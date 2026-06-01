-- ============================================================
-- Dispatch-picked shipping documents per drop-ship order.
-- ============================================================
-- Previously the docs the partner had to upload were auto-derived by
-- order value (≥₹50k → Invoice + DC + E-way Bill, else just DC).
-- That rule is still the default UI selection, but dispatch can now
-- override it per order — they tick exactly which docs they need
-- before clicking Request, and the partner-side upload boxes filter
-- to that list.
--
-- Valid values mirror bridgethings_order_partner_documents.doc_type:
--   'invoice' | 'dc' | 'eway_bill'
-- ============================================================

ALTER TABLE bridgethings_orders
  ADD COLUMN IF NOT EXISTS requested_doc_types TEXT[] NOT NULL DEFAULT '{}';
