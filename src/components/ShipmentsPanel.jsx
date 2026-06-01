// Admin-facing Shipments panel — used inside the Fulfillment modal.
// Lists every parcel for an order, lets staff add new parcels (picking
// items + qty), and mark in-transit parcels as delivered.
//
// A trigger on the DB rolls up the order's fulfillment_status,
// delivery_method, tracking_number and delivered_date based on what's
// been shipped/delivered — callers here just mutate shipments.
import { useEffect, useState } from 'react';
import {
  useShipmentsForOrder, computeRemainingByItem,
  createShipment, markShipmentDelivered, deleteShipment,
  updateShipment,
} from '../lib/shipments';
import { COURIERS } from '../lib/couriers';
import { useToast } from '../lib/toast';
import {
  EWAY_BILL_THRESHOLD, DOC_LABELS,
  useLegacyOrderDocs, useShipmentDocs,
  requestShipmentDocs, getPartnerDocUrl,
} from '../lib/partnerDocs';

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const today   = () => new Date().toISOString().slice(0, 10);

export default function ShipmentsPanel({ order, items, partner, unitCountsByItem = {}, onChanged }) {
  const { addToast } = useToast();
  const { shipments, loading, reload } = useShipmentsForOrder(order?.id);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId]     = useState(null);

  const remaining = computeRemainingByItem(items || [], shipments);
  const anythingRemaining = Object.values(remaining).some(r => r.remaining > 0);

  const handleMarkDelivered = async (shipmentId) => {
    setBusyId(shipmentId);
    try {
      await markShipmentDelivered(shipmentId, today());
      await reload();
      if (onChanged) await onChanged();
      addToast('Shipment marked delivered', 'success');
    } catch (err) {
      console.error('[shipments] deliver failed:', err);
      addToast(err.message || 'Failed to mark delivered', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (shipmentId) => {
    if (!window.confirm('Remove this shipment? The order status will update automatically.')) return;
    setBusyId(shipmentId);
    try {
      await deleteShipment(shipmentId);
      await reload();
      if (onChanged) await onChanged();
      addToast('Shipment removed', 'info');
    } catch (err) {
      console.error('[shipments] delete failed:', err);
      addToast(err.message || 'Failed to remove shipment', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      {/* Shipping Addresses — dispatch needs both Bill To (partner's
            account address, used on the invoice) and Ship To (where the
            parcel physically goes; same as Bill To unless this is a
            drop-ship). Two columns on wide screens, stacks on narrow. */}
      <div style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'0.85rem 1rem', marginBottom:'1rem'}}>
        <div className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.6rem'}}>
          Shipping Addresses
        </div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(240px, 1fr))', gap:'1rem'}}>
          {/* Bill To — always shown, sourced from the partner profile */}
          <div>
            <div className="text-xs text-muted" style={{marginBottom:'0.2rem'}}>Bill To</div>
            <div className="font-semibold">{partner?.name || partner?.company_name || '—'}</div>
            {partner?.company_name && partner?.name && partner.name !== partner.company_name && (
              <div className="text-sm">{partner.company_name}</div>
            )}
            {partner?.address && <div className="text-sm text-muted">{partner.address}</div>}
            {(partner?.city || partner?.state || partner?.pincode) && (
              <div className="text-sm text-muted">
                {[partner.city, partner.state, partner.pincode].filter(Boolean).join(', ')}
              </div>
            )}
            {partner?.phone && <div className="text-sm" style={{marginTop:'0.2rem'}}>📞 {partner.phone}</div>}
            {partner?.gst_number && <div className="text-xs text-muted" style={{marginTop:'0.2rem'}}>GSTIN: {partner.gst_number}</div>}
          </div>

          {/* Ship To — either the drop-ship customer or a "same as Bill To"
              hint, so dispatch never has to guess the destination. */}
          <div>
            <div className="text-xs text-muted" style={{marginBottom:'0.2rem'}}>Ship To</div>
            {order.ship_to_is_different ? (
              <>
                <div className="font-semibold">{order.ship_to_name || '—'}</div>
                {order.ship_to_address && <div className="text-sm text-muted">{order.ship_to_address}</div>}
                {(order.ship_to_city || order.ship_to_state || order.ship_to_pincode) && (
                  <div className="text-sm text-muted">
                    {[order.ship_to_city, order.ship_to_state, order.ship_to_pincode].filter(Boolean).join(', ')}
                  </div>
                )}
                {order.ship_to_phone && <div className="text-sm" style={{marginTop:'0.2rem'}}>📞 {order.ship_to_phone}</div>}
                {order.ship_to_gstin && <div className="text-xs text-muted" style={{marginTop:'0.2rem'}}>GSTIN: {order.ship_to_gstin}</div>}
              </>
            ) : (
              <div className="text-sm text-muted" style={{fontStyle:'italic'}}>Same as Bill To</div>
            )}
          </div>
        </div>
      </div>

      {/* Remaining-qty summary so dispatch can plan. Each item shows:
            shipped / ordered, with the "pending" bucket broken down into
            "to ship" (ops handed off — dispatch's job) vs "with ops"
            (still in production), so dispatch knows exactly how much is
            in their queue per product. */}
      <div style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'0.85rem 1rem', marginBottom:'1rem'}}>
        <div className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.4rem'}}>
          Quantity Status
        </div>
        {items?.length === 0 ? (
          <div className="text-sm text-muted">No items on this order.</div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'0.3rem'}}>
            {items.map(item => {
              const r = remaining[item.id] || { ordered: 0, shipped: 0, remaining: 0 };
              const pct = r.ordered > 0 ? Math.round((r.shipped / r.ordered) * 100) : 0;
              const done = r.remaining <= 0;
              const counts  = unitCountsByItem[item.id] || {};
              const ready   = counts.ready_to_dispatch || 0;
              const withOps = (counts.hold || 0) + (counts.production || 0) + (counts.sent_back || 0);
              return (
                <div key={item.id} style={{display:'flex', justifyContent:'space-between', gap:'0.75rem', flexWrap:'wrap', fontSize:'0.85rem'}}>
                  <span className="font-semibold">{item.product?.name || 'Unknown product'}</span>
                  <span>
                    <span style={{color: done ? 'var(--success)' : 'var(--text)'}}>{r.shipped}</span>
                    {' / '}
                    <span className="text-muted">{r.ordered}</span>
                    {' '}<span className="text-xs text-muted">({pct}%)</span>
                    {ready > 0 && (
                      <span className="badge badge-warning" style={{marginLeft:'0.5rem', fontSize:'0.7rem'}}>{ready} to ship</span>
                    )}
                    {withOps > 0 && (
                      <span className="badge badge-info" style={{marginLeft:'0.25rem', fontSize:'0.7rem'}}>{withOps} with ops</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Existing shipments */}
      <div style={{display:'flex', flexDirection:'column', gap:'0.75rem'}}>
        {loading && <div className="text-sm text-muted">Loading shipments...</div>}
        {!loading && shipments.length === 0 && (
          <div className="text-sm text-muted" style={{padding:'0.5rem'}}>
            No shipments yet. Click "Add Shipment" when the first parcel goes out — you can request the partner's docs from inside the shipment card after it's created.
          </div>
        )}
        {shipments.map((s, idx) => (
          <ShipmentCard
            key={s.id}
            shipment={s}
            index={shipments.length - idx}
            total={shipments.length}
            items={items}
            order={order}
            busy={busyId === s.id}
            onDeliver={() => handleMarkDelivered(s.id)}
            onDelete={() => handleDelete(s.id)}
            onChanged={async () => { await reload(); if (onChanged) await onChanged(); }}
          />
        ))}
      </div>

      {/* Dispatch-approval gate — blocks new shipments until admin clears
          the order. The gate doesn't hide existing shipments or stop the
          employee from filling unit details elsewhere. */}
      {(() => {
        const dispatch = order?.dispatch_approval;
        if (dispatch === 'awaiting_payment') {
          return (
            <div style={{marginTop:'1rem', padding:'0.85rem 1rem', background:'rgba(245,158,11,0.08)', border:'1px solid var(--warning)', borderRadius:'8px', fontSize:'0.85rem'}}>
              <div className="font-semibold" style={{color:'var(--warning)'}}>Awaiting partner payment</div>
              <div className="text-muted" style={{marginTop:'0.25rem'}}>
                You can&apos;t create shipments yet — the partner hasn&apos;t made a payment. Once they pay, an admin will review and clear the order for dispatch.
              </div>
            </div>
          );
        }
        if (dispatch === 'pending') {
          return (
            <div style={{marginTop:'1rem', padding:'0.85rem 1rem', background:'rgba(59,130,246,0.08)', border:'1px solid var(--info)', borderRadius:'8px', fontSize:'0.85rem'}}>
              <div className="font-semibold" style={{color:'var(--info)'}}>Awaiting admin production approval</div>
              <div className="text-muted" style={{marginTop:'0.25rem'}}>
                Partner has paid partially. Admin must clear this order before any parcel can go out.
              </div>
            </div>
          );
        }
        if (dispatch === 'rejected') {
          return (
            <div style={{marginTop:'1rem', padding:'0.85rem 1rem', background:'rgba(239,68,68,0.08)', border:'1px solid var(--danger)', borderRadius:'8px', fontSize:'0.85rem'}}>
              <div className="font-semibold" style={{color:'var(--danger)'}}>Dispatch rejected by admin</div>
              <div className="text-muted" style={{marginTop:'0.25rem'}}>
                The partner has been asked for more payment. Once they pay, the order returns to the admin queue for re-review.
              </div>
            </div>
          );
        }
        // dispatch === 'approved' — normal flow. Docs are now requested
        // per-shipment (inside each ShipmentCard), so no order-level
        // gate is needed; dispatch creates the shipment first, then
        // requests the matching docs from the partner from within that
        // shipment's card. Any legacy order-level docs (pre-migration)
        // surface inside the first shipment's docs panel.
        return (
          <>
            {anythingRemaining ? (
              creating ? (
                <NewShipmentForm
                  order={order}
                  items={items}
                  remaining={remaining}
                  onCancel={() => setCreating(false)}
                  onSaved={async () => {
                    setCreating(false);
                    await reload();
                    if (onChanged) await onChanged();
                  }}
                />
              ) : (
                <button className="btn btn-primary" style={{marginTop:'1rem'}} onClick={() => setCreating(true)}>
                  + Add Shipment
                </button>
              )
            ) : (
              <div className="text-sm" style={{marginTop:'1rem', color:'var(--success)'}}>
                All ordered quantities have been shipped. ✓
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

const ALL_DOC_TYPES = ['invoice', 'dc', 'eway_bill'];

// Per-shipment docs panel — lives inside each ShipmentCard. Read-only
// view of whatever docs were requested when the shipment was created
// (via the NewShipmentForm's integrated picker) plus the partner's
// uploads as they land. Dispatch CANNOT request more docs from here —
// the request UI is intentionally only available inside the "Add
// Shipment" form, so creating-a-shipment-and-requesting-its-docs is
// one atomic action and existing shipments stay clutter-free.
function ShipmentDocsBlock({ shipment, order, isFirstShipment = false }) {
  const { docs, loading } = useShipmentDocs(shipment.id);
  // Load legacy order-level docs only when this is the first shipment —
  // those uploads pre-date per-shipment tracking and conceptually
  // belong to the order's earliest parcel.
  const { docs: legacyDocs } = useLegacyOrderDocs(isFirstShipment ? order.id : null);

  const requested = shipment.partner_docs_status === 'requested';
  const submitted = shipment.partner_docs_status === 'submitted';
  const requestedTypes = shipment.requested_doc_types?.length
    ? shipment.requested_doc_types
    : [];

  const docRows = Object.values(docs);

  // Nothing requested for this shipment AND no legacy docs to show —
  // hide the whole panel so the shipment card stays tight.
  if (!requested && !submitted && !(isFirstShipment && legacyDocs.length > 0)) {
    return null;
  }

  return (
    <div style={{marginTop:'0.6rem', padding:'0.75rem 0.85rem', background:'var(--bg)', borderRadius:'6px', border:'1px dashed var(--border)'}}>
      <div className="font-semibold text-sm" style={{marginBottom:'0.4rem'}}>Shipping Documents</div>

      {/* Legacy order-level docs — only shown on the first shipment so
          they stay attached to the parcel they were originally uploaded
          for, instead of floating in a separate block. */}
      {isFirstShipment && legacyDocs.length > 0 && (
        <div style={{padding:'0.5rem 0.75rem', background:'rgba(100,116,139,0.08)', border:'1px solid var(--border)', borderRadius:'6px', marginBottom:'0.5rem'}}>
          <div className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'0.3rem'}}>
            Previously uploaded (order-level)
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:'0.3rem'}}>
            {legacyDocs.map(d => (
              <div key={d.id} style={{display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap', fontSize:'0.85rem'}}>
                <span style={{minWidth:'140px', fontWeight:600}}>{DOC_LABELS[d.doc_type] || d.doc_type}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    const url = await getPartnerDocUrl(d.storage_path, { download: true });
                    if (url) window.location.href = url;
                  }}
                >
                  Download
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    const url = await getPartnerDocUrl(d.storage_path);
                    if (url) window.open(url, '_blank', 'noopener');
                  }}
                >
                  Preview
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {requested && !submitted && (
        <div style={{padding:'0.5rem 0.75rem', background:'rgba(59,130,246,0.08)', border:'1px solid var(--info)', borderRadius:'6px', fontSize:'0.85rem', marginBottom:'0.5rem'}}>
          <div className="font-semibold" style={{color:'var(--info)'}}>Waiting on partner uploads</div>
          <div className="text-muted" style={{marginTop:'0.2rem'}}>
            Partner has been asked to upload: {requestedTypes.map(t => DOC_LABELS[t] || t).join(', ')}.
          </div>
        </div>
      )}
      {/* Uploaded docs for THIS shipment — Download forces browser save
          so dispatch can print locally and pack the parcel. */}
      {loading ? (
        <div className="text-xs text-muted">Loading documents...</div>
      ) : docRows.length === 0 ? (
        requested && <div className="text-xs text-muted">No documents uploaded yet.</div>
      ) : (
        <div style={{display:'flex', flexDirection:'column', gap:'0.35rem'}}>
          {docRows.map(d => (
            <div key={d.id} style={{display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap', fontSize:'0.85rem'}}>
              <span style={{minWidth:'140px', fontWeight:600}}>{DOC_LABELS[d.doc_type] || d.doc_type}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  const url = await getPartnerDocUrl(d.storage_path, { download: true });
                  if (url) window.location.href = url;
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  const url = await getPartnerDocUrl(d.storage_path);
                  if (url) window.open(url, '_blank', 'noopener');
                }}
              >
                Preview
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShipmentCard({ shipment, index, total, items, order, busy, onDeliver, onDelete, onChanged }) {
  const { addToast } = useToast();
  const delivered = Boolean(shipment.delivered_date);
  const hasTracking = Boolean(shipment.tracking_number?.trim());
  // Inline AWB editor — auto-open when tracking is missing (the
  // "finalize after docs land" workflow). Dispatch can also re-open it
  // later via "Edit tracking" to correct a number.
  const [editingTracking, setEditingTracking] = useState(!hasTracking);
  const [draftTracking, setDraftTracking] = useState(shipment.tracking_number || '');
  const [draftShippedDate, setDraftShippedDate] = useState(shipment.shipped_date || today());
  const [savingTracking, setSavingTracking] = useState(false);

  const handleSaveTracking = async () => {
    if (!draftTracking.trim()) {
      addToast('Enter the AWB / consignment number', 'error');
      return;
    }
    setSavingTracking(true);
    try {
      await updateShipment(shipment.id, {
        trackingNumber: draftTracking,
        shippedDate: draftShippedDate || today(),
      });
      addToast('Tracking number saved', 'success');
      setEditingTracking(false);
      if (onChanged) await onChanged();
    } catch (err) {
      console.error('[shipments] update tracking failed:', err);
      addToast(err.message || 'Failed to save tracking', 'error');
    } finally {
      setSavingTracking(false);
    }
  };

  // Map order_item_id → product name + qty for this shipment
  const itemSummary = (shipment.items || []).map(si => {
    const item = (items || []).find(it => it.id === si.order_item_id);
    return { name: item?.product?.name || 'Item', qty: si.qty };
  });

  return (
    <div style={{background:'var(--card)', border:'1px solid var(--border)', borderRadius:'8px', padding:'0.85rem 1rem'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:'0.5rem', marginBottom:'0.5rem'}}>
        <div className="font-semibold text-sm" style={{color:'var(--primary)'}}>
          Shipment {index} of {total}
          {' '}
          <span className={`badge ${delivered ? 'badge-success' : 'badge-info'}`} style={{marginLeft:'0.4rem'}}>
            {delivered ? 'Delivered' : 'In transit'}
          </span>
        </div>
        <div style={{display:'flex', gap:'0.4rem'}}>
          {!delivered && (
            <button className="btn btn-success btn-sm" disabled={busy} onClick={onDeliver}>
              Mark Delivered
            </button>
          )}
          <button className="btn btn-ghost btn-sm" style={{color:'var(--danger)'}} disabled={busy} onClick={onDelete}>
            Remove
          </button>
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:'0.6rem', fontSize:'0.85rem'}}>
        <div>
          <div className="text-xs text-muted">Courier</div>
          <div className="font-semibold">{shipment.courier || '—'}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Tracking #</div>
          <div style={{display:'flex', alignItems:'center', gap:'0.4rem', flexWrap:'wrap'}}>
            <div className="font-semibold" style={{wordBreak:'break-all'}}>
              {shipment.tracking_number || <span style={{color:'var(--text-muted)', fontWeight:400}}>Not yet entered</span>}
            </div>
            {hasTracking && !editingTracking && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{fontSize:'0.72rem', padding:'0.1rem 0.4rem'}}
                onClick={() => setEditingTracking(true)}
              >
                Edit
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">Shipped</div>
          <div className="font-semibold">{fmtDate(shipment.shipped_date)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Delivered</div>
          <div className="font-semibold">{fmtDate(shipment.delivered_date)}</div>
        </div>
      </div>

      {/* Inline AWB editor — auto-opens when tracking is missing (the
          create-now, finalize-after-docs workflow). Once tracking is in
          place, the editor closes; dispatch can re-open it via the
          "Edit" button on the Tracking # field above. */}
      {editingTracking && (
        <div style={{marginTop:'0.6rem', padding:'0.6rem 0.85rem', background:'#fffbeb', border:'1px solid var(--warning)', borderRadius:'6px'}}>
          <div className="font-semibold text-sm" style={{color:'var(--warning)', marginBottom:'0.3rem'}}>
            {hasTracking ? 'Update tracking' : 'Add tracking — parcel ready to ship'}
          </div>
          {!hasTracking && (
            <div className="text-xs text-muted" style={{marginBottom:'0.5rem'}}>
              Fill this in once the partner has uploaded docs and you've handed the parcel to the courier.
            </div>
          )}
          <div className="form-grid form-grid-2" style={{marginBottom:'0.5rem'}}>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">AWB / Tracking #</label>
              <input
                className="form-input"
                value={draftTracking}
                onChange={e => setDraftTracking(e.target.value)}
                placeholder="AWB / Consignment number"
                disabled={savingTracking}
                autoFocus
              />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">Shipped Date</label>
              <input
                type="date"
                className="form-input"
                value={draftShippedDate}
                onChange={e => setDraftShippedDate(e.target.value)}
                disabled={savingTracking}
              />
            </div>
          </div>
          <div style={{display:'flex', gap:'0.4rem', justifyContent:'flex-end'}}>
            {hasTracking && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={savingTracking}
                onClick={() => {
                  setEditingTracking(false);
                  setDraftTracking(shipment.tracking_number || '');
                  setDraftShippedDate(shipment.shipped_date || today());
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={savingTracking || !draftTracking.trim()}
              onClick={handleSaveTracking}
            >
              {savingTracking ? 'Saving...' : hasTracking ? 'Update tracking' : 'Save tracking'}
            </button>
          </div>
        </div>
      )}

      {itemSummary.length > 0 && (
        <div style={{marginTop:'0.5rem', fontSize:'0.8rem'}}>
          <span className="text-muted">Contents: </span>
          {itemSummary.map((s, i) => (
            <span key={i} style={{fontWeight:600}}>
              {i > 0 && ', '}
              {s.qty} × {s.name}
            </span>
          ))}
        </div>
      )}
      {shipment.notes && (
        <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>Note: {shipment.notes}</div>
      )}

      {/* Per-shipment docs — request, status, downloads. Only renders
          for drop-ship orders; same-address orders never need partner
          paperwork. The oldest shipment (index === 1) also shows any
          legacy order-level docs at the top so they stay attached to
          the shipment they were originally uploaded for. */}
      {order?.ship_to_is_different && (
        <ShipmentDocsBlock
          shipment={shipment}
          order={order}
          isFirstShipment={index === 1}
        />
      )}
    </div>
  );
}

function NewShipmentForm({ order, items, remaining, onCancel, onSaved }) {
  const { addToast } = useToast();
  // Default qty for each order_item = its remaining qty. Admin trims down
  // to whatever's actually being shipped.
  const initial = (items || []).reduce((acc, it) => {
    acc[it.id] = remaining[it.id]?.remaining || 0;
    return acc;
  }, {});
  const [qtys, setQtys]     = useState(initial);
  const [courier, setCourier] = useState(order?.delivery_method || COURIERS[0]?.name || '');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shippedDate, setShippedDate]       = useState(today());
  const [markDelivered, setMarkDelivered]   = useState(false);
  const [deliveredDate, setDeliveredDate]   = useState(today());
  const [notes, setNotes]                   = useState('');
  const [saving, setSaving]                 = useState(false);

  // Drop-ship orders: dispatch picks which docs to request from the
  // partner in the same form. Same-address orders skip this entirely.
  const dropShip = !!order?.ship_to_is_different;
  // Compute the value of THIS shipment from the picked qtys × unit_price
  // so we can default the doc picks based on the parcel value (not the
  // whole order's value).
  const shipmentValue = (items || []).reduce((sum, it) => {
    const qty = Number(qtys[it.id]) || 0;
    const price = Number(it.unit_price) || 0;
    return sum + qty * price;
  }, 0);
  const heavyShipment = shipmentValue >= EWAY_BILL_THRESHOLD;
  // Track whether the user has manually edited the picks. If not, keep
  // the defaults in sync with the live shipment value.
  const [docsTouched, setDocsTouched] = useState(false);
  const [docPicks, setDocPicks] = useState(() => new Set(heavyShipment ? ALL_DOC_TYPES : ['dc']));
  useEffect(() => {
    if (docsTouched || !dropShip) return;
    setDocPicks(new Set(heavyShipment ? ALL_DOC_TYPES : ['dc']));
  }, [heavyShipment, dropShip, docsTouched]);
  const toggleDocPick = (docType) => {
    setDocsTouched(true);
    setDocPicks(prev => {
      const next = new Set(prev);
      if (next.has(docType)) next.delete(docType); else next.add(docType);
      return next;
    });
  };

  const setQty = (id, value) => {
    const max = remaining[id]?.remaining || 0;
    const n   = Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
    setQtys(prev => ({ ...prev, [id]: n }));
  };

  const totalQty = Object.values(qtys).reduce((s, n) => s + (Number(n) || 0), 0);

  // Internal helper — used by both action buttons. `requestDocs=true`
  // chains a doc request to the new shipment; false saves the shipment
  // only and lets dispatch request docs later from inside the card.
  const persistShipment = async ({ requestDocs }) => {
    if (totalQty <= 0) { addToast('Add at least one item to the shipment', 'error'); return; }
    if (!courier.trim()) { addToast('Pick a courier', 'error'); return; }
    if (requestDocs && (!dropShip || docPicks.size === 0)) {
      addToast('Tick at least one document to request', 'error');
      return;
    }
    setSaving(true);
    try {
      const newShipment = await createShipment({
        orderId:        order.id,
        courier,
        trackingNumber,
        shippedDate,
        deliveredDate:  markDelivered ? deliveredDate : null,
        notes,
        items: Object.entries(qtys)
          .filter(([, q]) => Number(q) > 0)
          .map(([orderItemId, q]) => ({ orderItemId, qty: q })),
      });

      let docsRequested = 0;
      if (requestDocs && newShipment?.id && docPicks.size > 0) {
        try {
          await requestShipmentDocs(newShipment.id, Array.from(docPicks));
          docsRequested = docPicks.size;
        } catch (docErr) {
          // Shipment is saved either way — surface the doc failure so
          // dispatch knows to request manually from inside the card.
          console.error('[shipments] auto-request docs failed:', docErr);
          addToast('Shipment saved, but the doc request failed. You can request from inside the shipment card.', 'error');
        }
      }

      addToast(
        docsRequested > 0
          ? `Shipment recorded and ${docsRequested} document(s) requested from partner`
          : 'Shipment recorded',
        'success',
      );
      await onSaved();
    } catch (err) {
      console.error('[shipments] create failed:', err);
      addToast(err.message || 'Failed to record shipment', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{marginTop:'1rem', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem'}}>
      <div className="font-semibold" style={{marginBottom:'0.75rem'}}>New Shipment</div>

      {/* Per-item qty inputs */}
      <div style={{display:'flex', flexDirection:'column', gap:'0.5rem', marginBottom:'1rem'}}>
        {items.map(item => {
          const max = remaining[item.id]?.remaining || 0;
          return (
            <div key={item.id} style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'0.75rem', flexWrap:'wrap'}}>
              <div>
                <div className="font-semibold text-sm">{item.product?.name || 'Item'}</div>
                <div className="text-xs text-muted">{max} remaining of {item.qty}</div>
              </div>
              <input
                type="number"
                min="0"
                max={max}
                step="1"
                className="form-input"
                value={qtys[item.id] ?? 0}
                onChange={e => setQty(item.id, e.target.value)}
                disabled={max === 0}
                style={{width:'100px', textAlign:'right'}}
              />
            </div>
          );
        })}
      </div>

      {/* Courier + tracking + dates */}
      <div className="form-grid form-grid-2">
        <div className="form-group">
          <label className="form-label">Courier</label>
          <input
            className="form-input"
            list="shipment-courier-options"
            value={courier}
            onChange={e => setCourier(e.target.value)}
            placeholder="Blue Dart, DTDC, India Post..."
          />
          <datalist id="shipment-courier-options">
            {COURIERS.map(c => <option key={c.id} value={c.name} />)}
          </datalist>
        </div>
        <div className="form-group">
          <label className="form-label">Tracking #</label>
          <input
            className="form-input"
            value={trackingNumber}
            onChange={e => setTrackingNumber(e.target.value)}
            placeholder="AWB / Consignment number"
          />
          <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>
            Optional — leave blank if you don't have it yet. You can add it from the shipment card after the partner uploads docs and the parcel goes out.
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Shipped Date</label>
          <input type="date" className="form-input" value={shippedDate} onChange={e => setShippedDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" style={{display:'flex', alignItems:'center', gap:'0.4rem'}}>
            <input type="checkbox" checked={markDelivered} onChange={e => setMarkDelivered(e.target.checked)} />
            Already Delivered?
          </label>
          {markDelivered && (
            <input type="date" className="form-input" value={deliveredDate} onChange={e => setDeliveredDate(e.target.value)} />
          )}
        </div>
        <div className="form-group" style={{gridColumn:'1 / -1'}}>
          <label className="form-label">Notes (optional)</label>
          <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything the partner should know" />
        </div>
      </div>

      {/* Drop-ship: pick the docs to request from the partner for THIS
          parcel in the same form. Defaults flex with the live shipment
          value (DC alone for sub-₹50k, all three for ≥₹50k); dispatch
          can override. Same-address orders skip this block. */}
      {dropShip && (
        <div style={{marginTop:'1rem', padding:'0.85rem 1rem', background:'#fffbeb', border:'1px solid var(--warning)', borderRadius:'8px'}}>
          <div className="font-semibold text-sm" style={{color:'var(--warning)', marginBottom:'0.3rem'}}>
            Request docs from partner for this shipment
          </div>
          <div className="text-xs text-muted" style={{marginBottom:'0.6rem'}}>
            Tick the docs the partner should upload for this parcel only. Shipment value: <strong>₹{shipmentValue.toLocaleString('en-IN')}</strong>
            {heavyShipment ? ' — Invoice + DC + E-way Bill typically required.' : ' — DC is usually enough.'}
            {' '}Untick all to skip the request entirely.
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:'0.3rem'}}>
            {ALL_DOC_TYPES.map(docType => (
              <label key={docType} style={{display:'flex', alignItems:'center', gap:'0.5rem', fontSize:'0.85rem', cursor:'pointer'}}>
                <input
                  type="checkbox"
                  checked={docPicks.has(docType)}
                  onChange={() => toggleDocPick(docType)}
                  disabled={saving}
                />
                {DOC_LABELS[docType]}
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{display:'flex', justifyContent:'flex-end', gap:'0.5rem', marginTop:'1rem', flexWrap:'wrap'}}>
        <button
          className="btn btn-secondary"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        {/* Single morphing action — saves the shipment, and (when
            drop-ship + at least one doc ticked) also files the doc
            request in the same click. Same-address orders or "untick
            all" cases just save the shipment. */}
        <button
          className="btn btn-primary"
          disabled={saving || totalQty === 0}
          onClick={() => persistShipment({ requestDocs: dropShip && docPicks.size > 0 })}
        >
          {saving
            ? 'Saving...'
            : dropShip && docPicks.size > 0
              ? `Save Shipment & Request ${docPicks.size} doc(s)`
              : `Save Shipment (${totalQty} unit${totalQty === 1 ? '' : 's'})`}
        </button>
      </div>
    </div>
  );
}
