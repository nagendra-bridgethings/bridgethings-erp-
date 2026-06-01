-- ============================================================
-- Drop-ship support: separate ship-to address + partner-uploaded
-- shipping documents (their own invoice / DC / e-way bill).
-- ============================================================
-- When the channel partner wants BridgeThings to ship directly to
-- their end customer, the parcel has to carry the partner's own
-- legal paperwork (since the partner is the seller-of-record to the
-- end customer, not BridgeThings).
--
-- Rules:
--   PO total < ₹50,000 and drop-ship   → DC is enough.
--   PO total ≥ ₹50,000 and drop-ship   → Invoice + DC + E-way Bill.
--   Same-address orders                → No partner docs needed.
--
-- documents_in_parcel records the partner's checkbox choices —
-- which docs they want enclosed (independent of which docs they
-- must upload, which is dictated by the ₹50k rule).
-- ============================================================

ALTER TABLE bridgethings_orders
  -- Ship-to override. Null fields mean "same as bill-to / partner's profile".
  ADD COLUMN IF NOT EXISTS ship_to_is_different BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ship_to_name         TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_phone        TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_address      TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_city         TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_state        TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_pincode      TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_gstin        TEXT,
  -- Partner's checkbox choices: subset of {'invoice','dc'}.
  ADD COLUMN IF NOT EXISTS documents_in_parcel  TEXT[] NOT NULL DEFAULT '{}',
  -- Tracks the partner-upload flow for ≥₹50k drop-ship orders.
  --   not_required → no docs needed (same-address or <₹50k)
  --   requested    → operations asked, partner must upload
  --   submitted    → all three docs uploaded, dispatch can proceed
  ADD COLUMN IF NOT EXISTS partner_docs_status  TEXT NOT NULL DEFAULT 'not_required'
    CHECK (partner_docs_status IN ('not_required','requested','submitted'));

CREATE INDEX IF NOT EXISTS idx_orders_partner_docs_status
  ON bridgethings_orders(partner_docs_status);

-- ============================================================
-- bridgethings_order_partner_documents — partner uploads (invoice,
-- DC, eway bill) attached to drop-ship orders. One row per doc type
-- per order; re-uploading replaces the previous row via UNIQUE.
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_order_partner_documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES bridgethings_orders(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL CHECK (doc_type IN ('invoice','dc','eway_bill')),
  storage_path TEXT NOT NULL,                       -- bucket path; signed when viewed
  uploaded_by  UUID REFERENCES auth.users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, doc_type)
);

CREATE INDEX IF NOT EXISTS idx_partner_documents_order
  ON bridgethings_order_partner_documents(order_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE bridgethings_order_partner_documents ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'bridgethings_order_partner_documents'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON bridgethings_order_partner_documents', r.policyname);
  END LOOP;
END $$;

-- Partner can read + insert + update rows for their own orders.
CREATE POLICY "bridgethings_partner_docs_partner_read"
  ON bridgethings_order_partner_documents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_order_partner_documents.order_id
        AND o.partner_id = auth.uid()
    )
  );

CREATE POLICY "bridgethings_partner_docs_partner_write"
  ON bridgethings_order_partner_documents FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_order_partner_documents.order_id
        AND o.partner_id = auth.uid()
    )
  );

CREATE POLICY "bridgethings_partner_docs_partner_update"
  ON bridgethings_order_partner_documents FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM bridgethings_orders o
      WHERE o.id = bridgethings_order_partner_documents.order_id
        AND o.partner_id = auth.uid()
    )
  );

-- Staff (admin/employee/accountant) can read all so they can attach to parcels.
CREATE POLICY "bridgethings_partner_docs_staff_read"
  ON bridgethings_order_partner_documents FOR SELECT
  USING (bridgethings_current_role() IN ('admin','employee','accountant'));

-- ============================================================
-- Storage bucket for partner-uploaded shipping documents.
-- Same pattern as payment slips: private bucket, partners upload to
-- their own folder, staff reads all.
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('bridgethings-partner-shipping-docs', 'bridgethings-partner-shipping-docs', false)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname LIKE 'bridgethings_partner_shipping_docs_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "bridgethings_partner_shipping_docs_partner_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'bridgethings-partner-shipping-docs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "bridgethings_partner_shipping_docs_partner_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'bridgethings-partner-shipping-docs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "bridgethings_partner_shipping_docs_staff_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'bridgethings-partner-shipping-docs'
    AND bridgethings_current_role() IN ('admin','accountant','employee')
  );
