-- ============================================================
-- Email notifications — DB layer.
-- ============================================================
-- Architecture (self-hosted Supabase, so NO Edge Functions):
--
--   React mutation
--     └─ supabase.rpc('bridgethings_send_notification', …)   (src/lib/notify.js)
--          └─ SECURITY DEFINER fn:
--               1. resolve recipient(s) — one email, or a whole role group
--                  (admins / accountants / operations / dispatch)
--               2. render subject + body for the named template
--               3. INSERT a 'queued' audit row per recipient
--               4. net.http_post → THE MANAGER'S RELAY API (pg_net, async)
--               5. mark the row 'sent' (or 'failed' on error)
--
-- We do NOT send email ourselves. We POST { subject, body, receiver,
-- sender } to the relay API your manager provides; his side sends it.
-- Sender is always noreply@bridgethings.com.
--
-- Until the relay URL is configured in bridgethings_app_secrets, every
-- send is logged as 'skipped' — so this whole file is SAFE to run and
-- merge before the API exists. Nothing reaches a real inbox until you
-- insert the 'notify_api_url' secret.
--
-- >>> THE ONE PLACE TO EDIT once the manager sends his contract is the
-- >>> net.http_post(...) block near the bottom (URL, auth header, and the
-- >>> JSON field names). Everything else stays the same. <<<
-- ============================================================

-- 1. HTTP-from-Postgres. Idempotent; harmless if already enabled.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 0. Self-heal: if an earlier (since-removed) notifications scaffold was
--    ever run on this DB, drop its differently-shaped dispatcher overload
--    so it can't shadow the new one. (The audit table is healed with an
--    ADD COLUMN below; existing rows are preserved.)
DROP FUNCTION IF EXISTS bridgethings_send_notification(TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID);

-- ────────────────────────────────────────────────────────────────────
-- 2. Private secrets table. RLS on with NO policies = unreadable via
--    PostgREST. Only SECURITY DEFINER functions (running as postgres)
--    can read it. This holds the relay URL + API key + sender + portal.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bridgethings_app_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE bridgethings_app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bridgethings_app_secrets FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 3. Audit log. One row per (recipient, template) send attempt. Gives
--    a "what did we email this partner?" trail + a retry surface
--    (status='failed' rows can be replayed) + dispute proof.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bridgethings_notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  recipient_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_email    TEXT NOT NULL,
  recipient_role     TEXT,   -- 'partner' | 'admin' | 'accountant' | 'operations' | 'dispatch'

  channel         TEXT NOT NULL DEFAULT 'email'
                    CHECK (channel IN ('email','whatsapp','sms','in_app')),
  template        TEXT NOT NULL,           -- e.g. 'po_confirmed'
  subject         TEXT,
  body            TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- vars passed in

  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','failed','skipped')),
  provider        TEXT,                    -- 'relay'
  provider_msg_id TEXT,                    -- pg_net request id (look up net._http_response)
  error           TEXT,

  related_order_id    UUID REFERENCES bridgethings_orders(id) ON DELETE SET NULL,
  related_shipment_id UUID,  -- not FK'd: keep this table append-only safe

  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Heal a pre-existing table from the old scaffold (which lacked `body`).
-- No-op on a freshly-created table.
ALTER TABLE bridgethings_notifications ADD COLUMN IF NOT EXISTS body TEXT;

CREATE INDEX IF NOT EXISTS idx_bt_notifications_recipient ON bridgethings_notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bt_notifications_order     ON bridgethings_notifications(related_order_id);
CREATE INDEX IF NOT EXISTS idx_bt_notifications_status    ON bridgethings_notifications(status) WHERE status IN ('failed','queued');

ALTER TABLE bridgethings_notifications ENABLE ROW LEVEL SECURITY;

-- Admins see everything (debugging + audit).
DROP POLICY IF EXISTS bt_notifications_admin_read ON bridgethings_notifications;
CREATE POLICY bt_notifications_admin_read
  ON bridgethings_notifications FOR SELECT
  USING (bridgethings_current_role() = 'admin');

