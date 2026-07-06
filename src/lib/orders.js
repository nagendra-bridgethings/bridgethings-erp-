// src/lib/orders.js — Shared orders + line items data layer.
// All pages that read orders use useOrders(); pages that mutate orders
// use the helper functions exported here. RLS handles per-role visibility:
//   - partners see only their own orders (partner_id = auth.uid())
//   - admin/employee/accountant see all orders
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { computeOrderTotal } from './tax';
import { cableChargeFor } from './cable';
import { notify, loadOrderParty, orderShortId, fmtDate } from './notify';

// Fire the two "order cleared for dispatch" notifications: the partner
// ("production starting") and the operations team ("ready to produce").
// Exported so payments.js can reuse it after a payment completes the
// balance and the DB trigger auto-approves dispatch.
export async function notifyDispatchCleared(orderId) {
  const party = await loadOrderParty(orderId);
  const sid = orderShortId(orderId);
  const name = party?.partner?.name || 'there';
  if (party?.partner?.email) {
    notify('dispatch_approved',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: sid, partnerName: name },
      { relatedOrderId: orderId });
  }
  notify('production_ready', { group: 'operations' },
    { orderShortId: sid, partnerName: name },
    { relatedOrderId: orderId });
}

// Partner-facing order reference. Prefer the PO number the partner typed at
// submission so they track the order by their own number; fall back to the
// system short id (ORD-XXXXXXXX) when they skipped it. Used everywhere an
// order number is shown so the label is consistent across the app.
export function orderRef(order) {
  const po = order?.partner_po_number?.trim();
  if (po) return po;
  return 'ORD-' + (order?.id ? order.id.slice(0, 8).toUpperCase() : '');
}

// Embedded relational select: pulls each order with its items array AND each
// item's product info in a single round-trip.
const ORDER_SELECT = `
  *,
  items:bridgethings_order_items(
    *,
    product:bridgethings_products(id, name, internal_name, base_price, image_url, features)
  )
`;

/**
 * useOrders({ status, partnerId, includeStatuses, limit })
 *   status: filter to a single bridgethings_order_status (e.g. 'pending_approval')
 *   includeStatuses: filter to an array of statuses (e.g. ['active','completed'])
 *   partnerId: filter to a specific partner (rarely needed since RLS handles partners)
 *   limit: max rows to return (default 100). Dashboards typically need only the
 *     most recent — pulling the entire orders table on every render gets slow.
 *     Pass limit: null for NO client cap — required wherever the result feeds
 *     aggregates (revenue totals, queue tabs) that must never silently truncate.
 *   All filters optional. With no filters and admin role, returns every order.
 */
export function useOrders({ status, includeStatuses, partnerId, limit = 100 } = {}) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    await supabase.auth.getSession(); // Fix race condition before querying
    let query = supabase
      .from('bridgethings_orders')
      .select(ORDER_SELECT)
      .order('created_at', { ascending: false });
    if (limit != null) query = query.limit(limit);

    if (status)            query = query.eq('status', status);
    if (includeStatuses)   query = query.in('status', includeStatuses);
    if (partnerId)         query = query.eq('partner_id', partnerId);

    const { data, error } = await query;
    if (error) {
      console.error('[orders] load failed:', error);
      setError(error);
      setOrders([]);
    } else {
      setOrders(data || []);
      setError(null);
    }
    setLoading(false);
  }, [status, includeStatuses?.join(','), partnerId, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  return { orders, loading, error, reload: load };
}

/**
 * createOrder({ partnerId, items, status, deliveryMethod, shippingCost, requestedDeliveryDate })
 *   items: [{ product_id, qty, unit_price, notes }]
 *   deliveryMethod: courier partner name (e.g. "Delhivery"); stored in
 *     bridgethings_orders.delivery_method
 *   shippingCost: numeric shipping fee added on top of the items subtotal;
 *     stored in bridgethings_orders.shipping_cost
 *   requestedDeliveryDate: optional YYYY-MM-DD; partner's preferred delivery
 *     date. Admin may counter-propose a different one via proposeDeliveryDate.
 *   Inserts the order row, then the items in a follow-up batch insert.
 *   Returns the new order row (with items[]).
 */
