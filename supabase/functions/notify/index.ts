// supabase/functions/notify/index.ts
//
// Sends a transactional email via Resend and records every attempt in
// bridgethings_notifications. Invoked from the React app via:
//
//   supabase.functions.invoke('notify', {
//     body: { template, recipient, vars, relatedOrderId? }
//   })
//
// where `recipient` is either { email, name?, userId?, role? } or the
// shorthand string "name@example.com".
//
// Why an Edge Function (not direct from React)?
//   1. Keeps the Resend API key off the client.
//   2. One place to add new templates / change provider later.
//   3. Audit-logs every send so we can debug missing emails and replay
//      failures.
//
// Env vars (Supabase → Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY     re_xxxxxxxx
//   NOTIFY_FROM        "Bridge Things <orders@bridgethings.com>"
//   PORTAL_URL         https://app.bridgethings.com  (used inside templates)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────
// Templates — each is a pure function (vars → {subject, html}). Add a
// new key here and you can fire it from React the same day. Keep them
// short, plain, and link back to the portal so the partner can act.
// ─────────────────────────────────────────────────────────────────────
type TemplateFn = (v: Record<string, any>) => { subject: string; html: string };

const PORTAL_URL = Deno.env.get('PORTAL_URL') || 'https://app.bridgethings.com';

const wrap = (body: string) => `
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#111; max-width:560px; margin:0 auto;">
    <div style="padding:16px 0; border-bottom:1px solid #eee;">
      <strong style="color:#0d6efd;">Bridge Things</strong>
    </div>
    <div style="padding:20px 0; font-size:15px; line-height:1.55;">${body}</div>
    <div style="padding:16px 0; border-top:1px solid #eee; font-size:12px; color:#666;">
      This is an automated message from Bridge Things ERP.
    </div>
  </div>
`;

const templates: Record<string, TemplateFn> = {
  // 1. Admin accepted a PO → partner can now expect production updates.
  po_accepted: (v) => ({
    subject: `Order ${v.orderShortId} confirmed`,
    html: wrap(`
      <p>Hi ${v.partnerName || 'there'},</p>
      <p>Your purchase order <b>${v.orderShortId}</b> has been confirmed.</p>
      ${v.committedDate ? `<p><b>Committed delivery date:</b> ${v.committedDate}</p>` : ''}
      ${v.notes ? `<p><b>Note from our team:</b><br>${escapeHtml(v.notes)}</p>` : ''}
      <p>You can track progress anytime from your portal:</p>
      <p><a href="${PORTAL_URL}/partner/orders" style="background:#0d6efd;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">View Order</a></p>
    `),
  }),
};

// ─────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  // CORS preflight — required so the browser-side supabase-js call works.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { template, recipient, vars = {}, relatedOrderId = null, relatedShipmentId = null } = body || {};
  const rec = normaliseRecipient(recipient);

  if (!template)        return json({ error: 'template is required' }, 400);
  if (!rec?.email)      return json({ error: 'recipient.email is required' }, 400);
  if (!templates[template]) return json({ error: `Unknown template: ${template}` }, 400);

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const NOTIFY_FROM    = Deno.env.get('NOTIFY_FROM') || 'Bridge Things <onboarding@resend.dev>';
  if (!RESEND_API_KEY)  return json({ error: 'RESEND_API_KEY not configured' }, 500);

  // Service-role client — bypasses RLS so we can write the audit row
  // even when the caller's JWT (a partner / employee) wouldn't normally
  // be allowed to insert into bridgethings_notifications.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const rendered = templates[template](vars);

  // Insert audit row up front (status='queued') so even a hard crash
  // mid-send leaves a trace. We update it after the provider responds.
  const { data: logRow, error: logErr } = await admin
    .from('bridgethings_notifications')
    .insert({
      recipient_user_id:   rec.userId || null,
      recipient_email:     rec.email,
      recipient_role:      rec.role || null,
      channel:             'email',
      template,
      subject:             rendered.subject,
      payload:             vars,
      status:              'queued',
      provider:            'resend',
      related_order_id:    relatedOrderId,
      related_shipment_id: relatedShipmentId,
    })
    .select('id')
    .single();
  if (logErr) console.error('[notify] audit insert failed:', logErr);

  // Send via Resend.
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    NOTIFY_FROM,
        to:      [rec.email],
        subject: rendered.subject,
        html:    rendered.html,
      }),
    });
    const result = await res.json();

    if (!res.ok) {
      await markFailed(admin, logRow?.id, result?.message || JSON.stringify(result));
      return json({ ok: false, error: result?.message || 'Resend error', detail: result }, 502);
    }

    await admin
      .from('bridgethings_notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString(), provider_msg_id: result.id || null })
      .eq('id', logRow?.id);
    return json({ ok: true, id: result.id });
  } catch (err) {
    await markFailed(admin, logRow?.id, String(err?.message || err));
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────
function normaliseRecipient(r: any) {
  if (!r) return null;
  if (typeof r === 'string') return { email: r };
  return r;
}

async function markFailed(admin: any, id: string | undefined, error: string) {
  if (!id) return;
  await admin
    .from('bridgethings_notifications')
    .update({ status: 'failed', error })
    .eq('id', id);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: string) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
