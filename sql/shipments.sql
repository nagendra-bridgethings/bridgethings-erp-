-- ============================================================
-- Split shipments per order.
-- ============================================================
-- An order's quantity can ship in multiple parcels, each with its own
-- courier + tracking number + delivered date. Per-item qtys live in a
-- junction table so we always know "X of Y units shipped" per product.
--
-- Two tables:
--   bridgethings_shipments        — one parcel
--   bridgethings_shipment_items   — what's inside each parcel
--
-- A trigger keeps the parent order's fulfillment_status, delivered_date
-- and overall status in sync as shipments are added or delivered.
-- ============================================================

CREATE TABLE IF NOT EXISTS bridgethings_shipments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES bridgethings_orders(id) ON DELETE CASCADE,
  courier         TEXT,
  tracking_number TEXT,
  -- Date the parcel was handed to the courier.
  shipped_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Date the partner actually received it. NULL while in-transit.
  delivered_date  DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by      UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_shipments_order ON bridgethings_shipments(order_id);

CREATE TABLE IF NOT EXISTS bridgethings_shipment_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id     UUID NOT NULL REFERENCES bridgethings_shipments(id) ON DELETE CASCADE,
  order_item_id   UUID NOT NULL REFERENCES bridgethings_order_items(id) ON DELETE CASCADE,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shipment_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON bridgethings_shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_orderitem ON bridgethings_shipment_items(order_item_id);

-- ============================================================
-- Roll-up trigger: keep the parent order's fulfillment_status, the
-- displayed delivery_method + tracking_number (latest shipment), and
-- delivered_date in sync as shipments change.
--
-- Rules:
--   no shipments yet               → fulfillment_status untouched
--                                    (employee keeps in_process / ready_to_ship)
--   some qty shipped, not all      → fulfillment_status = 'shipped'
--   all qty shipped, some pending  → fulfillment_status = 'shipped'
--   all qty shipped + all delivered → fulfillment_status = 'delivered',
--                                     status = 'completed',
--                                     delivered_date = latest delivered_date
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_rollup_shipments()
RETURNS TRIGGER AS $$
DECLARE
  v_order_id          UUID;
  v_total_ordered     INTEGER;
  v_total_shipped     INTEGER;
  v_pending_count     INTEGER;
  v_latest_courier    TEXT;
  v_latest_tracking   TEXT;
  v_latest_delivered  DATE;
BEGIN
  -- Resolve the affected order. INSERT/UPDATE on shipment_items gives us
  -- shipment_id; we need to look up its order_id.
  IF TG_TABLE_NAME = 'bridgethings_shipment_items' THEN
    SELECT s.order_id INTO v_order_id
    FROM bridgethings_shipments s
    WHERE s.id = COALESCE(NEW.shipment_id, OLD.shipment_id);
  ELSE
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  END IF;

  IF v_order_id IS NULL THEN RETURN NULL; END IF;

  -- Sum ordered qty across all items in this order.
  SELECT COALESCE(SUM(qty), 0) INTO v_total_ordered
  FROM bridgethings_order_items
  WHERE order_id = v_order_id;

  -- Sum shipped qty across all shipment_items for this order's shipments.
  SELECT COALESCE(SUM(si.qty), 0) INTO v_total_shipped
  FROM bridgethings_shipment_items si
  JOIN bridgethings_shipments s ON s.id = si.shipment_id
  WHERE s.order_id = v_order_id;

  -- Count shipments still in transit (no delivered_date).
  SELECT COUNT(*) INTO v_pending_count
  FROM bridgethings_shipments
  WHERE order_id = v_order_id AND delivered_date IS NULL;

  -- Pull display fields from the latest shipment (for backward-compat with
  -- the existing order.delivery_method / tracking_number consumers).
  SELECT courier, tracking_number, delivered_date
    INTO v_latest_courier, v_latest_tracking, v_latest_delivered
  FROM bridgethings_shipments
  WHERE order_id = v_order_id
  ORDER BY shipped_date DESC, created_at DESC
  LIMIT 1;

  -- Apply rollup.
  IF v_total_shipped <= 0 THEN
    -- Nothing shipped yet (or last shipment was deleted). Leave the
    -- order's pre-shipment status untouched — employee controls it.
    UPDATE bridgethings_orders
    SET delivery_method = NULL,
        tracking_number = NULL,
        delivered_date  = NULL,
        updated_at      = NOW()
    WHERE id = v_order_id;
  ELSIF v_total_shipped >= v_total_ordered AND v_pending_count = 0 THEN
    -- Fully shipped AND all parcels delivered.
    UPDATE bridgethings_orders
    SET fulfillment_status = 'delivered',
        status             = 'completed',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        -- Use the latest delivery date as the order-level delivered date.
        delivered_date     = (
          SELECT MAX(delivered_date)
          FROM bridgethings_shipments
          WHERE order_id = v_order_id
        ),
        updated_at         = NOW()
    WHERE id = v_order_id;
  ELSE
    -- Something has shipped — order is in "shipped" state (whether some
    -- parcels are still in transit OR not all qty has gone out).
    UPDATE bridgethings_orders
    SET fulfillment_status = 'shipped',
        delivery_method    = v_latest_courier,
        tracking_number    = v_latest_tracking,
        delivered_date     = NULL,
        updated_at         = NOW()
    WHERE id = v_order_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_rollup_shipments_on_ship ON bridgethings_shipments;
