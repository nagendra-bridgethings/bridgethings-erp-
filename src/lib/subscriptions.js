// src/lib/subscriptions.js — Per-device dashboard subscriptions.
//
// Every physical unit shipped (a row in bridgethings_order_unit_details)
// needs its own dashboard subscription. Default plan is 1-year coverage
// from the start_date. Renewals are new rows so the table is the full
// payment history for each unit.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

const TABLE = 'bridgethings_unit_subscriptions';

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
export function latestSubFor(subs) {
  if (!subs?.length) return null;
  return [...subs].sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''))[0];
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
  return data;
}

// Admin can cancel a subscription (mistake, refund, etc.). The row stays
// for the audit trail; UI just stops counting it.
export async function cancelSubscription(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
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
  return data;
}

// Set/update the external dashboard credentials on a unit. Captured by
// Accounts at first activation and reused across renewals (we don't ask
// again — same login keeps working). Edit later only if a partner needs
// a reset.
export async function setDashboardCredentials(unitId, { username, password }) {
  if (!unitId) throw new Error('unitId is required');
  const { error } = await supabase
    .from('bridgethings_order_unit_details')
    .update({
      dashboard_username: username?.trim() || null,
      dashboard_password: password || null,
      updated_at:         new Date().toISOString(),
    })
    .eq('id', unitId);
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
  return data;
}
