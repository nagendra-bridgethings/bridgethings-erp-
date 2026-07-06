-- ============================================================
-- Bridge Things ERP — Subscription payment-proof upload
-- Run in: Supabase Dashboard > SQL Editor (safe to re-run).
--
-- Adds a payment-proof step to the subscription flow, mirroring the order
-- payment flow:
--   partner requests (pending)
--     → partner uploads bill + amount + slip   (status 'submitted')
--     → accountant sees the proof, verifies → approve (active)
--                                    or reject → back to 'pending' (re-upload)
--
-- Slips reuse the existing private bucket `bridgethings-payment-slips`
-- (staff already read every slip there; partners read their own uid folder),
-- so no new storage setup is needed.
-- ============================================================


-- ── 1. Proof columns + the new 'submitted' status ───────────────────
ALTER TABLE bridgethings_unit_subscriptions
  ADD COLUMN IF NOT EXISTS receipt_url    TEXT,   -- storage path of the uploaded slip
  ADD COLUMN IF NOT EXISTS payment_method TEXT,   -- upi / bank_transfer / cheque / cash / other
  ADD COLUMN IF NOT EXISTS rejection_note TEXT;   -- set when an accountant rejects a proof

-- status was CHECK (status IN ('pending','active','cancelled')); add 'submitted'.
ALTER TABLE bridgethings_unit_subscriptions
  DROP CONSTRAINT IF EXISTS bridgethings_unit_subscriptions_status_check;
ALTER TABLE bridgethings_unit_subscriptions
  ADD CONSTRAINT bridgethings_unit_subscriptions_status_check
  CHECK (status IN ('pending','submitted','active','cancelled'));


-- ── 2. Partner submits proof on their own pending request ───────────
-- Partners have no UPDATE policy on this table (they can only INSERT their
-- own 'pending' rows), and RLS can't restrict WHICH columns they'd change —
-- so the proof attaches through a SECURITY DEFINER RPC that verifies
-- ownership (unit → order → partner) and that the row is still pending.
-- amount_paid here is the amount the partner CLAIMS to have paid; the
-- accountant confirms/adjusts it on approval.
CREATE OR REPLACE FUNCTION bridgethings_submit_subscription_proof(
  p_sub_id       UUID,
  p_amount       NUMERIC,
  p_payment_date DATE,
  p_method       TEXT,
  p_receipt_url  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  UPDATE bridgethings_unit_subscriptions s
  SET amount_paid    = COALESCE(p_amount, 0),
      payment_date   = p_payment_date,
      payment_method = p_method,
      receipt_url    = p_receipt_url,
      status         = 'submitted',
      rejection_note = NULL,             -- clear any prior rejection on re-upload
      updated_at     = NOW()
  WHERE s.id = p_sub_id
    AND s.status = 'pending'             -- only from a pending (or rejected-back-to-pending) row
    AND EXISTS (
      SELECT 1
      FROM bridgethings_order_unit_details u
      JOIN bridgethings_order_items oi ON oi.id = u.order_item_id
      JOIN bridgethings_orders o       ON o.id  = oi.order_id
      WHERE u.id = s.unit_id
        AND o.partner_id = auth.uid()    -- caller must own the device
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION bridgethings_submit_subscription_proof(UUID, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

-- Accountant verify (approve) and reject are plain UPDATEs — accountants
-- already have a staff UPDATE policy on this table, so no RPC is needed for
-- those paths (see src/lib/subscriptions.js approveSubscription /
-- rejectSubscriptionProof).
