-- ============================================================
-- Per-channel-partner flat product discount.
-- ============================================================
-- A single percentage (0-100) applied to every product in this partner's
-- cart at PO submission time. Shipping and IGST are unaffected — IGST is
-- recomputed on the discounted items subtotal (GST-compliant: tax on
-- discounted supply value).
--
-- Old orders keep their saved unit_price; only NEW POs get the discount.
-- ============================================================

ALTER TABLE bridgethings_channelpartners
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 100);
