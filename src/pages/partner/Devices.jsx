// Partner — My Devices
//
// Lists every unit the partner owns + their dashboard-subscription status.
// Partner can select devices that need a sub (none/expired/expiring) and
// submit a Subscription Request — staff then activate once payment lands.
// Once active, partner can view the dashboard login captured by Accounts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import {
  useUnitSubscriptions, requestSubscriptions, submitSubscriptionProof,
  getDashboardCredentials,
  effectiveStatus, daysRemaining, latestSubFor, coverageSubFor,
} from '../../lib/subscriptions';
import { PAYMENT_METHODS } from '../../lib/payments';
import { orderRef } from '../../lib/orders';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

const STATUS_LABELS = {
  active:'Active', expiring_soon:'Expiring Soon', expired:'Expired',
  pending:'Requested', submitted:'Payment Submitted', cancelled:'Cancelled', none:'No Subscription',
};
const STATUS_COLORS = {
  active:'badge-success', expiring_soon:'badge-warning', expired:'badge-danger',
  pending:'badge-info', submitted:'badge-purple', cancelled:'badge-gray', none:'badge-gray',
};

// Statuses a partner can request/renew a subscription for.
const SELECTABLE_STATUSES = ['none', 'expired', 'expiring_soon'];

const TAB_FILTERS = ['all', 'active', 'expiring_soon', 'expired', 'none', 'pending', 'submitted'];

