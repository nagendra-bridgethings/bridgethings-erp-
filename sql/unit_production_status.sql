-- ============================================================
-- Per-UNIT production status (replaces per-item status).
-- ============================================================
-- Each physical unit (one row in bridgethings_order_unit_details)
-- now tracks its own production lifecycle. This lets ops handle
-- realistic scenarios:
--   - Some units of a product can be held (e.g. material out of
--     stock) while others move forward.
--   - Partner can request partial dispatch ("send the 2 that are
--     ready, hold the other 3").
--   - Dispatch can send back specific bad units without freezing
--     the rest.
--
-- Per-item production_status (added in item_production_status.sql)
-- is left in place but no longer the source of truth — JS reads
-- per-unit values from bridgethings_order_unit_details and rolls
-- up to item/order level on the fly.
-- ============================================================

ALTER TABLE bridgethings_order_unit_details
  ADD COLUMN IF NOT EXISTS production_status TEXT NOT NULL DEFAULT 'hold'
    CHECK (production_status IN ('hold','production','ready_to_dispatch','sent_back','dispatched')),
  ADD COLUMN IF NOT EXISTS dispatch_review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_unit_details_production_status
  ON bridgethings_order_unit_details(production_status);

-- ============================================================
-- Pre-create unit rows for every existing order_item, so ops can
-- set per-unit status from day one without needing to fill in
-- serial / SIM first. Idempotent.
-- ============================================================
INSERT INTO bridgethings_order_unit_details (order_item_id, unit_index)
SELECT oi.id, gs.unit_index
FROM bridgethings_order_items oi
CROSS JOIN LATERAL generate_series(1, GREATEST(oi.qty, 1)) AS gs(unit_index)
WHERE NOT EXISTS (
  SELECT 1 FROM bridgethings_order_unit_details ud
  WHERE ud.order_item_id = oi.id
    AND ud.unit_index    = gs.unit_index
);

-- ============================================================
-- Trigger: auto-create unit rows whenever a new order_item is
-- inserted. The default production_status='hold' lets ops start
-- managing them immediately.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_create_units_for_order_item()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO bridgethings_order_unit_details (order_item_id, unit_index)
  SELECT NEW.id, gs.unit_index
  FROM generate_series(1, GREATEST(NEW.qty, 1)) AS gs(unit_index)
  ON CONFLICT (order_item_id, unit_index) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_create_units_on_order_item ON bridgethings_order_items;
CREATE TRIGGER bridgethings_create_units_on_order_item
  AFTER INSERT ON bridgethings_order_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_create_units_for_order_item();

-- ============================================================
-- Replace the auto-dispatch trigger: when a shipment_item is
-- inserted for order_item X with qty=N, flip the first N
-- non-dispatched units (preferring ready_to_dispatch, ordered by
-- unit_index ASC) to 'dispatched'.
--
-- This replaces bridgethings_item_dispatched_on_shipment_item
-- from item_production_status.sql.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_units_dispatched_on_shipment_item()
RETURNS TRIGGER AS $$
DECLARE
  v_qty INTEGER;
BEGIN
  v_qty := NEW.qty;
  IF v_qty IS NULL OR v_qty <= 0 THEN RETURN NEW; END IF;

  WITH candidates AS (
    SELECT id
    FROM bridgethings_order_unit_details
    WHERE order_item_id = NEW.order_item_id
      AND production_status <> 'dispatched'
    -- Prefer ready_to_dispatch first; tie-break by unit_index.
    ORDER BY CASE production_status WHEN 'ready_to_dispatch' THEN 0 ELSE 1 END,
             unit_index
    LIMIT v_qty
  )
  UPDATE bridgethings_order_unit_details ud
  SET production_status    = 'dispatched',
      dispatch_review_note = NULL
  FROM candidates c
  WHERE ud.id = c.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Remove the old item-level trigger and install the unit-level one.
DROP TRIGGER IF EXISTS bridgethings_item_dispatched_on_shipment_item
  ON bridgethings_shipment_items;
DROP TRIGGER IF EXISTS bridgethings_units_dispatched_on_shipment_item
  ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_units_dispatched_on_shipment_item
  AFTER INSERT ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_units_dispatched_on_shipment_item();

-- ============================================================
-- Roll up unit production_status to the parent order_item, so the
-- existing derivePartnerStatusLabel helper (which reads
-- order.items[].production_status) keeps showing the right thing
-- on the partner side without needing to load every unit.
--
-- Rule:
--   all units 'dispatched'                                → 'dispatched'
--   else all units in ('ready_to_dispatch','dispatched')  → 'ready_to_dispatch'
--   else any unit 'sent_back'                             → 'sent_back'
--   else any unit in ('production','ready_to_dispatch')   → 'production'
--   else                                                  → 'hold'
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_rollup_item_production()
RETURNS TRIGGER AS $$
DECLARE
  v_item_id UUID;
  v_total   INTEGER;
  v_count_dispatched INTEGER;
  v_count_ready      INTEGER;
  v_count_sent_back  INTEGER;
  v_count_production INTEGER;
  v_new_status TEXT;
BEGIN
  v_item_id := COALESCE(NEW.order_item_id, OLD.order_item_id);
  IF v_item_id IS NULL THEN RETURN NULL; END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE production_status = 'dispatched'),
         COUNT(*) FILTER (WHERE production_status = 'ready_to_dispatch'),
         COUNT(*) FILTER (WHERE production_status = 'sent_back'),
         COUNT(*) FILTER (WHERE production_status = 'production')
  INTO v_total, v_count_dispatched, v_count_ready, v_count_sent_back, v_count_production
  FROM bridgethings_order_unit_details
  WHERE order_item_id = v_item_id;

  IF v_total = 0 THEN
    v_new_status := 'hold';
  ELSIF v_count_dispatched = v_total THEN
    v_new_status := 'dispatched';
  ELSIF (v_count_dispatched + v_count_ready) = v_total AND v_count_ready > 0 THEN
    v_new_status := 'ready_to_dispatch';
  ELSIF v_count_sent_back > 0 THEN
    v_new_status := 'sent_back';
  ELSIF (v_count_production + v_count_ready) > 0 THEN
    v_new_status := 'production';
  ELSE
    v_new_status := 'hold';
  END IF;

  UPDATE bridgethings_order_items
  SET production_status = v_new_status
  WHERE id = v_item_id
    AND production_status IS DISTINCT FROM v_new_status;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_rollup_item_production_on_units
  ON bridgethings_order_unit_details;
