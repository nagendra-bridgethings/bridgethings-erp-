-- ============================================================
-- Pure-SQL notification dispatcher.
-- ============================================================
-- Instead of an Edge Function (which would need CLI / SSH access we
-- don't have on this self-hosted Supabase), we send emails directly
-- from Postgres using the `pg_net` extension. Same audit table
-- (bridgethings_notifications), same React call site — only the
-- transport changes.
--
-- Architecture:
--   React  →  supabase.rpc('bridgethings_send_notification', ...)
--             └─→ SECURITY DEFINER function:
--                   1. Loads secrets from bridgethings_app_secrets
--                   2. Renders the named template
--                   3. Inserts a 'queued' row in bridgethings_notifications
--                   4. Calls net.http_post → Resend
--                   5. Marks row 'sent' (or 'failed' on exception)
--
-- pg_net is async: the HTTP request runs in the background; the SQL
-- function returns immediately. That means the caller never blocks
-- on the network even if Resend is slow — perfect for a
-- fire-and-forget notification.
-- ============================================================

-- 1. Enable pg_net (HTTP from Postgres). Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Private secrets table. RLS enabled with NO policies = nobody can
--    read it via PostgREST. Only SECURITY DEFINER functions running
--    as postgres can SELECT from it.
CREATE TABLE IF NOT EXISTS bridgethings_app_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE bridgethings_app_secrets ENABLE ROW LEVEL SECURITY;

-- Lock down direct access. We deliberately do NOT GRANT to authenticated
-- or anon — secrets must only flow through SECURITY DEFINER helpers.
REVOKE ALL ON bridgethings_app_secrets FROM PUBLIC, anon, authenticated;

-- 3. The dispatcher. Renders + sends + audits.
CREATE OR REPLACE FUNCTION bridgethings_send_notification(
  p_template            TEXT,
  p_recipient_email     TEXT,
  p_recipient_user_id   UUID    DEFAULT NULL,
  p_recipient_role      TEXT    DEFAULT NULL,
  p_vars                JSONB   DEFAULT '{}'::jsonb,
  p_related_order_id    UUID    DEFAULT NULL,
  p_related_shipment_id UUID    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_api_key    TEXT;
  v_from       TEXT;
  v_portal_url TEXT;
  v_subject    TEXT;
  v_html       TEXT;
  v_log_id     UUID;
  v_request_id BIGINT;
BEGIN
  -- Reject anonymous callers — only signed-in app users may send.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- Load secrets. resend_api_key is required; the others have fallbacks.
  SELECT value INTO v_api_key    FROM bridgethings_app_secrets WHERE key = 'resend_api_key';
  SELECT value INTO v_from       FROM bridgethings_app_secrets WHERE key = 'notify_from';
  SELECT value INTO v_portal_url FROM bridgethings_app_secrets WHERE key = 'portal_url';

  v_from       := COALESCE(v_from,       'Bridge Things <onboarding@resend.dev>');
  v_portal_url := COALESCE(v_portal_url, 'https://nagendra-bridgethings.github.io/bridgethings-erp-');

  IF v_api_key IS NULL THEN
    -- Skip silently (logged) so the calling business operation doesn't
    -- explode just because email isn't configured yet.
    INSERT INTO bridgethings_notifications (
      recipient_user_id, recipient_email, recipient_role,
      channel, template, subject, payload,
      status, error,
      related_order_id, related_shipment_id
    ) VALUES (
      p_recipient_user_id, p_recipient_email, p_recipient_role,
      'email', p_template, NULL, p_vars,
      'skipped', 'resend_api_key not configured',
      p_related_order_id, p_related_shipment_id
    ) RETURNING id INTO v_log_id;
    RETURN v_log_id;
  END IF;

  -- ─── Template rendering ─────────────────────────────────────────────
  -- Each new template adds one IF branch here. Keep them small and link
  -- back to the portal so the recipient can act on the message.
  IF p_template = 'po_accepted' THEN
    v_subject := 'Order ' || COALESCE(p_vars->>'orderShortId', '') || ' confirmed';
    v_html :=
      '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px;margin:0 auto;">'
      || '<div style="padding:16px 0;border-bottom:1px solid #eee;"><strong style="color:#0d6efd;">Bridge Things</strong></div>'
      || '<div style="padding:20px 0;font-size:15px;line-height:1.55;">'
      || '<p>Hi ' || COALESCE(p_vars->>'partnerName', 'there') || ',</p>'
      || '<p>Your purchase order <b>' || COALESCE(p_vars->>'orderShortId', '') || '</b> has been confirmed.</p>'
      || CASE WHEN COALESCE(p_vars->>'committedDate', '') <> ''
              THEN '<p><b>Committed delivery date:</b> ' || (p_vars->>'committedDate') || '</p>'
              ELSE '' END
      || CASE WHEN COALESCE(p_vars->>'notes', '') <> ''
              THEN '<p><b>Note from our team:</b><br>' || (p_vars->>'notes') || '</p>'
              ELSE '' END
      || '<p>You can track progress anytime from your portal:</p>'
      || '<p><a href="' || v_portal_url || '/partner/orders" style="background:#0d6efd;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">View Order</a></p>'
      || '</div>'
      || '<div style="padding:16px 0;border-top:1px solid #eee;font-size:12px;color:#666;">This is an automated message from Bridge Things ERP.</div>'
      || '</div>';
  ELSE
    RAISE EXCEPTION 'Unknown template: %', p_template;
  END IF;

  -- ─── Audit row (queued) ─────────────────────────────────────────────
  INSERT INTO bridgethings_notifications (
    recipient_user_id, recipient_email, recipient_role,
    channel, template, subject, payload,
    status, provider,
    related_order_id, related_shipment_id
  ) VALUES (
    p_recipient_user_id, p_recipient_email, p_recipient_role,
    'email', p_template, v_subject, p_vars,
    'queued', 'resend',
    p_related_order_id, p_related_shipment_id
  )
  RETURNING id INTO v_log_id;

  -- ─── Fire HTTP request via pg_net (async) ───────────────────────────
  SELECT net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',    v_from,
      'to',      jsonb_build_array(p_recipient_email),
      'subject', v_subject,
      'html',    v_html
    )
  )
  INTO v_request_id;

  -- pg_net is fire-and-forget — we don't get a delivery confirmation
  -- synchronously. Store the request_id (you can look up the actual
  -- response in net._http_response WHERE id = request_id later if you
  -- want to harden this into a real delivery tracker).
  UPDATE bridgethings_notifications
  SET    status          = 'sent',
         sent_at         = NOW(),
         provider_msg_id = v_request_id::TEXT
  WHERE  id = v_log_id;

  RETURN v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- A failure here must NOT roll back the caller's business operation
  -- (e.g. accepting a PO). Record the error and return.
  IF v_log_id IS NOT NULL THEN
    UPDATE bridgethings_notifications
    SET    status = 'failed',
           error  = SQLERRM
    WHERE  id = v_log_id;
  END IF;
  RETURN v_log_id;
END;
$$;

-- Let any signed-in app user fire a notification — the function checks
-- auth.uid() at the top, so anonymous callers are rejected.
REVOKE ALL ON FUNCTION bridgethings_send_notification(
  TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bridgethings_send_notification(
  TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID
) TO authenticated;
