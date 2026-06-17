// Partner — My Orders.
// Compact list of order IDs; click a row to open a modal with two tabs
// (Details + Tracking). The modal is shared with the partner Dashboard so
// the click-to-detail experience is consistent across the portal.
import { useMemo, useState } from 'react';
import { useOrders, derivePartnerStatusLabel, useOrderStatusBreakdown, partnerStatusBadges, orderRef } from '../../lib/orders';
import PartnerOrderModal from '../../components/PartnerOrderModal';

const ORDER_STATUS_LABELS = { draft:'Draft', pending_approval:'Awaiting Confirmation', active:'In Progress', completed:'Completed', rejected:'Rejected' };
const ORDER_STATUS_COLORS = { draft:'badge-gray', pending_approval:'badge-warning', active:'badge-info', completed:'badge-success', rejected:'badge-danger' };
const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function MyOrders() {
  // RLS scopes this to the partner's own rows. We only want orders the
  // admin has accepted — pending_approval / rejected live on the Purchase
  // Orders page (they haven't become "orders" yet).
  const { orders: allOrders, loading, reload } = useOrders({
    includeStatuses: ['active', 'completed'],
  });
  const myOrders = allOrders;
  // Per-order unit-status breakdown (incl. shipped vs delivered split)
  // so the status column can render "3 Delivered · 1 In Production"
  // dynamically instead of a single rolled-up label.
  const orderIds = useMemo(() => myOrders.map(o => o.id), [myOrders]);
  const breakdownByOrder = useOrderStatusBreakdown(orderIds);
  const [activeTab, setActiveTab] = useState('all');
  // Payment-status filter so partners can quickly find orders with a
  // balance still due (partial), unpaid orders, or fully paid ones —
  // works on top of the status tab + free-text search.
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [openOrder, setOpenOrder] = useState(null);
  const [search, setSearch] = useState('');

  const tabs = ['all', 'active', 'completed'];
  // Normalise to the three buckets we display; treat missing as 'pending'
  // so the chip counts add up to the total order count.
  const paymentBucket = o => o.payment_status || 'pending';
  const paymentChips = [
    { key: 'all',       label: 'All Payments' },
    { key: 'pending',   label: 'Unpaid' },
    { key: 'partial',   label: 'Partial' },
    { key: 'completed', label: 'Paid' },
  ];
  const filtered = (() => {
    let base = activeTab === 'all' ? myOrders : myOrders.filter(o => o.status === activeTab);
    if (paymentFilter !== 'all') base = base.filter(o => paymentBucket(o) === paymentFilter);
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(o => {
      const hay = [orderRef(o), shortId(o.id), o.id, o.partner_po_number, o.status, o.payment_status, o.delivery_method, o.tracking_number]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">My Orders</div>
          <div className="page-subtitle">Track all your orders in real-time</div>
        </div>
      </div>

      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'1rem', flexWrap:'wrap', borderBottom:'1px solid var(--border)', marginBottom:'1.5rem'}}>
        <div className="tabs" style={{border:'none', margin:0}}>
          {tabs.map(t => (
            <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`} onClick={() => setActiveTab(t)}>
              {t === 'all' ? 'All Orders' : ORDER_STATUS_LABELS[t]}
              <span className="count">{t === 'all' ? myOrders.length : myOrders.filter(o => o.status === t).length}</span>
            </button>
          ))}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:'0.5rem', paddingBottom:'0.4rem'}}>
          <span className="text-xs text-muted" style={{textTransform:'uppercase', letterSpacing:'0.05em'}}>Payment</span>
          <select
            className="form-select"
            value={paymentFilter}
            onChange={e => setPaymentFilter(e.target.value)}
            style={{minWidth:'150px'}}
          >
            {paymentChips.map(chip => {
              const count = chip.key === 'all'
                ? myOrders.length
                : myOrders.filter(o => paymentBucket(o) === chip.key).length;
              return <option key={chip.key} value={chip.key}>{chip.label} ({count})</option>;
            })}
          </select>
        </div>
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by order ID, status, courier, tracking number..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading orders...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No orders match "${search}".` : 'No orders in this category.'}</p></div></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Date</th>
                  <th style={{textAlign:'right'}}>Total</th>
                  <th>Status</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(order => (
                  <tr
                    key={order.id}
                    style={{cursor:'pointer'}}
                    onClick={() => setOpenOrder(order)}
                    title="Click to view details and tracking"
                  >
                    <td>
                      <span className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(order)}</span>
                    </td>
                    <td className="text-sm">{fmtDate(order.created_at)}</td>
                    <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(order.total_amount)}</td>
                    <td>
                      {(() => {
                        // Show per-unit breakdown badges once dispatch has
                        // been approved AND the order has progressed past
                        // the pre-production states. For pending/rejected
                        // /awaiting-payment etc. the single rolled-up
                        // label is more informative.
                        const counts = breakdownByOrder[order.id];
                        const canBreakdown =
                          counts
                          && order.dispatch_approval === 'approved'
                          && (order.status === 'active' || order.status === 'completed');
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
                        const s = derivePartnerStatusLabel(order);
                        return <span className={`badge ${s.className}`}>{s.label}</span>;
                      })()}
                    </td>
                    <td>
                      <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                        {order.payment_status || 'pending'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openOrder && (
        <PartnerOrderModal order={openOrder} onClose={() => setOpenOrder(null)} onChanged={reload} />
      )}
    </>
  );
}
