// Partner — My Orders.
// Compact list of order IDs; click a row to open a modal with two tabs
// (Details + Tracking). The modal is shared with the partner Dashboard so
// the click-to-detail experience is consistent across the portal.
import { useState } from 'react';
import { useOrders } from '../../lib/orders';
import PartnerOrderModal from '../../components/PartnerOrderModal';

const ORDER_STATUS_LABELS = { draft:'Draft', pending_approval:'Awaiting Confirmation', active:'Active', completed:'Completed', rejected:'Rejected' };
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
  const [activeTab, setActiveTab] = useState('all');
  const [openOrder, setOpenOrder] = useState(null);
  const [search, setSearch] = useState('');

  const tabs = ['all', 'active', 'completed'];
  const filtered = (() => {
    const base = activeTab === 'all' ? myOrders : myOrders.filter(o => o.status === activeTab);
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(o => {
      const hay = [shortId(o.id), o.id, o.status, o.payment_status, o.delivery_method, o.tracking_number]
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

      <div className="tabs">
        {tabs.map(t => (
          <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`} onClick={() => setActiveTab(t)}>
            {t === 'all' ? 'All Orders' : ORDER_STATUS_LABELS[t]}
            <span className="count">{t === 'all' ? myOrders.length : myOrders.filter(o => o.status === t).length}</span>
          </button>
        ))}
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
                      <span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(order.id)}</span>
                    </td>
                    <td className="text-sm">{fmtDate(order.created_at)}</td>
                    <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(order.total_amount)}</td>
                    <td>
                      <span className={`badge ${ORDER_STATUS_COLORS[order.status]||'badge-gray'}`}>
                        {ORDER_STATUS_LABELS[order.status]||order.status}
                      </span>
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
