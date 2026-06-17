-- ============================================================
-- Partner-supplied PO number  (run in Supabase SQL editor)
-- Date: 2026-06-17
-- ============================================================
-- When a channel partner submits a purchase order they can enter
-- their OWN reference (e.g. "CUSSJKFKJ") so they track the order by
-- a number that means something to them. It's optional — orders
-- without one fall back to the system short id (ORD-XXXXXXXX) in the
-- UI. No uniqueness constraint: partners may reuse/format freely.
-- ============================================================

ALTER TABLE bridgethings_orders
  ADD COLUMN IF NOT EXISTS partner_po_number TEXT;

-- Optional: speeds up lookups when searching by the partner's number.
CREATE INDEX IF NOT EXISTS idx_orders_partner_po_number
  ON bridgethings_orders(partner_po_number);
