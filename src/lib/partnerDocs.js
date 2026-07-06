// src/lib/partnerDocs.js — Partner-uploaded shipping documents for
// drop-ship orders (the partner's own invoice / DC / e-way bill that
// BridgeThings encloses in the parcel when shipping to the partner's
// end customer).
//
// Storage: private bucket bridgethings-partner-shipping-docs, paths
// shaped as <partnerId>/<orderId>/<docType>-<timestamp>.<ext>.
// Table:   bridgethings_order_partner_documents, one row per
// (order_id, doc_type) with re-uploads overwriting via upsert.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { notify, loadOrderParty, orderShortId } from './notify';

const TABLE       = 'bridgethings_order_partner_documents';
const DOCS_BUCKET = 'bridgethings-partner-shipping-docs';

export const DOC_LABELS = {
  invoice:   'Tax Invoice',
  dc:        'Delivery Challan',
  eway_bill: 'E-way Bill',
};

// Threshold the GST e-way bill rule kicks in at.
export const EWAY_BILL_THRESHOLD = 50000;

// Per-shipment variant: which docs the partner must upload for THIS
// specific shipment. Each shipment is its own bill of materials with
// its own value + items, so each can request its own set.
export function requiredDocsForShipment(shipment) {
  return shipment?.requested_doc_types?.length
    ? shipment.requested_doc_types
    : [];
}

// Hook: load order-level legacy docs (rows with shipment_id IS NULL),
// uploaded under the old order-level flow before docs became per
// shipment. Surfaced inside the first shipment's card so the legacy
// uploads stay with the shipment they were originally meant for,
// instead of floating in their own block.
export function useLegacyOrderDocs(orderId) {
  const [docs, setDocs]       = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) { setDocs([]); return; }
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('order_id', orderId)
      .is('shipment_id', null);
    if (error) {
      console.error('[partnerDocs] legacy load failed:', error);
      setDocs([]);
    } else {
      setDocs(data || []);
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => { load(); }, [load]);
  return { docs, loading, reload: load };
}


// Mint a short-lived signed URL so the staff member (or partner) can
// open a document from the private bucket. Pass { download: true } to
// have the storage server set Content-Disposition: attachment so the
// browser saves the file instead of opening it inline — used by the
// dispatch "Download" button.
export async function getPartnerDocUrl(path, { download = false } = {}) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(DOCS_BUCKET)
    .createSignedUrl(path, 60 * 10, download ? { download: true } : undefined);
  if (error) {
    console.error('[partnerDocs] signed url failed:', error);
    return null;
  }
  return data?.signedUrl || null;
}

// ──────────────────────────────────────────────────────────────────────
// Per-shipment doc helpers. Each shipment carries its own paperwork —
// dispatch ticks doc types per parcel, partner uploads per parcel,
// dispatch downloads per parcel. Previously this was at the order level
// (one set per order) which didn't fit split shipments.
// ──────────────────────────────────────────────────────────────────────

// Hook: load every doc uploaded for ONE shipment, keyed by doc_type.
export function useShipmentDocs(shipmentId) {
  const [docs, setDocs]       = useState({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!shipmentId) { setDocs({}); return; }
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('shipment_id', shipmentId);
    if (error) {
      console.error('[partnerDocs] shipment load failed:', error);
      setDocs({});
    } else {
      const byType = {};
      for (const row of data || []) byType[row.doc_type] = row;
      setDocs(byType);
    }
    setLoading(false);
  }, [shipmentId]);

  useEffect(() => { load(); }, [load]);
  return { docs, loading, reload: load };
}

// Dispatch ticks the doc types they need for this specific shipment
// and clicks Request. Writes the picked list + flips the shipment's
// partner_docs_status so the partner UI un-blocks for it.
export async function requestShipmentDocs(shipmentId, docTypes) {
  if (!shipmentId)        throw new Error('shipmentId is required');
  if (!docTypes?.length)  throw new Error('Pick at least one document type to request');
  const { data: ship } = await supabase
    .from('bridgethings_shipments')
    .select('order_id')
    .eq('id', shipmentId)
    .maybeSingle();

  const { error } = await supabase
    .from('bridgethings_shipments')
    .update({
      requested_doc_types: docTypes,
      partner_docs_status: 'requested',
    })
    .eq('id', shipmentId);
  if (error) throw error;

  // Notify the partner which documents to upload for this parcel.
  if (ship?.order_id) {
    const party = await loadOrderParty(ship.order_id);
    if (party?.partner?.email) {
      const docList = docTypes.map(t => DOC_LABELS[t] || t).join(', ');
      notify('docs_requested',
        { email: party.partner.email, role: 'partner', userId: party.partner.id },
        { orderShortId: orderShortId(ship.order_id), partnerName: party.partner.name, docList },
        { relatedOrderId: ship.order_id, relatedShipmentId: shipmentId });
    }
  }
}

// Partner uploads one document for a specific shipment. After the
// upload lands, checks whether all requested docs for this shipment are
// now in and flips partner_docs_status='submitted' if so — same
// auto-complete behaviour as the order-level flow.
export async function uploadShipmentDoc({
  orderId, partnerId, shipmentId, docType, file, shipment,
}) {
  if (!orderId)    throw new Error('orderId is required');
  if (!partnerId)  throw new Error('partnerId is required');
  if (!shipmentId) throw new Error('shipmentId is required');
  if (!docType)    throw new Error('docType is required');
  if (!file)       throw new Error('Please choose a file');

  // Store under <partnerId>/<orderId>/shipments/<shipmentId>/... so the
  // RLS first-folder check still works and each shipment's files have
  // their own subdirectory in the bucket.
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
  const path = `${partnerId}/${orderId}/shipments/${shipmentId}/${docType}-${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from(DOCS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      { order_id: orderId, shipment_id: shipmentId, doc_type: docType, storage_path: path },
      { onConflict: 'shipment_id,doc_type' },
    )
    .select()
    .single();
  if (error) throw error;

  // If all requested docs for this shipment are now uploaded, flip
  // partner_docs_status='submitted' via the SECURITY DEFINER RPC. A direct
  // UPDATE on bridgethings_shipments is RLS-blocked for partners (staff-only
  // write policy) and silently matches 0 rows — the status would stay
  // 'requested' forever while the "ready to ship" email fired anyway. The
  // RPC verifies ownership + completeness server-side and returns whether
  // the status actually transitioned; only then do we notify dispatch.
  if (shipment) {
    try {
      const { data: flipped, error: rpcErr } = await supabase
        .rpc('bridgethings_mark_shipment_docs_submitted', { p_shipment_id: shipmentId });
      if (rpcErr) throw rpcErr;
      if (flipped === true) {
        // All requested docs are in — tell dispatch the parcel can ship.
        const party = await loadOrderParty(orderId);
        notify('docs_submitted', { group: 'dispatch' },
          { orderShortId: orderShortId(orderId), partnerName: party?.partner?.name || 'A partner' },
          { relatedOrderId: orderId, relatedShipmentId: shipmentId });
      }
    } catch (e) {
      console.error('[partnerDocs] mark shipment submitted failed:', e);
    }
  }

  return data;
}
