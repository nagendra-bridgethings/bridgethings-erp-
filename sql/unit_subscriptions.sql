-- ============================================================
-- Per-unit dashboard subscriptions
-- ============================================================
-- One subscription row = one physical device gets dashboard access for one
-- year from start_date. Renewals are new rows so we keep full history.
--
-- Links to bridgethings_order_unit_details (the live per-unit tracking
-- table), NOT the legacy bridgethings_devices table.
-- ============================================================

-- 1. Per-product subscription price (₹/year). Admin sets this in Products UI.
ALTER TABLE bridgethings_products
  ADD COLUMN IF NOT EXISTS subscription_price NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 2. Subscriptions table — one row per (unit, year-of-coverage).
CREATE TABLE IF NOT EXISTS bridgethings_unit_subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id         UUID NOT NULL REFERENCES bridgethings_order_unit_details(id) ON DELETE CASCADE,
  start_date      DATE NOT NULL,
  -- 1-year validity from start_date. Stored (not generated) so admins can
  -- override for multi-year plans later.
  end_date        DATE NOT NULL,
  amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_date    DATE,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('pending','active','cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by      UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_unit_subs_unit    ON bridgethings_unit_subscriptions(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_subs_end     ON bridgethings_unit_subscriptions(end_date);
CREATE INDEX IF NOT EXISTS idx_unit_subs_status  ON bridgethings_unit_subscriptions(status);

ALTER TABLE bridgethings_unit_subscriptions ENABLE ROW LEVEL SECURITY;

-- Clean up old policies (idempotent re-run)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies WHERE tablename = 'bridgethings_unit_subscriptions'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON bridgethings_unit_subscriptions', r.policyname);
  END LOOP;
END $$;

-- Partner can read subscriptions for units in their own orders.
CREATE POLICY "bridgethings_unit_subs_partner_read"
  ON bridgethings_unit_subscriptions FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM bridgethings_order_unit_details u
      JOIN bridgethings_order_items oi ON oi.id = u.order_item_id
      JOIN bridgethings_orders o       ON o.id  = oi.order_id
      WHERE u.id = bridgethings_unit_subscriptions.unit_id
        AND o.partner_id = auth.uid()
    )
  );

-- Staff (admin/employee/accountant) can read everything.
CREATE POLICY "bridgethings_unit_subs_staff_read"
  ON bridgethings_unit_subscriptions FOR SELECT
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

-- Admin/employee can create / update / delete.
CREATE POLICY "bridgethings_unit_subs_staff_insert"
  ON bridgethings_unit_subscriptions FOR INSERT
  WITH CHECK (bridgethings_current_role() IN ('admin','employee'));

CREATE POLICY "bridgethings_unit_subs_staff_update"
  ON bridgethings_unit_subscriptions FOR UPDATE
  USING (bridgethings_current_role() IN ('admin','employee'));

CREATE POLICY "bridgethings_unit_subs_staff_delete"
  ON bridgethings_unit_subscriptions FOR DELETE
  USING (bridgethings_current_role() IN ('admin','employee'));
