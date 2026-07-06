// src/lib/subscriptions.js — Per-device dashboard subscriptions.
//
// Every physical unit shipped (a row in bridgethings_order_unit_details)
// needs its own dashboard subscription. Default plan is 1-year coverage
// from the start_date. Renewals are new rows so the table is the full
// payment history for each unit.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { notify, loadOrderParty, fmtAmount } from './notify';

const TABLE = 'bridgethings_unit_subscriptions';
// Reuse the order payment-slips bucket (staff read every slip; partners read
// their own uid folder) — subscription slips live under a subscriptions/ path.
const SLIP_BUCKET = 'bridgethings-payment-slips';

// Resolve everything a subscription mail needs from a unit id:
// the parent order's partner (email/name) + the product name + serial.
// unit → order_item (order_id, product) → order (partner).
async function unitContext(unitId) {
  if (!unitId) return {};
  const { data } = await supabase
    .from('bridgethings_order_unit_details')
    .select('serial_number, item:bridgethings_order_items(order_id, product:bridgethings_products(name))')
    .eq('id', unitId)
    .maybeSingle();
  const orderId = data?.item?.order_id || null;
  const party = orderId ? await loadOrderParty(orderId) : null;
  return {
    orderId,
    party,
    productName: data?.item?.product?.name || '',
    serial:      data?.serial_number || '',
  };
}

// Add one year to YYYY-MM-DD. Used to compute end_date when admin enters start.
export function addOneYear(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// Derive the effective status for UI badges from end_date + status.
// 'cancelled' wins; otherwise compare end_date vs today.
//   expired       — end_date is in the past
//   expiring_soon — end_date within 30 days
//   active        — end_date > 30 days away
//   none          — no subscription row at all
export function effectiveStatus(sub) {
  if (!sub) return 'none';
  if (sub.status === 'cancelled') return 'cancelled';
  if (sub.status === 'submitted') return 'submitted'; // proof uploaded, awaiting accountant
  if (sub.status === 'pending')   return 'pending';
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(sub.end_date);
  const diff  = Math.round((end - today) / 86_400_000);
  if (diff < 0)  return 'expired';
  if (diff <= 30) return 'expiring_soon';
  return 'active';
}

// Days remaining until end_date (negative = days since expiry).
export function daysRemaining(sub) {
  if (!sub?.end_date) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(sub.end_date);
  return Math.round((end - today) / 86_400_000);
}

// Pick the most-recent (latest end_date) sub for a unit. There can be many
// rows over time (yearly renewals); the latest one is what the UI cares about.
// Cancelled rows only represent the unit when NOTHING else exists — a
// cancelled renewal must not mask a still-valid active subscription
// underneath it (cancelled rows "stay in history but stop counting").
export function latestSubFor(subs) {
  if (!subs?.length) return null;
  const live = subs.filter(s => s.status !== 'cancelled');
  const pool = live.length ? live : subs;
  return [...pool].sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''))[0];
}

// The sub that represents the unit's PAID coverage right now — ignores
// pending requests (whose placeholder end_date always sorts newest) and
// cancelled rows. Use for credential access + expiry displays so a renewal
// request doesn't hide coverage the partner already paid for.
export function coverageSubFor(subs) {
  return latestSubFor((subs || []).filter(s => s.status === 'active'));
}

// Hook: load every subscription visible to the current user (RLS handles the
// partner-vs-staff split). Pages then group by unit_id as needed.
export function useUnitSubscriptions() {
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('end_date', { ascending: false });
    if (error) {
      console.error('[subscriptions] load failed:', error);
      setSubs([]);
    } else {
      setSubs(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  return { subs, loading, reload: load };
}

// Insert a new subscription row for a unit. Used both for first activation
// and for renewals — renewals are simply new rows with a later start_date.
export async function createSubscription({
  unitId, startDate, amountPaid, paymentDate, notes, status = 'active',
}) {
  if (!unitId)     throw new Error('unitId is required');
  if (!startDate)  throw new Error('startDate is required');
  const endDate = addOneYear(startDate);

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      unit_id:      unitId,
      start_date:   startDate,
      end_date:     endDate,
      amount_paid:  Number(amountPaid) || 0,
      payment_date: paymentDate || null,
      notes:        notes?.trim() || null,
      status,
    })
    .select()
    .single();
  if (error) throw error;

  // Notify the partner their subscription is live (activation or renewal).
  if (status === 'active') {
    const ctx = await unitContext(unitId);
    if (ctx.party?.partner?.email) {
      notify('sub_activated',
        { email: ctx.party.partner.email, role: 'partner', userId: ctx.party.partner.id },
        { partnerName: ctx.party.partner.name, productName: ctx.productName, serial: ctx.serial },
        { relatedOrderId: ctx.orderId });
    }
  }
  return data;
}

