-- ============================================================
-- Fix: ON CONFLICT requires a real UNIQUE constraint, not a partial
-- unique INDEX.
-- ============================================================
-- The previous migration (sql/shipment_partner_documents.sql) created
-- a partial unique index on (shipment_id, doc_type) WHERE shipment_id
-- IS NOT NULL. Supabase's upsert API takes a comma-separated column
-- list for `onConflict` and can't pass the WHERE predicate, so Postgres
-- couldn't match the partial index → "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification".
--
-- A plain UNIQUE constraint on (shipment_id, doc_type) is what we
-- actually need. Legacy rows with shipment_id IS NULL stay safe because
-- Postgres treats NULLs as distinct under a UNIQUE constraint by
-- default (no NULLS NOT DISTINCT), so multiple legacy rows can still
-- share a doc_type at the order level — the separate
-- idx_partner_docs_order_doctype_legacy partial index keeps THEM unique
-- per (order_id, doc_type).
-- ============================================================

-- Drop the partial index — the new constraint covers its purpose.
DROP INDEX IF EXISTS idx_partner_docs_shipment_doctype;

-- Add the real UNIQUE constraint that `ON CONFLICT` can match.
ALTER TABLE bridgethings_order_partner_documents
  DROP CONSTRAINT IF EXISTS bridgethings_order_partner_documents_shipment_id_doc_type_key;

ALTER TABLE bridgethings_order_partner_documents
  ADD CONSTRAINT bridgethings_order_partner_documents_shipment_id_doc_type_key
  UNIQUE (shipment_id, doc_type);
