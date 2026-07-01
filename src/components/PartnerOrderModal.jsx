// Shared partner-facing modal: Details + Tracking for a single order.
// Used by /partner/orders and /partner (dashboard) so clicking an order ID
// anywhere gives the partner the same view.
import { useEffect, useMemo, useState } from 'react';
import { loadUnitDetailsForItems } from '../lib/orderUnits';
import { acceptDeliveryCounter, declineDeliveryCounter, saveShipTo, derivePartnerStatusLabel, orderRef } from '../lib/orders';
import { DOC_LABELS, EWAY_BILL_THRESHOLD, requiredDocsForShipment, useLegacyOrderDocs, useShipmentDocs, uploadShipmentDoc, getPartnerDocUrl } from '../lib/partnerDocs';
import { usePaymentsForOrder, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, submitPaymentProof, getPaymentSlipUrl } from '../lib/payments';
import { useAuth } from '../lib/auth';
import { productNameForRole } from '../lib/productName';
import { useShipmentsForOrder } from '../lib/shipments';
import { IGST_LABEL } from '../lib/tax';
import { useToast } from '../lib/toast';

const ORDER_STATUS_LABELS = { draft:'Draft', pending_approval:'Awaiting Confirmation', active:'In Progress', completed:'Completed', rejected:'Rejected' };
const ORDER_STATUS_COLORS = { draft:'badge-gray', pending_approval:'badge-warning', active:'badge-info', completed:'badge-success', rejected:'badge-danger' };

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';