CREATE TRIGGER bridgethings_rollup_item_production_on_units
  AFTER INSERT OR UPDATE OR DELETE ON bridgethings_order_unit_details
  FOR EACH ROW EXECUTE FUNCTION bridgethings_rollup_item_production();

-- One-time backfill so existing items reflect their unit aggregate.
UPDATE bridgethings_order_items oi
SET production_status = sub.s
FROM (
  SELECT
    order_item_id,
    CASE
      WHEN COUNT(*) FILTER (WHERE production_status = 'dispatched') = COUNT(*)                                                THEN 'dispatched'
      WHEN COUNT(*) FILTER (WHERE production_status IN ('ready_to_dispatch','dispatched')) = COUNT(*)
           AND COUNT(*) FILTER (WHERE production_status = 'ready_to_dispatch') > 0                                            THEN 'ready_to_dispatch'
      WHEN COUNT(*) FILTER (WHERE production_status = 'sent_back') > 0                                                        THEN 'sent_back'
      WHEN COUNT(*) FILTER (WHERE production_status IN ('production','ready_to_dispatch')) > 0                                THEN 'production'
      ELSE 'hold'
    END AS s
  FROM bridgethings_order_unit_details
  GROUP BY order_item_id
) sub
WHERE oi.id = sub.order_item_id
  AND oi.production_status IS DISTINCT FROM sub.s;
