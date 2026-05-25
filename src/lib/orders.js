// src/lib/orders.js — Shared orders + line items data layer.
// All pages that read orders use useOrders(); pages that mutate orders
// use the helper functions exported here. RLS handles per-role visibility:
//   - partners see only their own orders (partner_id = auth.uid())
//   - admin/employee/accountant see all orders
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { computeOrderTotal } from './tax';

// Embedded relational select: pulls each order with its items array AND each
// item's product info in a single round-trip.
const ORDER_SELECT = `
  *,
  items:bridgethings_order_items(
    *,
    product:bridgethings_products(id, name, base_price, image_url, features)
  )
`;

/**
 * useOrders({ status, partnerId, includeStatuses, limit })
 *   status: filter to a single bridgethings_order_status (e.g. 'pending_approval')
 *   includeStatuses: filter to an array of statuses (e.g. ['active','completed'])
 *   partnerId: filter to a specific partner (rarely needed since RLS handles partners)
 *   limit: max rows to return (default 100). Dashboards typically need only the
 *     most recent — pulling the entire orders table on every render gets slow.
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
      .order('created_at', { ascending: false })
      .limit(limit);

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
}) {
  if (!partnerId) throw new Error('partnerId is required');
  if (!items?.length) throw new Error('At least one item is required');

  const itemsSubtotal = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
  const { shipping, tax, total } = computeOrderTotal({ itemsSubtotal, shipping: shippingCost });

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
    })
    .select()
    .single();

  if (orderErr) throw orderErr;

  const itemRows = items.map(i => ({
    order_id:   order.id,
    product_id: i.product_id,
    qty:        Number(i.qty) || 1,
    unit_price: Number(i.unit_price) || 0,
    notes:      i.notes?.trim() || null,
  }));

  const { data: insertedItems, error: itemsErr } = await supabase
    .from('bridgethings_order_items')
    .insert(itemRows)
    .select();

  if (itemsErr) {
    // Best-effort rollback: delete the order row we just created so we don't
    // leave an order without its items.
    await supabase.from('bridgethings_orders').delete().eq('id', order.id);
    throw itemsErr;
  }

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

  const { error: orderErr } = await supabase
    .from('bridgethings_orders')
    .update({
      status:                  'active',
      employee_notes:          employeeNotes?.trim() || null,
      committed_delivery_date: committed || null,
      updated_at:              new Date().toISOString(),
    })
    .eq('id', orderId);
  if (orderErr) throw orderErr;
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
}

/**
 * acceptDeliveryCounter(orderId)
 *   Partner accepts admin's counter-proposed date. PO re-enters the
 *   admin's approval queue with the new date locked in.
 */
export async function acceptDeliveryCounter(orderId) {
  if (!orderId) throw new Error('orderId is required');
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      delivery_negotiation_status: 'counter_accepted',
      updated_at:                  new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;
}

/**
 * declineDeliveryCounter(orderId)
 *   Partner can't accept admin's counter date — PO auto-rejects.
 */
export async function declineDeliveryCounter(orderId) {
  if (!orderId) throw new Error('orderId is required');
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      status:         'rejected',
      employee_notes: 'Partner declined the counter-proposed delivery date.',
      updated_at:     new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;
}

/**
 * rejectOrder(orderId, notes)
 *   Mark a pending PO as rejected (status='rejected'). The row stays so admins
 *   can see the rejection history. Optional notes are stored in employee_notes.
 */
export async function rejectOrder(orderId, notes) {
  const { error } = await supabase
    .from('bridgethings_orders')
    .update({
      status:         'rejected',
      employee_notes: notes?.trim() || null,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw error;
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
}
