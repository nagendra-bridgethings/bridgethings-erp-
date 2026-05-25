-- ============================================================
-- Multi-instalment payments per order.
-- ============================================================
-- Each row is ONE payment received from the partner. A single PO can
-- have multiple rows (the partner pays in instalments). The order's
-- amount_paid + payment_status are kept in sync by a trigger.
--
-- Accountants and admins write here; partners can read their own rows
-- via the order → partner_id RLS join. Employees see all (read-only).
-- ============================================================

CREATE TABLE IF NOT EXISTS bridgethings_order_payments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL REFERENCES bridgethings_orders(id) ON DELETE CASCADE,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_date     DATE NOT NULL,
  payment_method   TEXT NOT NULL DEFAULT 'bank_transfer'
                     CHECK (payment_method IN ('upi','bank_transfer','cheque','cash','other')),
  reference_number TEXT,
  notes            TEXT,
  receipt_url      TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  created_by       UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON bridgethings_order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_date  ON bridgethings_order_payments(payment_date);

-- ============================================================
-- Recompute orders.amount_paid + payment_status from the sum of rows.
-- Fires on insert / update / delete of any payment row.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_recompute_order_payment()
RETURNS TRIGGER AS $$
DECLARE
  v_order_id UUID;
  v_total    NUMERIC(12,2);
  v_paid     NUMERIC(12,2);
  v_status   bridgethings_payment_status;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM bridgethings_order_payments
  WHERE order_id = v_order_id;

  SELECT total_amount INTO v_total
  FROM bridgethings_orders
  WHERE id = v_order_id;

  IF v_paid <= 0 THEN
    v_status := 'pending';
  ELSIF v_paid < v_total THEN
    v_status := 'partial';
  ELSE
    v_status := 'completed';
  END IF;

  UPDATE bridgethings_orders
  SET amount_paid    = v_paid,
      payment_status = v_status,
      updated_at     = NOW()
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_recompute_order_payment_trg
  ON bridgethings_order_payments;

CREATE TRIGGER bridgethings_recompute_order_payment_trg
  AFTER INSERT OR UPDATE OR DELETE ON bridgethings_order_payments
  FOR EACH ROW
  EXECUTE FUNCTION bridgethings_recompute_order_payment();

-- ============================================================
-- RLS — partners read their own; staff (admin/employee/accountant) read
-- all; only admin + accountant write.
-- ============================================================
ALTER TABLE bridgethings_order_payments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies WHERE tablename = 'bridgethings_order_payments'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON bridgethings_order_payments', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "bridgethings_order_payments_partner_read"
  ON bridgethings_order_payments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_order_payments.order_id
        AND o.partner_id = auth.uid()
    )
  );

CREATE POLICY "bridgethings_order_payments_staff_read"
  ON bridgethings_order_payments FOR SELECT
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

CREATE POLICY "bridgethings_order_payments_staff_insert"
  ON bridgethings_order_payments FOR INSERT
  WITH CHECK (bridgethings_current_role() IN ('admin','accountant'));

CREATE POLICY "bridgethings_order_payments_staff_update"
  ON bridgethings_order_payments FOR UPDATE
  USING (bridgethings_current_role() IN ('admin','accountant'));

CREATE POLICY "bridgethings_order_payments_staff_delete"
  ON bridgethings_order_payments FOR DELETE
  USING (bridgethings_current_role() IN ('admin','accountant'));

-- ============================================================
-- Backfill: existing orders with amount_paid > 0 get ONE synthetic
-- payment row so the trigger maths stay consistent. We use the order's
-- updated_at as the proxy payment date.
-- ============================================================
INSERT INTO bridgethings_order_payments (
  order_id, amount, payment_date, payment_method, notes
)
SELECT
  id,
  amount_paid,
  COALESCE(updated_at::date, created_at::date, NOW()::date),
  'other',
  'Backfilled — payment recorded before instalment tracking was enabled'
FROM bridgethings_orders
WHERE amount_paid > 0
  AND NOT EXISTS (
    SELECT 1 FROM bridgethings_order_payments p
    WHERE p.order_id = bridgethings_orders.id
  );
