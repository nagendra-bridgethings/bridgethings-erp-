-- ============================================================
-- Fix: operations unit-status changes were not audited
-- ============================================================
-- The audit trigger (bridgethings_log_audit_event) was attached in
-- schema.sql to bridgethings_orders and the LEGACY bridgethings_devices
-- table. The live per-unit table is bridgethings_order_unit_details, which
-- had no audit trigger. So when Operations moves units to "Sent for
-- Dispatch" (an UPDATE on order_unit_details) nothing was logged — the
-- ops -> dispatch handoff never showed up in Audit Logs. (Dispatch DID
-- show, but only because creating a shipment updates the orders table,
-- which is audited.)
--
-- This attaches the SAME existing audit function to the live unit table.
-- Purely additive — no existing trigger/function/logic is changed. Audit
-- rows land with entity_type = 'order_unit_details'.
-- ============================================================
DROP TRIGGER IF EXISTS bridgethings_order_units_audit ON bridgethings_order_unit_details;
CREATE TRIGGER bridgethings_order_units_audit
  AFTER UPDATE ON bridgethings_order_unit_details
  FOR EACH ROW EXECUTE FUNCTION bridgethings_log_audit_event();
