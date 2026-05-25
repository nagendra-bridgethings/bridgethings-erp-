// Finance — Dashboard with multi-instalment payment tracking.
// Each order can have many payment rows (the partner pays in pieces).
// Accountant clicks "Add Payment" → modal captures amount/date/method/ref
// → trigger auto-updates orders.amount_paid + payment_status.
import { useState } from 'react';
import { usePartners } from '../../lib/partners';
import { useOrders } from '../../lib/orders';
import {
  usePaymentsForOrder, addPayment, deletePayment,
  PAYMENT_METHODS, PAYMENT_METHOD_LABEL,
} from '../../lib/payments';
import PartnerOrderModal from '../../components/PartnerOrderModal';
import { useToast } from '../../lib/toast';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';
const today   = () => new Date().toISOString().slice(0, 10);

export default function Finance() {
  // Accountant only sees orders the admin has already accepted (active or
  // completed). Pending POs and rejected ones live on the admin side.
  const { orders, loading, reload } = useOrders({
    includeStatuses: ['active', 'completed'],
  });
  const [activeTab, setActiveTab] = useState('pending');
  const [openOrder, setOpenOrder] = useState(null);
  const [payOrder, setPayOrder]   = useState(null); // order being paid into
  const [historyOrderId, setHistoryOrderId] = useState(null); // expanded payment history
  const [search, setSearch] = useState('');

  const { getPartner } = usePartners();

  const pending = orders.filter(o => o.payment_status !== 'completed');
  const completed = orders.filter(o => o.payment_status === 'completed');

  const totalRevenue = orders.reduce((s, o) => s + (Number(o.amount_paid) || 0), 0);
  const totalOutstanding = orders.reduce((s, o) => s + ((Number(o.total_amount) || 0) - (Number(o.amount_paid) || 0)), 0);

  const displayed = (() => {
    const base = activeTab === 'pending' ? pending : completed;
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(o => {
      const p = getPartner(o.partner_id);
      const hay = [shortId(o.id), o.id, p?.name, p?.company_name, p?.email]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Finance Dashboard</div>
          <div className="page-subtitle">Track payments and update financial status</div>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid" style={{marginBottom:'1.5rem'}}>
        <div className="stat-card">
          <div><div className="stat-label">Total Revenue Collected</div><div className="stat-value" style={{fontSize:'1.4rem', color:'var(--success)'}}>{fmtINR(totalRevenue)}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Outstanding Payments</div><div className="stat-value" style={{fontSize:'1.4rem', color:'var(--danger)'}}>{fmtINR(totalOutstanding)}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Pending Orders</div><div className="stat-value">{pending.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Fully Paid Orders</div><div className="stat-value">{completed.length}</div></div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${activeTab==='pending'?'active':''}`} onClick={() => setActiveTab('pending')}>
          Pending Payments <span className="count">{pending.length}</span>
        </button>
        <button className={`tab ${activeTab==='history'?'active':''}`} onClick={() => setActiveTab('history')}>
          Payment History <span className="count">{completed.length}</span>
        </button>
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by order ID or partner..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading orders...</p></div></div>
      ) : displayed.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No orders match "${search}".` : 'No orders in this category.'}</p></div></div>
      ) : (
        <div style={{display:'flex', flexDirection:'column', gap:'1rem'}}>
          {displayed.map(order => {
            const partner = getPartner(order.partner_id);
            const outstanding = (Number(order.total_amount) || 0) - (Number(order.amount_paid) || 0);
            const isHistoryOpen = historyOrderId === order.id;
            return (
              <div key={order.id} className="card">
                <div className="card-header">
                  <div style={{display:'flex', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
                    <button
                      type="button"
                      className="font-semibold"
                      onClick={() => setOpenOrder(order)}
                      style={{color:'var(--primary)', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline', fontSize:'inherit'}}
                      title="Click to view order details"
                    >
                      ORD-{shortId(order.id)}
                    </button>
                    <span className="text-sm text-muted">{partner?.name || partner?.company_name || '—'}</span>
                    <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                      {order.payment_status}
                    </span>
                  </div>
                  <div style={{display:'flex', gap:'0.4rem'}}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setHistoryOrderId(isHistoryOpen ? null : order.id)}
                    >
                      {isHistoryOpen ? 'Hide payments' : 'Payments'}
                    </button>
                    {outstanding > 0 && (
                      <button className="btn btn-success btn-sm" onClick={() => setPayOrder(order)}>
                        + Add Payment
                      </button>
                    )}
                  </div>
                </div>

                {/* Payment Details */}
                <div style={{padding:'1rem 1.5rem', display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:'1rem', borderBottom: isHistoryOpen ? '1px solid var(--border)' : 'none'}}>
                  <div><div className="text-xs text-muted">Total Amount</div><div className="font-semibold">{fmtINR(order.total_amount)}</div></div>
                  <div><div className="text-xs text-muted">Amount Paid</div><div className="font-semibold" style={{color:'var(--success)'}}>{fmtINR(order.amount_paid)}</div></div>
                  <div><div className="text-xs text-muted">Outstanding</div><div className="font-semibold" style={{color: outstanding > 0 ? 'var(--danger)' : 'var(--success)'}}>{fmtINR(outstanding)}</div></div>
                  <div><div className="text-xs text-muted">Order Date</div><div>{fmtDate(order.created_at)}</div></div>
                </div>

                {isHistoryOpen && (
                  <PaymentsTable orderId={order.id} canEdit onReload={reload} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {openOrder && (
        <PartnerOrderModal order={openOrder} onClose={() => setOpenOrder(null)} onChanged={reload} />
      )}

      {payOrder && (
        <AddPaymentModal
          order={payOrder}
          onClose={() => setPayOrder(null)}
          onSaved={async () => {
            await reload();
            // Auto-open history for the order we just paid into.
            setHistoryOrderId(payOrder.id);
            setPayOrder(null);
          }}
        />
      )}
    </>
  );
}

// Embedded payment history for one order. Used inline on /finance and
// also (without canEdit) on the partner My Orders modal.
export function PaymentsTable({ orderId, canEdit = false, onReload }) {
  const { addToast } = useToast();
  const { payments, loading, reload } = usePaymentsForOrder(orderId);
  const [deletingId, setDeletingId] = useState(null);

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this payment? The order balance will update automatically.')) return;
    setDeletingId(id);
    try {
      await deletePayment(id);
      await reload();
      if (onReload) await onReload();
      addToast('Payment removed', 'info');
    } catch (err) {
      console.error('[payments] delete failed:', err);
      addToast(err.message || 'Failed to remove payment', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return <div style={{padding:'1rem 1.5rem'}} className="text-sm text-muted">Loading payments...</div>;
  }
  if (payments.length === 0) {
    return <div style={{padding:'1rem 1.5rem'}} className="text-sm text-muted">No payments recorded yet.</div>;
  }
  return (
    <div className="table-wrap" style={{padding:'0 0 0.5rem'}}>
      <table style={{margin:0}}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th>Notes</th>
            <th style={{textAlign:'right'}}>Amount</th>
            {canEdit && <th></th>}
          </tr>
        </thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id}>
              <td className="text-sm">{fmtDate(p.payment_date)}</td>
              <td className="text-sm">{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
              <td className="text-sm">{p.reference_number || '—'}</td>
              <td className="text-sm text-muted">{p.notes || '—'}</td>
              <td className="text-sm font-semibold" style={{textAlign:'right', color:'var(--success)'}}>{fmtINR(p.amount)}</td>
              {canEdit && (
                <td style={{textAlign:'right'}}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{color:'var(--danger)'}}
                    disabled={deletingId === p.id}
                    onClick={() => handleDelete(p.id)}
                  >
                    {deletingId === p.id ? '...' : 'Remove'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddPaymentModal({ order, onClose, onSaved }) {
  const { addToast } = useToast();
  const outstanding = (Number(order.total_amount) || 0) - (Number(order.amount_paid) || 0);
  const [amount, setAmount]           = useState(outstanding > 0 ? outstanding.toFixed(2) : '');
  const [paymentDate, setPaymentDate] = useState(today());
  const [method, setMethod]           = useState('bank_transfer');
  const [reference, setReference]     = useState('');
  const [notes, setNotes]             = useState('');
  const [saving, setSaving]           = useState(false);

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { addToast('Enter a positive amount', 'error'); return; }
    if (!paymentDate)     { addToast('Pick a payment date', 'error'); return; }
    setSaving(true);
    try {
      await addPayment({
        orderId:         order.id,
        amount:          amt,
        paymentDate,
        method,
        referenceNumber: reference,
        notes,
      });
      addToast(`₹${amt.toLocaleString('en-IN')} recorded for ORD-${shortId(order.id)}`, 'success');
      await onSaved();
    } catch (err) {
      console.error('[payments] add failed:', err);
      addToast(err.message || 'Failed to record payment', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'560px'}}>
        <div className="modal-header">
          <h3>Record Payment — ORD-{shortId(order.id)}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{padding:'0.85rem 1rem', background:'var(--bg)', borderRadius:'8px', marginBottom:'1rem', display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:'0.75rem'}}>
            <div>
              <div className="text-xs text-muted">Total Amount</div>
              <div className="font-semibold">{fmtINR(order.total_amount)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Already Paid</div>
              <div className="font-semibold" style={{color:'var(--success)'}}>{fmtINR(order.amount_paid)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Outstanding</div>
              <div className="font-semibold" style={{color: outstanding > 0 ? 'var(--danger)' : 'var(--success)'}}>{fmtINR(outstanding)}</div>
            </div>
          </div>

          <div className="form-grid form-grid-2">
            <div className="form-group">
              <label className="form-label">Amount Received (₹) *</label>
              <input
                type="number" min="0.01" step="0.01"
                className="form-input"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={outstanding > 0 ? outstanding.toFixed(2) : '0.00'}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Payment Date *</label>
              <input type="date" className="form-input" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Method</label>
              <select className="form-select" value={method} onChange={e => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Reference / Txn #</label>
              <input className="form-input" value={reference} onChange={e => setReference(e.target.value)} placeholder="UPI ref, cheque no., UTR..." />
            </div>
            <div className="form-group" style={{gridColumn:'1 / -1'}}>
              <label className="form-label">Notes (optional)</label>
              <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any extra context for this payment" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn btn-success" disabled={saving} onClick={handleSave}>
            {saving ? 'Saving...' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
