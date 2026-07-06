-- ============================================================
-- Bridge Things ERP — "Plan" shipments must not show as Shipped
-- Run in: Supabase Dashboard > SQL Editor (safe to re-run).
--
-- PROBLEM
-- Dispatch creates a shipment as a *plan* first — to allocate units
-- to a parcel and request documents from the partner — BEFORE the
-- parcel actually goes out (no AWB / tracking number yet). But the
-- moment that shipment row existed, the DB:
--   1. rolled the order up to fulfillment_status = 'shipped', and
--   2. flipped the parcel's units to production_status = 'dispatched'.
-- So an order awaiting partner documents wrongly displayed as
-- "Shipped" / "In transit" with units counted as shipped.
--
-- FIX (single, consistent rule everywhere)
-- A parcel counts as ACTUALLY SHIPPED only once it has a tracking
-- number (handed to the courier) OR a delivered date. Plan parcels
-- (no AWB yet) leave the order in its pre-ship state and leave their
-- units at 'ready_to_dispatch'. Entering the AWB (or marking
-- delivered) is what promotes the order to 'shipped' and its units
-- to 'dispatched'. This mirrors the existing rule the app already
-- uses for the "your parcel shipped" email.
--
-- This replaces the two unit-dispatch triggers with one idempotent
-- "reconcile" function and re-points the order rollup at the same
-- shipped-means-tracked rule, then backfills existing rows.
-- ============================================================


-- ── 1. Order rollup: only tracked/delivered parcels count as shipped ──
-- Recompute one order's fulfillment_status / status / display tracking
-- from its parcels. Extracted into a callable function so the one-time
-- backfill at the bottom can reuse it.
CREATE OR REPLACE FUNCTION bridgethings_recompute_order_shipping(p_order_id UUID)
RETURNS VOID AS $$
DECLARE
  v_total_ordered   INTEGER;
  v_total_shipped   INTEGER;
  v_pending_count   INTEGER;
  v_latest_courier  TEXT;
  v_latest_tracking TEXT;
BEGIN
  IF p_order_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_total_ordered
  FROM bridgethings_order_items
  WHERE order_id = p_order_id;

  -- Units in parcels that have actually gone out (AWB present OR delivered).
  SELECT COALESCE(SUM(si.qty), 0) INTO v_total_shipped
  FROM bridgethings_shipment_items si
  JOIN bridgethings_shipments s ON s.id = si.shipment_id
  WHERE s.order_id = p_order_id
    AND (s.tracking_number IS NOT NULL OR s.delivered_date IS NOT NULL);

  -- Shipped parcels not yet delivered.
  SELECT COUNT(*) INTO v_pending_count
  FROM bridgethings_shipments
  WHERE order_id = p_order_id
    AND (tracking_number IS NOT NULL OR delivered_date IS NOT NULL)
    AND delivered_date IS NULL;

  -- Display courier/AWB from the latest actually-shipped parcel.
  SELECT courier, tracking_number
    INTO v_latest_courier, v_latest_tracking
  FROM bridgethings_shipments
  WHERE order_id = p_order_id
    AND (tracking_number IS NOT NULL OR delivered_date IS NOT NULL)
  ORDER BY shipped_date DESC, created_at DESC
  LIMIT 1;

  IF v_total_shipped <= 0 THEN
    -- Nothing actually shipped (only plan parcels, or none). Revert any
    -- stale 'shipped'/'delivered'/'completed' left by the old behaviour,
    -- and clear order-level tracking. delivery_method is left untouched so
    -- the partner's PO-time courier choice survives.
    UPDATE bridgethings_orders
    SET fulfillment_status = CASE WHEN fulfillment_status IN ('shipped','delivered')
                                  THEN 'ready_to_ship' ELSE fulfillment_status END,
        status             = CASE WHEN status = 'completed' THEN 'active' ELSE status END,
        tracking_number    = NULL,
        delivered_date     = NULL,
        updated_at         = NOW()
    WHERE id = p_order_id;
  ELSIF v_total_shipped >= v_total_ordered AND v_pending_count = 0 THEN
    -- Fully shipped and every shipped parcel delivered.
    UPDATE bridgethings_orders
    SET fulfillment_status = 'delivered',
        status             = 'completed',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        delivered_date     = (SELECT MAX(delivered_date)
                              FROM bridgethings_shipments WHERE order_id = p_order_id),
        updated_at         = NOW()
    WHERE id = p_order_id;
  ELSE
    -- At least one parcel actually shipped, but not all delivered.
    UPDATE bridgethings_orders
    SET fulfillment_status = 'shipped',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        delivered_date     = NULL,
        updated_at         = NOW()
    WHERE id = p_order_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger wrapper: resolve the affected order and recompute it.
