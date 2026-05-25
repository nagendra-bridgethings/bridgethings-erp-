// Admin Dashboard — Summary stats + recent activity
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { usePartners } from '../../lib/partners';
import { useOrders } from '../../lib/orders';
import { IGST_LABEL } from '../../lib/tax';
import { approveDispatch, rejectDispatch } from '../../lib/orders';
import POReviewModal from '../../components/POReviewModal';
import { useToast } from '../../lib/toast';
import { supabase } from '../../lib/supabase';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';

const statusBadge = status => {
  const map = { draft:'badge-gray', pending_approval:'badge-warning', active:'badge-info', completed:'badge-success' };
  const labels = { draft:'Draft', pending_approval:'Pending Approval', active:'Active', completed:'Completed' };
  return <span className={`badge ${map[status]||'badge-gray'}`}>{labels[status]||status}</span>;
};

export default function AdminDashboard() {
  const { user } = useAuth();
  const { addToast } = useToast();
  // Employees see an operational view (Products + Active Orders only).
  // Admins see the full picture including Channel Partners, Pending POs,
  // and Revenue Received.
  const isAdmin = user?.role === 'admin';

  const { partners, getPartner, loading: partnersLoading } = usePartners();
  const { orders, loading: ordersLoading, reload: reloadOrders } = useOrders({ limit: 50 });
  const [productCount, setProductCount] = useState(0);
  const [productsLoading, setProductsLoading] = useState(true);
  // Selected order for the detail modal — Recent Orders rows open the
  // shipping/items view; Recent POs rows open the PO review (confirm/reject).
  const [openOrder, setOpenOrder] = useState(null);
  const [openPO, setOpenPO]       = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await supabase.auth.getSession(); // Fix race condition before querying
      const { count } = await supabase
        .from('bridgethings_products')
        .select('*', { count: 'exact', head: true });
      if (!cancelled) {
        setProductCount(count || 0);
        setProductsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalRevenue = orders.reduce((s, o) => s + (Number(o.amount_paid) || 0), 0);
  // Pending = POs the admin can act on right now. POs in 'counter_sent'
  // are waiting on the partner to accept/decline, so they're hidden from
  // the queue until the partner responds.
  const pending   = orders.filter(o =>
    o.status === 'pending_approval'
    && o.delivery_negotiation_status !== 'counter_sent'
  );
  // Employees only see orders that have been cleared for dispatch — full
  // payment (auto-approved) or partial payment that admin has manually
  // approved. Admins see everything.
  const visibleOrders = isAdmin
    ? orders
    : orders.filter(o => o.dispatch_approval === 'approved');
  const active    = visibleOrders.filter(o => o.status === 'active');
  const completed = visibleOrders.filter(o => o.status === 'completed');

  const isLoading = partnersLoading || ordersLoading || productsLoading;

  if (isLoading) {
    return (
      <>
        <div className="page-header">
          <div>
            <div className="page-title">Dashboard</div>
            <div className="page-subtitle">Welcome back — here's what's happening today.</div>
          </div>
        </div>
        <div className="card"><div className="empty-state"><p>Loading dashboard...</p></div></div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">Welcome back — here's what's happening today.</div>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div><div className="stat-label">Total Products</div><div className="stat-value">{productCount}</div></div>
        </div>
        {isAdmin && (
          <div className="stat-card">
            <div><div className="stat-label">Channel Partners</div><div className="stat-value">{partners.length}</div></div>
          </div>
        )}
        {isAdmin && (
          <div className="stat-card">
            <div><div className="stat-label">Pending POs</div><div className="stat-value">{pending.length}</div></div>
          </div>
        )}
        <div className="stat-card">
          <div><div className="stat-label">Active Orders</div><div className="stat-value">{active.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Completed Orders</div><div className="stat-value">{completed.length}</div></div>
        </div>
        {isAdmin && (
          <div className="stat-card">
            <div><div className="stat-label">Revenue Received</div><div className="stat-value" style={{fontSize:'1.4rem'}}>{fmtINR(totalRevenue)}</div></div>
          </div>
        )}
      </div>

      {/* Dispatch Approvals — admin must say yes/no when payment is partial */}
      {isAdmin && (
        <DispatchApprovalsCard
          orders={orders}
          getPartner={getPartner}
          reload={reloadOrders}
          addToast={addToast}
        />
      )}

      {/* Two-column layout: Recent POs (admin-only) + Recent Orders */}
      <div style={{display:'grid', gridTemplateColumns: isAdmin ? 'repeat(auto-fit, minmax(360px, 1fr))' : '1fr', gap:'1.5rem'}}>
        {isAdmin && (
          <div className="card">
            <div className="card-header">
              <h2>Recent POs</h2>
              <Link to="/admin/po-received" className="btn btn-ghost btn-sm">View All →</Link>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Order ID</th><th>Partner</th><th style={{textAlign:'right'}}>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {pending.slice(0, 5).map(o => {
                    const partner = getPartner(o.partner_id);
                    return (
                      <tr
                        key={o.id}
                        style={{cursor:'pointer'}}
                        onClick={() => setOpenPO({ order: o, partner })}
                        title="Click to review the PO"
                      >
                        <td><span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(o.id)}</span></td>
                        <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                        <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(o.total_amount)}</td>
                        <td>{statusBadge(o.status)}</td>
                      </tr>
                    );
                  })}
                  {pending.length === 0 && (
                    <tr><td colSpan={4} style={{textAlign:'center', color:'var(--text-muted)', padding:'1.5rem'}}>No pending POs</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <h2>Recent Orders</h2>
            <Link to="/admin/fulfillment" className="btn btn-ghost btn-sm">View All →</Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Order ID</th><th>Partner</th><th style={{textAlign:'right'}}>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {visibleOrders.filter(o => o.status === 'active' || o.status === 'completed').slice(0, 5).map(o => {
                  const partner = getPartner(o.partner_id);
                  return (
                    <tr
                      key={o.id}
                      style={{cursor:'pointer'}}
                      onClick={() => setOpenOrder({ order: o, partner })}
                      title="Click to view order details and shipping address"
                    >
                      <td><span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(o.id)}</span></td>
                      <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                      <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(o.total_amount)}</td>
                      <td>{statusBadge(o.status)}</td>
                    </tr>
                  );
                })}
                {visibleOrders.filter(o => o.status === 'active' || o.status === 'completed').length === 0 && (
                  <tr><td colSpan={4} style={{textAlign:'center', color:'var(--text-muted)', padding:'1.5rem'}}>No orders yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {openOrder && (
        <OrderDetailModal
          order={openOrder.order}
          partner={openOrder.partner}
          onClose={() => setOpenOrder(null)}
        />
      )}

      {openPO && (
        <POReviewModal
          order={openPO.order}
          partner={openPO.partner}
          onClose={() => setOpenPO(null)}
          onConfirmed={async () => { await reloadOrders(); setOpenPO(null); }}
          onRejected={async () => { await reloadOrders(); setOpenPO(null); }}
        />
      )}
    </>
  );
}

// Lists every active order awaiting an admin dispatch decision (partial
// payment received). Admin can approve dispatch on the spot or send the
// order back to the partner with a "pay more" note.
function DispatchApprovalsCard({ orders, getPartner, reload, addToast }) {
  const pending = orders.filter(o => o.dispatch_approval === 'pending');
  const [busyId, setBusyId]   = useState(null);
  const [rejectFor, setRejectFor] = useState(null);

  if (pending.length === 0) return null;

  const handleApprove = async (order) => {
    setBusyId(order.id);
    try {
      await approveDispatch(order.id);
      await reload();
      addToast(`ORD-${shortId(order.id)} cleared for dispatch`, 'success');
    } catch (err) {
      console.error('[dispatch] approve failed:', err);
      addToast(err.message || 'Failed to approve dispatch', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" style={{marginBottom:'1.5rem', borderLeft:'4px solid var(--warning)'}}>
      <div className="card-header">
        <h2>Dispatch Approvals <span className="badge badge-warning" style={{marginLeft:'0.5rem'}}>{pending.length}</span></h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Partner</th>
              <th style={{textAlign:'right'}}>Total</th>
              <th style={{textAlign:'right'}}>Paid</th>
              <th style={{textAlign:'right'}}>Outstanding</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pending.map(o => {
              const partner     = getPartner(o.partner_id);
              const total       = Number(o.total_amount) || 0;
              const paid        = Number(o.amount_paid)  || 0;
              const outstanding = Math.max(0, total - paid);
              const pct         = total > 0 ? Math.round((paid / total) * 100) : 0;
              const busy        = busyId === o.id;
              return (
                <tr key={o.id}>
                  <td><span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(o.id)}</span></td>
                  <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                  <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(total)}</td>
                  <td className="text-sm" style={{textAlign:'right', color:'var(--success)'}}>{fmtINR(paid)} <span className="text-xs text-muted">({pct}%)</span></td>
                  <td className="text-sm font-semibold" style={{textAlign:'right', color:'var(--danger)'}}>{fmtINR(outstanding)}</td>
                  <td style={{textAlign:'right'}}>
                    <div style={{display:'inline-flex', gap:'0.4rem'}}>
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setRejectFor(o)}>
                        Reject
                      </button>
                      <button className="btn btn-success btn-sm" disabled={busy} onClick={() => handleApprove(o)}>
                        {busy ? '...' : 'Approve'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rejectFor && (
        <RejectDispatchModal
          order={rejectFor}
          onClose={() => setRejectFor(null)}
          onSaved={async () => {
            await reload();
            setRejectFor(null);
            addToast('Order sent back to partner', 'info');
          }}
        />
      )}
    </div>
  );
}

function RejectDispatchModal({ order, onClose, onSaved }) {
  const { addToast } = useToast();
  const outstanding = (Number(order.total_amount) || 0) - (Number(order.amount_paid) || 0);
  const [note, setNote] = useState(
    `Please pay an additional ${fmtINR(outstanding)} before we dispatch this order.`
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!note.trim()) { addToast('Add a message for the partner', 'error'); return; }
    setSaving(true);
    try {
      await rejectDispatch(order.id, note);
      await onSaved();
    } catch (err) {
      console.error('[dispatch] reject failed:', err);
      addToast(err.message || 'Failed to reject dispatch', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'520px'}}>
        <div className="modal-header">
          <h3>Reject Dispatch — ORD-{shortId(order.id)}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="text-sm text-muted" style={{marginBottom:'0.75rem'}}>
            The message below will be shown to the partner inside their order. They can pay more, after which the order automatically comes back to you for review.
          </div>
          <div className="form-group">
            <label className="form-label">Message to Partner</label>
            <textarea
              className="form-textarea"
              rows={4}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Please pay 50% before we dispatch this order"
              autoFocus
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={saving} onClick={handleSave}>
            {saving ? 'Sending...' : 'Send Back to Partner'}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderDetailModal({ order, partner, onClose }) {
  // Address lines for shipping. Pull every available partner field so the
  // employee has a complete shipping label without going elsewhere.
  const addressParts = [
    partner?.address,
    [partner?.city, partner?.state, partner?.pincode].filter(Boolean).join(', '),
  ].filter(Boolean);

  // Reconstruct the financial breakdown from the order row so admin sees
  // each component (items, shipping, IGST) separately — not just the
  // rolled-up total_amount.
  const itemsSubtotal = (order.items || []).reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
    0,
  );
  const shipping     = Number(order.shipping_cost) || 0;
  const tax          = Number(order.tax_amount)    || 0;
  const totalExclTax = itemsSubtotal + shipping;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'720px'}}>
        <div className="modal-header">
          <h3>Order ORD-{shortId(order.id)}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Top summary band */}
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:'1rem', marginBottom:'1.25rem', padding:'1rem', background:'var(--bg)', borderRadius:'8px'}}>
            <div>
              <div className="text-xs text-muted">Order Date</div>
              <div className="font-semibold">{fmtDate(order.created_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Status</div>
              <div>{statusBadge(order.status)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Total (excl. IGST)</div>
              <div className="font-semibold">{fmtINR(totalExclTax)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Total (incl. IGST)</div>
              <div className="font-semibold" style={{color:'var(--primary)'}}>{fmtINR(order.total_amount)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Payment</div>
              <div>
                <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                  {order.payment_status || '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Ship-to address */}
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
            Ship To
          </h4>
          <div style={{padding:'1rem', border:'1px solid var(--border)', borderRadius:'8px', marginBottom:'1.25rem', lineHeight:1.6}}>
            <div className="font-semibold">{partner?.name || partner?.company_name || 'Unknown partner'}</div>
            {partner?.company_name && partner?.name && partner.name !== partner.company_name && (
              <div className="text-sm">{partner.company_name}</div>
            )}
            {addressParts.map((line, i) => (
              <div key={i} className="text-sm">{line}</div>
            ))}
            {partner?.phone && <div className="text-sm" style={{marginTop:'0.4rem'}}>📞 {partner.phone}</div>}
            {partner?.email && <div className="text-sm text-muted">{partner.email}</div>}
            {partner?.gst_number && <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>GSTIN: {partner.gst_number}</div>}
          </div>

          {/* Items */}
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
            Items to Ship
          </h4>
          <div className="table-wrap" style={{marginBottom:'1.25rem'}}>
            <table style={{margin:0}}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{textAlign:'right'}}>Qty</th>
                  <th style={{textAlign:'right'}}>Unit Price</th>
                  <th style={{textAlign:'right'}}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {(order.items || []).map(item => {
                  const price = Number(item.unit_price) || 0;
                  return (
                    <tr key={item.id}>
                      <td className="font-semibold text-sm">{item.product?.name || '—'}</td>
                      <td style={{textAlign:'right'}}>{item.qty}</td>
                      <td style={{textAlign:'right'}}>{fmtINR(price)}</td>
                      <td style={{textAlign:'right'}} className="font-semibold">{fmtINR(price * (Number(item.qty) || 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Financial breakdown */}
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
            Amount Breakdown
          </h4>
          <div style={{padding:'1rem', border:'1px solid var(--border)', borderRadius:'8px', marginBottom:'1.25rem', display:'flex', flexDirection:'column', gap:'0.3rem'}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
              <span>Items subtotal</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(itemsSubtotal)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
              <span>Shipping{order.delivery_method ? ` (${order.delivery_method})` : ''}</span>
              <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shipping)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', borderTop:'1px dashed var(--border)', paddingTop:'0.4rem', marginTop:'0.2rem'}}>
              <span style={{fontWeight:600}}>Total before IGST</span>
              <span style={{fontWeight:600}}>{fmtINR(totalExclTax)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.9rem', color:'var(--text-muted)'}}>
              <span>{IGST_LABEL}</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(tax)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'1rem', borderTop:'1px solid var(--border)', paddingTop:'0.5rem', marginTop:'0.25rem'}}>
              <span style={{fontWeight:700}}>Total payable</span>
              <span style={{fontWeight:700, color:'var(--primary)', fontSize:'1.2rem'}}>{fmtINR(order.total_amount)}</span>
            </div>
          </div>

          {/* Shipping info */}
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
            Shipping
          </h4>
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:'1rem', padding:'1rem', border:'1px solid var(--border)', borderRadius:'8px'}}>
            <div>
              <div className="text-xs text-muted">Courier</div>
              <div className="font-semibold">
                {order.delivery_method || '—'}
                {shipping > 0 && <span className="text-xs text-muted" style={{marginLeft:'0.4rem', fontWeight:400}}>({fmtINR(shipping)})</span>}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Tracking Number</div>
              <div className="font-semibold" style={{wordBreak:'break-all'}}>{order.tracking_number || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Delivered Date</div>
              <div className="font-semibold">{fmtDate(order.delivered_date)}</div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <Link to="/admin/fulfillment" className="btn btn-primary" onClick={onClose}>
            Go to Orders
          </Link>
        </div>
      </div>
    </div>
  );
}
