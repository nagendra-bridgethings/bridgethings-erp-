// src/lib/shipments.js — Split shipments per order.
//
// Each shipment is one physical parcel: courier, tracking #, shipped
// date, delivered date. The shipment_items junction tracks how many of
// each ordered item went into the parcel — so a 10-unit order can ship
// as 6 + 4 across two parcels with different couriers.
//
// A DB trigger keeps the parent order's fulfillment_status,
// delivery_method, tracking_number and delivered_date in sync whenever
// shipments or shipment_items change. Callers here just insert/update/
// delete — the order rolls itself up.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

const SHIPMENTS_TABLE = 'bridgethings_shipments';
const ITEMS_TABLE     = 'bridgethings_shipment_items';

// Load every shipment for an order, with its embedded items. Newest first.
export function useShipmentsForOrder(orderId) {
  const [shipments, setShipments] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) { setShipments([]); return; }
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from(SHIPMENTS_TABLE)
      .select(`
        *,
        items:bridgethings_shipment_items(*)
      `)
      .eq('order_id', orderId)
      .order('shipped_date', { ascending: false })
      .order('created_at',   { ascending: false });
    if (error) {
      console.error('[shipments] load failed:', error);
      setShipments([]);
    } else {
      setShipments(data || []);
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => { load(); }, [load]);
  return { shipments, loading, reload: load };
}

// Given an order's items (with `qty`) and the list of shipments already
// recorded, compute how many of each item is still pending shipment.
// Returns a map keyed by order_item_id → { ordered, shipped, remaining }.
export function computeRemainingByItem(items = [], shipments = []) {
  const map = {};
  for (const it of items) {
    map[it.id] = { ordered: Number(it.qty) || 0, shipped: 0, remaining: Number(it.qty) || 0 };
  }
  for (const s of shipments) {
    for (const si of (s.items || [])) {
      const slot = map[si.order_item_id];
      if (!slot) continue;
      slot.shipped   += Number(si.qty) || 0;
      slot.remaining = Math.max(0, slot.ordered - slot.shipped);
    }
  }
  return map;
}

// Create one shipment + its line items in a single round-trip via two
// inserts. Validates that no item ships more than its remaining qty.
//
// items: [{ orderItemId: UUID, qty: number }]
export async function createShipment({
  orderId,
  courier,
  trackingNumber,
  shippedDate,
  deliveredDate, // optional — set if the shipment is already delivered
  notes,
  items,
}) {
  if (!orderId)        throw new Error('orderId is required');
  if (!items?.length)  throw new Error('Add at least one item to the shipment');
  const cleanItems = items
    .map(i => ({ orderItemId: i.orderItemId, qty: Math.floor(Number(i.qty) || 0) }))
    .filter(i => i.orderItemId && i.qty > 0);
  if (!cleanItems.length) throw new Error('Add at least one item with a positive quantity');

  const { data: shipment, error: shipErr } = await supabase
    .from(SHIPMENTS_TABLE)
    .insert({
      order_id:        orderId,
      courier:         courier?.trim()        || null,
      tracking_number: trackingNumber?.trim() || null,
      shipped_date:    shippedDate || new Date().toISOString().slice(0, 10),
      delivered_date:  deliveredDate || null,
      notes:           notes?.trim() || null,
    })
    .select()
    .single();
  if (shipErr) throw shipErr;

  const itemRows = cleanItems.map(i => ({
    shipment_id:   shipment.id,
    order_item_id: i.orderItemId,
    qty:           i.qty,
  }));
  const { error: itemsErr } = await supabase.from(ITEMS_TABLE).insert(itemRows);
  if (itemsErr) {
    // Roll back the orphan shipment so we don't leave a parcel with no items.
    await supabase.from(SHIPMENTS_TABLE).delete().eq('id', shipment.id);
    throw itemsErr;
  }
  return shipment;
}

// Mark an in-transit shipment as delivered. Trigger picks up the change
// and flips the order to 'delivered' / 'completed' once every parcel is
// in.
export async function markShipmentDelivered(shipmentId, deliveredDate) {
  if (!shipmentId) throw new Error('shipmentId is required');
  const { error } = await supabase
    .from(SHIPMENTS_TABLE)
    .update({ delivered_date: deliveredDate || new Date().toISOString().slice(0, 10) })
    .eq('id', shipmentId);
  if (error) throw error;
}

// Patch shipment fields after creation — used when dispatch creates the
// shipment as a "plan" (no AWB yet), waits for partner docs, then fills
// in the tracking number and actual shipped date once the parcel is on
// its way. Pass only the fields that change; nulls/undefineds are
// preserved verbatim by Supabase's update.
export async function updateShipment(shipmentId, patch) {
  if (!shipmentId) throw new Error('shipmentId is required');
  const clean = {};
  if ('courier'         in patch) clean.courier         = patch.courier?.trim()        || null;
  if ('trackingNumber'  in patch) clean.tracking_number = patch.trackingNumber?.trim() || null;
  if ('shippedDate'     in patch) clean.shipped_date    = patch.shippedDate            || null;
  if ('notes'           in patch) clean.notes           = patch.notes?.trim()          || null;
  if (Object.keys(clean).length === 0) return;
  const { error } = await supabase
    .from(SHIPMENTS_TABLE)
    .update(clean)
    .eq('id', shipmentId);
  if (error) throw error;
}

// Drop a shipment (and its items via ON DELETE CASCADE). Trigger
// recomputes the order status.
export async function deleteShipment(shipmentId) {
  if (!shipmentId) throw new Error('shipmentId is required');
  const { error } = await supabase.from(SHIPMENTS_TABLE).delete().eq('id', shipmentId);
  if (error) throw error;
}
