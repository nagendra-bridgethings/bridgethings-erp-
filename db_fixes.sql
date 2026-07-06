-- ============================================================
-- Bridge Things ERP — Database fixes from the 2026-07 bug audit
-- Run in: Supabase Dashboard > SQL Editor
--
-- IMPORTANT: Run STEP 0 by itself first (its own query), THEN
-- run the rest. Postgres cannot add an enum value and use it in
-- the same transaction.
--
-- Every statement is idempotent (IF NOT EXISTS / OR REPLACE /
-- drop-then-create), so re-running the script is safe.
-- ============================================================


-- ── STEP 0 (run alone first) ────────────────────────────────
-- Bug: rejectOrder()/declineDeliveryCounter() write status
-- 'rejected', but the base enum only has draft/pending_approval/
-- active/completed and no migration ever added 'rejected'.
-- Without it, rejecting a PO fails with an enum error AND the
-- POs Received page (which filters .in(status ...'rejected'))
-- errors out entirely.
ALTER TYPE bridgethings_order_status ADD VALUE IF NOT EXISTS 'rejected';


-- ── STEP 1: Admin can update channel partners ───────────────
-- Bug: the only UPDATE policy on bridgethings_channelpartners is
-- update_own (id = auth.uid()), so the admin "set discount %"
-- feature silently updated 0 rows while the UI showed success.
-- The protect_partner_discount trigger already blocks non-admins
-- from touching discount_percent, so this policy is safe.
DROP POLICY IF EXISTS "bridgethings_channelpartners_update_admin" ON bridgethings_channelpartners;
CREATE POLICY "bridgethings_channelpartners_update_admin"
  ON bridgethings_channelpartners FOR UPDATE
  USING      (bridgethings_current_role() = 'admin')
  WITH CHECK (bridgethings_current_role() = 'admin');


-- ── STEP 2: Partner may delete own still-pending order ──────
-- Bug: createOrder()'s rollback (delete the order row when the
-- items insert fails) was a guaranteed no-op — no DELETE policy
-- existed on bridgethings_orders, leaving orphaned empty orders
-- in the admin PO queue. Scope: only the partner's own orders,
-- and only while still pending_approval.
DROP POLICY IF EXISTS "bridgethings_orders_delete_own_pending" ON bridgethings_orders;
CREATE POLICY "bridgethings_orders_delete_own_pending"
  ON bridgethings_orders FOR DELETE
  USING (partner_id = auth.uid() AND status = 'pending_approval');


-- ── STEP 3: Partner doc-submitted flip via RPC ──────────────
-- Bug: after uploading the last requested document, the partner
-- client tried to UPDATE bridgethings_shipments.partner_docs_status
-- directly — blocked by RLS (staff-only write policy), so the
-- status stayed 'requested' forever while the "docs submitted"
-- email still fired. RLS can't allow partners a column-scoped
-- UPDATE, so the flip moves into a SECURITY DEFINER function that
-- verifies ownership + completeness itself.
CREATE OR REPLACE FUNCTION bridgethings_mark_shipment_docs_submitted(p_shipment_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested TEXT[];
  v_missing   INT;
BEGIN
  -- Caller must be the partner who owns the shipment's order.
  SELECT s.requested_doc_types INTO v_requested
  FROM bridgethings_shipments s
  JOIN bridgethings_orders o ON o.id = s.order_id
  WHERE s.id = p_shipment_id
    AND o.partner_id = auth.uid()
    AND s.partner_docs_status = 'requested';
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Every requested doc type must have an uploaded row.
  SELECT COUNT(*) INTO v_missing
  FROM unnest(v_requested) AS rt(doc_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM bridgethings_order_partner_documents d
    WHERE d.shipment_id = p_shipment_id AND d.doc_type = rt.doc_type
  );
  IF v_missing > 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE bridgethings_shipments
  SET partner_docs_status = 'submitted'
  WHERE id = p_shipment_id;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION bridgethings_mark_shipment_docs_submitted(UUID) TO authenticated;


-- ── STEP 4: Server-side over-shipment guard ─────────────────
-- Bug: two dispatch users (or two tabs) working from stale
-- "remaining" snapshots could each record a full shipment for the
-- same order — the DB accepted 20/10 units shipped and the rollup
-- trigger marked the order shipped/delivered on phantom quantity.
-- This trigger locks the order_item row and rejects any insert/
-- update that would push total shipped qty past the ordered qty.
CREATE OR REPLACE FUNCTION bridgethings_check_shipment_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ordered INT;
  v_shipped INT;
BEGIN
  SELECT qty INTO v_ordered
  FROM bridgethings_order_items
  WHERE id = NEW.order_item_id
  FOR UPDATE;                       -- serialize concurrent shipment writes per item
  IF v_ordered IS NULL THEN
    RAISE EXCEPTION 'Order item % not found', NEW.order_item_id;
  END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_shipped
  FROM bridgethings_shipment_items
  WHERE order_item_id = NEW.order_item_id
    AND id IS DISTINCT FROM NEW.id;

  IF v_shipped + NEW.qty > v_ordered THEN
    RAISE EXCEPTION 'Cannot ship % units of item %: only % of % remain unshipped',
      NEW.qty, NEW.order_item_id, v_ordered - v_shipped, v_ordered;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bridgethings_shipment_qty_guard ON bridgethings_shipment_items;
CREATE TRIGGER bridgethings_shipment_qty_guard
  BEFORE INSERT OR UPDATE ON bridgethings_shipment_items
  FOR EACH ROW EXECUTE FUNCTION bridgethings_check_shipment_qty();
