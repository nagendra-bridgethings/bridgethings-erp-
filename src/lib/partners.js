// src/lib/partners.js — Shared channel partner data hook.
// Multiple pages (Dashboard, POReceived, Fulfillment, Finance)
// need to display partner.name for a given partner_id. Rather than each one
// running its own query, they all use this hook.
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export function usePartners() {
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    await supabase.auth.getSession(); // Fix race condition before querying
    const { data, error } = await supabase
      .from('bridgethings_channelpartners')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[partners] load failed:', error);
      setError(error);
    } else {
      setPartners(data || []);
      setError(null);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Convenience lookup: find a partner row by its id (auth.users.id).
  const getPartner = (id) => partners.find(p => p.id === id) || null;

  return { partners, loading, error, getPartner, reload: load };
}

// Admin-only helper to set a partner's flat product discount (0-100).
// The DB CHECK constraint enforces the range; we clamp client-side too so
// the UI never sends an obviously bad value.
export async function updatePartnerDiscount(partnerId, percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  // .select() so an RLS-filtered update (0 rows touched, no error) is
  // detectable — without it the UI toasts success while nothing changed.
  const { data, error } = await supabase
    .from('bridgethings_channelpartners')
    .update({ discount_percent: pct })
    .eq('id', partnerId)
    .select('discount_percent');
  if (error) throw error;
  if (!data?.length) throw new Error('Discount update was blocked — no row was changed.');
  return pct;
}
