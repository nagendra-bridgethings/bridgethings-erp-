// Partner — Create Purchase Order.
// Items are added from the Catalog page and live in the cart context
// (persisted to localStorage) so navigating between pages preserves the draft.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { createOrder, useOrders } from '../../lib/orders';
import { COURIERS } from '../../lib/couriers';
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
  // Order shown in the items-preview modal triggered from the recent-orders table.
  const [viewOrder, setViewOrder] = useState(null);
  // Courier id selected by the partner. Defaults to the cheapest option so
  // the order total is meaningful even before they pick.
  const [courierId, setCourierId] = useState(COURIERS[0]?.id || '');
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
  // Grand total = (items − discount) + shipping + IGST on the discounted
  // subtotal. Matches the server-side math in createOrder() because we
  // pass the same discounted unit_price below.
  const orderTotals = computeOrderTotal({ itemsSubtotal: itemsAfterDiscount, shipping: shippingCost });
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
      const hay = [shortId(o.id), o.id, o.status, o.payment_status, o.delivery_method, o.tracking_number]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();
  const displayedOrders = showAllPOs ? filteredOrders : filteredOrders.slice(0, 5);

  const handleSubmit = async () => {
    if (items.length === 0) { addToast('Add at least one product to the PO', 'error'); return; }
    if (!user?.supabaseId) { addToast('Cannot submit: not signed in', 'error'); return; }

    setSubmitting(true);
    try {
      await createOrder({
        partnerId: user.supabaseId,
        items: items.map(i => ({
          product_id: i.product_id,
          qty:        i.qty,
          unit_price: applyDiscount(i.product.base_price, discountPct),
          notes:      i.notes,
        })),
        status:                'pending_approval',
        deliveryMethod:        selectedCourier?.name || null,
        shippingCost:          shippingCost,
        requestedDeliveryDate: requestedDeliveryDate || null,
      });
      clear();
      setRequestedDeliveryDate('');
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
      <p style={{color:'var(--text-muted)', marginBottom:'1.5rem'}}>Your purchase order has been sent to Bridge Things for review. You'll be notified once they confirm the delivery dates.</p>
      <button className="btn btn-primary" onClick={() => { setSubmitted(false); navigate('/partner/catalog'); }}>Create Another PO</button>
    </div>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Purchase Orders</div>
          <div className="page-subtitle">Submit new orders from your cart and track recent submissions</div>
        </div>
        {items.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              if (window.confirm('Clear all items from this PO?')) clear();
            }}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Items List */}
      {items.length > 0 && (
        <div className="card" style={{marginBottom:'1.25rem'}}>
          <div className="card-header"><h2>Order Items ({items.length})</h2></div>
          <div>
            {items.map((item, idx) => {
              const unitPrice = applyDiscount(item.product.base_price, discountPct);
              return (
              <div key={item.product_id} style={{padding:'1.25rem 1.5rem', borderBottom:'1px solid var(--border)'}}>
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
                <div className="form-grid form-grid-2">
                  <div className="form-group">
                    <label className="form-label">Quantity</label>
                    <input type="number" min="1" className="form-input" value={item.qty}
                      onChange={e => updateField(idx, 'qty', Math.max(1, parseInt(e.target.value)||1))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Notes / Customization</label>
                    <input className="form-input" value={item.notes} placeholder="Optional notes..."
                      onChange={e => updateField(idx, 'notes', e.target.value)} />
                  </div>
                </div>
                <div style={{textAlign:'right', fontWeight:600, color:'var(--primary)', marginTop:'0.5rem'}}>
                  Item Total: {fmtINR(unitPrice * item.qty)}
                </div>
              </div>
              );
            })}
          </div>

          {/* Courier selection */}
          <div style={{padding:'1.25rem 1.5rem', borderTop:'1px solid var(--border)'}}>
            <div style={{fontSize:'0.95rem', fontWeight:600, marginBottom:'0.75rem'}}>Delivery Partner</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:'0.6rem'}}>
              {COURIERS.map(c => {
                const isSelected = c.id === courierId;
                return (
                  <label
                    key={c.id}
                    style={{
                      display:'flex',
                      alignItems:'center',
                      justifyContent:'space-between',
                      gap:'0.5rem',
                      padding:'0.7rem 0.9rem',
                      border: `1.5px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius:'8px',
                      cursor:'pointer',
                      background: isSelected ? '#eff6ff' : 'var(--card)',
                      transition:'all 0.15s',
                    }}
                  >
                    <div style={{display:'flex', alignItems:'center', gap:'0.5rem'}}>
                      <input
                        type="radio"
                        name="courier"
                        value={c.id}
                        checked={isSelected}
                        onChange={() => setCourierId(c.id)}
                      />
                      <span style={{fontWeight:600, fontSize:'0.875rem'}}>{c.name}</span>
                    </div>
                    <span style={{fontWeight:600, fontSize:'0.875rem', color:'var(--primary)'}}>
                      {fmtINR(c.price)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Requested delivery date — optional. Admin reviews and either
              accepts or counter-proposes. */}
          <div style={{padding:'1.25rem 1.5rem', borderTop:'1px solid var(--border)'}}>
            <div style={{fontSize:'0.95rem', fontWeight:600, marginBottom:'0.5rem'}}>Requested Delivery Date</div>
            <div style={{fontSize:'0.8rem', color:'var(--text-muted)', marginBottom:'0.5rem'}}>
              When would you like to receive this order? Bridge Things will confirm or propose an alternative.
            </div>
            <input
              type="date"
              className="form-input"
              value={requestedDeliveryDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={e => setRequestedDeliveryDate(e.target.value)}
              style={{maxWidth:'260px'}}
            />
          </div>

          {/* Summary */}
          <div style={{padding:'1.25rem 1.5rem', background:'var(--bg)', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'1rem', flexWrap:'wrap'}}>
            <div style={{display:'flex', flexDirection:'column', gap:'0.25rem'}}>
              <div style={{display:'flex', justifyContent:'space-between', gap:'1.5rem', fontSize:'0.85rem', color:'var(--text-muted)'}}>
                <span>Items subtotal</span>
                <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(total)}</span>
              </div>
              {discountPct > 0 && (
                <div style={{display:'flex', justifyContent:'space-between', gap:'1.5rem', fontSize:'0.85rem', color:'var(--success)'}}>
                  <span>Discount ({discountPct}% off)</span>
                  <span style={{fontWeight:600}}>− {fmtINR(discountSaved)}</span>
                </div>
              )}
              <div style={{display:'flex', justifyContent:'space-between', gap:'1.5rem', fontSize:'0.85rem', color:'var(--text-muted)'}}>
                <span>Shipping ({selectedCourier?.name || '—'})</span>
                <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shippingCost)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', gap:'1.5rem', fontSize:'0.85rem', color:'var(--text-muted)'}}>
                <span>{IGST_LABEL}</span>
                <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(orderTotals.tax)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', gap:'1.5rem', fontSize:'1rem', borderTop:'1px solid var(--border)', paddingTop:'0.4rem', marginTop:'0.25rem'}}>
                <span style={{fontWeight:700}}>Order Total</span>
                <span style={{fontSize:'1.4rem', fontWeight:700, color:'var(--primary)'}}>{fmtINR(grandTotal)}</span>
              </div>
            </div>
            <button className="btn btn-primary" style={{padding:'0.7rem 2rem', fontSize:'0.95rem'}} onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit Purchase Order'}
            </button>
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
                  <th>Order ID</th>
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
                        ORD-{shortId(o.id)}
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
    </>
  );
}

