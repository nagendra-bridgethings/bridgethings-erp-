// Partner — Dashboard
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useOrders, derivePartnerStatusLabel, useOrderStatusBreakdown, partnerStatusBadges } from '../../lib/orders';
import PartnerOrderModal from '../../components/PartnerOrderModal';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function PartnerDashboard() {
  const { user } = useAuth();
  // RLS scopes to the partner's own orders. Show only admin-accepted orders
  // (active / completed) — pending POs surface on the Purchase Orders page.
  const { orders: myOrders, loading, reload } = useOrders({
    includeStatuses: ['active', 'completed'],
    limit: 50,
  });
  // Recent POs = pending_approval + rejected. These are partner-side
  // submissions that haven't become "orders" yet.
  const { orders: recentPOs, reload: reloadPOs } = useOrders({
    includeStatuses: ['pending_approval', 'rejected'],
    limit: 20,
  });
  // Per-order unit-status breakdown so the My Recent Orders status column
  // can show the dynamic "3 Delivered · 1 In Production" view that matches
  // the partner My Orders page.
  const orderIds = useMemo(() => myOrders.map(o => o.id), [myOrders]);
  const breakdownByOrder = useOrderStatusBreakdown(orderIds);
  const [openOrder, setOpenOrder] = useState(null);
  const pendingPayment = myOrders.filter(o => o.payment_status !== 'completed');
  const totalOrdered = myOrders.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

  const reloadAll = async () => { await reload(); await reloadPOs(); };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Welcome, {user?.name}!</div>
          <div className="page-subtitle">Here's an overview of your account activity.</div>
        </div>
        <Link to="/partner/catalog" className="btn btn-primary">New Purchase Order</Link>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div><div className="stat-label">Total Orders</div><div className="stat-value">{myOrders.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Pending Payments</div><div className="stat-value">{pendingPayment.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Total Ordered Value</div><div className="stat-value" style={{fontSize:'1.3rem'}}>{fmtINR(totalOrdered)}</div></div>
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(360px, 1fr))', gap:'1.5rem'}}>
        {/* Recent POs — partner submissions still waiting (or rejected). */}
        <div className="card">
          <div className="card-header">
            <h2>Recent POs</h2>
            <Link to="/partner/po" className="btn btn-ghost btn-sm">View All →</Link>
          </div>
          {recentPOs.length === 0 ? (
            <div className="empty-state"><p>No purchase orders. <Link to="/partner/catalog">Submit your first PO</Link></p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Order ID</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {recentPOs.slice(0, 5).map(o => (
                    <tr
                      key={o.id}
                      style={{cursor:'pointer'}}
                      onClick={() => setOpenOrder(o)}
                      title="Click to view PO details"
                    >
                      <td><span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(o.id)}</span></td>
                      <td>{fmtINR(o.total_amount)}</td>
                      <td>{(() => {
                        const s = derivePartnerStatusLabel(o);
                        return <span className={`badge ${s.className}`}>{s.label}</span>;
                      })()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* My Recent Orders — admin-accepted, in-progress / completed. */}
        <div className="card">
          <div className="card-header">
            <h2>My Recent Orders</h2>
            <Link to="/partner/orders" className="btn btn-ghost btn-sm">View All →</Link>
          </div>
          {loading ? (
            <div className="empty-state"><p>Loading orders...</p></div>
          ) : myOrders.length === 0 ? (
            <div className="empty-state"><p>No orders yet. <Link to="/partner/catalog">Place your first order</Link></p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Order ID</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {myOrders.slice(0, 5).map(o => (
                    <tr
                      key={o.id}
                      style={{cursor:'pointer'}}
                      onClick={() => setOpenOrder(o)}
                      title="Click to view details and tracking"
                    >
                      <td><span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(o.id)}</span></td>
                      <td>{fmtINR(o.total_amount)}</td>
                      <td>{(() => {
                        // Mirror the My Orders page: show per-unit
                        // breakdown badges once dispatch is approved,
                        // single rolled-up label otherwise.
                        const counts = breakdownByOrder[o.id];
                        const canBreakdown =
                          counts
                          && o.dispatch_approval === 'approved'
                          && (o.status === 'active' || o.status === 'completed');
                        const badges = canBreakdown ? partnerStatusBadges(counts) : [];
                        if (badges.length > 0) {
                          return (
                            <span style={{display:'inline-flex', gap:'0.25rem', flexWrap:'wrap'}}>
                              {badges.map((b, i) => (
                                <span key={i} className={`badge ${b.cls}`}>{b.label}</span>
                              ))}
                            </span>
                          );
                        }
                        const s = derivePartnerStatusLabel(o);
                        return <span className={`badge ${s.className}`}>{s.label}</span>;
                      })()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {openOrder && (
        <PartnerOrderModal order={openOrder} onClose={() => setOpenOrder(null)} onChanged={reloadAll} />
      )}
    </>
  );
}