CREATE TRIGGER bridgethings_rollup_shipments_on_ship
  AFTER INSERT OR UPDATE OR DELETE ON bridgethings_shipments
  FOR EACH ROW EXECUTE FUNCTION bridgethings_rollup_shipments();

DROP TRIGGER IF EXISTS bridgethings_rollup_shipments_on_items ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_rollup_shipments_on_items
  AFTER INSERT OR UPDATE OR DELETE ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_rollup_shipments();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE bridgethings_shipments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_shipment_items ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
    WHERE tablename IN ('bridgethings_shipments','bridgethings_shipment_items')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- Partners can read shipments for their own orders.
CREATE POLICY "bridgethings_shipments_partner_read"
  ON bridgethings_shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_shipments.order_id
        AND o.partner_id = auth.uid()
    )
  );

CREATE POLICY "bridgethings_shipments_staff_read"
  ON bridgethings_shipments FOR SELECT
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

CREATE POLICY "bridgethings_shipments_staff_write"
  ON bridgethings_shipments FOR ALL
  USING (bridgethings_current_role() IN ('admin','employee'))
  WITH CHECK (bridgethings_current_role() IN ('admin','employee'));

-- shipment_items follow the same partner-vs-staff split via JOIN.
CREATE POLICY "bridgethings_shipment_items_partner_read"
  ON bridgethings_shipment_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM bridgethings_shipments s
      JOIN bridgethings_orders o ON o.id = s.order_id
      WHERE s.id = bridgethings_shipment_items.shipment_id
        AND o.partner_id = auth.uid()
    )
  );

CREATE POLICY "bridgethings_shipment_items_staff_read"
  ON bridgethings_shipment_items FOR SELECT
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

CREATE POLICY "bridgethings_shipment_items_staff_write"
  ON bridgethings_shipment_items FOR ALL
  USING (bridgethings_current_role() IN ('admin','employee'))
  WITH CHECK (bridgethings_current_role() IN ('admin','employee'));

-- ============================================================
-- Backfill: any order that already had a delivery_method or
-- tracking_number gets one shipment row containing all items at full qty.
-- ============================================================
INSERT INTO bridgethings_shipments (order_id, courier, tracking_number, shipped_date, delivered_date, notes)
SELECT
  id,
  delivery_method,
  tracking_number,
  COALESCE(delivered_date, updated_at::date, created_at::date),
  delivered_date,
  'Backfilled — created before split-shipments was enabled'
FROM bridgethings_orders
WHERE (delivery_method IS NOT NULL OR tracking_number IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM bridgethings_shipments s
    WHERE s.order_id = bridgethings_orders.id
  );

-- And the items inside those backfilled shipments — full qty per order_item.
INSERT INTO bridgethings_shipment_items (shipment_id, order_item_id, qty)
SELECT s.id, oi.id, oi.qty
FROM bridgethings_shipments s
JOIN bridgethings_order_items oi ON oi.order_id = s.order_id
WHERE s.notes = 'Backfilled — created before split-shipments was enabled'
  AND NOT EXISTS (
    SELECT 1 FROM bridgethings_shipment_items si
    WHERE si.shipment_id = s.id AND si.order_item_id = oi.id
  );
