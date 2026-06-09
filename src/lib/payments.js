// src/lib/payments.js — Multi-instalment payments per PO.
//
// Each row in bridgethings_order_payments is one payment received from
// the partner. A DB trigger keeps orders.amount_paid + payment_status in
// sync whenever rows here change, so callers only need to insert/delete
// payment rows — the order totals update automatically.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { notify, loadOrderParty, orderShortId, fmtAmount } from './notify';
import { notifyDispatchCleared } from './orders';

const TABLE = 'bridgethings_order_payments';
const SLIP_BUCKET = 'bridgethings-payment-slips';

// Read just an order's current dispatch_approval — used to detect the
// moment a payment completes the balance and the recompute trigger flips
// it to 'approved' (so we only fire the "cleared" mails on that transition).
async function readDispatchApproval(orderId) {
  if (!orderId) return null;
  const { data } = await supabase
    .from('bridgethings_orders')
    .select('dispatch_approval')
    .eq('id', orderId)
    .maybeSingle();
  return data?.dispatch_approval || null;
}

// Shared post-payment notifications. Fires "payment received" to the
// partner, and — only if THIS payment is what tipped the order into
// fully-paid (beforeApproval !== 'approved' && now === 'approved') —
// the "cleared for production" pair to partner + operations.
async function afterPaymentApplied(orderId, beforeApproval, amountApplied) {
  if (!orderId) return;
  const party = await loadOrderParty(orderId);
  const { data: ord } = await supabase
    .from('bridgethings_orders')
    .select('total_amount, amount_paid, dispatch_approval')
    .eq('id', orderId)
    .maybeSingle();
  const balance = Math.max(0, Number(ord?.total_amount || 0) - Number(ord?.amount_paid || 0));

  if (party?.partner?.email) {
    notify('payment_verified',
      { email: party.partner.email, role: 'partner', userId: party.partner.id },
      { orderShortId: orderShortId(orderId), partnerName: party.partner.name,
        amount: fmtAmount(amountApplied), balance: fmtAmount(balance) },
      { relatedOrderId: orderId });
  }

  const nowApproval = ord?.dispatch_approval;
  if (beforeApproval !== 'approved' && nowApproval === 'approved') {
    // Fully paid → auto-approved. Tell partner + operations, no admin step.
    await notifyDispatchCleared(orderId);
  } else if (beforeApproval !== 'pending' && nowApproval === 'pending') {
    // Partial payment → order is now waiting on the admin to approve
    // dispatch. Email the admins so they know to action it.
    notify('dispatch_pending', { group: 'admins' },
      { orderShortId: orderShortId(orderId),
        partnerName: party?.partner?.name, partnerEmail: party?.partner?.email,
        amount: fmtAmount(ord?.amount_paid), balance: fmtAmount(balance) },
      { relatedOrderId: orderId });
  }
}

// Human-readable labels for the payment_method enum.
export const PAYMENT_METHODS = [
  { value: 'upi',           label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'cash',          label: 'Cash' },
  { value: 'other',         label: 'Other' },
];

export const PAYMENT_METHOD_LABEL = Object.fromEntries(
  PAYMENT_METHODS.map(m => [m.value, m.label]),
);

// Hook: load every payment for a single order, newest first. RLS scopes
// the query — partners see their own, staff sees all.
export function usePaymentsForOrder(orderId) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) { setPayments([]); return; }
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('order_id', orderId)
      .order('payment_date', { ascending: false })
      .order('created_at',   { ascending: false });
    if (error) {
      console.error('[payments] load failed:', error);
      setPayments([]);
    } else {
      setPayments(data || []);
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => { load(); }, [load]);
  return { payments, loading, reload: load };
}

// Insert a new payment row. Trigger handles updating orders.amount_paid
// and payment_status — caller doesn't need to touch the order row.
export async function addPayment({
  orderId, amount, paymentDate, method, referenceNumber, notes,
}) {
  if (!orderId)                          throw new Error('orderId is required');
  if (!amount || Number(amount) <= 0)    throw new Error('Amount must be greater than zero');
  if (!paymentDate)                      throw new Error('Payment date is required');

  // Snapshot dispatch state before the insert — staff-entered payments
  // default to status='verified', so the recompute trigger may flip the
  // order to fully-paid/approved on insert.
  const beforeApproval = await readDispatchApproval(orderId);

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      order_id:         orderId,
      amount:           Number(amount),
      payment_date:     paymentDate,
      payment_method:   method || 'bank_transfer',
      reference_number: referenceNumber?.trim() || null,
      notes:            notes?.trim() || null,
    })
    .select()
    .single();
  if (error) throw error;

  // Staff recorded a payment directly → notify the partner it's received,
  // and fire the production-cleared mails if this completed the balance.
  await afterPaymentApplied(orderId, beforeApproval, Number(amount));
  return data;
}

