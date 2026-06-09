-- ============================================================
-- Fix: channel partner cannot submit a PO (RLS violation)
-- ============================================================
-- bridgethings_create_units_for_order_item() is the AFTER INSERT trigger
-- on bridgethings_order_items that auto-creates one
-- bridgethings_order_unit_details row per unit. It was defined as
-- SECURITY INVOKER, so when a CHANNEL PARTNER submitted a PO the trigger's
-- INSERT ran with the partner's privileges — and the partner has no INSERT
-- rights on bridgethings_order_unit_details (RLS = admin/employee only).
-- The whole PO submission then failed with:
--
--   "new row violates row-level security policy for table
--    bridgethings_order_unit_details"
--
-- (It only surfaced once a real partner submitted a PO; staff-created
-- orders were unaffected because staff CAN insert unit rows.)
--
-- Fix: run the trigger as SECURITY DEFINER so it executes as the owner,
-- which bypasses RLS for this system-generated insert — the same pattern
-- bridgethings_current_role() and the notification dispatcher already use.
-- CREATE OR REPLACE updates the function in place; the existing
-- bridgethings_create_units_on_order_item trigger keeps pointing at it.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_create_units_for_order_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO bridgethings_order_unit_details (order_item_id, unit_index)
  SELECT NEW.id, gs.unit_index
  FROM generate_series(1, GREATEST(NEW.qty, 1)) AS gs(unit_index)
  ON CONFLICT (order_item_id, unit_index) DO NOTHING;
  RETURN NEW;
END;
$$;
