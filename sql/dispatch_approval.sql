-- ============================================================
-- Dispatch approval gate.
-- ============================================================
-- Sits between payment and fulfillment. The accountant records
-- payments; the trigger auto-decides whether dispatch can proceed:
--
--   no payment yet (payment_status='pending')   → 'awaiting_payment'
--   partial payment                              → 'pending' (admin must decide)
--   full payment                                 → 'approved' (auto-cleared)
--
-- Admin can also flip an order to 'approved' even at partial payment,
-- OR 'rejected' with a note that the partner sees ("pay more first").
-- Employees can only create shipments when dispatch_approval='approved'.
-- ============================================================

ALTER TABLE bridgethings_orders
  ADD COLUMN IF NOT EXISTS dispatch_approval TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (dispatch_approval IN ('awaiting_payment','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS dispatch_rejection_note TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_dispatch_approval
  ON bridgethings_orders(dispatch_approval);

-- ============================================================
-- Extend the payments trigger to keep dispatch_approval in sync.
-- (Replaces the function defined in sql/order_payments.sql.)
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

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM bridgethings_order_payments
  WHERE order_id = v_order_id;

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

  -- Auto-flip dispatch_approval based on the new payment state.
  --
  -- completed → always approved (full payment clears dispatch unconditionally)
  -- partial   → pending (admin must look) — unless admin already approved.
  --             A partial payment AFTER a rejection re-opens for review.
  -- pending   → awaiting_payment, unless admin had pre-approved manually.
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

-- The trigger itself doesn't need recreation — it points at the function
-- by name and CREATE OR REPLACE FUNCTION updated the function body in
-- place.

-- ============================================================
-- Backfill existing orders so their dispatch_approval matches their
-- current payment_status.
-- ============================================================
UPDATE bridgethings_orders
SET dispatch_approval = CASE
  WHEN payment_status = 'completed' THEN 'approved'
  WHEN payment_status = 'partial'   THEN 'pending'
  ELSE 'awaiting_payment'
END;
