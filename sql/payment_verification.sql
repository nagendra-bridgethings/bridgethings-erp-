-- ============================================================
-- Partner-uploaded payment proofs + accountant verification gate.
-- ============================================================
-- New flow:
--   1. Partner uploads a payment slip → row inserted with
--      status='pending_verification'. NOT counted toward amount_paid.
--   2. Accountant verifies → status='verified' → recompute trigger
--      adds it to amount_paid + flips dispatch_approval if fully paid.
--   3. Accountant rejects → status='rejected', partner can re-upload.
--
-- Accountant-entered manual payments (cash, cheque walk-ins) still
-- work — they're inserted directly with status='verified'.
-- ============================================================

ALTER TABLE bridgethings_order_payments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('pending_verification','verified','rejected')),
  ADD COLUMN IF NOT EXISTS rejection_note TEXT,
  ADD COLUMN IF NOT EXISTS verified_by    UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS verified_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_order_payments_status
  ON bridgethings_order_payments(status);

-- ============================================================
-- Recompute trigger — now only sums VERIFIED rows.
-- (Replaces the function originally defined in order_payments.sql
-- and extended in dispatch_approval.sql.)
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_recompute_order_payment()
RETURNS TRIGGER AS $$
DECLARE
  v_order_id          UUID;
  v_total             NUMERIC(12,2);
  v_paid              NUMERIC(12,2);
  v_status            bridgethings_payment_status;
  v_current_dispatch  TEXT;
  v_new_dispatch      TEXT;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  -- Only verified payments contribute to amount_paid.
  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM bridgethings_order_payments
  WHERE order_id = v_order_id
    AND status   = 'verified';

  SELECT total_amount, dispatch_approval
    INTO v_total, v_current_dispatch
  FROM bridgethings_orders
  WHERE id = v_order_id;

  IF v_paid <= 0 THEN
    v_status := 'pending';
  ELSIF v_paid < v_total THEN
    v_status := 'partial';
  ELSE
    v_status := 'completed';
  END IF;

  IF v_status = 'completed' THEN
    v_new_dispatch := 'approved';
  ELSIF v_status = 'partial' THEN
    IF v_current_dispatch IS NULL
       OR v_current_dispatch IN ('awaiting_payment', 'rejected') THEN
      v_new_dispatch := 'pending';
    ELSE
      v_new_dispatch := v_current_dispatch;
    END IF;
  ELSE
    IF v_current_dispatch = 'approved' THEN
      v_new_dispatch := 'approved';
    ELSE
      v_new_dispatch := 'awaiting_payment';
    END IF;
  END IF;

  UPDATE bridgethings_orders
  SET amount_paid       = v_paid,
      payment_status    = v_status,
      dispatch_approval = v_new_dispatch,
      updated_at        = NOW()
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RLS — partners can INSERT rows for their own orders, but only as
-- 'pending_verification'. They can also SELECT their own rows (already
-- covered by existing policy). Updating status to 'verified' or
-- 'rejected' is restricted to admin + accountant.
-- ============================================================

-- Drop and recreate partner INSERT policy with the status constraint.
DROP POLICY IF EXISTS "bridgethings_order_payments_partner_insert" ON bridgethings_order_payments;
CREATE POLICY "bridgethings_order_payments_partner_insert"
  ON bridgethings_order_payments FOR INSERT
  WITH CHECK (
    -- Partner inserting a row for their own order, only as pending.
    status = 'pending_verification'
    AND EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_order_payments.order_id
        AND o.partner_id = auth.uid()
    )
  );

-- ============================================================
-- Storage bucket for payment slips. Partners upload PDFs / images,
-- accountants + admins read them to verify.
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('bridgethings-payment-slips', 'bridgethings-payment-slips', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS — partner can upload to their own folder (path begins
-- with their auth.uid), staff (admin/accountant) can read everything.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname LIKE 'bridgethings_payment_slips_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END $$;

-- Partner uploads to <their-uid>/<filename>.
CREATE POLICY "bridgethings_payment_slips_partner_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'bridgethings-payment-slips'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Partner reads their own slips.
CREATE POLICY "bridgethings_payment_slips_partner_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'bridgethings-payment-slips'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Staff reads every slip in the bucket.
CREATE POLICY "bridgethings_payment_slips_staff_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'bridgethings-payment-slips'
    AND bridgethings_current_role() IN ('admin','accountant','employee')
  );