-- Partners see their own (lets us add an in-portal inbox later for free).
DROP POLICY IF EXISTS bt_notifications_partner_read ON bridgethings_notifications;
CREATE POLICY bt_notifications_partner_read
  ON bridgethings_notifications FOR SELECT
  USING (recipient_user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────
-- 4. Resolve a role group → its members' emails. SECURITY DEFINER so a
--    partner-triggered notification (e.g. "new PO" → admins) can read
--    staff emails it normally couldn't see under RLS.
--    Operations/Dispatch filter on the employees.team column; employees
--    with team IS NULL are intentionally excluded (assign a team to get
--    mail).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bridgethings_group_emails(p_group TEXT)
RETURNS TABLE(email TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.email FROM bridgethings_admins a
    WHERE p_group = 'admins' AND a.email IS NOT NULL
  UNION
  SELECT ac.email FROM bridgethings_accountants ac
    WHERE p_group = 'accountants' AND ac.email IS NOT NULL
  UNION
  SELECT e.email FROM bridgethings_employees e
    WHERE p_group IN ('operations','dispatch')
      AND e.team = p_group
      AND e.email IS NOT NULL;
$$;
-- Not granted to authenticated: only the SECURITY DEFINER dispatcher (and
-- the cron job) call it, and they run as the owner. Keeping it ungranted
-- stops logged-in users from enumerating staff emails directly.
REVOKE ALL ON FUNCTION bridgethings_group_emails(TEXT) FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 5. Template renderer. One IF branch per template. Plain-text bodies
--    for now (the relay may render HTML later — if so, swap the body
--    strings to HTML, no other change needed). Each body links back to
--    the relevant portal page so the recipient can act.
--
--    Var keys read from p_vars (all optional, all TEXT):
--      orderShortId partnerName committedDate proposedDate notes amount
--      balance courier tracking deviceCount productName serial daysLeft
--      docList
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bridgethings_render_notification(
  p_template   TEXT,
  p_vars       JSONB,
  p_portal_url TEXT,
  OUT v_subject TEXT,
  OUT v_body    TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- Convenience locals (NULL-safe).
  ord    TEXT := COALESCE(p_vars->>'orderShortId', '');
  who    TEXT := COALESCE(p_vars->>'partnerName', 'there');
  amt    TEXT := COALESCE(p_vars->>'amount', '');
  bal    TEXT := COALESCE(p_vars->>'balance', '');
  note   TEXT := COALESCE(p_vars->>'notes', '');
  eml    TEXT := COALESCE(p_vars->>'partnerEmail', '');
  url    TEXT := p_portal_url;
  -- " (partner@email)" suffix for staff mails so accounts/admin can see
  -- exactly which partner an internal notification is about.
  who_e  TEXT := COALESCE(p_vars->>'partnerName', 'A partner')
                 || CASE WHEN COALESCE(p_vars->>'partnerEmail','') <> ''
                         THEN ' (' || (p_vars->>'partnerEmail') || ')' ELSE '' END;
BEGIN
  IF p_template = 'po_submitted' THEN
    v_subject := 'New PO ORD-' || ord || ' from ' || who;
    v_body := 'A new purchase order (ORD-' || ord || ') has been submitted by ' || who_e || '.' ||
              E'\n\nReview it here: ' || url || '/admin/po-received';

  ELSIF p_template = 'po_confirmed' THEN
    v_subject := 'Your order ORD-' || ord || ' is confirmed';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nYour purchase order ORD-' || ord || ' has been confirmed.' ||
              CASE WHEN COALESCE(p_vars->>'committedDate','') <> ''
                   THEN E'\nCommitted delivery date: ' || (p_vars->>'committedDate') ELSE '' END ||
              CASE WHEN note <> '' THEN E'\nNote from our team: ' || note ELSE '' END ||
              E'\n\nTrack progress: ' || url || '/partner/orders';

  ELSIF p_template = 'po_rejected' THEN
    v_subject := 'Order ORD-' || ord || ' could not be accepted';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nUnfortunately your purchase order ORD-' || ord || ' was not accepted.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\nView details: ' || url || '/partner/po';

  ELSIF p_template = 'delivery_counter' THEN
    v_subject := 'New delivery date proposed for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe have proposed a new delivery date for ORD-' || ord || ': ' ||
              COALESCE(p_vars->>'proposedDate','') || '.' ||
              CASE WHEN note <> '' THEN E'\nNote: ' || note ELSE '' END ||
              E'\n\nAccept or decline it here: ' || url || '/partner/po';

  ELSIF p_template = 'counter_accepted' THEN
    v_subject := who || ' accepted the delivery date for ORD-' || ord;
    v_body := who_e || ' accepted the proposed delivery date for ORD-' || ord ||
              '. The order is now active.' ||
              E'\n\n' || url || '/admin/po-received';

  ELSIF p_template = 'counter_declined' THEN
    v_subject := who || ' declined the delivery date for ORD-' || ord;
    v_body := who_e || ' declined the proposed delivery date for ORD-' || ord ||
              '. The order has been rejected.' ||
              E'\n\n' || url || '/admin/po-received';

  ELSIF p_template = 'payment_submitted' THEN
    v_subject := 'Payment proof submitted for ORD-' || ord ||
                 CASE WHEN amt <> '' THEN ' (Rs ' || amt || ')' ELSE '' END;
    v_body := who_e || ' submitted a payment' ||
              CASE WHEN amt <> '' THEN ' of Rs ' || amt ELSE '' END ||
              ' for ORD-' || ord || ' awaiting verification.' ||
              E'\n\nVerify it here: ' || url || '/finance';

  ELSIF p_template = 'payment_verified' THEN
    v_subject := 'Payment received for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe have recorded your payment' ||
              CASE WHEN amt <> '' THEN ' of Rs ' || amt ELSE '' END ||
              ' for ORD-' || ord || '.' ||
              CASE WHEN bal <> '' THEN E'\nOutstanding balance: Rs ' || bal ELSE '' END ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'payment_rejected' THEN
    v_subject := 'Action needed: payment for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nThe payment you submitted for ORD-' || ord ||
              ' could not be verified.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\nPlease re-upload from your portal: ' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_approved' THEN
    v_subject := 'ORD-' || ord || ' cleared — production starting';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nGood news — ORD-' || ord ||
              ' has been cleared for dispatch and production will begin shortly.' ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_rejected' THEN
    v_subject := 'ORD-' || ord || ' on hold — balance due';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nORD-' || ord || ' is on hold pending payment.' ||
              CASE WHEN note <> '' THEN E'\nDetails: ' || note ELSE '' END ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_pending' THEN
    -- Partial payment verified → order is waiting on the admin to approve
    -- (or reject) dispatch before production can start.
    v_subject := 'ORD-' || ord || ' awaiting your dispatch approval';
    v_body := who_e || ' made a partial payment on ORD-' || ord || '.' ||
              CASE WHEN amt <> '' THEN E'\nPaid so far: Rs ' || amt ELSE '' END ||
              CASE WHEN bal <> '' THEN E'\nOutstanding: Rs ' || bal ELSE '' END ||
              E'\n\nApprove or reject dispatch on your dashboard: ' || url || '/admin';

  ELSIF p_template = 'production_ready' THEN
    v_subject := 'ORD-' || ord || ' ready to produce';
    v_body := 'Payment has cleared for ORD-' || ord || ' (' || who || ').' ||
              ' Units are ready to move into production.' ||
              E'\n\n' || url || '/operations/fulfillment';

  ELSIF p_template = 'units_ready_dispatch' THEN
    v_subject := 'Units ready to verify — ORD-' || ord;
    v_body := 'Operations marked units on ORD-' || ord || ' (' || who || ')' ||
              ' ready to dispatch. Please verify and ship.' ||
              E'\n\n' || url || '/dispatch/fulfillment';

  ELSIF p_template = 'units_sent_back' THEN
    v_subject := 'Units returned by dispatch — ORD-' || ord;
    v_body := 'Dispatch sent units on ORD-' || ord || ' back to operations.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\n' || url || '/operations/fulfillment';

  ELSIF p_template = 'docs_requested' THEN
    v_subject := 'Documents needed for your ORD-' || ord || ' shipment';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe need the following document(s) to ship part of ORD-' || ord || ': ' ||
              COALESCE(p_vars->>'docList','the requested documents') || '.' ||
              E'\n\nPlease upload them here: ' || url || '/partner/orders';

  ELSIF p_template = 'docs_submitted' THEN
    v_subject := 'Partner docs received — ORD-' || ord || ' ready to ship';
    v_body := who || ' uploaded all requested documents for an ORD-' || ord ||
              ' shipment. It is ready to ship.' ||
              E'\n\n' || url || '/dispatch/fulfillment';

  ELSIF p_template = 'shipment_dispatched' THEN
    v_subject := 'Your ORD-' || ord || ' has shipped';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA parcel for ORD-' || ord || ' has shipped' ||
              CASE WHEN COALESCE(p_vars->>'courier','') <> ''
                   THEN ' via ' || (p_vars->>'courier') ELSE '' END || '.' ||
              CASE WHEN COALESCE(p_vars->>'tracking','') <> ''
                   THEN E'\nTracking: ' || (p_vars->>'tracking') ELSE '' END ||
              E'\n\nTrack it: ' || url || '/partner/orders';

  ELSIF p_template = 'shipment_delivered' THEN
    v_subject := 'Your ORD-' || ord || ' was delivered';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA parcel for ORD-' || ord || ' has been delivered. Thank you!' ||
              E'\n\n' || url || '/partner/devices';

  ELSIF p_template = 'sub_requested' THEN
    v_subject := 'Subscription request from ' || who;
    v_body := who_e || ' requested dashboard subscriptions for ' ||
              COALESCE(p_vars->>'deviceCount','one or more') || ' device(s).' ||
              ' Approve once payment is received.' ||
              E'\n\n' || url || '/finance/subscriptions';

  ELSIF p_template = 'sub_activated' THEN
    v_subject := 'Your device subscription is active';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA dashboard subscription is now active' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' for ' || (p_vars->>'productName') ELSE '' END ||
              CASE WHEN COALESCE(p_vars->>'serial','') <> ''
                   THEN ' (SN ' || (p_vars->>'serial') || ')' ELSE '' END || '.' ||
              E'\n\nView your devices: ' || url || '/partner/devices';

  ELSIF p_template = 'sub_expiring' THEN
    v_subject := 'Your subscription expires in ' || COALESCE(p_vars->>'daysLeft','a few') || ' days';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nYour dashboard subscription' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' for ' || (p_vars->>'productName') ELSE '' END ||
              CASE WHEN COALESCE(p_vars->>'serial','') <> ''
                   THEN ' (SN ' || (p_vars->>'serial') || ')' ELSE '' END ||
              ' expires in ' || COALESCE(p_vars->>'daysLeft','a few') || ' days.' ||
              E'\n\nRenew it here: ' || url || '/partner/devices';

  ELSIF p_template = 'sub_cancelled' THEN
    v_subject := 'Your device subscription was cancelled';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA dashboard subscription has been cancelled.' ||
              ' If this was unexpected, please get in touch.' ||
              E'\n\n' || url || '/partner/devices';

  ELSE
    RAISE EXCEPTION 'Unknown notification template: %', p_template;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 6a. Internal single-recipient delivery: render → audit → POST. No auth
--     check here (callers gate). Reused by the RPC dispatcher AND by the
--     pg_cron expiry job, so the actual HTTP call lives in exactly one
--     place. NOT granted to anon/authenticated — only other SECURITY
--     DEFINER functions can call it.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bridgethings__deliver_email(
  p_template            TEXT,
  p_email               TEXT,
  p_role                TEXT,
  p_user_id             UUID,
  p_vars                JSONB,
  p_related_order_id    UUID,
  p_related_shipment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_api_url    TEXT;
  v_api_key    TEXT;
  v_from       TEXT;
  v_portal_url TEXT;
  v_subject    TEXT;
  v_body       TEXT;
  v_log_id     UUID;
  v_request_id BIGINT;
  v_headers    JSONB;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN RETURN; END IF;

  SELECT value INTO v_api_url    FROM bridgethings_app_secrets WHERE key = 'notify_api_url';
  SELECT value INTO v_api_key    FROM bridgethings_app_secrets WHERE key = 'notify_api_key';
  SELECT value INTO v_from       FROM bridgethings_app_secrets WHERE key = 'notify_from';
  SELECT value INTO v_portal_url FROM bridgethings_app_secrets WHERE key = 'portal_url';
  v_from       := COALESCE(v_from, 'noreply@bridgethings.com');
  v_portal_url := COALESCE(v_portal_url, 'https://nagendra-bridgethings.github.io/bridgethings-erp-');

  SELECT r.v_subject, r.v_body INTO v_subject, v_body
    FROM bridgethings_render_notification(p_template, p_vars, v_portal_url) AS r;

  -- Audit row first (a crash still leaves a trace).
  INSERT INTO bridgethings_notifications (
    recipient_user_id, recipient_email, recipient_role,
    channel, template, subject, body, payload,
    status, provider, related_order_id, related_shipment_id
  ) VALUES (
    p_user_id, p_email, p_role,
    'email', p_template, v_subject, v_body, p_vars,
    CASE WHEN v_api_url IS NULL THEN 'skipped' ELSE 'queued' END,
    'relay', p_related_order_id, p_related_shipment_id
  )
  RETURNING id INTO v_log_id;

  IF v_api_url IS NULL THEN
    UPDATE bridgethings_notifications
      SET error = 'notify_api_url not configured' WHERE id = v_log_id;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- >>> THE ONE BLOCK TO EDIT FOR THE MANAGER'S API <<<
  -- Configured for the Bridge Things relay (AWS API Gateway):
  --   POST <notify_api_url>   e.g. https://…amazonaws.com/dev/send
  --   body { subject, body, receiver }   ← sender is hardcoded on the relay
  --   no auth header by default (open endpoint). If the relay later adds a
  --   key, set the notify_api_key secret and it's sent as Bearer below.
  -- ═══════════════════════════════════════════════════════════════════
  v_headers := jsonb_build_object('Content-Type', 'application/json');
  IF v_api_key IS NOT NULL THEN
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_api_key);
  END IF;

  -- Wrap ONLY the network call in the exception scope. A caught exception
  -- in PL/pgSQL rolls back every change made inside its block — so the
  -- audit INSERT above MUST stay outside this sub-block, otherwise a
  -- failed send would roll the row away and the 'failed' UPDATE below
  -- would match nothing.
  BEGIN
    SELECT net.http_post(
      url     := v_api_url,
      headers := v_headers,
      body    := jsonb_build_object(
        'subject',  v_subject,
        'body',     v_body,
        'receiver', p_email
      )
    ) INTO v_request_id;

    UPDATE bridgethings_notifications
      SET status = 'sent', sent_at = NOW(), provider_msg_id = v_request_id::TEXT
      WHERE id = v_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE bridgethings_notifications
      SET status = 'failed', error = SQLERRM WHERE id = v_log_id;
  END;
END;
$$;
REVOKE ALL ON FUNCTION bridgethings__deliver_email(TEXT, TEXT, TEXT, UUID, JSONB, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 6b. The RPC dispatcher (called from src/lib/notify.js). Auth-gates,
--     resolves recipients (one email or a whole role group), then hands
--     each off to bridgethings__deliver_email. Returns recipient count.
--     Call with EITHER p_recipient_email OR p_recipient_group
--     ('admins'|'accountants'|'operations'|'dispatch').
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bridgethings_send_notification(
  p_template            TEXT,
  p_recipient_email     TEXT    DEFAULT NULL,
  p_recipient_group     TEXT    DEFAULT NULL,
  p_recipient_user_id   UUID    DEFAULT NULL,
  p_recipient_role      TEXT    DEFAULT NULL,
  p_vars                JSONB   DEFAULT '{}'::jsonb,
  p_related_order_id    UUID    DEFAULT NULL,
  p_related_shipment_id UUID    DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emails TEXT[];
  v_email  TEXT;
  v_role   TEXT := COALESCE(p_recipient_role, p_recipient_group);
  v_count  INT  := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF p_recipient_email IS NOT NULL AND p_recipient_email <> '' THEN
    v_emails := ARRAY[p_recipient_email];
  ELSIF p_recipient_group IS NOT NULL THEN
    SELECT array_agg(DISTINCT email) INTO v_emails
    FROM bridgethings_group_emails(p_recipient_group);
  END IF;

  IF v_emails IS NULL OR array_length(v_emails, 1) IS NULL THEN
    RETURN 0;  -- nobody to notify (e.g. a team with no members yet)
  END IF;

  FOREACH v_email IN ARRAY v_emails LOOP
    PERFORM bridgethings__deliver_email(
      p_template, v_email, v_role, p_recipient_user_id,
      p_vars, p_related_order_id, p_related_shipment_id
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION bridgethings_send_notification(
  TEXT, TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bridgethings_send_notification(
  TEXT, TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID
) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 7. Subscription-expiry reminders (catalog #21). No user action fires
--    these, so a daily pg_cron job sweeps for active subscriptions whose
--    LATEST coverage ends in exactly 30 / 7 / 1 day(s) and mails the
--    partner. Exact-day matching means each device gets at most three
--    nudges total, never a daily spam.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bridgethings_notify_expiring_subscriptions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  r       RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    WITH latest AS (
      -- The most-recent subscription row per unit (renewals are new rows).
      SELECT DISTINCT ON (s.unit_id) s.unit_id, s.end_date, s.status
      FROM bridgethings_unit_subscriptions s
      ORDER BY s.unit_id, s.end_date DESC
    )
    SELECT u.id            AS unit_id,
           u.serial_number AS serial,
           p.name          AS product_name,
           o.id            AS order_id,
           cp.id           AS partner_id,
           cp.email        AS partner_email,
           cp.name         AS partner_name,
           (l.end_date - CURRENT_DATE) AS days_left
    FROM latest l
    JOIN bridgethings_order_unit_details u  ON u.id = l.unit_id
    JOIN bridgethings_order_items        oi ON oi.id = u.order_item_id
    JOIN bridgethings_orders             o  ON o.id = oi.order_id
    JOIN bridgethings_channelpartners    cp ON cp.id = o.partner_id
    LEFT JOIN bridgethings_products      p  ON p.id = oi.product_id
    WHERE l.status = 'active'
      AND (l.end_date - CURRENT_DATE) IN (30, 7, 1)
      AND cp.email IS NOT NULL
  LOOP
    PERFORM bridgethings__deliver_email(
      'sub_expiring', r.partner_email, 'partner', r.partner_id,
      jsonb_build_object(
        'partnerName', r.partner_name,
        'productName', COALESCE(r.product_name, ''),
        'serial',      COALESCE(r.serial, ''),
        'daysLeft',    r.days_left::TEXT
      ),
      r.order_id, NULL
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Schedule it daily at 04:00. pg_cron may not be installed on every
-- self-hosted Supabase — if `CREATE EXTENSION pg_cron` fails, either
-- enable it (shared_preload_libraries) or call the function from any
-- external scheduler (cron/n8n) that can run one SQL statement a day:
--     SELECT bridgethings_notify_expiring_subscriptions();
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  -- Replace any prior schedule with the same name (idempotent re-runs).
  BEGIN PERFORM cron.unschedule('bridgethings-sub-expiry'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule(
    'bridgethings-sub-expiry',
    '0 4 * * *',
    $cron$ SELECT bridgethings_notify_expiring_subscriptions(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available (%); schedule bridgethings_notify_expiring_subscriptions() externally.', SQLERRM;
END $$;

-- ============================================================
-- 8. Configure the relay (run once the manager sends his API).
--    Until these rows exist, sends are logged 'skipped' (safe).
-- ============================================================
--   INSERT INTO bridgethings_app_secrets (key, value) VALUES
--     ('notify_api_url', 'https://relay.example.com/send'),
--     ('notify_api_key', 'the-key-he-gives-you'),
--     ('notify_from',    'noreply@bridgethings.com'),
--     ('portal_url',     'https://nagendra-bridgethings.github.io/bridgethings-erp-')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
