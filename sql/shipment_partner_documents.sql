-- ============================================================
-- Per-shipment partner documents (Invoice / DC / E-way Bill).
-- ============================================================
-- A split-shipment order has different items + different total value in
-- each parcel, so each parcel needs its own Invoice / DC / E-way Bill
-- from the channel partner. Pre-existing schema stored docs at the
-- order level (one set per order), which doesn't fit the multi-shipment
-- workflow.
--
-- This migration:
--   1. Adds requested_doc_types + partner_docs_status to each shipment
--      so dispatch can request a fresh doc set per parcel.
--   2. Links uploaded docs to a specific shipment via shipment_id.
--      Existing rows keep shipment_id = NULL and stay readable as
--      legacy order-level docs — no data is touched.
--   3. Switches the uniqueness constraint from (order_id, doc_type) to
--      (shipment_id, doc_type) for new rows, with a separate partial
--      index covering the legacy NULL-shipment rows.
-- ============================================================

-- ── 1. Per-shipment doc lifecycle ───────────────────────────
ALTER TABLE bridgethings_shipments
  ADD COLUMN IF NOT EXISTS requested_doc_types TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS partner_docs_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (partner_docs_status IN ('not_required','requested','submitted'));

CREATE INDEX IF NOT EXISTS idx_shipments_partner_docs_status
  ON bridgethings_shipments(partner_docs_status);

-- ── 2. Link docs to shipments ───────────────────────────────
ALTER TABLE bridgethings_order_partner_documents
  ADD COLUMN IF NOT EXISTS shipment_id UUID REFERENCES bridgethings_shipments(id) ON DELETE CASCADE;

-- ── 3. Replace order-level uniqueness with per-shipment ─────
-- Drop the old order-level UNIQUE so a single order can carry many
-- doc sets (one per shipment). The auto-generated constraint name is
-- bridgethings_order_partner_documents_order_id_doc_type_key.
ALTER TABLE bridgethings_order_partner_documents
  DROP CONSTRAINT IF EXISTS bridgethings_order_partner_documents_order_id_doc_type_key;

-- Per-shipment uniqueness: one row per (shipment_id, doc_type). Partial
-- index covers only new shipment-linked rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_docs_shipment_doctype
  ON bridgethings_order_partner_documents(shipment_id, doc_type)
  WHERE shipment_id IS NOT NULL;

-- Legacy rows (shipment_id IS NULL) keep their original (order_id,
-- doc_type) uniqueness so we never accidentally double-insert at the
-- order level either.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_docs_order_doctype_legacy
  ON bridgethings_order_partner_documents(order_id, doc_type)
  WHERE shipment_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_partner_documents_shipment
  ON bridgethings_order_partner_documents(shipment_id);
