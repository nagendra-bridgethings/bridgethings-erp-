// Admin — Dashboard Subscriptions per device unit.
// One row per physical unit. Staff approve pending partner requests and
// activate / renew subscriptions directly.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { usePartners } from '../../lib/partners';
import { useToast } from '../../lib/toast';
import {
  useUnitSubscriptions, createSubscription, approveSubscription, cancelSubscription,
  setDashboardCredentials, rejectSubscriptionProof, getSubscriptionSlipUrl,
  effectiveStatus, latestSubFor, addOneYear,
} from '../../lib/subscriptions';
import { orderRef } from '../../lib/orders';
import { staffProductName } from '../../lib/productName';
import { PAYMENT_METHOD_LABEL } from '../../lib/payments';

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const today   = () => new Date().toISOString().slice(0, 10);

const STATUS_LABELS = {
  active:'Active', expiring_soon:'Expiring Soon', expired:'Expired',
  pending:'Pending Request', submitted:'Payment Submitted', cancelled:'Cancelled', none:'No Subscription',
};
const STATUS_COLORS = {
  active:'badge-success', expiring_soon:'badge-warning', expired:'badge-danger',
  pending:'badge-info', submitted:'badge-warning', cancelled:'badge-gray', none:'badge-gray',
};

// 'submitted' (proof in — ready to verify) first, then 'pending' (awaiting the
// partner's proof), so the actionable requests are the most prominent.
const TAB_FILTERS = ['all', 'submitted', 'pending', 'none', 'active', 'expiring_soon', 'expired'];

const ROW_ACTION_LABEL = {
  submitted: 'Verify',
  pending:   'Review',
  none:      'Activate',
};

