-- ============================================================
-- Reconcile order status with actual shipment data.
-- ============================================================
-- Fixes a bug where an order could show status='completed' while the
-- per-product shipped/ordered tally showed pending units. The old
-- rollup trigger only SET status='completed' when everything was
-- delivered, but never RESET status back to 'active' when shipments
-- were partial or deleted — so any order completed under the old
-- single-shipment flow (or any qty change after completion) could
-- stay 'completed' incorrectly.
--
-- Two parts:
--   1. Patched trigger that also handles the "partial / nothing" case
--      by flipping completed → active.
--   2. One-time reconcile that re-runs the rollup logic against every
--      order using current shipment + order_items data.
-- ============================================================

CREATE OR REPLACE FUNCTION bridgethings_rollup_shipments()
RETURNS TRIGGER AS $$
DECLARE
  v_order_id          UUID;
  v_total_ordered     INTEGER;
  v_total_shipped     INTEGER;
  v_pending_count     INTEGER;
  v_shipment_count    INTEGER;
  v_latest_courier    TEXT;
  v_latest_tracking   TEXT;
  v_latest_delivered  DATE;
  v_current_status    TEXT;
BEGIN
  IF TG_TABLE_NAME = 'bridgethings_shipment_items' THEN
    SELECT s.order_id INTO v_order_id
    FROM bridgethings_shipments s
    WHERE s.id = COALESCE(NEW.shipment_id, OLD.shipment_id);
  ELSE
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  END IF;

  IF v_order_id IS NULL THEN RETURN NULL; END IF;

  SELECT status INTO v_current_status
  FROM bridgethings_orders
  WHERE id = v_order_id;

  SELECT COALESCE(SUM(qty), 0) INTO v_total_ordered
  FROM bridgethings_order_items
  WHERE order_id = v_order_id;

  SELECT COALESCE(SUM(si.qty), 0) INTO v_total_shipped
  FROM bridgethings_shipment_items si
  JOIN bridgethings_shipments s ON s.id = si.shipment_id
  WHERE s.order_id = v_order_id;

  SELECT COUNT(*) INTO v_shipment_count
  FROM bridgethings_shipments
  WHERE order_id = v_order_id;

  SELECT COUNT(*) INTO v_pending_count
  FROM bridgethings_shipments
  WHERE order_id = v_order_id AND delivered_date IS NULL;

  SELECT courier, tracking_number, delivered_date
    INTO v_latest_courier, v_latest_tracking, v_latest_delivered
  FROM bridgethings_shipments
  WHERE order_id = v_order_id
  ORDER BY shipped_date DESC, created_at DESC
  LIMIT 1;

  IF v_shipment_count = 0 OR v_total_shipped <= 0 THEN
    -- Nothing shipped (yet, or all shipments deleted). Roll the order
    -- back to active if it had been marked completed under the old flow.
    UPDATE bridgethings_orders
    SET delivery_method    = NULL,
        tracking_number    = NULL,
        delivered_date     = NULL,
        fulfillment_status = CASE
          WHEN fulfillment_status IN ('shipped','delivered')
            THEN 'ready_to_ship'
          ELSE fulfillment_status
        END,
        status             = CASE
          WHEN status = 'completed' THEN 'active'
          ELSE status
        END,
        updated_at         = NOW()
    WHERE id = v_order_id;

  ELSIF v_total_shipped >= v_total_ordered AND v_pending_count = 0 THEN
    -- Fully shipped AND all parcels delivered.
    UPDATE bridgethings_orders
    SET fulfillment_status = 'delivered',
        status             = 'completed',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        delivered_date     = (
          SELECT MAX(delivered_date)
          FROM bridgethings_shipments
          WHERE order_id = v_order_id
        ),
        updated_at         = NOW()
    WHERE id = v_order_id;

  ELSE
    -- Partial: either not all qty has gone out OR some parcels are still
    -- in transit. Force status back to 'active' if it had stuck at
    -- 'completed' from the old single-shipment flow.
    UPDATE bridgethings_orders
    SET fulfillment_status = 'shipped',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        delivered_date     = NULL,
        status             = CASE
          WHEN status = 'completed' THEN 'active'
          ELSE status
        END,
        updated_at         = NOW()
    WHERE id = v_order_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- One-time reconcile: walk every order and recompute its status.
-- We update each order directly (rather than nudging the trigger)
-- because some orders may have no shipments at all and the trigger
-- only fires on shipment events.
-- ============================================================
WITH per_order AS (
  SELECT
    ord.id AS order_id,
    ord.status,
    COALESCE((
      SELECT SUM(qty) FROM bridgethings_order_items WHERE order_id = ord.id
    ), 0) AS total_ordered,
    COALESCE((
      SELECT SUM(si.qty)
      FROM bridgethings_shipment_items si
      JOIN bridgethings_shipments s ON s.id = si.shipment_id
      WHERE s.order_id = ord.id
    ), 0) AS total_shipped,
    (
      SELECT COUNT(*) FROM bridgethings_shipments
      WHERE order_id = ord.id AND delivered_date IS NULL
    ) AS pending_count,
    (
      SELECT COUNT(*) FROM bridgethings_shipments
      WHERE order_id = ord.id
    ) AS shipment_count,
    (
      SELECT MAX(delivered_date) FROM bridgethings_shipments
      WHERE order_id = ord.id
    ) AS latest_delivered
  FROM bridgethings_orders ord
)
UPDATE bridgethings_orders o
SET fulfillment_status = CASE
      WHEN p.shipment_count = 0 OR p.total_shipped <= 0 THEN
        CASE WHEN o.fulfillment_status IN ('shipped','delivered')
          THEN 'ready_to_ship'
          ELSE o.fulfillment_status END
      WHEN p.total_shipped >= p.total_ordered AND p.pending_count = 0 THEN 'delivered'
      ELSE 'shipped'
    END,
    status = CASE
      WHEN p.total_shipped >= p.total_ordered AND p.pending_count = 0
           AND p.shipment_count > 0
        THEN 'completed'
      WHEN o.status = 'completed' THEN 'active'
      ELSE o.status
    END,
    delivered_date = CASE
      WHEN p.total_shipped >= p.total_ordered AND p.pending_count = 0
           AND p.shipment_count > 0
        THEN p.latest_delivered
      ELSE NULL
    END,
    updated_at = NOW()
FROM per_order p
WHERE p.order_id = o.id;