export async function createOrder({
  partnerId,
  items,
  status = 'pending_approval',
  deliveryMethod = null,
  shippingCost = 0,
  requestedDeliveryDate = null,
  partnerPoNumber = null,
}) {
  if (!partnerId) throw new Error('partnerId is required');
  if (!items?.length) throw new Error('At least one item is required');

  const itemsSubtotal = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
  // Extra-cable charges are taxable goods → fold into the IGST base.
  const cableSubtotal = items.reduce((s, i) => s + cableChargeFor(i.extra_cable_m, i.qty), 0);
  const { shipping, tax, total } = computeOrderTotal({ itemsSubtotal: itemsSubtotal + cableSubtotal, shipping: shippingCost });

  const { data: order, error: orderErr } = await supabase
    .from('bridgethings_orders')
    .insert({
      partner_id:              partnerId,
      status,
      total_amount:            total,   // subtotal + shipping + IGST
      tax_amount:              tax,
      amount_paid:             0,
      payment_status:          'pending',
      delivery_method:         deliveryMethod || null,
      shipping_cost:           shipping,
      requested_delivery_date: requestedDeliveryDate || null,
      partner_po_number:       partnerPoNumber?.trim() || null,
    })
    .select()
    .single();

  if (orderErr) throw orderErr;

  const itemRows = items.map(i => ({
    order_id:      order.id,
    product_id:    i.product_id,
    qty:           Number(i.qty) || 1,
    unit_price:    Number(i.unit_price) || 0,
    notes:         i.notes?.trim() || null,
    extra_cable_m: Math.max(0, Math.floor(Number(i.extra_cable_m) || 0)),
    cable_charge:  cableChargeFor(i.extra_cable_m, i.qty),
  }));

  const { data: insertedItems, error: itemsErr } = await supabase
    .from('bridgethings_order_items')
    .insert(itemRows)
    .select();

  if (itemsErr) {
    // Best-effort rollback: delete the order row we just created so we don't
    // leave an order without its items. .select() so an RLS-blocked delete
    // (0 rows, no error) is at least visible in the console instead of
    // silently leaving an empty order in the admin queue.
    const { data: deleted, error: delErr } = await supabase
      .from('bridgethings_orders')
      .delete()
      .eq('id', order.id)
      .select('id');
    if (delErr || !deleted?.length) {
      console.error('[orders] rollback failed — orphaned order', order.id, delErr || '(0 rows deleted)');
    }
    throw itemsErr;
  }

  // Notify admins a new PO landed in their review queue.
  const party = await loadOrderParty(order.id);
  notify('po_submitted', { group: 'admins' },
    { orderShortId: orderShortId(order.id), partnerName: party?.partner?.name || 'A partner',
      partnerEmail: party?.partner?.email },
    { relatedOrderId: order.id });

  return { ...order, items: insertedItems };
}

/**
 * confirmOrder(orderId, notes)
 *   Admin/employee uses this to accept a PO: sets order.status='active'
 *   and optionally records communication-to-partner notes. Also locks in
 *   committed_delivery_date from whichever negotiation path applies —
 *   the partner's original requested date OR the admin's counter that
 *   the partner accepted.
 */
export async function confirmOrder(orderId, employeeNotes) {
  const { data: current, error: readErr } = await supabase
    .from('bridgethings_orders')
    .select('requested_delivery_date, proposed_delivery_date, delivery_negotiation_status')
    .eq('id', orderId)
    .single();
  if (readErr) throw readErr;

  const committed = current.delivery_negotiation_status === 'counter_accepted'
    ? current.proposed_delivery_date
    : current.requested_delivery_date;

  // Guard on the still-pending status so a stale modal (order already
  // accepted/rejected elsewhere) can't overwrite the newer state. A 0-row
  // update returns success with empty data, so we must check the count.
  const { data: updated, error: orderErr } = await supabase
    .from('bridgethings_orders')
    .update({
      status:                  'active',
      employee_notes:          employeeNotes?.trim() || null,
      committed_delivery_date: committed || null,
      updated_at:              new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'pending_approval')
    .select('id');
  if (orderErr) throw orderErr;
  if (!updated?.length) throw new Error('This PO is no longer pending (it may already be approved or rejected). Please refresh.');

  // Notify the partner their PO is confirmed (with the committed date).
  const party = await loadOrderParty(orderId);
  if (party?.partner?.email) {
    notify('po_confirmed',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name,
        committedDate: fmtDate(committed), notes: employeeNotes?.trim() || '' },
      { relatedOrderId: orderId });
  }
}

