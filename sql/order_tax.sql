-- ============================================================
-- IGST (18%) on purchase orders.
-- ============================================================
-- Stored as a separate column so historical orders stay auditable
-- even if the rate changes. total_amount continues to be the grand
-- total (subtotal + shipping + tax).
-- ============================================================

ALTER TABLE bridgethings_orders
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
