-- ============================================================
-- Add SIM number to per-unit details.
-- ============================================================
-- The existing `sim` column captured the SIM provider/name
-- (e.g. "jio", "airtel"). This adds a separate sim_number column
-- for the actual MSISDN / ICCID so the partner can see both side by
-- side on My Devices.
-- ============================================================

ALTER TABLE bridgethings_order_unit_details
  ADD COLUMN IF NOT EXISTS sim_number TEXT;
