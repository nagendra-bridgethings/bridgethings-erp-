// Admin Dashboard — Summary stats + recent activity
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { usePartners } from '../../lib/partners';
import { useOrders, orderRef } from '../../lib/orders';
import { approveDispatch, rejectDispatch } from '../../lib/orders';
import { resolveOpsTeam } from '../../lib/portalPaths';
import POReviewModal from '../../components/POReviewModal';
import { useToast } from '../../lib/toast';
import { supabase } from '../../lib/supabase';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');

const statusBadge = status => {
  const map = { draft:'badge-gray', pending_approval:'badge-warning', active:'badge-info', completed:'badge-success' };
  const labels = { draft:'Draft', pending_approval:'Pending Approval', active:'In Progress', completed:'Completed' };
  return <span className={`badge ${map[status]||'badge-gray'}`}>{labels[status]||status}</span>;
};

export default function AdminDashboard() {
  const { user } = useAuth();
  const { addToast } = useToast();
  // Employees see an operational view (Products + Active Orders only).
  // Admins see the full picture including Channel Partners, Pending POs,
  // and Revenue Received.
  const isAdmin = user?.role === 'admin';
  // Dispatch sees an order only after operations has handed off ≥1 unit
  // (ready_to_dispatch or already dispatched). Mirrors the gate used on
  // the Orders page so the Dashboard's Active/Completed counts match.
  const team = user?.role === 'employee' ? resolveOpsTeam(user) : null;

  const { partners, getPartner, loading: partnersLoading } = usePartners();
  // limit: null — the stat cards, Revenue Received, and the Production
  // Approvals queue are aggregates over ALL orders; a capped window silently
  // drops older orders (e.g. an old order paid partially today would vanish
  // from the approvals queue forever). Display tables slice client-side.
  const { orders, loading: ordersLoading, reload: reloadOrders } = useOrders({ limit: null });
  const [productCount, setProductCount] = useState(0);
  const [productsLoading, setProductsLoading] = useState(true);
  // Per-order unit-status counts. Used to filter the Active/Completed
  // count cards for the dispatch role (only counts orders where ops has
  // handed off ≥1 unit).
  const [unitStatusByOrder, setUnitStatusByOrder] = useState({});
  // Recent POs rows open the PO review modal (confirm/reject).
  const [openPO, setOpenPO] = useState(null);

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

  useEffect(() => {
    // Dispatch needs counts for the dispatch-only visibility gate; admin +
    // ops need them so the Recent Orders status badge mirrors the rollup
    // shown on the Orders page (e.g. "In Production" instead of the raw
    // order-status "In Progress").
    if (!orders.length) return;
    let cancelled = false;
    (async () => {
      const itemIds = orders.flatMap(o => (o.items || []).map(i => i.id));
      if (!itemIds.length) return;
      const { data, error } = await supabase
        .from('bridgethings_order_unit_details')
        .select('order_item_id, production_status')
        .in('order_item_id', itemIds);
      if (cancelled) return;
      if (error) {
        console.error('[Dashboard] unit status load failed:', error);
        return;
      }
      const itemToOrder = {};
      for (const o of orders) {
        for (const it of (o.items || [])) itemToOrder[it.id] = o.id;
      }
      const map = {};
      for (const row of data || []) {
        const oid = itemToOrder[row.order_item_id];
        if (!oid) continue;
        if (!map[oid]) map[oid] = {};
        const s = row.production_status || 'hold';
        map[oid][s] = (map[oid][s] || 0) + 1;
      }
      setUnitStatusByOrder(map);
    })();
    return () => { cancelled = true; };
  }, [orders]);

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
  //
  // Dispatch has an extra gate: ops must have actually handed off ≥1 unit
  // (ready_to_dispatch or dispatched). Otherwise the order is invisible —
  // even if dispatch is approved, dispatch has nothing to do yet.
  const visibleOrders = (() => {
    if (isAdmin) return orders;
    const approved = orders.filter(o => o.dispatch_approval === 'approved');
    if (team !== 'dispatch') return approved;
    return approved.filter(o => {
      const c = unitStatusByOrder[o.id] || {};
      return ((c.ready_to_dispatch || 0) + (c.dispatched || 0)) > 0;
    });
  })();
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

      {/* Production Approvals — admin must say yes/no when payment is partial
          before ops can start producing units for this order. */}
      {isAdmin && (
        <DispatchApprovalsCard
          orders={orders}
          getPartner={getPartner}
          reload={reloadOrders}
          addToast={addToast}
        />
      )}

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
                      <td><span className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(o)}</span></td>
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
      addToast(`${orderRef(order)} approved for production`, 'success');
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
        <h2>Production Approvals <span className="badge badge-warning" style={{marginLeft:'0.5rem'}}>{pending.length}</span></h2>
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
                  <td><span className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(o)}</span></td>
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
          <h3>Reject Production — {orderRef(order)}</h3>
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

