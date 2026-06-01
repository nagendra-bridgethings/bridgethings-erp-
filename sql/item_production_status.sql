-- ============================================================
-- Per-item production status (ops ↔ dispatch handoff).
-- ============================================================
-- Each order_item now tracks its own lifecycle through production:
--
--   hold              → default, order arrived, ops hasn't started
--   production        → ops is filling unit details
--   ready_to_dispatch → ops handed item off, dispatch sees it
--   sent_back         → dispatch rejected with a note, ops must fix
--   dispatched        → item appeared in a shipment (auto-flipped)
--
-- A trigger flips items to 'dispatched' as soon as they're added to a
-- shipment_item row, so the dispatch queue stays clean automatically.
-- dispatch_review_note carries the rejection text dispatch entered.
-- ============================================================

ALTER TABLE bridgethings_order_items
  ADD COLUMN IF NOT EXISTS production_status TEXT NOT NULL DEFAULT 'hold'
    CHECK (production_status IN ('hold','production','ready_to_dispatch','sent_back','dispatched')),
  ADD COLUMN IF NOT EXISTS dispatch_review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_order_items_production_status
  ON bridgethings_order_items(production_status);

-- ============================================================
-- Auto-flip items to 'dispatched' when added to a shipment.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_item_dispatched_on_shipment_item()
RETURNS TRIGGER AS $$
BEGIN
  -- bridgethings_order_items has no updated_at column.
  UPDATE bridgethings_order_items
  SET production_status    = 'dispatched',
      dispatch_review_note = NULL
  WHERE id = NEW.order_item_id
    AND production_status <> 'dispatched';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_item_dispatched_on_shipment_item
  ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_item_dispatched_on_shipment_item
  AFTER INSERT ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_item_dispatched_on_shipment_item();