export default function Subscriptions() {
  const { addToast } = useToast();
  const { getPartner } = usePartners();
  const { subs, loading: subsLoading, reload: reloadSubs } = useUnitSubscriptions();
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [openUnit, setOpenUnit] = useState(null);

  // Load every unit row (with its item -> order -> partner + product) so we
  // can list devices across all orders. RLS gives staff full visibility.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setUnitsLoading(true);
      await supabase.auth.getSession();
      const { data, error } = await supabase
        .from('bridgethings_order_unit_details')
        .select(`
          *,
          item:bridgethings_order_items(
            id, qty,
            order:bridgethings_orders(id, partner_id, status, delivered_date, partner_po_number),
            product:bridgethings_products(id, name, internal_name, subscription_price)
          )
        `)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        console.error('[subscriptions] units load failed:', error);
        addToast(error.message || 'Failed to load units', 'error');
        setUnits([]);
      } else {
        setUnits(data || []);
      }
      setUnitsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  // Group subs by unit_id for O(1) lookup while rendering rows.
  const subsByUnit = useMemo(() => {
    const map = {};
    for (const s of subs) {
      (map[s.unit_id] = map[s.unit_id] || []).push(s);
    }
    return map;
  }, [subs]);

  // Build flat rows for the table — ONLY for units whose order has actually
  // been DELIVERED. Units are auto-created the moment a PO is submitted, so
  // without this gate a pending/in-production order's devices would show up
  // as subscription-eligible before the customer even has them. order-level
  // delivered_date is set only once the whole order is delivered (cleared
  // otherwise), and is the same signal the partner My Devices page uses.
  const rows = useMemo(() => units
    .filter(u => Boolean(u.item?.order?.delivered_date))
    .map(u => {
      const unitSubs = subsByUnit[u.id] || [];
      const latest   = latestSubFor(unitSubs);
      return {
        unit:    u,
        partner: getPartner(u.item?.order?.partner_id),
        product: u.item?.product,
        latest,
        status:  effectiveStatus(latest),
        history: unitSubs,
      };
    }), [units, subsByUnit, getPartner]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(r => {
      if (filter !== 'all' && r.status !== filter) return false;
      if (!term) return true;
      const hay = [
        r.unit?.serial_number, r.unit?.sim, staffProductName(r.product),
        r.partner?.name, r.partner?.company_name, r.unit?.id,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  }, [rows, filter, search]);

  const tabCount = (key) =>
    key === 'all' ? rows.length : rows.filter(r => r.status === key).length;

  // "Requests to action" = awaiting-proof (pending) + proof-submitted rows.
  const isRequest = (r) => r.status === 'pending' || r.status === 'submitted';
  const pendingCount = rows.filter(isRequest).length;
  // Money-tracking summary for Accounts: outstanding requests, total
  // collected on currently-active subs, count expiring in 30 days.
  const pendingAmount  = rows
    .filter(isRequest)
    .reduce((s, r) => s + (Number(r.status === 'submitted' ? r.latest?.amount_paid : r.latest?.amount_due) || 0), 0);
  // Filter on the DERIVED status: the DB never flips status on expiry, so
  // raw status==='active' would count expired rows and every historical
  // renewal forever — contradicting the adjacent Active Subscriptions card.
  const activeRevenue  = subs
    .filter(s => ['active', 'expiring_soon'].includes(effectiveStatus(s)))
    .reduce((s, x) => s + (Number(x.amount_paid) || 0), 0);
  const expiringSoon   = rows.filter(r => r.status === 'expiring_soon').length;
  const loading        = subsLoading || unitsLoading;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Device Subscriptions</div>
          <div className="page-subtitle">One subscription per physical unit — valid 1 year from start date.</div>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div><div className="stat-label">Pending Requests</div><div className="stat-value" style={{color:'var(--info)'}}>{pendingCount}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Amount Awaited</div><div className="stat-value" style={{fontSize:'1.3rem', color:'var(--info)'}}>{fmtINR(pendingAmount)}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Active Subscriptions</div><div className="stat-value" style={{color:'var(--success)'}}>{rows.filter(r => r.status === 'active' || r.status === 'expiring_soon').length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Expiring in 30 days</div><div className="stat-value" style={{color:'var(--warning)'}}>{expiringSoon}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Revenue Collected</div><div className="stat-value" style={{fontSize:'1.3rem', color:'var(--primary)'}}>{fmtINR(activeRevenue)}</div></div>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="card" style={{marginBottom:'1rem', borderLeft:'4px solid var(--info)'}}>
          <div style={{padding:'1rem 1.25rem', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div>
              <div className="font-semibold">{pendingCount} pending subscription request(s)</div>
              <div className="text-sm text-muted">Partners are waiting for activation. Share payment details and click Review to approve.</div>
            </div>
            <button className="btn btn-info btn-sm" onClick={() => setFilter(rows.some(r => r.status === 'submitted') ? 'submitted' : 'pending')}>View Requests</button>
          </div>
        </div>
      )}

      <div className="tabs">
        {TAB_FILTERS.map(t => (
          <button
            key={t}
            className={`tab${filter === t ? ' active' : ''}`}
            onClick={() => setFilter(t)}
          >
            {t === 'all' ? 'All' : STATUS_LABELS[t]} ({tabCount(t)})
          </button>
        ))}
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search serial, SIM, partner, product..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading subscriptions...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>No units match this view.</p></div></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Product</th>
                  <th>Meter Serial Number</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Start</th>
                  <th>Expires</th>
                  <th style={{textAlign:'right'}}>Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const isPending   = r.status === 'pending';
                  const isSubmitted = r.status === 'submitted';
                  const isReview    = isPending || isSubmitted; // not yet activated
                  // Requested amount (amount_due) while pending; the partner's
                  // claimed amount (amount_paid) once a proof is submitted;
                  // otherwise the recorded payment on the active row.
                  const amount = isPending
                    ? r.latest?.amount_due
                    : r.latest?.amount_paid;
                  return (
                    <tr key={r.unit.id} style={isReview ? {background:'rgba(59,130,246,0.04)'} : undefined}>
                      <td className="text-sm">{r.partner?.name || r.partner?.company_name || '—'}</td>
                      <td className="text-sm font-semibold">{staffProductName(r.product) || '—'}</td>
                      <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{r.unit.serial_number || '—'}</code></td>
                      <td className="text-sm"><span style={{color:'var(--primary)'}}>{orderRef(r.unit.item?.order)}</span></td>
                      <td><span className={`badge ${STATUS_COLORS[r.status]}`}>{STATUS_LABELS[r.status]}</span></td>
                      <td className="text-sm">{isReview ? '—' : fmtDate(r.latest?.start_date)}</td>
                      <td className="text-sm">{isReview ? '—' : fmtDate(r.latest?.end_date)}</td>
                      <td className="text-sm" style={{textAlign:'right'}}>{amount ? fmtINR(amount) : '—'}</td>
                      <td>
                        <button className="btn btn-primary btn-sm" onClick={() => setOpenUnit(r)}>
                          {ROW_ACTION_LABEL[r.status] || 'Renew'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openUnit && (
        <SubscriptionModal
          row={openUnit}
          onClose={() => setOpenUnit(null)}
          onSaved={async (msg) => {
            await reloadSubs();
            setOpenUnit(null);
            addToast(msg || 'Subscription saved', 'success');
          }}
          onCancelled={async () => {
            await reloadSubs();
            // Close like onSaved does: the open modal holds a pre-cancel
            // snapshot (stale badge + live Cancel button), so leaving it
            // open invites a duplicate cancel + duplicate partner email.
            setOpenUnit(null);
            addToast('Subscription cancelled', 'info');
          }}
        />
      )}
    </>
  );
}

function SubscriptionModal({ row, onClose, onSaved, onCancelled }) {
  const { addToast } = useToast();
  const latest      = row.latest;
  const isPending   = row.status === 'pending';   // requested, no proof yet
  const isSubmitted = row.status === 'submitted'; // proof uploaded, awaiting verify
  const isReview    = isPending || isSubmitted;   // partner request not yet activated
  // For a review (pending/submitted) the existing row gets updated. For
  // everything else we insert a new row (activation / renewal).
  // Default start: day after the most recent active end, else today.
  const prior = (row.history || []).find(h => h.status === 'active');
  const defaultStart = (!isReview && prior?.end_date)
    ? new Date(new Date(prior.end_date).getTime() + 86_400_000).toISOString().slice(0, 10)
    : today();

  const defaultAmount = isSubmitted
    ? (latest?.amount_paid ?? latest?.amount_due ?? row.product?.subscription_price ?? '')
    : isPending
      ? (latest?.amount_due ?? row.product?.subscription_price ?? '')
      : (row.product?.subscription_price ?? '');

  const [startDate, setStartDate]     = useState(defaultStart);
  const [amount, setAmount]           = useState(defaultAmount);
  const [paymentDate, setPaymentDate] = useState(today());
  const [notes, setNotes]             = useState(latest?.notes || '');
  const [saving, setSaving]           = useState(false);

  // Dashboard credentials live on the unit (one set per device, reused
  // across renewals). Required on first activation; on renewal we just
  // show what's on file with an Edit toggle.
  const hasExistingCreds = Boolean(row.unit.dashboard_username || row.unit.dashboard_password);
  const [editCreds, setEditCreds] = useState(!hasExistingCreds);
  const [dashUser, setDashUser]   = useState(row.unit.dashboard_username || '');
  const [dashPass, setDashPass]   = useState(row.unit.dashboard_password || '');
  const [showPass, setShowPass]   = useState(false);

  const endDate = addOneYear(startDate);

  const handleSave = async () => {
    if (!startDate) { addToast('Start date is required', 'error'); return; }
    if (editCreds) {
      if (!dashUser.trim() || !dashPass) {
        addToast('Dashboard username and password are required', 'error');
        return;
      }
    }
    setSaving(true);
    try {
      // Persist credentials first when entered (first activation or reset)
      // so the partner sees the new login as soon as the sub flips active.
      if (editCreds) {
        await setDashboardCredentials(row.unit.id, { username: dashUser, password: dashPass });
      }
      if (isReview) {
        await approveSubscription(latest.id, {
          startDate, amountPaid: amount, paymentDate, notes,
        });
        await onSaved('Subscription approved & activated');
      } else {
        await createSubscription({
          unitId:      row.unit.id,
          startDate,
          amountPaid:  amount,
          paymentDate,
          notes,
        });
        await onSaved('Subscription saved');
      }
    } catch (err) {
      console.error('[subscriptions] save failed:', err);
      addToast(err.message || 'Failed to save subscription', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRejectPending = async () => {
    if (!latest?.id) return;
    // Optional reason — shown to the partner in the "request declined" mail.
    const note = window.prompt('Decline this subscription request? Optionally add a reason for the partner (they will see it). The partner can submit a new request afterwards.', '');
    if (note === null) return; // prompt cancelled
    setSaving(true);
    try {
      // Declining a pending REQUEST — sends the "request declined" mail (not
      // the misleading "subscription cancelled" one, since the partner never
      // had active coverage).
      await cancelSubscription(latest.id, { mode: 'declined', note });
      await onSaved('Request declined');
    } catch (err) {
      console.error('[subscriptions] reject failed:', err);
      addToast(err.message || 'Failed to reject request', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Reject a SUBMITTED proof (wrong/unclear slip) — sends it back to the
  // partner as 'pending' with a note so they can re-upload. Distinct from
  // declining a request outright.
  const handleRejectProof = async () => {
    const note = window.prompt('Reason for rejecting this payment proof (the partner will see it and can re-upload):');
    if (note == null) return;
    if (!note.trim()) { addToast('Please add a rejection reason', 'error'); return; }
    setSaving(true);
    try {
      await rejectSubscriptionProof(latest.id, note.trim());
      await onSaved('Payment proof rejected — sent back to the partner');
    } catch (err) {
      console.error('[subscriptions] reject proof failed:', err);
      addToast(err.message || 'Failed to reject proof', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Open the partner's uploaded slip. Window is opened synchronously (inside
  // the click) so popup blockers don't swallow it after the await.
  const openSlip = async () => {
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    const url = await getSubscriptionSlipUrl(latest?.receipt_url);
    if (url) { if (w) w.location = url; else window.open(url, '_blank', 'noopener'); }
    else { if (w) w.close(); addToast('Could not open the payment slip', 'error'); }
  };

  const handleCancelSub = async (id) => {
    // A pending/submitted row is a REQUEST, not active coverage — declining it
    // must send the "request declined" mail, not "subscription cancelled".
    const target = (row.history || []).find(h => h.id === id);
    const isRequestRow = target && (target.status === 'pending' || target.status === 'submitted');
    const confirmMsg = isRequestRow
      ? 'Decline this subscription request? The partner will be notified and can submit a new one.'
      : 'Cancel this subscription? It will stay in history but stop counting toward access.';
    if (!window.confirm(confirmMsg)) return;
    try {
      await cancelSubscription(id, isRequestRow ? { mode: 'declined' } : {});
      await onCancelled();
    } catch (err) {
      console.error('[subscriptions] cancel failed:', err);
      addToast(err.message || 'Failed to cancel subscription', 'error');
    }
  };

  const modalTitle = isSubmitted ? 'Verify Subscription Payment' :
                     isPending   ? 'Review Subscription Request' :
                     latest      ? 'Renew Subscription' :
                                   'Activate Subscription';
  const submitLabel = isReview ? 'Approve & Activate'
                    : latest   ? 'Renew (+1 year)'
                    :            'Activate (+1 year)';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'680px'}}>
        <div className="modal-header">
          <h3>{modalTitle}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {isReview && (
            <div style={{padding:'1rem 1.15rem', background:'rgba(59,130,246,0.06)', border:'1px solid var(--info)', borderRadius:'10px', marginBottom:'1.25rem'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'1rem', flexWrap:'wrap'}}>
                <div>
                  <div className="font-semibold text-sm">
                    {isSubmitted ? 'Payment proof submitted' : 'Subscription requested'}
                  </div>
                  <div className="text-xs text-muted" style={{marginTop:'0.15rem'}}>
                    {isSubmitted ? 'Uploaded' : 'Requested'} on {fmtDate(latest?.created_at)} by {row.partner?.name || row.partner?.company_name || 'the partner'}
                  </div>
                </div>
                {isSubmitted && latest?.receipt_url && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={openSlip}
                    style={{display:'inline-flex', alignItems:'center', gap:'0.4rem', whiteSpace:'nowrap'}}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    View Payment Slip
                  </button>
                )}
              </div>

              {isSubmitted ? (
                <>
                  <div style={{display:'flex', gap:'1.75rem', flexWrap:'wrap', marginTop:'0.85rem', paddingTop:'0.85rem', borderTop:'1px solid var(--border)'}}>
                    <div>
                      <div className="text-xs text-muted">Claimed amount</div>
                      <div className="font-semibold" style={{fontSize:'1.05rem', color:'var(--primary)'}}>{fmtINR(latest?.amount_paid)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">Method</div>
                      <div className="font-semibold text-sm">{PAYMENT_METHOD_LABEL[latest?.payment_method] || '—'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">Paid on</div>
                      <div className="font-semibold text-sm">{fmtDate(latest?.payment_date)}</div>
                    </div>
                  </div>
                  <div className="text-xs text-muted" style={{marginTop:'0.75rem'}}>
                    Open the slip, confirm the amount &amp; start date below, then approve.
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted" style={{marginTop:'0.5rem'}}>
                  Requested amount: <b>{fmtINR(latest?.amount_due)}</b>. Waiting on the partner's payment proof — or set the amount + date below and approve directly if paid offline.
                </div>
              )}
            </div>
          )}

          <div style={{padding:'1rem', background:'var(--bg)', borderRadius:'8px', marginBottom:'1.25rem'}}>
            <div className="text-xs text-muted">Device</div>
            <div className="font-semibold">{staffProductName(row.product) || 'Unknown product'}</div>
            <div className="text-sm" style={{marginTop:'0.25rem'}}>
              Meter Serial Number: <code>{row.unit.serial_number || '—'}</code>
              {row.unit.sim && <> &middot; SIM: <code>{row.unit.sim}</code></>}
            </div>
            <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>
              Partner: {row.partner?.name || row.partner?.company_name || '—'}
            </div>
          </div>

          <div className="form-grid form-grid-2">
            <div className="form-group">
              <label className="form-label">Start Date</label>
              <input type="date" className="form-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Expires (auto)</label>
              <input className="form-input" value={fmtDate(endDate)} disabled />
            </div>
            <div className="form-group">
              <label className="form-label">Amount Paid (₹)</label>
              <input
                type="number" min="0" step="0.01" className="form-input"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={String(defaultAmount || '0')}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Payment Date</label>
              <input type="date" className="form-input" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>
            <div className="form-group" style={{gridColumn:'1 / -1'}}>
              <label className="form-label">Notes (optional)</label>
              <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Reference, receipt #, etc." />
            </div>
          </div>

          <h4 style={{margin:'1.5rem 0 0.5rem', fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em'}}>
            Dashboard Credentials
          </h4>
          {!editCreds ? (
            <div style={{padding:'0.85rem 1rem', background:'var(--bg)', borderRadius:'8px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
              <div>
                <div className="text-xs text-muted">Username</div>
                <div className="font-semibold text-sm"><code>{row.unit.dashboard_username || '—'}</code></div>
                <div className="text-xs text-muted" style={{marginTop:'0.4rem'}}>Password</div>
                <div className="font-semibold text-sm">
                  <code>{showPass ? (row.unit.dashboard_password || '—') : '••••••••'}</code>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPass(s => !s)}>{showPass ? 'Hide' : 'Show'}</button>
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditCreds(true)}>
                Reset Credentials
              </button>
            </div>
          ) : (
            <>
              <div className="text-xs text-muted" style={{marginBottom:'0.5rem'}}>
                {hasExistingCreds
                  ? 'Overwriting the existing login. Share the new credentials with the partner.'
                  : 'Captured once per device. Renewals reuse the same login automatically.'}
              </div>
              <div className="form-grid form-grid-2">
                <div className="form-group">
                  <label className="form-label">Dashboard Username</label>
                  <input className="form-input" value={dashUser} onChange={e => setDashUser(e.target.value)} placeholder="e.g. bridge_partner_001" autoComplete="off" />
                </div>
                <div className="form-group">
                  <label className="form-label">Dashboard Password</label>
                  <div style={{display:'flex', gap:'0.4rem'}}>
                    <input
                      className="form-input"
                      type={showPass ? 'text' : 'password'}
                      value={dashPass}
                      onChange={e => setDashPass(e.target.value)}
                      placeholder="Strong password"
                      autoComplete="new-password"
                    />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPass(s => !s)}>{showPass ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
              </div>
              {hasExistingCreds && (
                <button type="button" className="btn btn-ghost btn-sm" style={{marginTop:'0.25rem'}} onClick={() => {
                  setEditCreds(false);
                  setDashUser(row.unit.dashboard_username || '');
                  setDashPass(row.unit.dashboard_password || '');
                }}>
                  Cancel reset
                </button>
              )}
            </>
          )}

          {row.history.length > 0 && (
            <>
              <h4 style={{margin:'1.5rem 0 0.5rem', fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em'}}>
                Subscription History
              </h4>
              <div className="table-wrap">
                <table style={{margin:0}}>
                  <thead>
                    <tr>
                      <th>Start</th><th>Expires</th><th style={{textAlign:'right'}}>Amount</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.history.map(h => (
                      <tr key={h.id}>
                        <td className="text-sm">{h.status === 'pending' ? '—' : fmtDate(h.start_date)}</td>
                        <td className="text-sm">{h.status === 'pending' ? '—' : fmtDate(h.end_date)}</td>
                        <td className="text-sm" style={{textAlign:'right'}}>{fmtINR(h.status === 'pending' ? h.amount_due : h.amount_paid)}</td>
                        <td><span className={`badge ${STATUS_COLORS[effectiveStatus(h)]}`}>{STATUS_LABELS[effectiveStatus(h)]}</span></td>
                        <td>
                          {h.status !== 'cancelled' && (
                            <button className="btn btn-ghost btn-sm" style={{color:'var(--danger)'}} onClick={() => handleCancelSub(h.id)}>Cancel</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>Close</button>
          {isSubmitted && (
            <button className="btn btn-danger" disabled={saving} onClick={handleRejectProof}>Reject Proof</button>
          )}
          {isPending && (
            <button className="btn btn-danger" disabled={saving} onClick={handleRejectPending}>Decline Request</button>
          )}
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? 'Saving...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
