-- ============================================================
-- Subscription request flow — partner-initiated pending rows.
-- ============================================================
-- Partner selects devices → inserts pending rows with amount_due set
-- from the product's subscription_price. Admin then approves (sets to
-- active, fills amount_paid + payment_date) once the offline payment
-- arrives. Same pattern as PO confirmation today.
-- ============================================================

-- amount_due is the price the partner was quoted at request time.
-- Stored separately from amount_paid so the request is auditable even
-- if the product's subscription_price changes later.
ALTER TABLE bridgethings_unit_subscriptions
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Partner-side INSERT policy. Strictly limited:
--   - Only their own units (via order → partner_id)
--   - Only as 'pending' (can't sneak in already-active rows)
--   - amount_paid must be 0 at insert time (only admin can mark paid)
CREATE POLICY "bridgethings_unit_subs_partner_insert"
  ON bridgethings_unit_subscriptions FOR INSERT
  WITH CHECK (
    status = 'pending'
    AND amount_paid = 0
    AND EXISTS (
      SELECT 1
      FROM bridgethings_order_unit_details u
      JOIN bridgethings_order_items oi ON oi.id = u.order_item_id
      JOIN bridgethings_orders o       ON o.id  = oi.order_id
      WHERE u.id = bridgethings_unit_subscriptions.unit_id
        AND o.partner_id = auth.uid()
    )
  );
