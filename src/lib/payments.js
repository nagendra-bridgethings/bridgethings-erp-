// src/lib/payments.js — Multi-instalment payments per PO.
//
// Each row in bridgethings_order_payments is one payment received from
// the partner. A DB trigger keeps orders.amount_paid + payment_status in
// sync whenever rows here change, so callers only need to insert/delete
// payment rows — the order totals update automatically.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

const TABLE = 'bridgethings_order_payments';
const SLIP_BUCKET = 'bridgethings-payment-slips';

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
}

// Accountant rejects a partner-submitted payment (e.g. wrong slip,
// amount mismatch). Partner sees the note and can re-upload.
export async function rejectPayment(paymentId, note) {
  if (!paymentId)     throw new Error('paymentId is required');
  if (!note?.trim())  throw new Error('Please add a note explaining the rejection');
  const { error } = await supabase
    .from(TABLE)
    .update({
      status:         'rejected',
      rejection_note: note.trim(),
    })
    .eq('id', paymentId);
  if (error) throw error;
}
