// src/lib/notify.js — Fire-and-forget email notifications.
//
// Calls the pure-SQL dispatcher `bridgethings_send_notification` via
// supabase.rpc. The dispatcher renders the named template, logs an
// audit row, and POSTs { subject, body, receiver, sender } to the
// company relay API (configured in bridgethings_app_secrets). Self-
// hosted Supabase makes Edge Functions painful, so all of this lives
// in SQL — see sql/notifications.sql.
//
// Errors are logged but NEVER thrown. A failed notification must not
// break the business action that triggered it (confirming a PO,
// verifying a payment, …). Until the relay URL is configured the
// dispatcher just logs every send as 'skipped', so calling notify()
// is always safe.
//
// Two ways to address a notification — pass EXACTLY ONE:
//   • email — a single explicit address (partner-facing mails)
//   • group — a staff role group the dispatcher expands server-side:
//             'admins' | 'accountants' | 'operations' | 'dispatch'
//
// Usage:
//   notify('po_confirmed', { email: partner.email, role: 'partner', userId: partner.id },
//          { orderShortId, partnerName, committedDate });
//   notify('po_submitted', { group: 'admins' },
//          { orderShortId, partnerName }, { relatedOrderId: order.id });
import { supabase } from './supabase';

// Format a UUID the same way the UI does everywhere: ORD-XXXXXXXX.
export const orderShortId = (id) => (id ? id.slice(0, 8).toUpperCase() : '');

// Format a number as an Indian-locale amount string for email bodies.
export const fmtAmount = (n) =>
  Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Format a YYYY-MM-DD / ISO date the way the portal shows it (10 Jun 2026).
export const fmtDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return String(iso); }
};

// Resolve an order's channel-partner (email + name + id) so a data-layer
// function that only has an orderId can address a partner-facing mail.
// RLS lets each caller read the partner they're acting on (staff read all,
// the partner reads their own row). Returns null on any failure — callers
// guard on the result so notifications never break the business action.
export async function loadOrderParty(orderId) {
  if (!orderId) return null;
  try {
    const { data, error } = await supabase
      .from('bridgethings_orders')
      .select('id, partner_id, partner:bridgethings_channelpartners(id, email, name)')
      .eq('id', orderId)
      .single();
    if (error) { console.error('[notify] loadOrderParty failed:', error.message); return null; }
    return data;
  } catch (err) {
    console.error('[notify] loadOrderParty threw:', err);
    return null;
  }
}

/**
 * notify(template, recipient, vars, opts)
 *   recipient: { email?, group?, role?, userId? }
 *   vars:      template variables (plain object, all stringifiable)
 *   opts:      { relatedOrderId?, relatedShipmentId? }
 * Returns { ok, count } — never throws.
 */
export async function notify(template, recipient = {}, vars = {}, opts = {}) {
  try {
    const { data, error } = await supabase.rpc('bridgethings_send_notification', {
      p_template:            template,
      p_recipient_email:     recipient.email  || null,
      p_recipient_group:     recipient.group  || null,
      p_recipient_user_id:   recipient.userId || null,
      p_recipient_role:      recipient.role   || recipient.group || null,
      p_vars:                vars || {},
      p_related_order_id:    opts.relatedOrderId    || null,
      p_related_shipment_id: opts.relatedShipmentId || null,
    });
    if (error) {
      console.error(`[notify] ${template} failed:`, error.message);
      return { ok: false, error };
    }
    return { ok: true, count: data ?? 0 };
  } catch (err) {
    console.error(`[notify] ${template} threw:`, err);
    return { ok: false, error: err };
  }
}
