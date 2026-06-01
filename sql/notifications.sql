-- ============================================================
-- Notifications audit log.
-- ============================================================
-- Every outbound email (later: WhatsApp, SMS, in-app) is recorded
-- here BEFORE it leaves the Edge Function, then updated with the
-- provider response. Gives us:
--   • a chronological feed of "what did the system tell this partner?"
--   • a retry surface for failed sends (status='failed' rows can be
--     replayed by re-invoking the function with the same payload)
--   • proof of delivery during partner disputes ("we emailed you on X")
--
-- Writes happen exclusively from the `notify` Edge Function using the
-- service-role key, so no INSERT policy is needed for end-users.
-- Reads are scoped:
--   • admins         — see everything (debugging + audit)
--   • partners       — see their own rows (so the portal can show a
--                       Notifications inbox later if we want)
-- ============================================================

CREATE TABLE IF NOT EXISTS bridgethings_notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Who/what this notification is about. recipient_user_id is nullable
  -- because internal notifications (e.g. "new PO arrived" to admins)
  -- may target a role rather than a specific user.
  recipient_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_email    TEXT NOT NULL,
  recipient_role     TEXT,   -- 'partner' | 'admin' | 'employee' | 'accountant'

  -- What was sent.
  channel         TEXT NOT NULL DEFAULT 'email'
                    CHECK (channel IN ('email','whatsapp','sms','in_app')),
  template        TEXT NOT NULL,           -- e.g. 'po_accepted', 'shipment_dispatched'
  subject         TEXT,                    -- rendered subject (email only)
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the vars passed to the template

  -- What happened.
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','failed','skipped')),
  provider        TEXT,                    -- 'resend' (later: 'twilio', etc.)
  provider_msg_id TEXT,                    -- id returned by Resend, used for webhooks later
  error           TEXT,                    -- last error message if status='failed'

  -- Optional context — link the notification back to the entity it's about
  -- so the future inbox UI can deep-link ("View order ORD-XXXX").
  related_order_id    UUID REFERENCES bridgethings_orders(id) ON DELETE SET NULL,
  related_shipment_id UUID,  -- intentionally not FK'd to keep this table append-only safe

  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON bridgethings_notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_order     ON bridgethings_notifications(related_order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status    ON bridgethings_notifications(status) WHERE status IN ('failed','queued');

ALTER TABLE bridgethings_notifications ENABLE ROW LEVEL SECURITY;

-- Admins: see everything.
DROP POLICY IF EXISTS notifications_admin_read ON bridgethings_notifications;
CREATE POLICY notifications_admin_read
  ON bridgethings_notifications
  FOR SELECT
  USING (bridgethings_current_role() = 'admin');

-- Partners: see their own (lets us add a Notifications inbox later
-- without a second migration).
DROP POLICY IF EXISTS notifications_partner_read ON bridgethings_notifications;
CREATE POLICY notifications_partner_read
  ON bridgethings_notifications
  FOR SELECT
  USING (recipient_user_id = auth.uid());
