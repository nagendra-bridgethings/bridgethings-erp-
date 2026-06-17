// Finance — Dashboard with multi-instalment payment tracking.
// Each order can have many payment rows (the partner pays in pieces).
// Accountant clicks "Add Payment" → modal captures amount/date/method/ref
// → trigger auto-updates orders.amount_paid + payment_status.
import { useCallback, useEffect, useState } from 'react';
import { usePartners } from '../../lib/partners';
import { useOrders, orderRef } from '../../lib/orders';
import {
  usePaymentsForOrder, addPayment, deletePayment,
  PAYMENT_METHODS, PAYMENT_METHOD_LABEL,
  verifyPayment, rejectPayment, getPaymentSlipUrl,
} from '../../lib/payments';
import PartnerOrderModal from '../../components/PartnerOrderModal';
import { useToast } from '../../lib/toast';
import { supabase } from '../../lib/supabase';

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
  const [activeTab, setActiveTab] = useState('verify');
  const [pendingVerifyCount, setPendingVerifyCount] = useState(0);

  // Lightweight count fetch so the tab badge stays accurate after the
  // accountant verifies/rejects rows in the PendingVerificationList.
  const loadPendingVerifyCount = useCallback(async () => {
    const { count } = await supabase
      .from('bridgethings_order_payments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending_verification');
    setPendingVerifyCount(count || 0);
  }, []);
  useEffect(() => { loadPendingVerifyCount(); }, [loadPendingVerifyCount]);
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
      const hay = [orderRef(o), shortId(o.id), o.id, o.partner_po_number, p?.name, p?.company_name, p?.email]
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
        <button className={`tab ${activeTab==='verify'?'active':''}`} onClick={() => setActiveTab('verify')}>
          Pending Verification <span className="count">{pendingVerifyCount}</span>
        </button>
        <button className={`tab ${activeTab==='pending'?'active':''}`} onClick={() => setActiveTab('pending')}>
          Pending Payments <span className="count">{pending.length}</span>
        </button>
        <button className={`tab ${activeTab==='history'?'active':''}`} onClick={() => setActiveTab('history')}>
          Payment History <span className="count">{completed.length}</span>
        </button>
      </div>

      {activeTab === 'verify' && (
        <PendingVerificationList
          getPartner={getPartner}
          onChange={async () => { await reload(); await loadPendingVerifyCount(); }}
        />
      )}

      {activeTab !== 'verify' && (
      <>


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
                      {orderRef(order)}
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

      </>
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

// Cross-order list of payments awaiting accountant verification. Each
// row shows the order ID, the partner, the amount the partner claims,
// the uploaded slip, and Verify / Reject buttons. Verify flips the row
// to 'verified' → existing trigger adds the amount to the order's
// amount_paid + flips dispatch_approval. Reject asks for a note.
function PendingVerificationList({ getPartner, onChange }) {
  const { addToast } = useToast();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId]   = useState(null);
  const [rejectFor, setRejectFor] = useState(null);
  const [verifyFor, setVerifyFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    await supabase.auth.getSession();
    const { data, error } = await supabase
      .from('bridgethings_order_payments')
      .select('*, order:bridgethings_orders(id, partner_id, total_amount, amount_paid, partner_po_number)')
      .eq('status', 'pending_verification')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[verify] load failed:', error);
      setRows([]);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Verify is gated through a modal now so the accountant explicitly
  // confirms the amount + sees whether the order ends up partial or
  // fully paid before committing.

  if (loading) {
    return <div className="card"><div className="empty-state"><p>Loading pending verifications...</p></div></div>;
  }
  if (rows.length === 0) {
    return <div className="card"><div className="empty-state"><p>Nothing waiting for verification right now.</p></div></div>;
  }

  return (
    <>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Partner</th>
                <th>Date</th>
                <th>Method</th>
                <th>Reference</th>
                <th>Slip</th>
                <th style={{textAlign:'right'}}>Amount</th>
                <th style={{textAlign:'right'}}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const partner = getPartner(p.order?.partner_id);
                const busy = busyId === p.id;
                return (
                  <tr key={p.id}>
                    <td className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(p.order)}</td>
                    <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                    <td className="text-sm">{fmtDate(p.payment_date)}</td>
                    <td className="text-sm">{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
                    <td className="text-sm">{p.reference_number || '—'}</td>
                    <td className="text-sm">{p.receipt_url ? <SlipLink path={p.receipt_url} /> : '—'}</td>
                    <td className="text-sm font-semibold" style={{textAlign:'right', color:'var(--warning)'}}>{fmtINR(p.amount)}</td>
                    <td style={{textAlign:'right'}}>
                      <div style={{display:'inline-flex', gap:'0.4rem'}}>
                        <button className="btn btn-danger btn-sm"  disabled={busy} onClick={() => setRejectFor(p)}>Reject</button>
                        <button className="btn btn-success btn-sm" disabled={busy} onClick={() => setVerifyFor(p)}>
                          Verify
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {rejectFor && (
        <RejectPaymentModal
          row={rejectFor}
          onClose={() => setRejectFor(null)}
          onRejected={async () => { setRejectFor(null); await load(); if (onChange) await onChange(); }}
        />
      )}

      {verifyFor && (
        <VerifyPaymentModal
          row={verifyFor}
          getPartner={getPartner}
          onClose={() => setVerifyFor(null)}
          onVerified={async () => {
            setVerifyFor(null);
            await load();
            if (onChange) await onChange();
          }}
        />
      )}
    </>
  );
}

// Verify modal — shows the slip, the order's payment math, and a clear
// "this will leave the order partial / fully paid" classification before
// the accountant commits. They can also adjust the amount if the slip
// shows a different figure than what the partner claimed.
function VerifyPaymentModal({ row, getPartner, onClose, onVerified }) {
  const { addToast } = useToast();
  const partner = getPartner(row.order?.partner_id);
  const orderTotal      = Number(row.order?.total_amount) || 0;
  const alreadyPaid     = Number(row.order?.amount_paid)  || 0;
  const claimedAmount   = Number(row.amount)              || 0;
  const [amount, setAmount] = useState(claimedAmount.toFixed(2));
  const [busy, setBusy]     = useState(false);

  const amountNum  = Number(amount) || 0;
  const afterPaid  = alreadyPaid + amountNum;
  const outstanding = Math.max(0, orderTotal - afterPaid);
  const willComplete = afterPaid >= orderTotal;
  const adjusted = Math.abs(amountNum - claimedAmount) > 0.01;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (amountNum <= 0) { addToast('Amount must be greater than zero', 'error'); return; }
    setBusy(true);
    try {
      await verifyPayment(row.id, adjusted ? amountNum : undefined);
      addToast(
        willComplete
          ? 'Verified — order is now fully paid'
          : 'Verified as partial payment — balance remaining',
        'success',
      );
      await onVerified();
    } catch (err) {
      console.error('[verify] failed:', err);
      addToast(err.message || 'Failed to verify payment', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'520px'}}>
        <div className="modal-header">
          <h3>Verify Payment</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:'0.75rem', marginBottom:'1rem', padding:'0.85rem', background:'var(--bg)', borderRadius:'8px'}}>
              <div>
                <div className="text-xs text-muted">Order</div>
                <div className="font-semibold">{orderRef(row.order)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Partner</div>
                <div className="font-semibold">{partner?.name || partner?.company_name || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Method</div>
                <div className="font-semibold">{PAYMENT_METHOD_LABEL[row.payment_method] || row.payment_method}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Date</div>
                <div className="font-semibold">{fmtDate(row.payment_date)}</div>
              </div>
              {row.reference_number && (
                <div style={{gridColumn:'1 / -1'}}>
                  <div className="text-xs text-muted">Reference</div>
                  <div className="font-semibold">{row.reference_number}</div>
                </div>
              )}
              {row.receipt_url && (
                <div style={{gridColumn:'1 / -1'}}>
                  <div className="text-xs text-muted">Slip</div>
                  <SlipLink path={row.receipt_url} />
                </div>
              )}
              {row.notes && (
                <div style={{gridColumn:'1 / -1'}}>
                  <div className="text-xs text-muted">Partner Note</div>
                  <div className="text-sm">{row.notes}</div>
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Amount Received (₹)</label>
              <input
                type="number" min="0.01" step="0.01"
                className="form-input"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                required
              />
              <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>
                Partner claimed {fmtINR(claimedAmount)}{adjusted ? ' — you are adjusting this value' : ''}
              </div>
            </div>

            {/* Payment math — makes partial/full obvious. */}
            <div style={{
              padding:'0.85rem 1rem', borderRadius:'8px',
              background: willComplete ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)',
              border: `1px solid ${willComplete ? 'var(--success)' : 'var(--warning)'}`,
              display:'flex', flexDirection:'column', gap:'0.3rem', fontSize:'0.85rem',
            }}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <span className="text-muted">Order Total</span>
                <span className="font-semibold">{fmtINR(orderTotal)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <span className="text-muted">Already Verified</span>
                <span className="font-semibold">{fmtINR(alreadyPaid)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <span className="text-muted">This Payment</span>
                <span className="font-semibold">{fmtINR(amountNum)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', borderTop:'1px dashed var(--border)', paddingTop:'0.3rem', marginTop:'0.2rem'}}>
                <span className="font-semibold">After Verification</span>
                <span className="font-semibold">{fmtINR(afterPaid)}</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <span className="text-muted">Balance Remaining</span>
                <span className="font-semibold" style={{color: outstanding > 0 ? 'var(--warning)' : 'var(--success)'}}>{fmtINR(outstanding)}</span>
              </div>
              <div style={{marginTop:'0.4rem'}}>
                <span className={`badge ${willComplete ? 'badge-success' : 'badge-warning'}`}>
                  {willComplete ? 'Will be marked: FULLY PAID' : 'Will be marked: PARTIAL PAYMENT'}
                </span>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-success" disabled={busy}>
              {busy ? 'Verifying...' : (willComplete ? 'Verify (Fully Paid)' : 'Verify (Partial)')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Tiny prompt-modal used by the verification list — captures the
// rejection note before calling rejectPayment().
function RejectPaymentModal({ row, onClose, onRejected }) {
  const { addToast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await rejectPayment(row.id, note);
      addToast('Payment rejected — partner will see the reason', 'info');
      await onRejected();
    } catch (err) {
      console.error('[reject] failed:', err);
      addToast(err.message || 'Failed to reject payment', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'460px'}}>
        <div className="modal-header">
          <h3>Reject Payment</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Reason (shown to partner)</label>
              <textarea
                className="form-textarea" rows={3}
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="e.g. Amount on slip doesn't match the entered figure"
                required
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? 'Rejecting...' : 'Reject Payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Renders a "View" link that mints a signed URL on click. Used by both
// the pending verification list above and the per-order payments table.
function SlipLink({ path }) {
  const handleClick = async (e) => {
    e.preventDefault();
    const url = await getPaymentSlipUrl(path);
    if (url) window.open(url, '_blank', 'noopener');
  };
  return <a href="#" onClick={handleClick} style={{color:'var(--primary)'}}>View</a>;
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
            <th>Status</th>
            <th>Slip</th>
            <th style={{textAlign:'right'}}>Amount</th>
            {canEdit && <th></th>}
          </tr>
        </thead>
        <tbody>
          {payments.map(p => {
            const isPending  = p.status === 'pending_verification';
            const isRejected = p.status === 'rejected';
            const statusBadge = isPending
              ? { className: 'badge-warning', label: 'Pending Verification' }
              : isRejected
                ? { className: 'badge-danger',  label: 'Rejected' }
                : { className: 'badge-success', label: 'Verified' };
            const amountColor = isPending ? 'var(--warning)'
                              : isRejected ? 'var(--danger)'
                              : 'var(--success)';
            return (
              <tr key={p.id}>
                <td className="text-sm">{fmtDate(p.payment_date)}</td>
                <td className="text-sm">{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
                <td className="text-sm">{p.reference_number || '—'}</td>
                <td>
                  <span className={`badge ${statusBadge.className}`}>{statusBadge.label}</span>
                  {isRejected && p.rejection_note && (
                    <div className="text-xs text-muted" style={{marginTop:'0.2rem'}}>Reason: {p.rejection_note}</div>
                  )}
                </td>
                <td className="text-sm">{p.receipt_url ? <SlipLink path={p.receipt_url} /> : '—'}</td>
                <td className="text-sm font-semibold" style={{textAlign:'right', color:amountColor}}>{fmtINR(p.amount)}</td>
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
            );
          })}
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
      addToast(`₹${amt.toLocaleString('en-IN')} recorded for ${orderRef(order)}`, 'success');
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
          <h3>Record Payment — {orderRef(order)}</h3>
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
