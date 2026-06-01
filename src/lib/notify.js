// src/lib/notify.js — Fire-and-forget notification helper.
//
// Calls the pure-SQL dispatcher `bridgethings_send_notification` via
// supabase.rpc. Why SQL instead of an Edge Function? Self-hosted
// Supabase makes Edge Function deployment painful (CLI / SSH /
// docker-compose) but RPC functions can be created and updated from
// the SQL editor in seconds.
//
// Usage:
//   await notify('po_accepted', {
//     email:  partner.email,
//     name:   partner.name,
//     userId: partner.id,
//     role:   'partner',
//   }, {
//     orderShortId: 'ORD-1DDDD7CF',
//     partnerName:  'Nagendra',
//     committedDate:'10 Jun 2026',
//   }, { relatedOrderId: order.id });
//
// Errors are logged but NEVER thrown — a missing notification should
// not block the underlying user action. If the email fails, the user
// still gets their PO confirmed; the failure is audited in
// bridgethings_notifications (status='failed').
import { supabase } from './supabase';

export async function notify(template, recipient, vars = {}, opts = {}) {
  try {
    const { data, error } = await supabase.rpc('bridgethings_send_notification', {
      p_template:            template,
      p_recipient_email:     recipient?.email || null,
      p_recipient_user_id:   recipient?.userId || null,
      p_recipient_role:      recipient?.role || null,
      p_vars:                vars,
      p_related_order_id:    opts.relatedOrderId    || null,
      p_related_shipment_id: opts.relatedShipmentId || null,
    });
    if (error) {
      console.error(`[notify] ${template} failed:`, error);
      return { ok: false, error };
    }
    return { ok: true, id: data };
  } catch (err) {
    console.error(`[notify] ${template} threw:`, err);
    return { ok: false, error: err };
  }
}