// Admin can cancel a subscription (mistake, refund, etc.). The row stays
// for the audit trail; UI just stops counting it.
//
// mode picks the partner email:
//   'cancelled' — an ACTIVE subscription was cancelled (default)
//   'declined'  — a still-PENDING request was declined (partner never had
//                 coverage, so "cancelled" wording would mislead) → sends
//                 the "request declined" mail instead. `note` (optional) is
//                 shown to the partner as the reason.
//   'none'      — send no email
export async function cancelSubscription(id, { mode = 'cancelled', note } = {}) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('unit_id')
    .maybeSingle();
  if (error) throw error;

  if (mode !== 'none' && data?.unit_id) {
    const ctx = await unitContext(data.unit_id);
    if (ctx.party?.partner?.email) {
      notify(mode === 'declined' ? 'sub_request_declined' : 'sub_cancelled',
        { email: ctx.party.partner.email, role: 'partner', userId: ctx.party.partner.id },
        { partnerName: ctx.party.partner.name, productName: ctx.productName, serial: ctx.serial,
          notes: note?.trim() || '' },
        { relatedOrderId: ctx.orderId });
    }
  }
}

// Partner-initiated: batch-insert pending subscription requests for a set
// of devices. The amount_due is captured per row so it's locked in even
// if the product's subscription_price changes later. Admin will later
// approve via approveSubscription() once payment arrives.
//
// items: [{ unitId: UUID, amountDue: number }]
export async function requestSubscriptions(items) {
  if (!items?.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = items.map(({ unitId, amountDue }) => ({
    unit_id:      unitId,
    start_date:   today,                 // placeholder; admin sets the real start on approval
    end_date:     addOneYear(today),     // placeholder; recomputed on approval
    amount_due:   Number(amountDue) || 0,
    amount_paid:  0,
    status:       'pending',
  }));
  const { data, error } = await supabase.from(TABLE).insert(rows).select();
  if (error) throw error;

  // Notify accountants there are subscription requests to approve.
  const ctx = await unitContext(items[0].unitId);
  notify('sub_requested', { group: 'accountants' },
    { partnerName: ctx.party?.partner?.name || 'A partner', partnerEmail: ctx.party?.partner?.email,
      deviceCount: String(items.length) },
    { relatedOrderId: ctx.orderId });
  return data;
}

// Partner uploads a payment slip + claimed amount against their own pending
// subscription request. Uploads the slip to the private bucket, then flips the
// row to 'submitted' via the SECURITY DEFINER RPC (partners have no direct
// UPDATE on the table). Accountants then verify it. Fires sub_payment_submitted
// so accounts know a proof has landed and is ready to check.
export async function submitSubscriptionProof({
  subId, partnerId, amount, paymentDate, method, file,
}) {
  if (!subId)                         throw new Error('subId is required');
  if (!partnerId)                     throw new Error('partnerId is required');
  if (!amount || Number(amount) <= 0) throw new Error('Amount must be greater than zero');
  if (!paymentDate)                   throw new Error('Payment date is required');
  if (!file)                          throw new Error('Please attach the payment slip');

  // Path begins with the partner uid so the storage RLS allows the upload.
  const ext  = (file.name.split('.').pop() || 'pdf').toLowerCase();
  const path = `${partnerId}/subscriptions/${subId}/${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from(SLIP_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data: ok, error } = await supabase.rpc('bridgethings_submit_subscription_proof', {
    p_sub_id:       subId,
    p_amount:       Number(amount),
    p_payment_date: paymentDate,
    p_method:       method || 'bank_transfer',
    p_receipt_url:  path,
  });
  if (error) throw error;
  if (!ok)   throw new Error('Could not attach the proof — the request may no longer be pending. Please refresh.');

  // Tell accountants a subscription payment proof is ready to verify.
  const ctx = await unitContext(
    (await supabase.from(TABLE).select('unit_id').eq('id', subId).maybeSingle()).data?.unit_id,
  );
  notify('sub_payment_submitted', { group: 'accountants' },
    { partnerName: ctx.party?.partner?.name || 'A partner', partnerEmail: ctx.party?.partner?.email,
      amount: fmtAmount(amount), productName: ctx.productName },
    { relatedOrderId: ctx.orderId });
}

// Signed URL so an accountant (or the partner) can open a subscription slip
// from the private bucket. Same bucket as order slips.
export async function getSubscriptionSlipUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(SLIP_BUCKET)
    .createSignedUrl(path, 60 * 10); // 10 minutes
  if (error) {
    console.error('[subscriptions] signed url failed:', error);
    return null;
  }
  return data?.signedUrl || null;
}

// Accountant rejects a SUBMITTED proof — sends it back to 'pending' with a
// note so the partner can re-upload a correct slip. (Distinct from declining a
// request outright, which cancels it.) Accountants have a staff UPDATE policy,
// so this is a direct update.
export async function rejectSubscriptionProof(subId, note) {
  if (!subId)        throw new Error('subId is required');
  if (!note?.trim()) throw new Error('Please add a note explaining the rejection');
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'pending', rejection_note: note.trim(), updated_at: new Date().toISOString() })
    .eq('id', subId)
    .select('unit_id')
    .maybeSingle();
  if (error) throw error;

  // Tell the partner their proof was rejected + why, so they can re-upload.
  if (data?.unit_id) {
    const ctx = await unitContext(data.unit_id);
    if (ctx.party?.partner?.email) {
      notify('sub_payment_rejected',
        { email: ctx.party.partner.email, role: 'partner', userId: ctx.party.partner.id },
        { partnerName: ctx.party.partner.name, productName: ctx.productName, notes: note.trim() },
        { relatedOrderId: ctx.orderId });
    }
  }
}

// Fetch a unit's dashboard credentials on demand. The password is NEVER put
// in the device-list payload — it comes only from this SECURITY DEFINER RPC,
// which re-checks ownership + active paid coverage server-side. Returns
// { username, password } or throws ('Not authorized' / 'Subscription is not
// active…') so an expired-subscription partner can't read the password.
export async function getDashboardCredentials(unitId) {
  if (!unitId) throw new Error('unitId is required');
  const { data, error } = await supabase.rpc('bridgethings_get_dashboard_credentials', { p_unit_id: unitId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { username: row?.dashboard_username || '', password: row?.dashboard_password || '' };
}

// Set/update the external dashboard credentials on a unit. Captured by
// Accounts at first activation and reused across renewals (we don't ask
// again — same login keeps working). Edit later only if a partner needs
// a reset.
export async function setDashboardCredentials(unitId, { username, password }) {
  if (!unitId) throw new Error('unitId is required');
  // Go through the SECURITY DEFINER RPC: accountants (who activate the
  // dashboard) have no direct write on bridgethings_order_unit_details, so a
  // plain .update() silently saved nothing. The RPC updates just the two
  // credential columns, gated to admin/accountant/employee.
  const { error } = await supabase.rpc('bridgethings_set_dashboard_credentials', {
    p_unit_id:  unitId,
    p_username: username ?? null,
    p_password: password ?? null,
  });
  if (error) throw error;
}

// Admin-side: turn a pending request into an active subscription once
// payment has been received offline. Re-anchors the dates from the real
// payment/start date so the year of coverage starts when paid, not when
// the partner first requested.
export async function approveSubscription(subId, {
  startDate, amountPaid, paymentDate, notes,
}) {
  if (!subId)    throw new Error('subId is required');
  if (!startDate) throw new Error('startDate is required');
  const payload = {
    start_date:   startDate,
    end_date:     addOneYear(startDate),
    amount_paid:  Number(amountPaid) || 0,
    payment_date: paymentDate || null,
    status:       'active',
    updated_at:   new Date().toISOString(),
  };
  if (notes !== undefined) payload.notes = notes?.trim() || null;
  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq('id', subId)
    .select()
    .single();
  if (error) throw error;

  // Approved a pending request → notify the partner it's now active.
  if (data?.unit_id) {
    const ctx = await unitContext(data.unit_id);
    if (ctx.party?.partner?.email) {
      notify('sub_activated',
        { email: ctx.party.partner.email, role: 'partner', userId: ctx.party.partner.id },
        { partnerName: ctx.party.partner.name, productName: ctx.productName, serial: ctx.serial },
        { relatedOrderId: ctx.orderId });
    }
  }
  return data;
}
