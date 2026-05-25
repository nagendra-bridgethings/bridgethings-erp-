-- ============================================================
-- Give accountant role write access to unit subscriptions.
-- ============================================================
-- Accounts is the team that confirms payment received and activates the
-- dashboard, so they need INSERT / UPDATE / DELETE on the subscriptions
-- table — same scope as admin/employee.
-- ============================================================

DROP POLICY IF EXISTS bridgethings_unit_subs_staff_insert ON bridgethings_unit_subscriptions;
DROP POLICY IF EXISTS bridgethings_unit_subs_staff_update ON bridgethings_unit_subscriptions;
DROP POLICY IF EXISTS bridgethings_unit_subs_staff_delete ON bridgethings_unit_subscriptions;

CREATE POLICY "bridgethings_unit_subs_staff_insert"
  ON bridgethings_unit_subscriptions FOR INSERT
  WITH CHECK (bridgethings_current_role() IN ('admin','employee','accountant'));

CREATE POLICY "bridgethings_unit_subs_staff_update"
  ON bridgethings_unit_subscriptions FOR UPDATE
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

CREATE POLICY "bridgethings_unit_subs_staff_delete"
  ON bridgethings_unit_subscriptions FOR DELETE
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));
