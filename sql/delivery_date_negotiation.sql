-- ============================================================
-- Requested delivery date + admin counter-proposal flow.
-- ============================================================
-- Partner picks a "requested delivery date" when submitting a PO
-- (optional — they can leave it blank). Admin reviewing the PO either:
--   1. Approves with the requested date (or no-date) as-is, OR
--   2. Counter-proposes a different date + a note to the partner.
--
-- A counter sends the PO into a holding state — it disappears from the
-- admin approval queue until the partner responds. Partner can:
--   accept → goes back into the admin queue, locked to the counter date
--   decline → PO is auto-rejected (partner walked away)
--
-- The final locked-in date is stored in committed_delivery_date at
-- approval time so fulfillment / invoices have one source of truth.
-- ============================================================

ALTER TABLE bridgethings_orders
  ADD COLUMN IF NOT EXISTS requested_delivery_date    DATE,
  ADD COLUMN IF NOT EXISTS proposed_delivery_date     DATE,
  ADD COLUMN IF NOT EXISTS delivery_negotiation_note  TEXT,
  ADD COLUMN IF NOT EXISTS delivery_negotiation_status TEXT
    CHECK (delivery_negotiation_status IN ('counter_sent','counter_accepted')),
  ADD COLUMN IF NOT EXISTS committed_delivery_date    DATE;

-- Helpful index for admin dashboard queries that filter the queue by
-- negotiation status.
CREATE INDEX IF NOT EXISTS idx_orders_negotiation_status
  ON bridgethings_orders(delivery_negotiation_status);
