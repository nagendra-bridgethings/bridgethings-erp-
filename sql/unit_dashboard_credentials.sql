-- ============================================================
-- Dashboard credentials per device unit.
-- ============================================================
-- Accountant captures the username/password they hand off to the partner
-- when activating the first subscription. Stored on the unit row (not on
-- the subscription row) so renewals reuse the same credentials.
--
-- NOTE: these are plain-text credentials for an *external* dashboard
-- system, not for Bridge Things ERP auth. RLS already scopes the row
-- so only the owning partner + staff can see them.
-- ============================================================

ALTER TABLE bridgethings_order_unit_details
  ADD COLUMN IF NOT EXISTS dashboard_username TEXT,
  ADD COLUMN IF NOT EXISTS dashboard_password TEXT;