export default function PartnerOrderModal({ order, onClose, onChanged, detailsOnly = false }) {
  const { addToast } = useToast();
  const [tab, setTab] = useState('details');
  const [counterBusy, setCounterBusy] = useState(false);
  // Unit details for this order's items, lazily loaded on open.
  const [unitsByItem, setUnitsByItem] = useState(null);

  const counterPending = order.delivery_negotiation_status === 'counter_sent'
    && order.status === 'pending_approval';

  const handleAcceptCounter = async () => {
    setCounterBusy(true);
    try {
      await acceptDeliveryCounter(order.id);
      addToast('Counter-date accepted. Your order is now active.', 'success');
      if (onChanged) await onChanged();
      onClose();
    } catch (err) {
      console.error('[PartnerOrderModal] accept counter failed:', err);
      addToast(err.message || 'Failed to accept counter', 'error');
    } finally {
      setCounterBusy(false);
    }
  };

  const handleDeclineCounter = async () => {
    if (!window.confirm('Declining will reject this purchase order. Continue?')) return;
    setCounterBusy(true);
    try {
      await declineDeliveryCounter(order.id);
      addToast('Counter-date declined. Order rejected.', 'info');
      if (onChanged) await onChanged();
      onClose();
    } catch (err) {
      console.error('[PartnerOrderModal] decline counter failed:', err);
      addToast(err.message || 'Failed to decline counter', 'error');
    } finally {
      setCounterBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const itemIds = (order.items || []).map(i => i.id);
      const map = await loadUnitDetailsForItems(itemIds);
      if (!cancelled) setUnitsByItem(map);
    })();
    return () => { cancelled = true; };
  }, [order]);

  // Per-item delivered quantity, derived from shipments that have a
  // delivered_date. Lets the Details badge show a dispatched unit as
  // "Delivered" once its parcel has landed, instead of staying "Dispatched".
  const { shipments } = useShipmentsForOrder(order?.id);
  const deliveredByItem = useMemo(() => {
    const m = {};
    for (const s of shipments || []) {
      if (!s.delivered_date) continue;
      for (const si of (s.items || [])) {
        m[si.order_item_id] = (m[si.order_item_id] || 0) + (Number(si.qty) || 0);
      }
    }
    return m;
  }, [shipments]);

  const itemsSubtotal = (order.items || []).reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
    0,
  );
  const cableTotal = (order.items || []).reduce((s, i) => s + (Number(i.cable_charge) || 0), 0);
  const shipping = Number(order.shipping_cost) || 0;
  const tax      = Number(order.tax_amount)    || 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'820px'}}>
        <div className="modal-header">
          <h3>
            Order {orderRef(order)}{' '}
            {(() => {
              // PO context (detailsOnly): show the order-level status only —
              // production states like "Hold" are internal to ops and don't
              // belong on the partner's PO view.
              const s = detailsOnly
                ? { label: ORDER_STATUS_LABELS[order.status] || order.status,
                    className: ORDER_STATUS_COLORS[order.status] || 'badge-gray' }
                : derivePartnerStatusLabel(order);
              return (
                <span className={`badge ${s.className}`} style={{marginLeft:'0.5rem', verticalAlign:'middle'}}>{s.label}</span>
              );
            })()}
          </h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {order.status === 'rejected' && (
            <div style={{padding:'0.85rem 1rem', background:'rgba(239,68,68,0.08)', border:'1px solid var(--danger)', borderRadius:'8px', marginBottom:'1rem'}}>
              <div className="font-semibold text-sm" style={{color:'var(--danger)'}}>This purchase order was rejected by Bridge Things.</div>
              {order.employee_notes && (
                <div className="text-sm" style={{marginTop:'0.4rem'}}>
                  <span className="text-muted">Reason:</span> {order.employee_notes}
                </div>
              )}
              <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>
                You can place a new purchase order from the catalog.
              </div>
            </div>
          )}

          {order.dispatch_approval === 'rejected' && order.status !== 'rejected' && (
            <div style={{padding:'0.85rem 1rem', background:'rgba(245,158,11,0.08)', border:'1px solid var(--warning)', borderRadius:'8px', marginBottom:'1rem'}}>
              <div className="font-semibold text-sm" style={{color:'var(--warning)'}}>
                Bridge Things needs more payment before dispatching this order.
              </div>
              {order.dispatch_rejection_note && (
                <div className="text-sm" style={{marginTop:'0.4rem'}}>
                  <span className="text-muted">Message:</span> {order.dispatch_rejection_note}
                </div>
              )}
              <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>
                Record another payment to bring the balance up — your order will automatically return to the admin for review.
              </div>
            </div>
          )}

          {counterPending && (
            <div style={{padding:'1rem', background:'#fffbeb', border:'1px solid var(--warning)', borderRadius:'8px', marginBottom:'1rem'}}>
              <div className="font-semibold" style={{color:'var(--warning)'}}>
                Bridge Things proposed a different dispatch date
              </div>
              <div style={{display:'flex', flexWrap:'wrap', gap:'1.5rem', marginTop:'0.6rem'}}>
                <div>
                  <div className="text-xs text-muted">Your Requested Date</div>
                  <div className="font-semibold">{fmtDate(order.requested_delivery_date)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Proposed Date</div>
                  <div className="font-semibold">{fmtDate(order.proposed_delivery_date)}</div>
                </div>
              </div>
              {order.delivery_negotiation_note && (
                <div className="text-sm" style={{marginTop:'0.6rem'}}>
                  <span className="text-muted">Message:</span> {order.delivery_negotiation_note}
                </div>
              )}
              <div style={{display:'flex', gap:'0.5rem', marginTop:'0.85rem', flexWrap:'wrap'}}>
                <button className="btn btn-primary btn-sm" disabled={counterBusy} onClick={handleAcceptCounter}>
                  {counterBusy ? 'Working...' : 'Accept Proposed Date'}
                </button>
                <button className="btn btn-danger btn-sm" disabled={counterBusy} onClick={handleDeclineCounter}>
                  Decline (Reject PO)
                </button>
              </div>
            </div>
          )}

          {(order.requested_delivery_date || order.committed_delivery_date) && (
            <div style={{padding:'0.6rem 0.85rem', background:'rgba(34,197,94,0.08)', border:'1px solid var(--success)', borderRadius:'8px', marginBottom:'1rem', fontSize:'0.85rem', display:'flex', flexWrap:'wrap', gap:'1.5rem'}}>
              {order.requested_delivery_date && (
                <div>
                  <span className="text-muted">Requested dispatch date:</span>{' '}
                  <span className="font-semibold">{fmtDate(order.requested_delivery_date)}</span>
                </div>
              )}
              {order.committed_delivery_date && (
                <div>
                  <span className="text-muted">Committed dispatch date:</span>{' '}
                  <span className="font-semibold" style={{color:'var(--success)'}}>{fmtDate(order.committed_delivery_date)}</span>
                </div>
              )}
            </div>
          )}

          {/* Tab strip — hidden in detailsOnly mode (Purchase Orders page),
              where the order isn't yet a fulfilment context for the partner. */}
          {!detailsOnly && (
            <div className="tabs" style={{marginBottom:'1.25rem'}}>
              <button
                type="button"
                className={`tab${tab === 'details' ? ' active' : ''}`}
                onClick={() => setTab('details')}
              >
                Details
              </button>
              <button
                type="button"
                className={`tab${tab === 'payments' ? ' active' : ''}`}
                onClick={() => setTab('payments')}
              >
                Payments
              </button>
              <button
                type="button"
                className={`tab${tab === 'tracking' ? ' active' : ''}`}
                onClick={() => setTab('tracking')}
              >
                Tracking
              </button>
            </div>
          )}

          {(detailsOnly || tab === 'details') && (
            <DetailsTab
              order={order}
              itemsSubtotal={itemsSubtotal}
              cableTotal={cableTotal}
              shipping={shipping}
              tax={tax}
              unitsByItem={unitsByItem}
              deliveredByItem={deliveredByItem}
              // Production state (per-item badge + unit details) only makes
              // sense once payment has cleared and dispatch is approved —
              // before that, ops hasn't started and everything is 'hold' by
              // default. Hide entirely from the PO modal too.
              showUnits={!detailsOnly && order.dispatch_approval === 'approved'}
            />
          )}

          {!detailsOnly && tab === 'tracking' && (
            <TrackingTab order={order} onChanged={onChanged} />
          )}

          {!detailsOnly && tab === 'payments' && (
            <PaymentsTab order={order} />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailsTab({ order, itemsSubtotal, cableTotal = 0, shipping, tax, unitsByItem, deliveredByItem = {}, showUnits = true }) {
  const { user } = useAuth();
  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Items
      </h4>
      <div style={{display:'flex', flexDirection:'column', gap:'0.75rem', marginBottom:'1.25rem'}}>
        {(order.items || []).map(item => {
          // Partner only sees a unit AFTER it's been dispatched (packed into
          // a parcel by ops/dispatch). Units still in progress / sent to
          // dispatch are internal — the per-unit details (serial, SIM,
          // calibration, certs) only become useful to the partner once the
          // device is actually on its way.
          const allUnits = unitsByItem?.[item.id] || [];
          const units = allUnits.filter(u => u.production_status === 'dispatched');
          const price = Number(item.unit_price) || 0;
          const qty   = Number(item.qty) || 0;
          return (
            <div key={item.id} style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
                <div style={{display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap'}}>
                  <div className="font-semibold">{productNameForRole(item.product, user?.role) || 'Unknown product'}</div>
                  {showUnits && (() => {
                    // Show one badge per production state present on this
                    // item's units, so the partner can see partial progress
                    // at a glance — e.g. "1 Dispatched · 1 In Production"
                    // instead of a single rolled-up "In Production" that
                    // hides the unit that's already on its way.
                    //
                    // 'sent_back' (internal ops/dispatch back-and-forth) is
                    // merged into 'production' so the partner only sees
                    // forward progress.
                    const counts = allUnits.reduce((acc, u) => {
                      let s = u.production_status || 'hold';
                      if (s === 'sent_back') s = 'production';
                      acc[s] = (acc[s] || 0) + 1;
                      return acc;
                    }, {});
                    // A 'dispatched' unit is "Delivered" once its parcel has a
                    // delivered_date, else "Shipped" (in transit). Split the
                    // dispatched count using this item's delivered quantity so
                    // the badge matches the My Orders list (which is already
                    // shipment-aware) instead of showing a stale "Dispatched".
                    const dispatched = counts.dispatched || 0;
                    if (dispatched > 0) {
                      const deliveredQty = Math.min(dispatched, deliveredByItem[item.id] || 0);
                      const shippedQty   = dispatched - deliveredQty;
                      delete counts.dispatched;
                      if (deliveredQty > 0) counts.delivered = deliveredQty;
                      if (shippedQty   > 0) counts.shipped   = shippedQty;
                    }
                    if (Object.keys(counts).length === 0) {
                      // Units haven't loaded yet — single fallback badge from
                      // the item-level rollup.
                      const s = item.production_status || 'hold';
                      const fallback = {
                        hold:              { className: 'badge-info',    label: 'In Progress' },
                        production:        { className: 'badge-info',    label: 'In Production' },
                        sent_back:         { className: 'badge-info',    label: 'In Production' },
                        ready_to_dispatch: { className: 'badge-warning', label: 'Sent for Dispatch' },
                        dispatched:        { className: 'badge-success', label: 'Dispatched' },
                      }[s] || { className: 'badge-gray', label: s };
                      return <span className={`badge ${fallback.className}`}>{fallback.label}</span>;
                    }
                    const ORDER = ['hold', 'production', 'ready_to_dispatch', 'shipped', 'delivered'];
                    const LBL = {
                      hold:              'In Progress',
                      production:        'In Production',
                      ready_to_dispatch: 'Sent for Dispatch',
                      shipped:           'Shipped',
                      delivered:         'Delivered',
                    };
                    const CLS = {
                      hold:              'badge-info',
                      production:        'badge-info',
                      ready_to_dispatch: 'badge-warning',
                      shipped:           'badge-purple',
                      delivered:         'badge-success',
                    };
                    return (
                      <span style={{display:'inline-flex', gap:'0.25rem', flexWrap:'wrap'}}>
                        {ORDER.filter(s => counts[s]).map(s => (
                          <span key={s} className={`badge ${CLS[s]}`}>{counts[s]} {LBL[s]}</span>
                        ))}
                      </span>
                    );
                  })()}
                </div>
                <div className="text-sm font-semibold" style={{color:'var(--primary)'}}>
                  {qty} × {fmtINR(price)} = {fmtINR(qty * price)}
                </div>
              </div>
              {item.notes && <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>Note: {item.notes}</div>}
              {Number(item.cable_charge) > 0 && (
                <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>
                  Extra cable: {item.extra_cable_m} m/unit · {fmtINR(item.cable_charge)}
                </div>
              )}
              {showUnits && units.length > 0 && (
                <div style={{marginTop:'0.75rem'}}>
                  <div className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.4rem'}}>
                    Unit details
                  </div>
                  <div className="table-wrap">
                    <table style={{margin:0}}>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Type</th>
                          <th>Serial</th>
                          <th>SIM</th>
                          <th>Calibrated</th>
                          <th>Cal. Cert</th>
                          <th>Warranty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {units.map(u => (
                          <tr key={u.unit_index}>
                            <td className="text-sm font-semibold">{u.unit_index}</td>
                            <td className="text-sm">{u.device_type || '—'}</td>
                            <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{u.serial_number || '—'}</code></td>
                            <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{u.sim || '—'}</code></td>
                            <td className="text-sm">{fmtDate(u.calibrated_on)}</td>
                            <td className="text-sm">
                              {u.calibration_certificate_url
                                ? <a href={u.calibration_certificate_url} target="_blank" rel="noreferrer" style={{color:'var(--primary)'}}>View</a>
                                : '—'}
                            </td>
                            <td className="text-sm">
                              {u.warranty_certificate_url
                                ? <a href={u.warranty_certificate_url} target="_blank" rel="noreferrer" style={{color:'var(--primary)'}}>View</a>
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Amount Breakdown
      </h4>
      <div style={{padding:'1rem', border:'1px solid var(--border)', borderRadius:'8px', display:'flex', flexDirection:'column', gap:'0.3rem'}}>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
          <span>Items subtotal</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(itemsSubtotal)}</span>
        </div>
        {cableTotal > 0 && (
          <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
            <span>Extra cable</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(cableTotal)}</span>
          </div>
        )}
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
          <span>Shipping{order.delivery_method ? ` (${order.delivery_method})` : ''}</span>
          <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shipping)}</span>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', borderTop:'1px dashed var(--border)', paddingTop:'0.4rem', marginTop:'0.2rem'}}>
          <span style={{fontWeight:600}}>Total before IGST</span>
          <span style={{fontWeight:600}}>{fmtINR(itemsSubtotal + cableTotal + shipping)}</span>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
          <span>{IGST_LABEL}</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(tax)}</span>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'1rem', borderTop:'1px solid var(--border)', paddingTop:'0.5rem', marginTop:'0.25rem'}}>
          <span style={{fontWeight:700}}>Total payable</span>
          <span style={{fontWeight:700, color:'var(--primary)', fontSize:'1.2rem'}}>{fmtINR(order.total_amount)}</span>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.85rem', marginTop:'0.4rem'}}>
          <span className="text-muted">Amount paid</span>
          <span style={{fontWeight:600, color:'var(--success)'}}>{fmtINR(order.amount_paid)}</span>
        </div>
        {(() => {
          const outstanding = Math.max(0, (Number(order.total_amount) || 0) - (Number(order.amount_paid) || 0));
          if (outstanding <= 0) return null;
          return (
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.85rem', marginTop:'0.2rem'}}>
              <span className="text-muted">Balance remaining</span>
              <span style={{fontWeight:700, color:'var(--danger)'}}>{fmtINR(outstanding)}</span>
            </div>
          );
        })()}
      </div>
    </>
  );
}

function TrackingTab({ order, onChanged }) {
  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Shipments
      </h4>
      <PartnerShipmentsList order={order} />

      <PartnerShippingSection order={order} onChanged={onChanged} />
    </>
  );
}

// Payments tab — payment summary card + slip upload form + history.
// Split out from Tracking so the partner can find payment actions
// without scrolling past shipment details.
function PaymentsTab({ order }) {
  // Load payments once at this level so both the summary header (needs
  // the pending-verification total) and the section below (history table
  // + upload form) use the same data and avoid a duplicate fetch.
  const { payments, loading: paymentsLoading, reload: reloadPayments } = usePaymentsForOrder(order.id);
  const total       = Number(order.total_amount) || 0;
  const paid        = Number(order.amount_paid)  || 0;
  const outstanding = Math.max(0, total - paid);
  const pct         = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  // Amount the partner has submitted slips for but accountant hasn't yet
  // verified. These rows are in the DB with status='pending_verification'
  // — they DON'T count toward order.amount_paid until the accountant
  // verifies. Surfacing them here gives the partner immediate feedback
  // that their submission was registered.
  const pendingVerification = payments
    .filter(p => p.status === 'pending_verification')
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Payment
      </h4>
      <div style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem'}}>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:'1rem'}}>
          <div>
            <div className="text-xs text-muted">Status</div>
            <div>
              <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                {order.payment_status || 'pending'}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">Total Payable</div>
            <div className="font-semibold" style={{color:'var(--primary)'}}>{fmtINR(total)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">You've Paid</div>
            <div className="font-semibold" style={{color:'var(--success)'}}>{fmtINR(paid)}</div>
            {pendingVerification > 0 && (
              <div className="text-xs" style={{color:'var(--warning)', marginTop:'0.2rem'}}>
                + {fmtINR(pendingVerification)} pending verification
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted">Balance Remaining</div>
            <div className="font-semibold" style={{color: outstanding > 0 ? 'var(--danger)' : 'var(--success)'}}>
              {fmtINR(outstanding)}
            </div>
          </div>
        </div>
        <div style={{marginTop:'0.85rem'}}>
          <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.78rem', color:'var(--text-muted)', marginBottom:'0.3rem'}}>
            <span>Payment progress</span>
            <span>{pct}%</span>
          </div>
          <div style={{height:'8px', borderRadius:'4px', background:'var(--bg)', overflow:'hidden'}}>
            <div style={{height:'100%', width:`${pct}%`, background: pct >= 100 ? 'var(--success)' : pct > 0 ? 'var(--warning)' : 'var(--danger)', transition:'width 0.25s'}} />
          </div>
        </div>
        {outstanding > 0 && (
          <div className="text-xs text-muted" style={{marginTop:'0.6rem'}}>
            Please pay the remaining <b style={{color:'var(--danger)'}}>{fmtINR(outstanding)}</b> to complete this order. Once Bridge Things receives the next payment, your accountant updates it here automatically.
          </div>
        )}
      </div>

      <PartnerPaymentSection order={order} payments={payments} loading={paymentsLoading} reload={reloadPayments} />
    </>
  );
}

// Container that owns the payments-for-this-order hook and renders both
// the upload form (when there's still a balance) and the history table
// underneath. Keeping them in one component lets us share `reload` so
// submitting a new slip immediately refreshes the history.
function PartnerPaymentSection({ order, payments, loading, reload }) {
  const { user } = useAuth();

  // Sum of verified payments only — pending submissions don't yet count.
  const verifiedPaid = payments
    .filter(p => p.status === 'verified')
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const outstanding = Math.max(0, (Number(order.total_amount) || 0) - verifiedPaid);
  // Only let the partner upload while their order is active AND there's
  // still money to pay. Once fully paid we hide the form entirely.
  const showUpload = order.status === 'active' && outstanding > 0;

  return (
    <>
      {showUpload && (
        <>
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginTop:'1.25rem', marginBottom:'0.5rem'}}>
            Submit Payment Proof
          </h4>
          <PartnerPaymentUpload
            orderId={order.id}
            partnerId={user?.supabaseId}
            outstanding={outstanding}
            onSubmitted={reload}
          />
        </>
      )}

      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginTop:'1.25rem', marginBottom:'0.5rem'}}>
        Payment History
      </h4>
      <div style={{border:'1px solid var(--border)', borderRadius:'8px', overflow:'hidden'}}>
        <PartnerPaymentHistory payments={payments} loading={loading} />
      </div>
    </>
  );
}

// Partner-facing upload form — picks a file, amount, date, method,
// reference and submits. The slip is uploaded to private storage and a
// payments row is inserted with status='pending_verification'.
function PartnerPaymentUpload({ orderId, partnerId, outstanding, onSubmitted }) {
  const { addToast } = useToast();
  const [amount, setAmount]    = useState('');
  const [date, setDate]        = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod]    = useState('bank_transfer');
  const [ref, setRef]          = useState('');
  const [notes, setNotes]      = useState('');
  const [file, setFile]        = useState(null);
  const [busy, setBusy]        = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await submitPaymentProof({
        orderId,
        partnerId,
        amount,
        paymentDate: date,
        method,
        referenceNumber: ref,
        notes,
        file,
      });
      addToast('Payment proof submitted. Accounts team will verify shortly.', 'success');
      setAmount(''); setRef(''); setNotes(''); setFile(null);
      setDate(new Date().toISOString().slice(0, 10));
      if (onSubmitted) await onSubmitted();
    } catch (err) {
      console.error('[payments] submit proof failed:', err);
      addToast(err.message || 'Failed to submit payment proof', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem', background:'var(--card)', display:'flex', flexDirection:'column', gap:'0.75rem'}}
    >
      <div className="text-xs text-muted">
        Outstanding: <span style={{color:'var(--danger)', fontWeight:600}}>{fmtINR(outstanding)}</span>
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:'0.6rem'}}>
        <div className="form-group" style={{margin:0}}>
          <label className="form-label">Amount (₹)</label>
          <input
            className="form-input" type="number" min="1" step="0.01"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 25000" required
          />
        </div>
        <div className="form-group" style={{margin:0}}>
          <label className="form-label">Payment Date</label>
          <input
            className="form-input" type="date"
            value={date} onChange={e => setDate(e.target.value)} required
          />
        </div>
        <div className="form-group" style={{margin:0}}>
          <label className="form-label">Method</label>
          <select
            className="form-input"
            value={method} onChange={e => setMethod(e.target.value)}
          >
            {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{margin:0}}>
          <label className="form-label">Reference / UTR (optional)</label>
          <input
            className="form-input"
            value={ref} onChange={e => setRef(e.target.value)}
            placeholder="Transaction ID"
          />
        </div>
      </div>
      <div className="form-group" style={{margin:0}}>
        <label className="form-label">Payment Slip (PDF or image)</label>
        <input
          type="file"
          accept="application/pdf,image/*"
          onChange={e => setFile(e.target.files?.[0] || null)}
          required
          style={{fontSize:'0.85rem'}}
        />
      </div>
      <div className="form-group" style={{margin:0}}>
        <label className="form-label">Notes (optional)</label>
        <input
          className="form-input"
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Any context for the accounts team"
        />
      </div>
      <div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Submitting...' : 'Submit Payment Proof'}
        </button>
      </div>
    </form>
  );
}

// Read-only shipment list for the partner. Each parcel is its own card
// with courier, tracking #, dispatch + delivery dates, and the items
// that were inside. A single PO can ship across several parcels.
function PartnerShipmentsList({ order }) {
  const { user } = useAuth();
  const { shipments, loading } = useShipmentsForOrder(order?.id);
  const items = order?.items || [];

  if (loading) {
    return <div className="text-sm text-muted" style={{padding:'0.5rem 0'}}>Loading shipments...</div>;
  }
  if (shipments.length === 0) {
    return (
      <div style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem', fontSize:'0.85rem', color:'var(--text-muted)'}}>
        No shipments yet. You'll see courier + tracking details here as soon as the Bridge Things team dispatches a parcel.
      </div>
    );
  }
  return (
    <div style={{display:'flex', flexDirection:'column', gap:'0.6rem'}}>
      {shipments.map((s, idx) => {
        const indexLabel = shipments.length - idx;
        const delivered  = Boolean(s.delivered_date);
        const itemSummary = (s.items || []).map(si => {
          const item = items.find(it => it.id === si.order_item_id);
          return { name: productNameForRole(item?.product, user?.role) || 'Item', qty: si.qty };
        });
        return (
          <div key={s.id} style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'0.85rem 1rem'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:'0.5rem', marginBottom:'0.4rem'}}>
              <div className="font-semibold text-sm" style={{color:'var(--primary)'}}>
                Shipment {indexLabel} of {shipments.length}
              </div>
              <span className={`badge ${delivered ? 'badge-success' : 'badge-info'}`}>
                {delivered ? 'Delivered' : 'In transit'}
              </span>
            </div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:'0.6rem', fontSize:'0.85rem'}}>
              <div>
                <div className="text-xs text-muted">Courier</div>
                <div className="font-semibold">{s.courier || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Tracking #</div>
                <div className="font-semibold" style={{wordBreak:'break-all'}}>{s.tracking_number || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Shipped</div>
                <div className="font-semibold">{fmtDate(s.shipped_date)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Delivered</div>
                <div className="font-semibold">{fmtDate(s.delivered_date)}</div>
              </div>
            </div>
            {itemSummary.length > 0 && (
              <div style={{marginTop:'0.5rem', fontSize:'0.8rem'}}>
                <span className="text-muted">Contents: </span>
                {itemSummary.map((x, i) => (
                  <span key={i} style={{fontWeight:600}}>
                    {i > 0 && ', '}
                    {x.qty} × {x.name}
                  </span>
                ))}
              </div>
            )}

            {/* Per-shipment doc upload — only renders for drop-ship orders
                where dispatch has requested at least one doc for THIS
                shipment. Each shipment is its own paperwork lifecycle.
                The oldest shipment (indexLabel === 1) also surfaces any
                legacy order-level docs that the partner uploaded before
                docs became per-shipment. */}
            {order?.ship_to_is_different && (
              <ShipmentDocsUploadBlock
                shipment={s}
                orderId={order.id}
                partnerId={user?.supabaseId}
                isFirstShipment={indexLabel === 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Per-shipment partner doc uploads. Mirror of the order-level
// PartnerDocsUploadBlock but scoped to one shipment — reads
// requested_doc_types + partner_docs_status from the shipment row,
// uploads into the bucket under that shipment's subfolder.
function ShipmentDocsUploadBlock({ shipment, orderId, partnerId, isFirstShipment = false }) {
  const { addToast } = useToast();
  const { docs, loading, reload } = useShipmentDocs(shipment?.id);
  // Only the oldest shipment surfaces legacy order-level docs (rows
  // uploaded before docs became per-shipment).
  const { docs: legacyDocs } = useLegacyOrderDocs(isFirstShipment ? orderId : null);
  const required = requiredDocsForShipment(shipment);
  const status   = shipment?.partner_docs_status;
  const isRequested = status === 'requested' || status === 'submitted';
  const hasLegacy = legacyDocs.length > 0;

  if (!isRequested || required.length === 0) {
    // Even if dispatch hasn't requested new docs for this shipment yet,
    // we still want to show any legacy docs that belong to the order
    // when this is the first shipment. Otherwise show the standard hint.
    if (!hasLegacy) {
      return (
        <div className="text-xs text-muted" style={{marginTop:'0.6rem', padding:'0.5rem 0.75rem', background:'var(--bg)', borderRadius:'6px'}}>
          Dispatch hasn't requested any documents for this shipment yet. Upload boxes will appear here if they do.
        </div>
      );
    }
    return (
      <div style={{marginTop:'0.6rem', border:'1px dashed var(--border)', borderRadius:'6px', padding:'0.75rem 0.85rem', background:'var(--bg)'}}>
        <div className="font-semibold text-sm" style={{marginBottom:'0.4rem'}}>Shipping Documents for this shipment</div>
        <LegacyDocsSubsection legacyDocs={legacyDocs} />
        <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>
          Dispatch hasn't requested any new documents for this shipment yet. Upload boxes will appear here if they do.
        </div>
      </div>
    );
  }

  return (
    <div style={{marginTop:'0.6rem', border:'1px dashed var(--border)', borderRadius:'6px', padding:'0.75rem 0.85rem', background:'var(--bg)'}}>
      <div className="font-semibold text-sm" style={{marginBottom:'0.4rem'}}>Shipping Documents for this shipment</div>
      {hasLegacy && <LegacyDocsSubsection legacyDocs={legacyDocs} />}
      {status === 'submitted' && (
        <div className="text-xs" style={{color:'var(--success)', marginBottom:'0.4rem'}}>
          All requested documents uploaded. You can still re-upload if you need to replace one.
        </div>
      )}
      {loading ? (
        <div className="text-xs text-muted">Loading...</div>
      ) : (
        <div style={{display:'flex', flexDirection:'column', gap:'0.4rem'}}>
          {required.map(docType => (
            <ShipmentDocUploadRow
              key={docType}
              docType={docType}
              existing={docs[docType]}
              onUpload={async (file) => {
                try {
                  await uploadShipmentDoc({
                    orderId,
                    partnerId,
                    shipmentId: shipment.id,
                    docType,
                    file,
                    shipment,
                  });
                  addToast(`${DOC_LABELS[docType]} uploaded`, 'success');
                  await reload();
                } catch (err) {
                  console.error('[shipmentDocs] upload failed:', err);
                  addToast(err.message || 'Upload failed', 'error');
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Read-only "Previously uploaded (order-level)" subsection rendered at
// the top of the first shipment's docs panel. Shows the legacy uploads
// with a View link only — no re-upload, since those rows aren't tied to
// a shipment and shouldn't grow.
function LegacyDocsSubsection({ legacyDocs }) {
  return (
    <div style={{padding:'0.5rem 0.75rem', background:'rgba(100,116,139,0.08)', border:'1px solid var(--border)', borderRadius:'6px', marginBottom:'0.5rem'}}>
      <div className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'0.3rem'}}>
        Previously uploaded (order-level)
      </div>
      <div style={{display:'flex', flexDirection:'column', gap:'0.3rem'}}>
        {legacyDocs.map(d => (
          <div key={d.id} style={{display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap', fontSize:'0.85rem'}}>
            <span style={{minWidth:'140px', fontWeight:600}}>{DOC_LABELS[d.doc_type] || d.doc_type}</span>
            <a href="#" onClick={async (e) => {
              e.preventDefault();
              const url = await getPartnerDocUrl(d.storage_path);
              if (url) window.open(url, '_blank', 'noopener');
            }} style={{color:'var(--primary)'}}>View</a>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShipmentDocUploadRow({ docType, existing, onUpload }) {
  const [busy, setBusy] = useState(false);
  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try { await onUpload(file); } finally { setBusy(false); e.target.value = ''; }
  };
  return (
    <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:'0.6rem', fontSize:'0.85rem'}}>
      <div style={{minWidth:'140px', fontWeight:600}}>{DOC_LABELS[docType]}</div>
      {existing
        ? <a href="#" onClick={async (e) => {
            e.preventDefault();
            const url = await getPartnerDocUrl(existing.storage_path);
            if (url) window.open(url, '_blank', 'noopener');
          }} style={{color:'var(--primary)'}}>View current</a>
        : <span className="text-muted">No file yet</span>}
      <input type="file" accept="application/pdf,image/*" onChange={handleChange} disabled={busy} style={{fontSize:'0.8rem'}} />
      {busy && <span className="text-xs text-muted">Uploading...</span>}
    </div>
  );
}

// Read-only payment ledger shown to the partner inside their order modal.
// Mixes accountant-entered rows (verified by default) and partner-submitted
// rows (pending_verification → verified or rejected). Each row carries a
// status badge so the partner knows where their submission stands.
function PartnerPaymentHistory({ payments, loading }) {
  if (loading) {
    return <div style={{padding:'0.85rem 1rem'}} className="text-sm text-muted">Loading payments...</div>;
  }
  if (!payments?.length) {
    return <div style={{padding:'0.85rem 1rem'}} className="text-sm text-muted">No payments recorded yet.</div>;
  }
  const statusBadge = (s) => {
    if (s === 'verified')             return { className: 'badge-success', label: 'Verified' };
    if (s === 'rejected')             return { className: 'badge-danger',  label: 'Rejected' };
    if (s === 'pending_verification') return { className: 'badge-warning', label: 'Pending Verification' };
    return { className: 'badge-gray', label: s || '—' };
  };
  return (
    <div className="table-wrap">
      <table style={{margin:0}}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Slip</th>
            <th style={{textAlign:'right'}}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {payments.map(p => {
            const badge = statusBadge(p.status);
            const isPending  = p.status === 'pending_verification';
            const isRejected = p.status === 'rejected';
            const amountColor = isPending ? 'var(--warning)'
                              : isRejected ? 'var(--danger)'
                              : 'var(--success)';
            return (
              <tr key={p.id}>
                <td className="text-sm">{fmtDate(p.payment_date)}</td>
                <td className="text-sm">{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
                <td className="text-sm">{p.reference_number || '—'}</td>
                <td>
                  <span className={`badge ${badge.className}`}>{badge.label}</span>
                  {isRejected && p.rejection_note && (
                    <div className="text-xs text-muted" style={{marginTop:'0.2rem'}}>
                      Reason: {p.rejection_note}
                    </div>
                  )}
                </td>
                <td className="text-sm">
                  {p.receipt_url
                    ? <SlipLink path={p.receipt_url} />
                    : <span className="text-muted">—</span>}
                </td>
                <td className="text-sm font-semibold" style={{textAlign:'right', color:amountColor}}>{fmtINR(p.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Renders a "View" link that mints a signed URL on click (private bucket
// → can't use the raw path). Falls back to "—" if the URL can't be
// generated.
function SlipLink({ path }) {
  const handleClick = async (e) => {
    e.preventDefault();
    const url = await getPaymentSlipUrl(path);
    if (url) window.open(url, '_blank', 'noopener');
  };
  return <a href="#" onClick={handleClick} style={{color:'var(--primary)'}}>View</a>;
}

// ────────────────────────────────────────────────────────────────────────
// Shipping Details section — bill-to / ship-to + drop-ship docs.
// Visible only after the admin has accepted the PO (status='active').
// ────────────────────────────────────────────────────────────────────────
function PartnerShippingSection({ order, onChanged }) {
  const { user } = useAuth();
  const { addToast } = useToast();
  const total = Number(order.total_amount) || 0;
  const heavyOrder = total >= EWAY_BILL_THRESHOLD;
  // Only the channel partner can edit these fields — they're the source
  // of truth for ship-to / drop-ship docs. Everyone else (admin, ops,
  // dispatch, accountant) sees the same data but read-only.
  const canEdit = user?.role === 'partner';

  const [diff, setDiff] = useState(!!order.ship_to_is_different);
  const [form, setForm] = useState({
    ship_to_name:    order.ship_to_name    || '',
    ship_to_phone:   order.ship_to_phone   || '',
    ship_to_address: order.ship_to_address || '',
    ship_to_city:    order.ship_to_city    || '',
    ship_to_state:   order.ship_to_state   || '',
    ship_to_pincode: order.ship_to_pincode || '',
    ship_to_gstin:   order.ship_to_gstin   || '',
  });
  const [includeInvoice, setIncludeInvoice] = useState((order.documents_in_parcel || []).includes('invoice'));
  const [includeDC, setIncludeDC]           = useState((order.documents_in_parcel || []).includes('dc'));
  const [saving, setSaving] = useState(false);

  if (order.status !== 'active' && order.status !== 'completed') {
    return null;
  }
  // Staff viewing a same-address order — nothing extra to show. Skip
  // the section entirely so non-partners don't see an empty card.
  if (!canEdit && !diff) {
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const docs = [];
      if (diff && includeInvoice) docs.push('invoice');
      if (diff && includeDC)      docs.push('dc');
      await saveShipTo(order.id, {
        ship_to_is_different: diff,
        ...form,
        documents_in_parcel: docs,
      });
      addToast('Shipping details saved', 'success');
      // Refresh parent's orders list so the next time this modal opens
      // (or any other consumer of `order`) sees the saved ship_to_* fields
      // populated, not an empty form.
      if (onChanged) await onChanged();
    } catch (err) {
      console.error('[shipping] save failed:', err);
      addToast(err.message || 'Failed to save shipping details', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginTop:'1.25rem', marginBottom:'0.5rem'}}>
        Shipping Details
      </h4>

      <div style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem', display:'flex', flexDirection:'column', gap:'0.85rem'}}>
        {/* Bill-to summary — read-only, comes from the partner's profile */}
        <div>
          <div className="text-xs text-muted" style={{marginBottom:'0.2rem'}}>Bill To</div>
          <div className="font-semibold">{user?.name || user?.company_name || '—'}</div>
          {user?.address && <div className="text-sm" style={{color:'var(--text-muted)'}}>{user.address}</div>}
          {(user?.city || user?.state || user?.pincode) && (
            <div className="text-sm" style={{color:'var(--text-muted)'}}>
              {[user.city, user.state, user.pincode].filter(Boolean).join(', ')}
            </div>
          )}
        </div>

        <label style={{display:'flex', alignItems:'center', gap:'0.5rem', fontSize:'0.9rem', cursor: canEdit ? 'pointer' : 'default'}}>
          <input
            type="checkbox"
            checked={diff}
            onChange={e => setDiff(e.target.checked)}
            disabled={!canEdit}
          />
          Ship to a different address (drop-ship to my customer)
        </label>

        {diff && (
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:'0.6rem'}}>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">Customer Name</label>
              <input className="form-input" value={form.ship_to_name}
                onChange={e => setForm({...form, ship_to_name: e.target.value})}
                placeholder="End customer / consignee name"
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">Phone</label>
              <input className="form-input" value={form.ship_to_phone}
                onChange={e => setForm({...form, ship_to_phone: e.target.value})}
                placeholder="10-digit number"
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0, gridColumn:'1 / -1'}}>
              <label className="form-label">Address</label>
              <input className="form-input" value={form.ship_to_address}
                onChange={e => setForm({...form, ship_to_address: e.target.value})}
                placeholder="Street, area, landmark"
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">City</label>
              <input className="form-input" value={form.ship_to_city}
                onChange={e => setForm({...form, ship_to_city: e.target.value})}
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">State</label>
              <input className="form-input" value={form.ship_to_state}
                onChange={e => setForm({...form, ship_to_state: e.target.value})}
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">Pincode</label>
              <input className="form-input" value={form.ship_to_pincode}
                onChange={e => setForm({...form, ship_to_pincode: e.target.value})}
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
            <div className="form-group" style={{margin:0}}>
              <label className="form-label">GSTIN (optional)</label>
              <input className="form-input" value={form.ship_to_gstin}
                onChange={e => setForm({...form, ship_to_gstin: e.target.value})}
                disabled={!canEdit} readOnly={!canEdit} />
            </div>
          </div>
        )}

        {diff && (
          <div>
            <div className="text-sm font-semibold" style={{marginBottom:'0.4rem'}}>Documents to enclose in the parcel</div>
            <label style={{display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.85rem'}}>
              <input type="checkbox" checked={includeInvoice} onChange={e => setIncludeInvoice(e.target.checked)} disabled={!canEdit} />
              Include Invoice in parcel
            </label>
            <label style={{display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.85rem'}}>
              <input type="checkbox" checked={includeDC} onChange={e => setIncludeDC(e.target.checked)} disabled={!canEdit} />
              Include DC (Delivery Challan) in parcel
            </label>
          </div>
        )}

        {/* Hint for the partner — only relevant while they're entering
            the ship-to address. Staff viewers don't see this. */}
        {diff && canEdit && (
          <div className="text-xs" style={{
            background: '#fef9c3',
            border: '1px solid var(--warning)',
            padding:'0.6rem 0.85rem', borderRadius:'6px', color:'var(--text)',
          }}>
            Dispatch will tell you which shipping documents to upload (typically Invoice + DC + E-way Bill for ≥₹50,000 orders, just a DC otherwise). Upload boxes appear below once they request them.
          </div>
        )}

        {canEdit && (
          <div>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save Shipping Details'}
            </button>
          </div>
        )}
      </div>

      {/* Legacy order-level docs are now surfaced inside the first
          shipment card (ShipmentDocsUploadBlock with isFirstShipment),
          so no parent-level docs panel is needed here anymore. */}
    </>
  );
}

