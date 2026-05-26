-- ============================================================
-- Multiple images per product.
-- ============================================================
-- The original schema only allowed one image_url per product. This adds
-- an image_urls TEXT[] array so admin can upload multiple shots of the
-- same product (different angles, packaging, certificates, etc.).
--
-- Backwards-compat: image_url stays as the "primary" image — the first
-- entry in image_urls is always mirrored back to image_url on save, so
-- cards / thumbnails / old code that reads image_url keep working
-- without changes.
-- ============================================================

ALTER TABLE bridgethings_products
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: any existing product with a single image_url gets that URL
-- as the sole entry in image_urls, so the admin form opens with the
-- correct gallery state instead of an empty array.
UPDATE bridgethings_products
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND (image_urls IS NULL OR cardinality(image_urls) = 0);
