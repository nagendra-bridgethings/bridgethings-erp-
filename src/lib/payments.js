// src/lib/payments.js — Multi-instalment payments per PO.
//
// Each row in bridgethings_order_payments is one payment received from
// the partner. A DB trigger keeps orders.amount_paid + payment_status in
// sync whenever rows here change, so callers only need to insert/delete
// payment rows — the order totals update automatically.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

const TABLE = 'bridgethings_order_payments';

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
