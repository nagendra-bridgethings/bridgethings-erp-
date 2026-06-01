// src/lib/notify.js — Thin wrapper around the `notify` Edge Function.
//
// Usage from anywhere in the app:
//
//   await notify('po_accepted', { email, name, userId, role:'partner' }, {
//     orderShortId: 'ORD-1DDDD7CF',
//     partnerName:  'Nagendra',
//     committedDate:'10 Jun 2026',
//   }, { relatedOrderId: order.id });
//
// Failures are logged but never thrown — a missing notification should
// NEVER block the underlying user action (you'd rather have the order
// confirmed and a missed email than a confused user staring at an
// error toast).
import { supabase } from './supabase';

export async function notify(template, recipient, vars = {}, opts = {}) {
  try {
    const { data, error } = await supabase.functions.invoke('notify', {
      body: {
        template,
        recipient,
        vars,
        relatedOrderId:    opts.relatedOrderId    || null,
        relatedShipmentId: opts.relatedShipmentId || null,
      },
    });
    if (error) {
      console.error(`[notify] ${template} failed:`, error);
      return { ok: false, error };
    }
    return data;
  } catch (err) {
    console.error(`[notify] ${template} threw:`, err);
    return { ok: false, error: err };
  }
}
