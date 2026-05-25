// Admin-facing Shipments panel — used inside the Fulfillment modal.
// Lists every parcel for an order, lets staff add new parcels (picking
// items + qty), and mark in-transit parcels as delivered.
//
// A trigger on the DB rolls up the order's fulfillment_status,
// delivery_method, tracking_number and delivered_date based on what's
// been shipped/delivered — callers here just mutate shipments.
import { useState } from 'react';
import {
  useShipmentsForOrder, computeRemainingByItem,
  createShipment, markShipmentDelivered, deleteShipment,
} from '../lib/shipments';
import { COURIERS } from '../lib/couriers';
import { useToast } from '../lib/toast';

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const today   = () => new Date().toISOString().slice(0, 10);

export default function ShipmentsPanel({ order, items, onChanged }) {
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
      {/* Remaining-qty summary so admin can plan */}
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
              return (
                <div key={item.id} style={{display:'flex', justifyContent:'space-between', gap:'0.75rem', flexWrap:'wrap', fontSize:'0.85rem'}}>
                  <span className="font-semibold">{item.product?.name || 'Unknown product'}</span>
                  <span>
                    <span style={{color: done ? 'var(--success)' : 'var(--text)'}}>{r.shipped}</span>
                    {' / '}
                    <span className="text-muted">{r.ordered}</span>
                    {' '}<span className="text-xs text-muted">({pct}%)</span>
                    {r.remaining > 0 && (
                      <span className="text-xs" style={{marginLeft:'0.5rem', color:'var(--warning)'}}>· {r.remaining} pending</span>
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
          <div className="text-sm text-muted" style={{padding:'0.5rem'}}>No shipments yet. Click "Add Shipment" when the first parcel goes out.</div>
        )}
        {shipments.map((s, idx) => (
          <ShipmentCard
            key={s.id}
            shipment={s}
            index={shipments.length - idx}
            total={shipments.length}
            items={items}
            busy={busyId === s.id}
            onDeliver={() => handleMarkDelivered(s.id)}
            onDelete={() => handleDelete(s.id)}
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
              <div className="font-semibold" style={{color:'var(--info)'}}>Awaiting admin dispatch approval</div>
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
        // dispatch === 'approved' — normal flow.
        return anythingRemaining ? (
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
        );
      })()}
    </div>
  );
}

function ShipmentCard({ shipment, index, total, items, busy, onDeliver, onDelete }) {
  const delivered = Boolean(shipment.delivered_date);
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
          <div className="font-semibold" style={{wordBreak:'break-all'}}>{shipment.tracking_number || '—'}</div>
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

  const setQty = (id, value) => {
    const max = remaining[id]?.remaining || 0;
    const n   = Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
    setQtys(prev => ({ ...prev, [id]: n }));
  };

  const totalQty = Object.values(qtys).reduce((s, n) => s + (Number(n) || 0), 0);

  const handleSave = async () => {
    if (totalQty <= 0) { addToast('Add at least one item to the shipment', 'error'); return; }
    if (!courier.trim()) { addToast('Pick a courier', 'error'); return; }
    setSaving(true);
    try {
      await createShipment({
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
      addToast('Shipment recorded', 'success');
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

      <div style={{display:'flex', justifyContent:'flex-end', gap:'0.5rem', marginTop:'1rem'}}>
        <button className="btn btn-secondary" disabled={saving} onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || totalQty === 0} onClick={handleSave}>
          {saving ? 'Saving...' : `Save Shipment (${totalQty} unit${totalQty === 1 ? '' : 's'})`}
        </button>
      </div>
    </div>
  );
}