// Remove a payment row (e.g. corrects an accidentally-recorded payment).
// Trigger reverts orders.amount_paid + payment_status accordingly.
export async function deletePayment(paymentId) {
  if (!paymentId) throw new Error('paymentId is required');
  const { error } = await supabase.from(TABLE).delete().eq('id', paymentId);
  if (error) throw error;
}

// ────────────────────────────────────────────────────────────────────────
// Partner-side payment proof upload.
// Inserts a row with status='pending_verification' (so it does NOT count
// toward amount_paid yet) and uploads the slip to storage. Accountant
// must verify it before the trigger adds the amount to the order.
// ────────────────────────────────────────────────────────────────────────
export async function submitPaymentProof({
  orderId, partnerId, amount, paymentDate, method, referenceNumber, notes, file,
}) {
  if (!orderId)                       throw new Error('orderId is required');
  if (!partnerId)                     throw new Error('partnerId is required');
  if (!amount || Number(amount) <= 0) throw new Error('Amount must be greater than zero');
  if (!paymentDate)                   throw new Error('Payment date is required');
  if (!file)                          throw new Error('Please attach the payment slip');

  // Upload the slip first — path begins with the partner's uid so RLS
  // allows it. Filename gets a timestamp prefix to avoid collisions.
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
  const path = `${partnerId}/${orderId}/${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from(SLIP_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadErr) throw uploadErr;

  // Bucket is private — generate a signed URL the accountant can open.
  // We persist the path; the URL is regenerated on demand by callers.
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      order_id:         orderId,
      amount:           Number(amount),
      payment_date:     paymentDate,
      payment_method:   method || 'bank_transfer',
      reference_number: referenceNumber?.trim() || null,
      notes:            notes?.trim() || null,
      receipt_url:      path,                    // storage path, signed when viewed
      status:           'pending_verification',
    })
    .select()
    .single();
  if (error) throw error;

  // Notify accountants there's a payment proof awaiting verification.
  const party = await loadOrderParty(orderId);
  notify('payment_submitted', { group: 'accountants' },
    { orderShortId: orderShortId(orderId), partnerName: party?.partner?.name || 'A partner',
      partnerEmail: party?.partner?.email, amount: fmtAmount(amount) },
    { relatedOrderId: orderId });
  return data;
}

// Generate a short-lived signed URL so the accountant (or partner) can
// open the slip from the private bucket.
export async function getPaymentSlipUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(SLIP_BUCKET)
    .createSignedUrl(path, 60 * 10); // 10 minutes
  if (error) {
    console.error('[payments] signed url failed:', error);
    return null;
  }
  return data?.signedUrl || null;
}

// Accountant verifies a partner-submitted payment. Flips status to
// 'verified' which makes the recompute trigger include it in
// amount_paid + flips dispatch_approval if fully paid.
// If `adjustedAmount` is passed, the row's amount field is overwritten
// first — useful when the slip shows a different value than what the
// partner claimed.
export async function verifyPayment(paymentId, adjustedAmount) {
  if (!paymentId) throw new Error('paymentId is required');
  const { data: { user } } = await supabase.auth.getUser();

  // Read the payment (order, amount, current status) so we can address the
  // partner mail and detect the pending → verified transition.
  const { data: pay } = await supabase
    .from(TABLE)
    .select('order_id, amount, status')
    .eq('id', paymentId)
    .maybeSingle();
  const alreadyVerified = pay?.status === 'verified';
  const beforeApproval = await readDispatchApproval(pay?.order_id);

  const patch = {
    status:      'verified',
    verified_by: user?.id || null,
    verified_at: new Date().toISOString(),
  };
  if (adjustedAmount !== undefined && adjustedAmount !== null && Number(adjustedAmount) > 0) {
    patch.amount = Number(adjustedAmount);
  }
  const { error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', paymentId);
  if (error) throw error;

  // Only notify on a real transition into verified (not a re-verify no-op).
  if (!alreadyVerified && pay?.order_id) {
    const applied = patch.amount !== undefined ? patch.amount : Number(pay.amount || 0);
    await afterPaymentApplied(pay.order_id, beforeApproval, applied);
  }
}

// Accountant rejects a partner-submitted payment (e.g. wrong slip,
// amount mismatch). Partner sees the note and can re-upload.
export async function rejectPayment(paymentId, note) {
  if (!paymentId)     throw new Error('paymentId is required');
  if (!note?.trim())  throw new Error('Please add a note explaining the rejection');
  const { data: pay } = await supabase
    .from(TABLE)
    .select('order_id')
    .eq('id', paymentId)
    .maybeSingle();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status:         'rejected',
      rejection_note: note.trim(),
    })
    .eq('id', paymentId);
  if (error) throw error;

  // Notify the partner so they can re-upload a correct slip.
  if (pay?.order_id) {
    const party = await loadOrderParty(pay.order_id);
    if (party?.partner?.email) {
      notify('payment_rejected',
        { email: party.partner.email, role: 'partner', userId: party.partner.id },
        { orderShortId: orderShortId(pay.order_id), partnerName: party.partner.name, notes: note.trim() },
        { relatedOrderId: pay.order_id });
    }
  }
}