CREATE OR REPLACE FUNCTION bridgethings_rollup_shipments()
RETURNS TRIGGER AS $$
DECLARE v_order_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'bridgethings_shipment_items' THEN
    SELECT s.order_id INTO v_order_id
    FROM bridgethings_shipments s
    WHERE s.id = COALESCE(NEW.shipment_id, OLD.shipment_id);
  ELSE
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  END IF;
  PERFORM bridgethings_recompute_order_shipping(v_order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- (existing triggers bridgethings_rollup_shipments_on_ship /
--  _on_items already call this function — left in place.)


-- ── 2. Units dispatch only when their parcel actually ships ──────────
-- Idempotent reconcile: an order_item should have exactly as many units
-- in 'dispatched' as it has qty sitting in SHIPPED parcels (AWB/delivered).
-- Promotes or demotes units to hit that target — so plan parcels leave
-- units at 'ready_to_dispatch', and entering the AWB dispatches them.
CREATE OR REPLACE FUNCTION bridgethings_sync_dispatched_units(p_order_item_id UUID)
RETURNS VOID AS $$
DECLARE
  v_target  INTEGER;
  v_current INTEGER;
  v_diff    INTEGER;
BEGIN
  IF p_order_item_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(si.qty), 0) INTO v_target
  FROM bridgethings_shipment_items si
  JOIN bridgethings_shipments s ON s.id = si.shipment_id
  WHERE si.order_item_id = p_order_item_id
    AND (s.tracking_number IS NOT NULL OR s.delivered_date IS NOT NULL);

  SELECT COUNT(*) INTO v_current
  FROM bridgethings_order_unit_details
  WHERE order_item_id = p_order_item_id
    AND production_status = 'dispatched';

  v_diff := v_target - v_current;

  IF v_diff > 0 THEN
    -- Promote non-dispatched units (prefer ready_to_dispatch) to dispatched.
    WITH candidates AS (
      SELECT id FROM bridgethings_order_unit_details
      WHERE order_item_id = p_order_item_id AND production_status <> 'dispatched'
      ORDER BY CASE production_status WHEN 'ready_to_dispatch' THEN 0 ELSE 1 END, unit_index
      LIMIT v_diff
    )
    UPDATE bridgethings_order_unit_details ud
    SET production_status = 'dispatched', dispatch_review_note = NULL
    FROM candidates c WHERE ud.id = c.id;
  ELSIF v_diff < 0 THEN
    -- Demote surplus dispatched units back to ready_to_dispatch (most
    -- recently dispatched first).
    WITH candidates AS (
      SELECT id FROM bridgethings_order_unit_details
      WHERE order_item_id = p_order_item_id AND production_status = 'dispatched'
      ORDER BY unit_index DESC
      LIMIT (-v_diff)
    )
    UPDATE bridgethings_order_unit_details ud
    SET production_status = 'ready_to_dispatch'
    FROM candidates c WHERE ud.id = c.id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Fire the reconcile whenever a parcel's items change...
CREATE OR REPLACE FUNCTION bridgethings_sync_units_on_shipment_item()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM bridgethings_sync_dispatched_units(COALESCE(NEW.order_item_id, OLD.order_item_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ...or when a parcel gains/loses its AWB or delivered date.
CREATE OR REPLACE FUNCTION bridgethings_sync_units_on_shipment()
RETURNS TRIGGER AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tracking_number IS NOT DISTINCT FROM OLD.tracking_number)
     AND (NEW.delivered_date  IS NOT DISTINCT FROM OLD.delivered_date) THEN
    RETURN NULL;  -- shipped-state unchanged; nothing to reconcile
  END IF;
  FOR r IN
    SELECT DISTINCT order_item_id
    FROM bridgethings_shipment_items
    WHERE shipment_id = COALESCE(NEW.id, OLD.id)
  LOOP
    PERFORM bridgethings_sync_dispatched_units(r.order_item_id);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Replace the old dispatch-on-insert / undispatch-on-delete triggers with
-- the single reconcile (covers INSERT, UPDATE and DELETE).
DROP TRIGGER IF EXISTS bridgethings_units_dispatched_on_shipment_item        ON bridgethings_shipment_items;
DROP TRIGGER IF EXISTS bridgethings_units_undispatched_on_shipment_item_delete ON bridgethings_shipment_items;
DROP TRIGGER IF EXISTS bridgethings_sync_units_on_shipment_item              ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_sync_units_on_shipment_item
  AFTER INSERT OR UPDATE OR DELETE ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_sync_units_on_shipment_item();

DROP TRIGGER IF EXISTS bridgethings_sync_units_on_shipment ON bridgethings_shipments;
CREATE TRIGGER bridgethings_sync_units_on_shipment
  AFTER UPDATE ON bridgethings_shipments
  FOR EACH ROW EXECUTE FUNCTION bridgethings_sync_units_on_shipment();


-- ── 3. Backfill existing data ───────────────────────────────────────
-- Demote units that were dispatched by plan parcels, then recompute every
-- order that has parcels so wrongly-'shipped' orders revert correctly.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT order_item_id FROM bridgethings_shipment_items LOOP
    PERFORM bridgethings_sync_dispatched_units(r.order_item_id);
  END LOOP;
  FOR r IN SELECT DISTINCT order_id FROM bridgethings_shipments LOOP
    PERFORM bridgethings_recompute_order_shipping(r.order_id);
  END LOOP;
END $$;
