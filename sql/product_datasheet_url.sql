-- ============================================================
-- Per-product datasheet URL.
-- ============================================================
-- Admin pastes a link to the product's datasheet (typically a hosted
-- PDF — Supabase storage, Drive, etc.). Partners see a "View Datasheet"
-- link on the catalog detail modal that opens it in a new tab.
-- ============================================================

ALTER TABLE bridgethings_products
  ADD COLUMN IF NOT EXISTS datasheet_url TEXT;