/**
 * proposeDeliveryDate(orderId, date, note)
 *   Admin can't meet the partner's requested delivery date and is sending
 *   back a counter-proposal. PO stays pending_approval but disappears
 *   from the admin's queue until the partner responds.
 */
export async function proposeDeliveryDate(orderId, date, note) {
  if (!orderId)       throw new Error('orderId is required');
  if (!date)          throw new Error('Please pick a proposed date');
  if (!note?.trim())  throw new Error('Please add a note for the partner');

  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      proposed_delivery_date:      date,
      delivery_negotiation_note:   note.trim(),
      delivery_negotiation_status: 'counter_sent',
      updated_at:                  new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;

  // Notify the partner of the counter-proposed delivery date.
  const party = await loadOrderParty(orderId);
  if (party?.partner?.email) {
    notify('delivery_counter',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name,
        proposedDate: fmtDate(date), notes: note.trim() },
      { relatedOrderId: orderId });
  }
}

/**
 * acceptDeliveryCounter(orderId)
 *   Partner accepts admin's counter-proposed date. Since the admin
 *   already proposed the date, partner accepting it is the final
 *   handshake — the PO auto-promotes to 'active' with the proposed
 *   date locked into committed_delivery_date. No second admin click.
 */
export async function acceptDeliveryCounter(orderId) {
  if (!orderId) throw new Error('orderId is required');

  const { data: current, error: readErr } = await supabase
    .from('bridgethings_orders')
    .select('proposed_delivery_date')
    .eq('id', orderId)
    .single();
  if (readErr) throw readErr;

  const { data: updated, error } = await supabase
    .from('bridgethings_orders')
    .update({
      status:                      'active',
      delivery_negotiation_status: 'counter_accepted',
      committed_delivery_date:     current.proposed_delivery_date || null,
      updated_at:                  new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'pending_approval')
    .select('id');
  if (error) throw error;
  if (!updated?.length) throw new Error('This order is no longer awaiting your response. Please refresh.');

  // Notify admins the partner accepted — the order is now active.
  const party = await loadOrderParty(orderId);
  notify('counter_accepted', { group: 'admins' },
    { orderShortId: orderShortId(orderId), partnerName: party?.partner?.name || 'The partner',
      partnerEmail: party?.partner?.email },
    { relatedOrderId: orderId });
}

/**
 * declineDeliveryCounter(orderId)
 *   Partner can't accept admin's counter date — PO auto-rejects.
 */
export async function declineDeliveryCounter(orderId) {
  if (!orderId) throw new Error('orderId is required');
  const { data: updated, error } = await supabase
    .from('bridgethings_orders')
    .update({
      status:         'rejected',
      employee_notes: 'Partner declined the counter-proposed delivery date.',
      updated_at:     new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'pending_approval')
    .select('id');
  if (error) throw error;
  if (!updated?.length) throw new Error('This order is no longer awaiting your response. Please refresh.');

  // Notify admins the partner declined — the order was rejected.
  const party = await loadOrderParty(orderId);
  notify('counter_declined', { group: 'admins' },
    { orderShortId: orderShortId(orderId), partnerName: party?.partner?.name || 'The partner',
      partnerEmail: party?.partner?.email },
    { relatedOrderId: orderId });
}

/**
 * rejectOrder(orderId, notes)
 *   Mark a pending PO as rejected (status='rejected'). The row stays so admins
 *   can see the rejection history. Optional notes are stored in employee_notes.
 */
export async function rejectOrder(orderId, notes) {
  // Same stale-snapshot guard as confirmOrder: never reject an order that
  // already left pending (e.g. the partner accepted a counter-date and the
  // admin's list is stale — rejecting would kill an active, possibly paid order).
  const { data: updated, error } = await supabase
    .from('bridgethings_orders')
    .update({
      status:         'rejected',
      employee_notes: notes?.trim() || null,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'pending_approval')
    .select('id');
  if (error) throw error;
  if (!updated?.length) throw new Error('This PO is no longer pending (it may already be approved or rejected). Please refresh.');

  // Notify the partner their PO was rejected (with the reason, if given).
  const party = await loadOrderParty(orderId);
  if (party?.partner?.email) {
    notify('po_rejected',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name, notes: notes?.trim() || '' },
      { relatedOrderId: orderId });
  }
}

/**
 * updateFulfillment(orderId, patch)
 *   patch: { fulfillment_status, delivery_method, tracking_number, delivered_date }
 *   When fulfillment reaches 'delivered', also flip order.status to 'completed'
 *   and auto-stamp `delivered_date` to today if admin didn't pick one — so
 *   invoices always have a real date instead of '—'.
 */
export async function updateFulfillment(orderId, patch) {
  const orderPatch = { ...patch, updated_at: new Date().toISOString() };
  if (patch.fulfillment_status === 'delivered') {
    orderPatch.status = 'completed';
    if (!patch.delivered_date) {
      orderPatch.delivered_date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }
  }

  const { error: orderErr } = await supabase
    .from('bridgethings_orders')
    .update(orderPatch)
    .eq('id', orderId);
  if (orderErr) throw orderErr;
}

/**
 * saveShipTo(orderId, patch)
 *   Partner saves the ship-to address + which documents they want
 *   enclosed in the parcel. When the address differs from bill-to AND
 *   the order is >= ₹50,000, we also flip partner_docs_status to
 *   'not_required' for now — operations toggles it to 'requested'
 *   when they're ready to ship, at which point the partner uploads
 *   invoice + DC + e-way bill.
 *
 *   patch shape:
 *     { ship_to_is_different, ship_to_name, ship_to_phone,
 *       ship_to_address, ship_to_city, ship_to_state, ship_to_pincode,
 *       ship_to_gstin, documents_in_parcel }
 */
export async function saveShipTo(orderId, patch) {
  if (!orderId) throw new Error('orderId is required');
  const cleanDocs = Array.isArray(patch.documents_in_parcel)
    ? patch.documents_in_parcel.filter(Boolean)
    : [];
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      ship_to_is_different: !!patch.ship_to_is_different,
      ship_to_name:         patch.ship_to_name?.trim()    || null,
      ship_to_phone:        patch.ship_to_phone?.trim()   || null,
      ship_to_address:      patch.ship_to_address?.trim() || null,
      ship_to_city:         patch.ship_to_city?.trim()    || null,
      ship_to_state:        patch.ship_to_state?.trim()   || null,
      ship_to_pincode:      patch.ship_to_pincode?.trim() || null,
      ship_to_gstin:        patch.ship_to_gstin?.trim()   || null,
      documents_in_parcel:  cleanDocs,
      updated_at:           new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;
}

/**
 * derivePartnerStatusLabel(order)
 *   Single source of truth for what the channel partner sees as the
 *   status badge on their My Orders / Dashboard / order modal.
 *
 *   Order-level lifecycle wins at the boundaries:
 *     pending_approval → 'Awaiting Confirmation'
 *     rejected         → 'Rejected'
 *     completed        → 'Completed'
 *
 *   For 'active' orders we either show the shipping stage
 *   (Shipped / Delivered) when shipments exist, or roll up the
 *   per-item production_status (Hold / In Production / Ready to
 *   Dispatch) so the partner sees ops progress in real time. The
 *   internal 'sent_back' state is folded into 'In Production' to
 *   hide the ops↔dispatch back-and-forth.
 */
export function derivePartnerStatusLabel(order) {
  if (!order) return { label: '—', className: 'badge-gray' };
  if (order.status === 'pending_approval')
    return { label: 'Awaiting Confirmation', className: 'badge-warning' };
  if (order.status === 'rejected')
    return { label: 'Rejected', className: 'badge-danger' };
  if (order.status === 'completed')
    return { label: 'Completed', className: 'badge-success' };

  // active order — shipping stage wins if it's progressed past prep
  if (order.fulfillment_status === 'shipped')
    return { label: 'Shipped', className: 'badge-purple' };
  if (order.fulfillment_status === 'delivered')
    return { label: 'Delivered', className: 'badge-success' };

  // Payment / dispatch gate: production hasn't started until payment clears
  // and admin has approved dispatch. Surfacing the internal 'Hold' state to
  // the partner before then is misleading — they just need to know payment
  // is pending or the order is queued.
  if (order.dispatch_approval !== 'approved') {
    if (order.dispatch_approval === 'awaiting_payment')
      return { label: 'Awaiting Payment', className: 'badge-warning' };
    return { label: 'In Progress', className: 'badge-info' };
  }

  // Roll up per-item production_status
  const items = order.items || [];
  if (items.length === 0)
    return { label: 'In Progress', className: 'badge-info' };
  const all = (s) => items.every(i => (i.production_status || 'hold') === s);
  const any = (s) => items.some(i => (i.production_status || 'hold') === s);
  // 'hold' is the default state every unit lands in at creation — the partner
  // doesn't need to know about it. Collapse into the generic "In Progress"
  // so they only see forward movement (In Production → Sent for Dispatch).
  if (all('ready_to_dispatch'))  return { label: 'Sent for Dispatch', className: 'badge-warning' };
  if (any('production') || any('ready_to_dispatch') || any('sent_back'))
    return { label: 'In Production', className: 'badge-info' };
  return { label: 'In Progress', className: 'badge-info' };
}

/**
 * deriveOpsOrderStatus(counts)
 *   Roll up an order to a single ops-facing production state from its
 *   per-unit counts. Dispatched units are excluded from the "remaining"
 *   pool so e.g. (1 dispatched + 1 ready) → ready_to_dispatch rather
 *   than a separate "partial_dispatched" state that has no tab.
 *
 *   Shared between the Orders page (where it drives tab filters AND row
 *   badges) and the admin Dashboard (Recent Orders), so the label a user
 *   sees in both spots can never drift.
 */
export function deriveOpsOrderStatus(counts) {
  const c = counts || {};
  const hold  = c.hold || 0;
  const prod  = c.production || 0;
  const ready = c.ready_to_dispatch || 0;
  const sent  = c.sent_back || 0;
  const disp  = c.dispatched || 0;
  const total = hold + prod + ready + sent + disp;
  if (total === 0)             return 'hold';
  const remaining = total - disp;
  if (remaining === 0)         return 'dispatched';
  if (sent > 0)                return 'sent_back';
  if (prod > 0)                return 'production';
  if (ready > 0 && hold > 0)   return 'partial_ready';
  if (ready > 0)               return 'ready_to_dispatch';
  return 'hold';
}

/**
 * useOrderStatusBreakdown(orderIds)
 *   Loads per-order unit-status counts + shipment delivery info in three
 *   queries, then returns a map keyed by order id of:
 *     { hold, production, sent_back, ready_to_dispatch, dispatched,
 *       shipped, delivered }
 *
 *   Used by partner pages (My Orders, Dashboard) so the status column can
 *   show a dynamic per-unit breakdown — "3 Delivered · 1 In Production"
 *   — instead of a single rolled-up "Shipped" label that hides partial
 *   progress.
 *
 *   `shipped` = dispatched units in shipments that haven't been marked
 *   delivered yet (in-transit). `delivered` = dispatched units in
 *   shipments with delivered_date set.
 */
export function useOrderStatusBreakdown(orderIds) {
  const [breakdown, setBreakdown] = useState({});

  // Stable key so we don't re-run on every render with a new array ref.
  const key = (orderIds || []).slice().sort().join(',');

  useEffect(() => {
    if (!orderIds?.length) { setBreakdown({}); return; }
    let cancelled = false;
    (async () => {
      await supabase.auth.getSession();

      // 1) Items → order mapping (lets us roll unit counts up to the order).
      const { data: items, error: itemsErr } = await supabase
        .from('bridgethings_order_items')
        .select('id, order_id')
        .in('order_id', orderIds);
      if (cancelled) return;
      if (itemsErr) { console.error('[orderStatus] items load failed:', itemsErr); return; }

      const itemToOrder = {};
      const itemIds = [];
      for (const it of items || []) {
        itemToOrder[it.id] = it.order_id;
        itemIds.push(it.id);
      }

      // 2) Per-unit production_status counts.
      let units = [];
      if (itemIds.length) {
        const { data, error } = await supabase
          .from('bridgethings_order_unit_details')
          .select('order_item_id, production_status')
          .in('order_item_id', itemIds);
        if (cancelled) return;
        if (error) { console.error('[orderStatus] units load failed:', error); return; }
        units = data || [];
      }

      // 3) Shipments + their items — only the delivered ones contribute to
      //    delivered_qty. Undelivered shipments give us shipped_qty by
      //    subtraction from total dispatched.
      const { data: shipments, error: shipErr } = await supabase
        .from('bridgethings_shipments')
        .select('order_id, delivered_date, items:bridgethings_shipment_items(qty)')
        .in('order_id', orderIds);
      if (cancelled) return;
      if (shipErr) { console.error('[orderStatus] shipments load failed:', shipErr); return; }

      const map = {};
      for (const oid of orderIds) {
        map[oid] = {
          hold: 0, production: 0, sent_back: 0,
          ready_to_dispatch: 0, dispatched: 0,
          shipped: 0, delivered: 0,
        };
      }
      for (const u of units) {
        const oid = itemToOrder[u.order_item_id];
        if (!oid || !map[oid]) continue;
        const s = u.production_status || 'hold';
        if (map[oid][s] !== undefined) map[oid][s]++;
      }
      for (const s of shipments || []) {
        if (!s.delivered_date || !map[s.order_id]) continue;
        for (const si of s.items || []) {
          map[s.order_id].delivered += Number(si.qty) || 0;
        }
      }
      // Of all dispatched units, the ones NOT in delivered shipments are
      // in-transit ("shipped").
      for (const oid of Object.keys(map)) {
        const m = map[oid];
        m.shipped = Math.max(0, m.dispatched - m.delivered);
      }
      setBreakdown(map);
    })();
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return breakdown;
}

/**
 * partnerStatusBadges(counts)
 *   Maps the breakdown counts from useOrderStatusBreakdown into a list of
 *   partner-facing badge descriptors. Order is forward-flow:
 *     In Production → Sent for Dispatch → Shipped → Delivered
 *   Empty buckets are skipped, so partners only see badges that mean
 *   something for this specific order.
 */
export function partnerStatusBadges(counts) {
  if (!counts) return [];
  const inProd    = (counts.hold || 0) + (counts.production || 0) + (counts.sent_back || 0);
  const ready     = counts.ready_to_dispatch || 0;
  const shipped   = counts.shipped   || 0;
  const delivered = counts.delivered || 0;
  const badges = [];
  if (inProd > 0)    badges.push({ label: `${inProd} In Production`,    cls: 'badge-info' });
  if (ready > 0)     badges.push({ label: `${ready} Sent for Dispatch`, cls: 'badge-warning' });
  if (shipped > 0)   badges.push({ label: `${shipped} Shipped`,         cls: 'badge-purple' });
  if (delivered > 0) badges.push({ label: `${delivered} Delivered`,     cls: 'badge-success' });
  return badges;
}

// Badge styling per ops status. Keys = deriveOpsOrderStatus return values.
export const OPS_STATUS_BADGE = {
  hold:              { cls: 'badge-info',    label: 'In Progress' },
  production:        { cls: 'badge-info',    label: 'In Production' },
  partial_ready:     { cls: 'badge-warning', label: 'Partial Ready' },
  ready_to_dispatch: { cls: 'badge-warning', label: 'Sent for Dispatch' },
  sent_back:         { cls: 'badge-danger',  label: 'Sent Back' },
  dispatched:        { cls: 'badge-success', label: 'Dispatched' },
};

/**
 * ITEM_PRODUCTION_STATUSES — per-item lifecycle the operations team
 * cycles through, plus the auto/dispatch ones.
 */
export const ITEM_PRODUCTION_STATUSES = [
  // 'hold' is the default state every unit lands in. Labelled "In Progress"
  // so ops sees a forward-looking status from the moment payment clears,
  // rather than reading it as "ops chose to hold this".
  { value: 'hold',              label: 'In Progress' },
  { value: 'production',        label: 'In Production' },
  { value: 'ready_to_dispatch', label: 'Sent for Dispatch' },
  { value: 'sent_back',         label: 'Sent Back to Ops' },
  { value: 'dispatched',        label: 'Dispatched' },
];
export const ITEM_PRODUCTION_LABEL = Object.fromEntries(
  ITEM_PRODUCTION_STATUSES.map(s => [s.value, s.label]),
);

/**
 * setItemProductionStatus(itemId, status)
 *   Ops uses this to move an order_item through hold → production →
 *   ready_to_dispatch. Clears any prior send-back note so the red
 *   banner on the partner / ops view disappears.
 */
export async function setItemProductionStatus(itemId, status) {
  if (!itemId) throw new Error('itemId is required');
  if (!status) throw new Error('status is required');
  // bridgethings_order_items has no updated_at column — don't set one.
  const patch = { production_status: status };
  // Moving forward clears the dispatch note. Send-back path uses
  // sendItemsBackToOps which sets the note instead.
  if (status !== 'sent_back') patch.dispatch_review_note = null;
  const { error } = await supabase
    .from('bridgethings_order_items')
    .update(patch)
    .eq('id', itemId);
  if (error) throw error;
}

/**
 * markItemsReadyToDispatch(itemIds)
 *   Ops bulk-action: tick a set of items and click "Send to Dispatch".
 *   All chosen items flip to 'ready_to_dispatch' in one round-trip.
 */
export async function markItemsReadyToDispatch(itemIds) {
  if (!itemIds?.length) throw new Error('Pick at least one item');
  const { error } = await supabase
    .from('bridgethings_order_items')
    .update({
      production_status:    'ready_to_dispatch',
      dispatch_review_note: null,
    })
    .in('id', itemIds);
  if (error) throw error;
}

/**
 * sendItemsBackToOps(itemIds, note)
 *   Dispatch found something wrong while verifying. Flips items back
 *   to 'sent_back' with a shared note. Ops sees the note prominently
 *   so they know what to fix before re-submitting.
 */
export async function sendItemsBackToOps(itemIds, note) {
  if (!itemIds?.length) throw new Error('Pick at least one item');
  if (!note?.trim())    throw new Error('Please add a note for the operations team');
  const { error } = await supabase
    .from('bridgethings_order_items')
    .update({
      production_status:    'sent_back',
      dispatch_review_note: note.trim(),
    })
    .in('id', itemIds);
  if (error) throw error;
}

/**
 * approveDispatch(orderId)
 *   Admin clears an order for dispatch even when payment is partial.
 *   Clears any prior rejection note so the partner-side banner disappears.
 */
export async function approveDispatch(orderId) {
  if (!orderId) throw new Error('orderId is required');
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      dispatch_approval:       'approved',
      dispatch_rejection_note: null,
      updated_at:              new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;

  // Notify partner ("production starting") + operations ("ready to produce").
  await notifyDispatchCleared(orderId);
}

/**
 * rejectDispatch(orderId, note)
 *   Admin sends the order back to the partner asking for more payment.
 *   `note` is shown verbatim on the partner's order modal — be specific.
 */
export async function rejectDispatch(orderId, note) {
  if (!orderId) throw new Error('orderId is required');
  if (!note?.trim()) throw new Error('Please provide a reason for the partner');
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      dispatch_approval:       'rejected',
      dispatch_rejection_note: note.trim(),
      updated_at:              new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;

  // Notify the partner the order is on hold pending more payment.
  const party = await loadOrderParty(orderId);
  if (party?.partner?.email) {
    notify('dispatch_rejected',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name, notes: note.trim() },
      { relatedOrderId: orderId });
  }
}
