-- ============================================================
-- Fix: deleting a shipment leaves its units stuck as 'dispatched'
-- ============================================================
-- bridgethings_units_dispatched_on_shipment_item flips units to
-- 'dispatched' AFTER INSERT on bridgethings_shipment_items, but there was
-- no matching DELETE trigger. So when dispatch creates a shipment (units →
-- dispatched) and then removes it, the units stay 'dispatched' with no
-- shipment backing them: they vanish from dispatch's "waiting" queue and
-- can never be re-shipped.
--
-- This adds an AFTER DELETE trigger that reverts the freed units back to
-- 'ready_to_dispatch' (the state they were in before being put on the
-- shipment), so they reappear in dispatch's queue. Units aren't pinned to
-- a specific shipment, so we revert OLD.qty of the order_item's dispatched
-- units — by count, total dispatched always equals total shipped.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_units_undispatched_on_shipment_item_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_qty INTEGER;
BEGIN
  v_qty := OLD.qty;
  IF v_qty IS NULL OR v_qty <= 0 THEN RETURN OLD; END IF;

  WITH candidates AS (
    SELECT id
    FROM bridgethings_order_unit_details
    WHERE order_item_id = OLD.order_item_id
      AND production_status = 'dispatched'
    ORDER BY unit_index DESC   -- free the most-recently dispatched first
    LIMIT v_qty
  )
  UPDATE bridgethings_order_unit_details ud
  SET production_status = 'ready_to_dispatch'
  FROM candidates c
  WHERE ud.id = c.id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_units_undispatched_on_shipment_item_delete
  ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_units_undispatched_on_shipment_item_delete
  AFTER DELETE ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_units_undispatched_on_shipment_item_delete();

-- ============================================================
-- One-time reconcile: revert units that are already orphaned as
-- 'dispatched' (more dispatched units than there are shipped quantities,
-- left behind by shipment deletions before this trigger existed). Reverts
-- the excess back to 'ready_to_dispatch' so they re-enter dispatch's queue.
-- ============================================================
WITH ship AS (
  SELECT order_item_id, COALESCE(SUM(qty), 0) AS shipped
  FROM bridgethings_shipment_items
  GROUP BY order_item_id
),
excess AS (
  SELECT u.order_item_id,
         COUNT(*) FILTER (WHERE u.production_status = 'dispatched')
           - COALESCE(MAX(s.shipped), 0) AS over
  FROM bridgethings_order_unit_details u
  LEFT JOIN ship s ON s.order_item_id = u.order_item_id
  GROUP BY u.order_item_id
),
to_revert AS (
  SELECT u.id,
         ROW_NUMBER() OVER (PARTITION BY u.order_item_id ORDER BY u.unit_index DESC) AS rn,
         e.over
  FROM bridgethings_order_unit_details u
  JOIN excess e ON e.order_item_id = u.order_item_id
  WHERE u.production_status = 'dispatched' AND e.over > 0
)
UPDATE bridgethings_order_unit_details ud
SET production_status = 'ready_to_dispatch'
FROM to_revert t
WHERE ud.id = t.id AND t.rn <= t.over;
