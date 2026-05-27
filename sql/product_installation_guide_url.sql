-- ============================================================
-- Per-product installation-guide URL.
-- ============================================================
-- Admin pastes a link to the product's installation manual (typically a
-- hosted PDF). Partners see a "View Installation Guide" link on the
-- catalog detail modal, mirroring the datasheet button.
-- ============================================================

ALTER TABLE bridgethings_products
  ADD COLUMN IF NOT EXISTS installation_guide_url TEXT;