export default function PartnerDevices() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const { subs, loading: subsLoading, reload: reloadSubs } = useUnitSubscriptions();
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [credsRow, setCredsRow] = useState(null);
  const [proofRow, setProofRow] = useState(null);
  const [search, setSearch] = useState('');

  // RLS scopes order_unit_details to the partner's own units automatically
  // (via the parent order's partner_id check in the policies).
  // We filter at the UNIT level on production_status='dispatched' — that's
  // the trigger-driven state set when a unit is added to a shipment. The
  // earlier order-level fulfillment_status='delivered' filter was too
  // restrictive: it hid dispatched units whenever any other unit on the
  // order was still in production (because the order stays 'shipped'
  // until everything is delivered).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setUnitsLoading(true);
      await supabase.auth.getSession();
      // Explicit columns — do NOT select dashboard_password (it would ship in
      // the payload for every unit regardless of subscription; RLS is
      // row-level only). The password is fetched on demand via a coverage-
      // gated RPC. dashboard_username stays (login id, needed for search).
      const { data, error } = await supabase
        .from('bridgethings_order_unit_details')
        .select(`
          id, order_item_id, unit_index, serial_number, sim, sim_number,
          production_status, calibration_certificate_url, warranty_certificate_url,
          dashboard_username, created_at,
          item:bridgethings_order_items!inner(
            id, qty,
            order:bridgethings_orders!inner(id, delivered_date, fulfillment_status, partner_po_number),
            product:bridgethings_products(id, name, subscription_price)
          )
        `)
        .eq('production_status', 'dispatched')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        console.error('[devices] load failed:', error);
        setUnits([]);
      } else {
        setUnits(data || []);
      }
      setUnitsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const subsByUnit = useMemo(() => {
    const map = {};
    for (const s of subs) {
      (map[s.unit_id] = map[s.unit_id] || []).push(s);
    }
    return map;
  }, [subs]);

  const rows = useMemo(() => units.map(u => {
    const unitSubs = subsByUnit[u.id] || [];
    // Cancelled rows never represent the device here: a device whose subs
    // are ALL cancelled must derive 'none' (selectable for a fresh request)
    // instead of a dead-end 'Cancelled' badge that blocks re-requesting.
    const latest = latestSubFor(unitSubs.filter(s => s.status !== 'cancelled'));
    // Paid coverage (ignores pending placeholders) — drives credentials
    // access and expiry display so a renewal request doesn't hide a
    // still-valid subscription.
    const coverage = coverageSubFor(unitSubs);
    const price  = Number(u.item?.product?.subscription_price) || 0;
    return {
      unit: u,
      latest,
      coverage,
      status: effectiveStatus(latest),
      price,
    };
  }), [units, subsByUnit]);

  const filtered = (() => {
    const base = filter === 'all' ? rows : rows.filter(r => r.status === filter);
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(r => {
      const hay = [
        r.unit.serial_number, r.unit.sim, r.unit.sim_number, r.unit.dashboard_username,
        r.unit.item?.product?.name, orderRef(r.unit.item?.order), shortId(r.unit.item?.order?.id), r.unit.item?.order?.partner_po_number,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();
  const tabCount = (key) =>
    key === 'all' ? rows.length : rows.filter(r => r.status === key).length;

  const loading = subsLoading || unitsLoading;

  // High-level counters for the top banner.
  const expiringSoon = rows.filter(r => r.status === 'expiring_soon').length;
  const expired      = rows.filter(r => r.status === 'expired').length;
  const missing      = rows.filter(r => r.status === 'none').length;

  // Drop stale selections whenever rows refresh (e.g. after a request submit).
  useEffect(() => {
    setSelected(prev => {
      const next = new Set();
      for (const r of rows) {
        if (SELECTABLE_STATUSES.includes(r.status) && prev.has(r.unit.id)) {
          next.add(r.unit.id);
        }
      }
      return next;
    });
  }, [rows]);

  const toggleOne = (unitId) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(unitId) ? next.delete(unitId) : next.add(unitId);
      return next;
    });
  };

  // Header checkbox toggles all selectable rows currently in view.
  const visibleSelectable = filtered.filter(r => SELECTABLE_STATUSES.includes(r.status));
  const allVisibleSelected = visibleSelectable.length > 0
    && visibleSelectable.every(r => selected.has(r.unit.id));
  const toggleAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of visibleSelectable) next.delete(r.unit.id);
      } else {
        for (const r of visibleSelectable) next.add(r.unit.id);
      }
      return next;
    });
  };

  const selectedRows  = rows.filter(r => selected.has(r.unit.id));
  const selectedTotal = selectedRows.reduce((s, r) => s + r.price, 0);

  const handleSubmitRequest = async () => {
    if (!selectedRows.length) return;
    setSubmitting(true);
    try {
      await requestSubscriptions(
        selectedRows.map(r => ({ unitId: r.unit.id, amountDue: r.price })),
      );
      await reloadSubs();
      setSelected(new Set());
      setShowConfirm(false);
      addToast(`Subscription request sent for ${selectedRows.length} device(s)`, 'success');
    } catch (err) {
      console.error('[devices] request failed:', err);
      addToast(err.message || 'Failed to send subscription request', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">My Devices</div>
          <div className="page-subtitle">Dashboard subscription status for every device you own.</div>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div><div className="stat-label">Total Devices</div><div className="stat-value">{rows.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Active Subscriptions</div><div className="stat-value" style={{color:'var(--success)'}}>{rows.filter(r => r.status === 'active').length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Expiring in 30 days</div><div className="stat-value" style={{color:'var(--warning)'}}>{expiringSoon}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Expired</div><div className="stat-value" style={{color:'var(--danger)'}}>{expired}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Missing</div><div className="stat-value" style={{color:'var(--text)'}}>{missing}</div></div>
        </div>
      </div>

      {(expired + missing + expiringSoon) > 0 && (
        <div className="card" style={{marginBottom:'1rem', borderLeft:'4px solid var(--warning)'}}>
          <div style={{padding:'1rem 1.25rem'}}>
            <div className="font-semibold" style={{marginBottom:'0.25rem'}}>
              {expired + missing > 0 ? 'Action needed — dashboard access at risk' : 'Renewals coming up'}
            </div>
            <div className="text-sm text-muted">
              Select the devices below and click "Request Subscription". Our team will share payment details and activate the dashboard once received.
            </div>
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
            placeholder="Search by serial, SIM, product, order, login..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading devices...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No devices match "${search}".` : 'No devices in this view.'}</p></div></div>
      ) : (
        <div className="card" style={{marginBottom: selected.size ? '5rem' : '1rem'}}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{width:'36px'}}>
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleSelectable.length}
                      onChange={toggleAllVisible}
                      aria-label="Select all selectable devices in view"
                    />
                  </th>
                  <th>Product</th>
                  <th>Meter Serial Number</th>
                  <th>SIM</th>
                  <th>SIM Number</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th>Days Left</th>
                  <th style={{textAlign:'right'}}>Sub. Price</th>
                  <th>Cal. Cert</th>
                  <th>Warranty</th>
                  <th>Login</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  // Expiry + credential access derive from PAID coverage, not
                  // the newest row — a pending renewal request must not hide
                  // dates/credentials of a subscription that's still valid.
                  const coverageStatus = effectiveStatus(r.coverage);
                  // A pending/submitted request with NO paid coverage carries a
                  // placeholder end_date (today+1yr) — don't show it as real
                  // coverage. Mirror the admin page which renders '—' for these.
                  const isReviewRow = r.status === 'pending' || r.status === 'submitted';
                  const showCoverageDates = !(isReviewRow && !r.coverage);
                  const days = showCoverageDates ? daysRemaining(r.coverage || r.latest) : null;
                  const selectable = SELECTABLE_STATUSES.includes(r.status);
                  // Password isn't in the payload — presence of a username
                  // (always set alongside the password by staff) marks creds.
                  const hasCreds   = Boolean(r.unit.dashboard_username);
                  const canViewCreds = hasCreds && (coverageStatus === 'active' || coverageStatus === 'expiring_soon');
                  return (
                    <tr key={r.unit.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(r.unit.id)}
                          disabled={!selectable}
                          onChange={() => toggleOne(r.unit.id)}
                          aria-label={`Select unit ${r.unit.serial_number || r.unit.id}`}
                        />
                      </td>
                      <td className="text-sm font-semibold">{r.unit.item?.product?.name || '—'}</td>
                      <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{r.unit.serial_number || '—'}</code></td>
                      <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{r.unit.sim || '—'}</code></td>
                      <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{r.unit.sim_number || '—'}</code></td>
                      <td className="text-sm"><span style={{color:'var(--primary)'}}>{orderRef(r.unit.item?.order)}</span></td>
                      <td>
                        <span className={`badge ${STATUS_COLORS[r.status]}`}>{STATUS_LABELS[r.status]}</span>
                        {r.status === 'pending' && r.latest?.id && (
                          <div style={{marginTop:'0.35rem'}}>
                            <button className="btn btn-primary btn-sm" onClick={() => setProofRow(r)}>
                              {r.latest.rejection_note ? 'Re-upload Proof' : 'Upload Payment Proof'}
                            </button>
                            {r.latest.rejection_note && (
                              <div className="text-xs" style={{color:'var(--danger)', marginTop:'0.25rem', maxWidth:'180px'}}>
                                Rejected: {r.latest.rejection_note}
                              </div>
                            )}
                          </div>
                        )}
                        {r.status === 'submitted' && (
                          <div className="text-xs text-muted" style={{marginTop:'0.35rem'}}>Proof sent — awaiting verification</div>
                        )}
                      </td>
                      <td className="text-sm">{showCoverageDates ? fmtDate((r.coverage || r.latest)?.end_date) : '—'}</td>
                      <td className="text-sm">
                        {days == null ? '—' : days < 0 ? `${Math.abs(days)} ago` : days}
                      </td>
                      <td className="text-sm" style={{textAlign:'right'}}>{r.price > 0 ? fmtINR(r.price) : '—'}</td>
                      <td className="text-sm">
                        {r.unit.calibration_certificate_url
                          ? <a href={r.unit.calibration_certificate_url} target="_blank" rel="noreferrer" style={{color:'var(--primary)'}}>View</a>
                          : <span className="text-xs text-muted">—</span>}
                      </td>
                      <td className="text-sm">
                        {r.unit.warranty_certificate_url
                          ? <a href={r.unit.warranty_certificate_url} target="_blank" rel="noreferrer" style={{color:'var(--primary)'}}>View</a>
                          : <span className="text-xs text-muted">—</span>}
                      </td>
                      <td>
                        {canViewCreds ? (
                          <button className="btn btn-ghost btn-sm" onClick={() => setCredsRow(r)}>View</button>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sticky action bar */}
      {selected.size > 0 && (
        <div style={{
          position:'fixed', bottom:0, left:'var(--sidebar-width, 260px)', right:0,
          background:'var(--card)', borderTop:'1px solid var(--border)',
          padding:'0.85rem 1.5rem',
          display:'flex', justifyContent:'space-between', alignItems:'center',
          boxShadow:'0 -4px 12px rgba(0,0,0,0.06)', zIndex:10,
        }}>
          <div>
            <div className="font-semibold">{selected.size} device(s) selected</div>
            <div className="text-sm text-muted">Total: <b style={{color:'var(--primary)'}}>{fmtINR(selectedTotal)}</b> · 1 year of dashboard access per device</div>
          </div>
          <div style={{display:'flex', gap:'0.5rem'}}>
            <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <button className="btn btn-primary" onClick={() => setShowConfirm(true)}>
              Request Subscription
            </button>
          </div>
        </div>
      )}

      {credsRow && (
        <CredentialsModal row={credsRow} onClose={() => setCredsRow(null)} />
      )}

      {proofRow && (
        <ProofModal
          row={proofRow}
          partnerId={user?.supabaseId}
          onClose={() => setProofRow(null)}
          onSubmitted={async () => { await reloadSubs(); setProofRow(null); }}
        />
      )}

      {showConfirm && (
        <div className="modal-overlay" onClick={() => !submitting && setShowConfirm(false)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'640px'}}>
            <div className="modal-header">
              <h3>Confirm Subscription Request</h3>
              <button className="modal-close" onClick={() => setShowConfirm(false)} disabled={submitting}>✕</button>
            </div>
            <div className="modal-body">
              <p className="text-sm text-muted" style={{marginBottom:'1rem'}}>
                You're requesting 1-year dashboard subscriptions for the devices below. Our team will email payment details and activate access once payment is received.
              </p>
              <div className="table-wrap">
                <table style={{margin:0}}>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Meter Serial Number</th>
                      <th style={{textAlign:'right'}}>Price (₹/yr)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.map(r => (
                      <tr key={r.unit.id}>
                        <td className="text-sm font-semibold">{r.unit.item?.product?.name || '—'}</td>
                        <td className="text-sm"><code style={{fontSize:'0.8rem'}}>{r.unit.serial_number || '—'}</code></td>
                        <td className="text-sm" style={{textAlign:'right'}}>{fmtINR(r.price)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={2} className="font-semibold" style={{textAlign:'right'}}>Total</td>
                      <td className="font-semibold" style={{textAlign:'right', color:'var(--primary)'}}>{fmtINR(selectedTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {selectedRows.some(r => r.price === 0) && (
                <div className="text-xs" style={{marginTop:'0.75rem', color:'var(--warning)'}}>
                  Some products don't have a subscription price set yet. The Bridge Things team will confirm the amount before activation.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" disabled={submitting} onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={submitting} onClick={handleSubmitRequest}>
                {submitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Partner uploads their payment bill + amount + slip against a pending
// subscription request. Amount pre-fills to the quoted price; accountant
// verifies afterward.
function ProofModal({ row, partnerId, onClose, onSubmitted }) {
  const { addToast } = useToast();
  const sub = row.latest;
  const [amount, setAmount]           = useState(String(sub?.amount_due ?? row.price ?? ''));
  const [paymentDate, setPaymentDate] = useState(todayLocal());
  const [method, setMethod]           = useState('bank_transfer');
  const [file, setFile]               = useState(null);
  const [saving, setSaving]           = useState(false);
  const fileRef = useRef(null);

  const submit = async () => {
    if (!file) { addToast('Please attach the payment slip', 'error'); return; }
    setSaving(true);
    try {
      await submitSubscriptionProof({
        subId: sub.id, partnerId, amount, paymentDate, method, file,
      });
      addToast('Payment proof submitted — our team will verify and activate your subscription.', 'success');
      await onSubmitted();
    } catch (err) {
      console.error('[devices] proof submit failed:', err);
      addToast(err.message || 'Failed to submit payment proof', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'520px'}}>
        <div className="modal-header">
          <h3>Upload Payment Proof</h3>
          <button className="modal-close" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{padding:'0.85rem 1rem', background:'var(--bg)', borderRadius:'8px', marginBottom:'1rem'}}>
            <div className="text-xs text-muted">Device</div>
            <div className="font-semibold">{row.unit.item?.product?.name || 'Unknown product'}</div>
            <div className="text-sm" style={{marginTop:'0.25rem'}}>Meter Serial Number: <code>{row.unit.serial_number || '—'}</code></div>
          </div>
          {sub?.rejection_note && (
            <div style={{padding:'0.6rem 0.85rem', background:'var(--danger-bg)', border:'1px solid var(--danger)', borderRadius:'8px', marginBottom:'1rem'}}>
              <div className="text-sm" style={{color:'var(--danger)'}}>Your previous proof was rejected: {sub.rejection_note}</div>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Amount Paid (₹)</label>
            <input type="number" min="0" step="0.01" className="form-input" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Payment Date</label>
            <input type="date" className="form-input" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Payment Method</label>
            <select className="form-select" value={method} onChange={e => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Payment Slip / Bill</label>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" className="form-input"
              onChange={e => setFile(e.target.files?.[0] || null)} />
            <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>PDF or image of the receipt/bank slip.</div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Submitting...' : 'Submit Proof'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ row, onClose }) {
  const [showPass, setShowPass] = useState(false);
  const [copied, setCopied]     = useState(null); // 'user' | 'pass' | null
  // The password is NOT in the device payload — fetch it (and the username)
  // through the coverage-gated RPC when the modal opens.
  const [creds, setCreds]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getDashboardCredentials(row.unit.id);
        if (!cancelled) setCreds(c);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load credentials');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [row.unit.id]);
  const username = creds?.username || row.unit.dashboard_username || '';
  const password = creds?.password || '';

  const copy = async (text, kind) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard blocked — partner can still read & manual-copy.
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'520px'}}>
        <div className="modal-header">
          <h3>Dashboard Login</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{padding:'0.85rem 1rem', background:'var(--bg)', borderRadius:'8px', marginBottom:'1rem'}}>
            <div className="text-xs text-muted">Device</div>
            <div className="font-semibold">{row.unit.item?.product?.name || 'Unknown product'}</div>
            <div className="text-sm" style={{marginTop:'0.25rem'}}>
              Meter Serial Number: <code>{row.unit.serial_number || '—'}</code>
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-muted" style={{padding:'0.5rem 0'}}>Loading credentials…</div>
          ) : error ? (
            <div className="text-sm" style={{color:'var(--danger)', padding:'0.5rem 0'}}>{error}</div>
          ) : (
          <>
          <div className="form-group">
            <label className="form-label">Username</label>
            <div style={{display:'flex', gap:'0.4rem', alignItems:'center'}}>
              <input className="form-input" value={username} readOnly />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(username, 'user')}>
                {copied === 'user' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <div style={{display:'flex', gap:'0.4rem', alignItems:'center'}}>
              <input
                className="form-input"
                type={showPass ? 'text' : 'password'}
                value={password}
                readOnly
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPass(s => !s)}>
                {showPass ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(password, 'pass')}>
                {copied === 'pass' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="text-xs text-muted" style={{marginTop:'0.5rem'}}>
            Keep these credentials confidential. Contact Bridge Things if you need them reset.
          </div>
          </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
