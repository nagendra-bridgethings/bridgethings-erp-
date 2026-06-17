// Partner — My Devices
//
// Lists every unit the partner owns + their dashboard-subscription status.
// Partner can select devices that need a sub (none/expired/expiring) and
// submit a Subscription Request — staff then activate once payment lands.
// Once active, partner can view the dashboard login captured by Accounts.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import {
  useUnitSubscriptions, requestSubscriptions,
  effectiveStatus, daysRemaining, latestSubFor,
} from '../../lib/subscriptions';
import { orderRef } from '../../lib/orders';

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

const STATUS_LABELS = {
  active:'Active', expiring_soon:'Expiring Soon', expired:'Expired',
  pending:'Requested', cancelled:'Cancelled', none:'No Subscription',
};
const STATUS_COLORS = {
  active:'badge-success', expiring_soon:'badge-warning', expired:'badge-danger',
  pending:'badge-info', cancelled:'badge-gray', none:'badge-gray',
};

// Statuses a partner can request/renew a subscription for.
const SELECTABLE_STATUSES = ['none', 'expired', 'expiring_soon'];

const TAB_FILTERS = ['all', 'active', 'expiring_soon', 'expired', 'none', 'pending'];

export default function PartnerDevices() {
  const { addToast } = useToast();
  const { subs, loading: subsLoading, reload: reloadSubs } = useUnitSubscriptions();
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [credsRow, setCredsRow] = useState(null);
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
      const { data, error } = await supabase
        .from('bridgethings_order_unit_details')
        .select(`
          *,
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
    const latest = latestSubFor(subsByUnit[u.id] || []);
    const price  = Number(u.item?.product?.subscription_price) || 0;
    return {
      unit: u,
      latest,
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
          <div><div className="stat-label">Expired / Missing</div><div className="stat-value" style={{color:'var(--danger)'}}>{expired + missing}</div></div>
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
                  <th>Serial</th>
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
                  const days = daysRemaining(r.latest);
                  const selectable = SELECTABLE_STATUSES.includes(r.status);
                  const hasCreds   = Boolean(r.unit.dashboard_username || r.unit.dashboard_password);
                  const canViewCreds = hasCreds && (r.status === 'active' || r.status === 'expiring_soon');
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
                      <td><span className={`badge ${STATUS_COLORS[r.status]}`}>{STATUS_LABELS[r.status]}</span></td>
                      <td className="text-sm">{fmtDate(r.latest?.end_date)}</td>
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
                      <th>Serial</th>
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

function CredentialsModal({ row, onClose }) {
  const [showPass, setShowPass] = useState(false);
  const [copied, setCopied]     = useState(null); // 'user' | 'pass' | null
  const username = row.unit.dashboard_username || '';
  const password = row.unit.dashboard_password || '';

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
              Serial: <code>{row.unit.serial_number || '—'}</code>
            </div>
          </div>

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
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
