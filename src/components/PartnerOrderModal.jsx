// Shared partner-facing modal: Details + Tracking for a single order.
// Used by /partner/orders and /partner (dashboard) so clicking an order ID
// anywhere gives the partner the same view.
import { useEffect, useState } from 'react';
import { getOrderStepperSteps } from '../lib/orderStepper';
import { loadUnitDetailsForItems } from '../lib/orderUnits';
import { acceptDeliveryCounter, declineDeliveryCounter } from '../lib/orders';
import { usePaymentsForOrder, PAYMENT_METHOD_LABEL } from '../lib/payments';
import { useShipmentsForOrder } from '../lib/shipments';
import { IGST_LABEL } from '../lib/tax';
import { useToast } from '../lib/toast';

const ORDER_STATUS_LABELS = { draft:'Draft', pending_approval:'Awaiting Confirmation', active:'Active', completed:'Completed', rejected:'Rejected' };
const ORDER_STATUS_COLORS = { draft:'badge-gray', pending_approval:'badge-warning', active:'badge-info', completed:'badge-success', rejected:'badge-danger' };

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function PartnerOrderModal({ order, onClose, onChanged }) {
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
      addToast('Counter-date accepted. Bridge Things will confirm shortly.', 'success');
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

  const itemsSubtotal = (order.items || []).reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
    0,
  );
  const shipping = Number(order.shipping_cost) || 0;
  const tax      = Number(order.tax_amount)    || 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'820px'}}>
        <div className="modal-header">
          <h3>
            Order ORD-{shortId(order.id)}{' '}
            <span className={`badge ${ORDER_STATUS_COLORS[order.status]||'badge-gray'}`} style={{marginLeft:'0.5rem', verticalAlign:'middle'}}>
              {ORDER_STATUS_LABELS[order.status]||order.status}
            </span>
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
                Bridge Things proposed a different delivery date
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
                  <span className="text-muted">Requested delivery date:</span>{' '}
                  <span className="font-semibold">{fmtDate(order.requested_delivery_date)}</span>
                </div>
              )}
              {order.committed_delivery_date && (
                <div>
                  <span className="text-muted">Committed delivery date:</span>{' '}
                  <span className="font-semibold" style={{color:'var(--success)'}}>{fmtDate(order.committed_delivery_date)}</span>
                </div>
              )}
            </div>
          )}

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
              className={`tab${tab === 'tracking' ? ' active' : ''}`}
              onClick={() => setTab('tracking')}
            >
              Tracking
            </button>
          </div>

          {tab === 'details' && (
            <DetailsTab
              order={order}
              itemsSubtotal={itemsSubtotal}
              shipping={shipping}
              tax={tax}
              unitsByItem={unitsByItem}
            />
          )}

          {tab === 'tracking' && (
            <TrackingTab order={order} />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailsTab({ order, itemsSubtotal, shipping, tax, unitsByItem }) {
  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Items
      </h4>
      <div style={{display:'flex', flexDirection:'column', gap:'0.75rem', marginBottom:'1.25rem'}}>
        {(order.items || []).map(item => {
          const units = unitsByItem?.[item.id] || [];
          const price = Number(item.unit_price) || 0;
          const qty   = Number(item.qty) || 0;
          return (
            <div key={item.id} style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
                <div className="font-semibold">{item.product?.name || 'Unknown product'}</div>
                <div className="text-sm font-semibold" style={{color:'var(--primary)'}}>
                  {qty} × {fmtINR(price)} = {fmtINR(qty * price)}
                </div>
              </div>
              {item.notes && <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>Note: {item.notes}</div>}
              {units.length > 0 && (
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
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
          <span>Shipping{order.delivery_method ? ` (${order.delivery_method})` : ''}</span>
          <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shipping)}</span>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', borderTop:'1px dashed var(--border)', paddingTop:'0.4rem', marginTop:'0.2rem'}}>
          <span style={{fontWeight:600}}>Total before IGST</span>
          <span style={{fontWeight:600}}>{fmtINR(itemsSubtotal + shipping)}</span>
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

function TrackingTab({ order }) {
  const steps = getOrderStepperSteps(order);
  return (
    <>
      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.75rem'}}>
        Status
      </h4>
      <div style={{padding:'1.25rem', border:'1px solid var(--border)', borderRadius:'8px', marginBottom:'1.25rem'}}>
        <div className="status-stepper">
          {steps.map((step, i, arr) => (
            <div key={step.key} style={{display:'flex', alignItems:'center', flex:1}}>
              <div className="step" style={{flex:'none'}}>
                <div className={`step-circle ${step.done?'done':step.active?'active':''}`}>{step.done ? '✓' : i+1}</div>
                <div className={`step-label ${step.done?'done':step.active?'active':''}`}>{step.label}</div>
              </div>
              {i < arr.length - 1 && (
                <div style={{flex:1, height:'2px', background: step.done ? 'var(--success)' : 'var(--border)', margin:'0 4px', marginTop:'-20px'}}/>
              )}
            </div>
          ))}
        </div>
      </div>

      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Shipments
      </h4>
      <PartnerShipmentsList order={order} />
      <div style={{height:'1.25rem'}} />

      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
        Payment
      </h4>
      {(() => {
        const total       = Number(order.total_amount) || 0;
        const paid        = Number(order.amount_paid)  || 0;
        const outstanding = Math.max(0, total - paid);
        const pct         = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
        return (
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
              </div>
              <div>
                <div className="text-xs text-muted">Balance Remaining</div>
                <div className="font-semibold" style={{color: outstanding > 0 ? 'var(--danger)' : 'var(--success)'}}>
                  {fmtINR(outstanding)}
                </div>
              </div>
            </div>
            {/* Payment progress bar */}
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
        );
      })()}

      <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginTop:'1.25rem', marginBottom:'0.5rem'}}>
        Payment History
      </h4>
      <div style={{border:'1px solid var(--border)', borderRadius:'8px', overflow:'hidden'}}>
        <PartnerPaymentHistory orderId={order.id} />
      </div>
    </>
  );
}

// Read-only shipment list for the partner. Each parcel is its own card
// with courier, tracking #, dispatch + delivery dates, and the items
// that were inside. A single PO can ship across several parcels.
function PartnerShipmentsList({ order }) {
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
          return { name: item?.product?.name || 'Item', qty: si.qty };
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
          </div>
        );
      })}
    </div>
  );
}

// Read-only payment ledger shown to the partner inside their order modal.
// The accountant adds rows on /finance — partner just sees them here.
function PartnerPaymentHistory({ orderId }) {
  const { payments, loading } = usePaymentsForOrder(orderId);

  if (loading) {
    return <div style={{padding:'0.85rem 1rem'}} className="text-sm text-muted">Loading payments...</div>;
  }
  if (payments.length === 0) {
    return <div style={{padding:'0.85rem 1rem'}} className="text-sm text-muted">No payments recorded yet.</div>;
  }
  return (
    <div className="table-wrap">
      <table style={{margin:0}}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th style={{textAlign:'right'}}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id}>
              <td className="text-sm">{fmtDate(p.payment_date)}</td>
              <td className="text-sm">{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
              <td className="text-sm">{p.reference_number || '—'}</td>
              <td className="text-sm font-semibold" style={{textAlign:'right', color:'var(--success)'}}>{fmtINR(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
