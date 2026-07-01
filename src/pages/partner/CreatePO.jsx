// Partner — Create Purchase Order.
// Items are added from the Catalog page and live in the cart context
// (persisted to localStorage) so navigating between pages preserves the draft.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { createOrder, useOrders, orderRef } from '../../lib/orders';
import { COURIERS } from '../../lib/couriers';
import { CABLE_FREE_METERS, CABLE_RATE_PER_METER, cableChargeFor } from '../../lib/cable';
import { computeOrderTotal, IGST_LABEL } from '../../lib/tax';
import { useToast } from '../../lib/toast';
import PartnerOrderModal from '../../components/PartnerOrderModal';

// Apply the partner's flat discount % to a base price. Match the rounding
// used in Catalog so the displayed price always equals the saved price.
const applyDiscount = (basePrice, discountPercent) => {
  const base = Number(basePrice) || 0;
  const pct  = Number(discountPercent) || 0;
  if (!pct) return base;
  return Math.round((base * (1 - pct / 100)) * 100) / 100;
};

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function CreatePO() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const { items, total, updateField, removeAt, clear } = useCart();
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // PO-number popup: shown when the partner clicks Submit. They can enter
  // their own reference (e.g. "CUSSJKFKJ") or skip it.
  const [showPoModal, setShowPoModal] = useState(false);
  const [poNumber, setPoNumber] = useState('');
  const [lastPoNumber, setLastPoNumber] = useState(''); // shown on success screen
  // Order shown in the items-preview modal triggered from the recent-orders table.
  const [viewOrder, setViewOrder] = useState(null);
  // Courier id selected by the partner. Defaults to the cheapest option so
  // the order total is meaningful even before they pick.
  // No courier pre-selected — the partner must explicitly pick one.
  const [courierId, setCourierId] = useState('');
  const selectedCourier = COURIERS.find(c => c.id === courierId) || null;
  const shippingCost = selectedCourier ? Number(selectedCourier.price) || 0 : 0;
  // Optional — partner can suggest a preferred delivery date. Admin reviews
  // it and either accepts (PO approved as-is) or counter-proposes a date.
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('');
  // Partner-specific discount % comes from the auth profile. Cart still
  // stores base_price; we apply the discount here at PO time so the saved
  // unit_price reflects whatever discount is active at submission.
  const discountPct = Number(user?.discount_percent) || 0;
  const itemsAfterDiscount = items.reduce(
    (s, i) => s + applyDiscount(i.product?.base_price, discountPct) * (Number(i.qty) || 0),
    0,
  );
  const discountSaved = total - itemsAfterDiscount;
  // Extra-cable charges (only for products that support cable).
  const cableTotal = items.reduce(
    (s, i) => s + (i.product?.cable_supported ? cableChargeFor(i.extra_cable_m, i.qty) : 0),
    0,
  );
  // Grand total = (items − discount) + shipping + IGST on the discounted
  // subtotal. Matches the server-side math in createOrder() because we
  // pass the same discounted unit_price below.
  const orderTotals = computeOrderTotal({ itemsSubtotal: itemsAfterDiscount + cableTotal, shipping: shippingCost });
  const grandTotal  = orderTotals.total;
  // Pull the partner's recent orders (RLS scopes to their own) so they can
  // see/track previously-submitted POs without leaving this page. We pull
  // up to 200 — enough to act as "all" for any real partner — and let the
  // UI clamp to the latest 5 by default, toggling open on demand.
  const { orders: recentOrders, loading: ordersLoading, reload: reloadOrders } = useOrders({ limit: 200 });
  const [showAllPOs, setShowAllPOs] = useState(false);
  const [poSearch, setPoSearch] = useState('');
  const [poTab, setPoTab] = useState('all');
  // Map UI tab → which order.status values count for it.
  const matchesTab = (o) => {
    if (poTab === 'all')         return true;
    if (poTab === 'pending')     return o.status === 'pending_approval';
    if (poTab === 'in_progress') return o.status === 'active';
    if (poTab === 'completed')   return o.status === 'completed';
    if (poTab === 'rejected')    return o.status === 'rejected';
    return true;
  };
  const tabCount = (key) => {
    if (key === 'all')         return recentOrders.length;
    if (key === 'pending')     return recentOrders.filter(o => o.status === 'pending_approval').length;
    if (key === 'in_progress') return recentOrders.filter(o => o.status === 'active').length;
    if (key === 'completed')   return recentOrders.filter(o => o.status === 'completed').length;
    if (key === 'rejected')    return recentOrders.filter(o => o.status === 'rejected').length;
    return 0;
  };
  const filteredOrders = (() => {
    const byTab = recentOrders.filter(matchesTab);
    const term  = poSearch.trim().toLowerCase();
    if (!term) return byTab;
    return byTab.filter(o => {
      const hay = [orderRef(o), shortId(o.id), o.id, o.partner_po_number, o.status, o.payment_status, o.delivery_method, o.tracking_number]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();
  const displayedOrders = showAllPOs ? filteredOrders : filteredOrders.slice(0, 5);

  // Step 1: clicking "Submit Purchase Order" validates then opens the
  // PO-number popup (instead of submitting straight away).
  const openSubmit = () => {
    if (items.length === 0) { addToast('Add at least one product to the PO', 'error'); return; }
    if (!selectedCourier) { addToast('Please select a delivery partner', 'error'); return; }
    if (!user?.supabaseId) { addToast('Cannot submit: not signed in', 'error'); return; }
    setPoNumber('');
    setShowPoModal(true);
  };

  // Step 2: actually create the order, attaching the (optional) PO number.
  // `poValue` lets "Skip" submit blank regardless of what's typed.
  const handleSubmit = async (poValue = poNumber) => {
    if (!user?.supabaseId) { addToast('Cannot submit: not signed in', 'error'); return; }
    const po = (poValue ?? '').trim();

    setSubmitting(true);
    try {
      await createOrder({
        partnerId: user.supabaseId,
        items: items.map(i => ({
          product_id:    i.product_id,
          qty:           i.qty,
          unit_price:    applyDiscount(i.product.base_price, discountPct),
          notes:         i.notes,
          extra_cable_m: i.product?.cable_supported ? (i.extra_cable_m || 0) : 0,
        })),
        status:                'pending_approval',
        deliveryMethod:        selectedCourier?.name || null,
        shippingCost:          shippingCost,
        requestedDeliveryDate: requestedDeliveryDate || null,
        partnerPoNumber:       po || null,
      });
      setLastPoNumber(po);
      clear();
      setRequestedDeliveryDate('');
      setShowPoModal(false);
      setSubmitted(true);
      addToast('Purchase Order submitted successfully! Awaiting Bridge Things confirmation.', 'success');
    } catch (err) {
      console.error('[createPO] submit failed:', err);
      addToast(err.message || 'Failed to submit purchase order', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) return (
    <div style={{maxWidth:'520px', margin:'4rem auto', textAlign:'center'}}>
      <h2 style={{marginBottom:'0.5rem'}}>PO Submitted Successfully!</h2>
      {lastPoNumber && (
        <p style={{marginBottom:'0.75rem', fontSize:'0.95rem'}}>
          Your PO number: <span style={{fontWeight:700, color:'var(--primary)'}}>{lastPoNumber}</span>
        </p>
      )}
      <p style={{color:'var(--text-muted)', marginBottom:'1.5rem'}}>Your purchase order has been sent to Bridge Things for review. You'll be notified once they confirm the dispatch dates.</p>
      <button className="btn btn-primary" onClick={() => { setSubmitted(false); navigate('/partner/catalog'); }}>Create Another PO</button>
    </div>
  );

  return (
    <>
      <style>{`
        /* Two-column checkout: line items on the left, a sticky order
           summary on the right so the panel always stays in view as the
           partner scrolls long carts. Collapses to one column on tablets. */
        .po-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 360px;
          gap: 1.5rem; align-items: start; margin-bottom: 1.5rem;
        }
        @media (max-width: 900px) { .po-layout { grid-template-columns: 1fr; } }

        .po-item { padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); transition: background 0.15s ease; }
        .po-item:hover { background: var(--bg); }
        .po-item:last-child { border-bottom: 0; }

        .po-section { padding: 1.25rem 1.5rem; border-top: 1px solid var(--border); background: var(--bg); }
        .po-section-title {
          font-size: 0.72rem; font-weight: 700; letter-spacing: 0.05em;
          text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.85rem;
        }
        .po-date {
          max-width: 280px; width: 100%; cursor: pointer; font-variant-numeric: tabular-nums;
        }
        .po-date::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; padding: 2px; }
        .po-date::-webkit-calendar-picker-indicator:hover { opacity: 1; }
        .po-date:invalid::-webkit-datetime-edit { color: var(--text-muted); }

        /* Sticky summary card (right column). On mobile it un-sticks and
           simply stacks below the items. */
        .po-summary-card {
          position: sticky; top: 1.5rem; background: var(--card);
          border: 1px solid var(--border); border-radius: var(--radius);
          box-shadow: var(--shadow-sm); overflow: hidden;
        }
        @media (max-width: 900px) { .po-summary-card { position: static; } }
        .po-summary-head {
          padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
          font-size: 0.95rem; font-weight: 700; color: var(--text);
        }
        .po-summary-body { padding: 1.25rem; }
        .po-summary-row { display: flex; justify-content: space-between; gap: 1.5rem; font-size: 0.85rem; }
        .po-submit { width: 100%; justify-content: center; padding: 0.8rem 1.5rem !important; font-size: 0.95rem !important; font-weight: 600; margin-top: 1.1rem; }
        .po-clear { color: var(--danger) !important; border: 1px solid var(--border) !important; background: var(--card) !important; }
        .po-clear:hover { background: var(--danger-bg) !important; border-color: var(--danger) !important; }
      `}</style>

      <div className="page-header">
        <div>
          <div className="page-title">Purchase Orders</div>
          <div className="page-subtitle">Submit new orders from your cart and track recent submissions</div>
        </div>
        {items.length > 0 && (
          <button
            className="btn btn-sm po-clear"
            onClick={() => {
              if (window.confirm('Clear all items from this PO?')) clear();
            }}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Build-a-PO area — two-column checkout (items + sticky summary) */}
      {items.length > 0 && (
        <div className="po-layout">
        {/* LEFT COLUMN — line items + dispatch date + delivery partner */}
        <div className="card" style={{marginBottom:0}}>
          <div className="card-header"><h2>Order Items ({items.length})</h2></div>
          <div>
            {items.map((item, idx) => {
              const unitPrice = applyDiscount(item.product.base_price, discountPct);
              const lineCable = item.product?.cable_supported ? cableChargeFor(item.extra_cable_m, item.qty) : 0;
              return (
              <div key={item.product_id} className="po-item">
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'0.75rem'}}>
                  <div>
                    <div className="font-semibold">{item.product.name}</div>
                    <div className="text-sm text-muted">
                      {fmtINR(unitPrice)} per unit
                      {discountPct > 0 && (
                        <> &middot; <span style={{textDecoration:'line-through'}}>{fmtINR(item.product.base_price)}</span> ({discountPct}% off)</>
                      )}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" style={{color:'var(--danger)'}} onClick={() => removeAt(idx)}>Remove</button>
                </div>
                <div style={{display:'flex', gap:'1rem', flexWrap:'wrap', alignItems:'flex-start'}}>
                  <div className="form-group" style={{flex:'0 0 140px'}}>
                    <label className="form-label">Quantity</label>
                    <input type="number" min="1" className="form-input" value={item.qty}
                      onChange={e => updateField(idx, 'qty', Math.max(1, parseInt(e.target.value)||1))}
                      style={{width:'100%'}} />
                  </div>
                  <div className="form-group" style={{flex:'1 1 240px'}}>
                    <label className="form-label">Notes / Customization</label>
                    <input className="form-input" value={item.notes} placeholder="Optional notes..."
                      onChange={e => updateField(idx, 'notes', e.target.value)}
                      style={{width:'100%'}} />
                  </div>
                  {item.product?.cable_supported && (
                    <div className="form-group" style={{flex:'0 0 200px'}}>
                      <label className="form-label">Extra cable (m)</label>
                      <input type="number" min="0" className="form-input" value={item.extra_cable_m || 0}
                        onChange={e => updateField(idx, 'extra_cable_m', Math.max(0, parseInt(e.target.value)||0))}
                        style={{width:'100%'}} />
                      <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>{CABLE_FREE_METERS} m free · ₹{CABLE_RATE_PER_METER}/m extra (per unit)</div>
                    </div>
                  )}
                </div>
                <div style={{textAlign:'right', marginTop:'0.5rem'}}>
                  {lineCable > 0 && (
                    <div className="text-xs text-muted">
                      Extra cable: {item.extra_cable_m} m × {item.qty} unit{item.qty > 1 ? 's' : ''} × ₹{CABLE_RATE_PER_METER} = {fmtINR(lineCable)}
                    </div>
                  )}
                  <div style={{fontWeight:600, color:'var(--primary)'}}>
                    Item Total: {fmtINR(unitPrice * item.qty + lineCable)}
                  </div>
                </div>
              </div>
              );
            })}
          </div>

          {/* Requested dispatch date (left) + delivery partner dropdown (right) */}
          <div className="po-section">
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(240px, 1fr))', gap:'1.5rem', alignItems:'start'}}>
              <div>
                <div className="po-section-title">
                  Requested Dispatch Date
                  <span style={{textTransform:'none', letterSpacing:'normal', fontWeight:400}}> · optional</span>
                </div>
                <input
                  type="date"
                  className="form-input po-date"
                  value={requestedDeliveryDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={e => setRequestedDeliveryDate(e.target.value)}
                  style={{maxWidth:'100%'}}
                />
                <div style={{fontSize:'0.78rem', color:'var(--text-muted)', marginTop:'0.5rem'}}>
                  Bridge Things will confirm this date or propose an alternative.
                </div>
              </div>
              <div>
                <div className="po-section-title">Delivery Partner</div>
                <select
                  className="form-select"
                  value={courierId}
                  onChange={e => setCourierId(e.target.value)}
                  style={{width:'100%'}}
                >
                  <option value="">Select delivery partner</option>
                  {COURIERS.map(c => (
                    <option key={c.id} value={c.id}>{c.name} — {fmtINR(c.price)}</option>
                  ))}
                </select>
                <div style={{fontSize:'0.78rem', color:'var(--text-muted)', marginTop:'0.5rem'}}>
                  {selectedCourier ? `Shipping charge: ${fmtINR(shippingCost)}` : 'Choose a courier to add shipping.'}
                </div>
              </div>
            </div>
          </div>

        </div>{/* end LEFT COLUMN card */}

        {/* RIGHT COLUMN — sticky order summary */}
        <div className="po-summary-card">
          <div className="po-summary-head">Order Summary</div>
          <div className="po-summary-body">
              <div style={{display:'flex', flexDirection:'column', gap:'0.55rem'}}>
                <div className="po-summary-row" style={{color:'var(--text-muted)'}}>
                  <span>Items subtotal</span>
                  <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(total)}</span>
                </div>
                {discountPct > 0 && (
                  <div className="po-summary-row" style={{color:'var(--success)'}}>
                    <span>Discount ({discountPct}% off)</span>
                    <span style={{fontWeight:600}}>− {fmtINR(discountSaved)}</span>
                  </div>
                )}
                {cableTotal > 0 && (
                  <div className="po-summary-row" style={{color:'var(--text-muted)'}}>
                    <span>Extra cable</span>
                    <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(cableTotal)}</span>
                  </div>
                )}
                <div className="po-summary-row" style={{color:'var(--text-muted)'}}>
                  <span>Shipping ({selectedCourier?.name || '—'})</span>
                  <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shippingCost)}</span>
                </div>
                <div className="po-summary-row" style={{color:'var(--text-muted)'}}>
                  <span>{IGST_LABEL}</span>
                  <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(orderTotals.tax)}</span>
                </div>
              </div>
              <div className="po-summary-row" style={{alignItems:'center', borderTop:'1px solid var(--border)', marginTop:'0.85rem', paddingTop:'0.85rem'}}>
                <span style={{fontWeight:700, fontSize:'0.95rem'}}>Order Total</span>
                <span style={{fontSize:'1.35rem', fontWeight:700, color:'var(--primary)'}}>{fmtINR(grandTotal)}</span>
              </div>
              <button className="btn btn-primary po-submit" onClick={openSubmit} disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Purchase Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order history — partner's recent POs for quick tracking */}
      <div className="card" style={{marginTop:'1.5rem'}}>
        <div className="card-header">
          <h2>Your Purchase Orders</h2>
          {filteredOrders.length > 5 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowAllPOs(s => !s)}
            >
              {showAllPOs ? 'Show Less' : `View All (${filteredOrders.length})`}
            </button>
          )}
        </div>
        <div className="tabs" style={{padding:'0 1.25rem', borderBottom:'1px solid var(--border)'}}>
          {[
            { key: 'all',         label: 'All' },
            { key: 'pending',     label: 'Awaiting Confirmation' },
            { key: 'in_progress', label: 'In Progress' },
            { key: 'completed',   label: 'Completed' },
            { key: 'rejected',    label: 'Rejected' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              className={`tab${poTab === t.key ? ' active' : ''}`}
              onClick={() => setPoTab(t.key)}
            >
              {t.label} ({tabCount(t.key)})
            </button>
          ))}
        </div>
        <div className="card-body" style={{padding:'0.75rem 1.25rem', borderBottom:'1px solid var(--border)'}}>
          <input
            className="form-input"
            placeholder="Search by order ID, status, courier, tracking number..."
            value={poSearch}
            onChange={e => setPoSearch(e.target.value)}
          />
        </div>
        {ordersLoading ? (
          <div className="empty-state"><p>Loading order history...</p></div>
        ) : recentOrders.length === 0 ? (
          <div className="empty-state"><p>No previous purchase orders. Submit one above to start tracking.</p></div>
        ) : filteredOrders.length === 0 ? (
          <div className="empty-state"><p>No orders match "{poSearch}".</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Date</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {displayedOrders.map(o => (
                  <tr key={o.id}>
                    <td>
                      <button
                        type="button"
                        className="font-semibold"
                        style={{color:'var(--primary)', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}
                        onClick={() => setViewOrder(o)}
                      >
                        {orderRef(o)}
                      </button>
                    </td>
                    <td className="text-sm">{fmtDate(o.created_at)}</td>
                    <td className="text-sm">{(o.items || []).length}</td>
                    <td className="text-sm font-semibold">{fmtINR(o.total_amount)}</td>
                    <td>
                      <span className={`badge ${o.payment_status==='completed'?'badge-success':o.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                        {o.payment_status || 'pending'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewOrder && (
        <PartnerOrderModal
          order={viewOrder}
          onClose={() => setViewOrder(null)}
          onChanged={reloadOrders}
          detailsOnly
        />
      )}

      {/* PO-number popup — partner sets their own reference (or skips). */}
      {showPoModal && (
        <div className="modal-overlay" onClick={() => !submitting && setShowPoModal(false)}>
          <div className="modal" style={{maxWidth:'440px'}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Your PO Number</h3>
              <button className="modal-close" aria-label="Close" onClick={() => !submitting && setShowPoModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{fontSize:'0.85rem', color:'var(--text-muted)', marginBottom:'0.85rem'}}>
                Give this order your own reference number so it's easy to track on your side.
                Leave it blank to use an auto-generated number.
              </p>
              <input
                className="form-input"
                style={{width:'100%'}}
                placeholder="e.g. CUSSJKFKJ"
                value={poNumber}
                autoFocus
                maxLength={40}
                onChange={e => setPoNumber(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !submitting) handleSubmit(); }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => handleSubmit('')} disabled={submitting}>
                {submitting ? 'Submitting...' : 'Skip'}
              </button>
              <button className="btn btn-primary" onClick={() => handleSubmit()} disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Purchase Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

