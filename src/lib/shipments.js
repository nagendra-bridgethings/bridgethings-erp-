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
import { notify, loadOrderParty, orderShortId } from './notify';

const SHIPMENTS_TABLE = 'bridgethings_shipments';
const ITEMS_TABLE     = 'bridgethings_shipment_items';

// Tell the partner a parcel is on its way. Fired the moment a shipment
// first gets a tracking number — either at creation (if created with one)
// or later via updateShipment when dispatch fills the AWB on a "plan"
// shipment. Gated on tracking-appears so plan-first parcels don't email
// "shipped" before they actually move.
async function notifyShipmentShipped(orderId, courier, tracking, shipmentId) {
  if (!orderId) return;
  const party = await loadOrderParty(orderId);
  if (party?.partner?.email) {
    notify('shipment_dispatched',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name,
        courier: courier?.trim() || '', tracking: tracking?.trim() || '' },
      { relatedOrderId: orderId, relatedShipmentId: shipmentId });
  }
}

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
// recorded, compute per order_item_id:
//   ordered    — qty on the order line
//   shipped    — qty ALLOCATED to any parcel (plan or dispatched). Drives
//                "remaining to parcel" so the same unit can't be put in two
//                parcels.
//   dispatched — qty in parcels that have ACTUALLY gone out (AWB entered or
//                delivered). This is "really shipped" — a plan parcel awaiting
//                docs/AWB does NOT count here.
//   remaining  — qty not yet in any parcel (ordered − shipped).
// Callers use `shipped`/`remaining` for the add-shipment form and
// `dispatched` for shipped-progress display, so a packed-but-not-yet-shipped
// parcel never reads as "shipped".
export function computeRemainingByItem(items = [], shipments = []) {
  const map = {};
  for (const it of items) {
    map[it.id] = { ordered: Number(it.qty) || 0, shipped: 0, dispatched: 0, remaining: Number(it.qty) || 0 };
  }
  for (const s of shipments) {
    const isDispatched = Boolean(s.tracking_number || s.delivered_date);
    for (const si of (s.items || [])) {
      const slot = map[si.order_item_id];
      if (!slot) continue;
      const q = Number(si.qty) || 0;
      slot.shipped   += q;
      if (isDispatched) slot.dispatched += q;
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

  // Validate against the CURRENT remaining qty in the DB, not the caller's
  // possibly-stale snapshot (another session/tab may have shipped since the
  // form opened). A failed read throws — never treat it as "0 shipped".
  const { data: orderItems, error: oiErr } = await supabase
    .from('bridgethings_order_items')
    .select('id, qty')
    .eq('order_id', orderId);
  if (oiErr) throw oiErr;
  const orderedById = Object.fromEntries((orderItems || []).map(i => [i.id, Number(i.qty) || 0]));

  const { data: priorShipments, error: psErr } = await supabase
    .from(SHIPMENTS_TABLE)
    .select('id, items:bridgethings_shipment_items(order_item_id, qty)')
    .eq('order_id', orderId);
  if (psErr) throw psErr;
  const shippedById = {};
  for (const s of priorShipments || []) {
    for (const si of (s.items || [])) {
      shippedById[si.order_item_id] = (shippedById[si.order_item_id] || 0) + (Number(si.qty) || 0);
    }
  }

  for (const i of cleanItems) {
    if (!(i.orderItemId in orderedById)) {
      throw new Error('Shipment contains an item that does not belong to this order');
    }
    const remaining = orderedById[i.orderItemId] - (shippedById[i.orderItemId] || 0);
    if (i.qty > remaining) {
      throw new Error(`Cannot ship ${i.qty} units — only ${Math.max(0, remaining)} remain unshipped for this item. Refresh and try again.`);
    }
  }

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

  // Send the right partner mail for the state this parcel was created in.
  // Mutually exclusive so a create-with-both never double-sends:
  //   • already delivered (hand-delivery / completed) → delivery confirmation
  //   • has a tracking number (real dispatch)         → "shipped" mail
  //   • neither (a plan awaiting docs/AWB)            → no mail yet; it fires
  //     later from updateShipment/markShipmentDelivered.
  if ((deliveredDate || '').trim()) {
    const party = await loadOrderParty(orderId);
    if (party?.partner?.email) {
      notify('shipment_delivered',
        { email: party.partner.email, role: 'partner', userId: party.partner.id },
        { orderShortId: orderShortId(orderId), partnerName: party.partner.name },
        { relatedOrderId: orderId, relatedShipmentId: shipment.id });
    }
  } else if ((trackingNumber || '').trim()) {
    await notifyShipmentShipped(orderId, courier, trackingNumber, shipment.id);
  }
  return shipment;
}

// Mark an in-transit shipment as delivered. Trigger picks up the change
// and flips the order to 'delivered' / 'completed' once every parcel is
// in.
export async function markShipmentDelivered(shipmentId, deliveredDate) {
  if (!shipmentId) throw new Error('shipmentId is required');
  const { data: before } = await supabase
    .from(SHIPMENTS_TABLE)
    .select('order_id, delivered_date')
    .eq('id', shipmentId)
    .maybeSingle();

  const { error } = await supabase
    .from(SHIPMENTS_TABLE)
    .update({ delivered_date: deliveredDate || new Date().toISOString().slice(0, 10) })
    .eq('id', shipmentId);
  if (error) throw error;

  // Notify the partner on the first delivery mark (skip re-marks).
  if (before?.order_id && !before?.delivered_date) {
    const party = await loadOrderParty(before.order_id);
    if (party?.partner?.email) {
      notify('shipment_delivered',
        { email: party.partner.email, role: 'partner', userId: party.partner.id },
        { orderShortId: orderShortId(before.order_id), partnerName: party.partner.name },
        { relatedOrderId: before.order_id, relatedShipmentId: shipmentId });
    }
  }
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

  // Snapshot before so we can detect a tracking number appearing for the
  // first time (plan → dispatched) and notify the partner exactly once.
  const { data: before } = await supabase
    .from(SHIPMENTS_TABLE)
    .select('order_id, tracking_number, courier')
    .eq('id', shipmentId)
    .maybeSingle();

  const { error } = await supabase
    .from(SHIPMENTS_TABLE)
    .update(clean)
    .eq('id', shipmentId);
  if (error) throw error;

  const trackingAppeared =
    !(before?.tracking_number || '').trim() &&
    !!(clean.tracking_number || '').trim();
  if (trackingAppeared) {
    await notifyShipmentShipped(
      before?.order_id,
      clean.courier ?? before?.courier,
      clean.tracking_number,
      shipmentId,
    );
  }
}

// Drop a shipment (and its items via ON DELETE CASCADE). Trigger
// recomputes the order status.
export async function deleteShipment(shipmentId) {
  if (!shipmentId) throw new Error('shipmentId is required');
  const { error } = await supabase.from(SHIPMENTS_TABLE).delete().eq('id', shipmentId);
  if (error) throw error;
}
