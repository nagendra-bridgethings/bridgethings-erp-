-- ============================================================
-- Drop dead columns from bridgethings_order_items.
-- ============================================================
-- These four columns are no longer written or read by the app:
--   serial_number, mac_id    — superseded by bridgethings_order_unit_details
--   requested_date           — partner-side date picker was removed earlier
--   confirmed_date           — admin-side date picker was removed earlier
-- All rows in the live DB are NULL for these columns. Safe to drop.
-- ============================================================

ALTER TABLE bridgethings_order_items
  DROP COLUMN IF EXISTS serial_number,
  DROP COLUMN IF EXISTS mac_id,
  DROP COLUMN IF EXISTS requested_date,
  DROP COLUMN IF EXISTS confirmed_date;
