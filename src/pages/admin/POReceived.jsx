// Admin — POs Received: review incoming POs, confirm or reject.
// Tabs split by status (Pending / Approved / Rejected). The list is a
// compact table; clicking a row opens a modal with full PO details
// (items, amount breakdown, notes textarea, and Confirm/Reject buttons
// for pending POs).
import { useMemo, useState } from 'react';
import { usePartners } from '../../lib/partners';
import { useOrders, orderRef } from '../../lib/orders';
import POReviewModal from '../../components/POReviewModal';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

// Map tab → which order statuses belong to it.
const TAB_STATUSES = {
  pending:  ['pending_approval'],
  approved: ['active', 'completed'],
  rejected: ['rejected'],
};

const TAB_LABELS = {
  pending:  'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_BADGE = {
  pending_approval: { className: 'badge-warning', label: 'Pending Review' },
  active:           { className: 'badge-info',    label: 'In Progress' },
  completed:        { className: 'badge-success', label: 'Completed' },
  rejected:         { className: 'badge-danger',  label: 'Rejected' },
};

export default function POReceived() {
  // limit: null — this is the ONLY admin UI listing pending POs; the default
  // 100-row cap (shared across all four statuses) would silently evict an
  // old PO stuck in negotiation once newer orders pile up.
  const { orders, loading, reload } = useOrders({
    includeStatuses: ['pending_approval', 'active', 'completed', 'rejected'],
    limit: null,
  });
  const { getPartner } = usePartners();

  const [tab, setTab] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');

  const buckets = useMemo(() => ({
    pending:  orders.filter(o => TAB_STATUSES.pending.includes(o.status)),
    approved: orders.filter(o => TAB_STATUSES.approved.includes(o.status)),
    rejected: orders.filter(o => TAB_STATUSES.rejected.includes(o.status)),
  }), [orders]);

  const visible = (() => {
    const base = buckets[tab];
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(o => {
      const partner = getPartner(o.partner_id);
      const hay = [orderRef(o), shortId(o.id), o.id, o.partner_po_number, partner?.name, partner?.company_name, partner?.email]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">POs Received</div>
          <div className="page-subtitle">
            {loading ? 'Loading...' : `${buckets.pending.length} pending, ${buckets.approved.length} approved, ${buckets.rejected.length} rejected`}
          </div>
        </div>
      </div>

      <div className="tabs">
        {Object.keys(TAB_LABELS).map(key => (
          <button
            key={key}
            className={`tab${tab === key ? ' active' : ''}`}
            onClick={() => { setTab(key); setSelected(null); }}
          >
            {TAB_LABELS[key]} ({buckets[key].length})
          </button>
        ))}
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by order ID, partner..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading purchase orders...</p></div></div>
      ) : visible.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No POs match "${search}".` : `No ${TAB_LABELS[tab].toLowerCase()} purchase orders.`}</p></div></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Channel Partner</th>
                  <th>Date</th>
                  <th>Requested Dispatch</th>
                  <th>Items</th>
                  <th style={{textAlign:'right'}}>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(order => {
                  const partner = getPartner(order.partner_id);
                  // Pending POs in negotiation get a clearer label so admin
                  // knows they're parked on the partner.
                  const isAwaitingPartner = order.status === 'pending_approval'
                    && order.delivery_negotiation_status === 'counter_sent';
                  const isCounterAccepted = order.status === 'pending_approval'
                    && order.delivery_negotiation_status === 'counter_accepted';
                  const badge = isAwaitingPartner
                    ? { className: 'badge-gray',    label: 'Awaiting Partner' }
                    : isCounterAccepted
                      ? { className: 'badge-info',  label: 'Partner Accepted — Review' }
                      : (STATUS_BADGE[order.status] || { className: 'badge-gray', label: order.status });
                  return (
                    <tr
                      key={order.id}
                      style={{cursor:'pointer'}}
                      onClick={() => setSelected(order)}
                      title="Click to view PO details"
                    >
                      <td>
                        <span className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(order)}</span>
                      </td>
                      <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                      <td className="text-sm">{fmtDate(order.created_at)}</td>
                      <td className="text-sm">
                        {order.committed_delivery_date
                          ? <span style={{color:'var(--success)', fontWeight:600}}>{fmtDate(order.committed_delivery_date)}</span>
                          : fmtDate(order.requested_delivery_date)}
                      </td>
                      <td className="text-sm">{(order.items || []).length}</td>
                      <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(order.total_amount)}</td>
                      <td><span className={`badge ${badge.className}`}>{badge.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && (
        <POReviewModal
          order={selected}
          partner={getPartner(selected.partner_id)}
          onClose={() => setSelected(null)}
          onConfirmed={async () => { await reload(); setSelected(null); }}
          onRejected={async () => { await reload(); setSelected(null); }}
        />
      )}
    </>
  );
}
