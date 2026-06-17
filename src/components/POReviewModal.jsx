// Admin-facing PO review modal. Shows the PO summary, items, amount
// breakdown, and admin notes. Pending POs get Confirm + Reject buttons;
// approved/rejected POs are shown read-only.
//
// Used by /admin/po-received (full review queue) and the admin Dashboard's
// "Recent POs" section so both entry points open the same view.
import { useState } from 'react';
import { confirmOrder, rejectOrder, proposeDeliveryDate, orderRef } from '../lib/orders';
import { IGST_LABEL } from '../lib/tax';
import { useToast } from '../lib/toast';

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';

const STATUS_BADGE = {
  pending_approval: { className: 'badge-warning', label: 'Pending Review' },
  active:           { className: 'badge-info',    label: 'In Progress' },
  completed:        { className: 'badge-success', label: 'Completed' },
  rejected:         { className: 'badge-danger',  label: 'Rejected' },
};

export default function POReviewModal({ order, partner, onClose, onConfirmed, onRejected }) {
  const { addToast } = useToast();
  const [notes, setNotes] = useState(order.employee_notes || '');
  const [busy, setBusy]   = useState(false);
  // Counter-proposal dialog state — admin opens this when they can't meet
  // the partner's requested delivery date.
  const [showCounter, setShowCounter]     = useState(false);
  const [counterDate, setCounterDate]     = useState('');
  const [counterNote, setCounterNote]     = useState('');
  const isPending = order.status === 'pending_approval';
  const badge     = STATUS_BADGE[order.status] || { className: 'badge-gray', label: order.status };
  // The counter waits on the partner if 'counter_sent'; admin can only
  // Approve / Reject (or send another counter) once partner has responded.
  const awaitingPartner = isPending && order.delivery_negotiation_status === 'counter_sent';
  const counterAccepted = order.delivery_negotiation_status === 'counter_accepted';

  const itemsSubtotal = (order.items || []).reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
    0,
  );
  const shipping = Number(order.shipping_cost) || 0;
  const tax      = Number(order.tax_amount)    || 0;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await confirmOrder(order.id, notes);
      addToast(`PO ${orderRef(order)} confirmed and moved to orders`, 'success');
      if (onConfirmed) await onConfirmed();
    } catch (err) {
      console.error('[POReview] confirm failed:', err);
      addToast(err.message || 'Failed to confirm order', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleProposeCounter = async () => {
    if (!counterDate)        { addToast('Pick a proposed date', 'error'); return; }
    if (!counterNote.trim()) { addToast('Add a note explaining the new date', 'error'); return; }
    setBusy(true);
    try {
      await proposeDeliveryDate(order.id, counterDate, counterNote);
      addToast('Counter date sent to partner', 'success');
      setShowCounter(false);
      if (onConfirmed) await onConfirmed(); // reuse parent's refresh handler
    } catch (err) {
      console.error('[POReview] propose failed:', err);
      addToast(err.message || 'Failed to send counter', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!window.confirm(`Reject PO ${orderRef(order)}? It will be archived as a rejected order.`)) return;
    setBusy(true);
    try {
      await rejectOrder(order.id, notes);
      addToast('PO rejected', 'info');
      if (onRejected) await onRejected();
    } catch (err) {
      console.error('[POReview] reject failed:', err);
      addToast(err.message || 'Failed to reject order', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{maxWidth:'780px'}}>
        <div className="modal-header">
          <h3>
            {isPending ? 'Review PO: ' : 'PO: '}{orderRef(order)}{' '}
            <span className={`badge ${badge.className}`} style={{marginLeft:'0.5rem', verticalAlign:'middle'}}>{badge.label}</span>
          </h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Summary band */}
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:'1rem', marginBottom:'1.25rem', padding:'1rem', background:'var(--bg)', borderRadius:'8px'}}>
            <div>
              <div className="text-xs text-muted">Channel Partner</div>
              <div className="font-semibold">{partner?.name || partner?.company_name || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Order Date</div>
              <div className="font-semibold">{fmtDate(order.created_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Items</div>
              <div className="font-semibold">{(order.items || []).length} product(s)</div>
            </div>
            <div>
              <div className="text-xs text-muted">Order Total</div>
              <div className="font-semibold" style={{color:'var(--primary)'}}>{fmtINR(order.total_amount)}</div>
            </div>
          </div>

          {/* Delivery-date negotiation band — only when relevant */}
          {(order.requested_delivery_date || order.proposed_delivery_date) && (
            <div style={{
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '0.85rem 1rem',
              marginBottom: '1.25rem',
              background: awaitingPartner ? '#fef9c3' : counterAccepted ? '#dcfce7' : 'var(--card)',
            }}>
              <div style={{display:'flex', flexWrap:'wrap', gap:'1.5rem', alignItems:'flex-start'}}>
                <div>
                  <div className="text-xs text-muted">Partner Requested Dispatch</div>
                  <div className="font-semibold">{fmtDate(order.requested_delivery_date)}</div>
                </div>
                {order.proposed_delivery_date && (
                  <div>
                    <div className="text-xs text-muted">Your Counter-Proposal</div>
                    <div className="font-semibold">{fmtDate(order.proposed_delivery_date)}</div>
                  </div>
                )}
                {awaitingPartner && (
                  <div className="badge badge-warning" style={{alignSelf:'center'}}>Awaiting partner response</div>
                )}
                {counterAccepted && (
                  <div className="badge badge-success" style={{alignSelf:'center'}}>Partner accepted your date</div>
                )}
              </div>
              {order.delivery_negotiation_note && (
                <div className="text-xs" style={{color:'var(--text-muted)', marginTop:'0.5rem'}}>
                  Your note to partner: {order.delivery_negotiation_note}
                </div>
              )}
            </div>
          )}

          {/* Counter-proposal dialog — inline so the admin keeps context */}
          {showCounter && (
            <div style={{
              border: '1px solid var(--warning)',
              borderRadius: '8px',
              padding: '1rem',
              marginBottom: '1.25rem',
              background: '#fffbeb',
            }}>
              <div className="font-semibold" style={{marginBottom:'0.5rem'}}>Propose a Different Dispatch Date</div>
              <div className="text-xs" style={{color:'var(--text-muted)', marginBottom:'0.75rem'}}>
                Partner will be asked to accept the new date or decline (PO is rejected).
              </div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'0.75rem'}}>
                <div className="form-group" style={{margin:0}}>
                  <label className="form-label">New Dispatch Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={counterDate}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={e => setCounterDate(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{margin:0, gridColumn:'1 / -1'}}>
                  <label className="form-label">Reason (shown to partner)</label>
                  <textarea
                    className="form-textarea"
                    rows={2}
                    placeholder="e.g. DN100 sensor procurement adds 2 weeks; earliest feasible date is..."
                    value={counterNote}
                    onChange={e => setCounterNote(e.target.value)}
                  />
                </div>
              </div>
              <div style={{display:'flex', gap:'0.5rem', justifyContent:'flex-end', marginTop:'0.75rem'}}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setShowCounter(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleProposeCounter}>
                  {busy ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          )}

          {/* Items */}
          <h4 style={{fontSize:'0.85rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem'}}>
            Order Items
          </h4>
          <div style={{display:'flex', flexDirection:'column', gap:'0.5rem', marginBottom:'1rem'}}>
            {(order.items || []).map(item => (
              <div key={item.id} style={{background:'var(--card)', border:'1px solid var(--border)', borderRadius:'8px', padding:'0.85rem 1rem'}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
                  <div className="font-semibold">{item.product?.name || 'Unknown product'}</div>
                  <div className="text-sm font-semibold" style={{color:'var(--primary)'}}>Qty: {item.qty}</div>
                </div>
                {item.notes && <div className="text-xs" style={{color:'var(--warning)', marginTop:'0.4rem'}}>Partner Note: {item.notes}</div>}
              </div>
            ))}
          </div>

          {/* Amount breakdown */}
          <div style={{padding:'1rem', border:'1px solid var(--border)', borderRadius:'8px', marginBottom:'1.25rem', display:'flex', flexDirection:'column', gap:'0.25rem'}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.85rem', color:'var(--text-muted)'}}>
              <span>Items subtotal</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(itemsSubtotal)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.85rem', color:'var(--text-muted)'}}>
              <span>Shipping{order.delivery_method ? ` (${order.delivery_method})` : ''}</span>
              <span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(shipping)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.85rem', color:'var(--text-muted)'}}>
              <span>{IGST_LABEL}</span><span style={{fontWeight:600, color:'var(--text)'}}>{fmtINR(tax)}</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border)', paddingTop:'0.4rem', marginTop:'0.25rem'}}>
              <span style={{fontWeight:700}}>Order Total</span>
              <span style={{fontWeight:700, color:'var(--primary)'}}>{fmtINR(order.total_amount)}</span>
            </div>
          </div>

          {/* Notes */}
          <div className="form-group">
            <label className="form-label">
              {isPending ? 'Internal Notes / Communication to Partner' : 'Notes'}
            </label>
            <textarea
              className="form-textarea"
              rows={3}
              placeholder="e.g. DN100 is available, customization will take 2 extra days..."
              value={notes}
              disabled={!isPending}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Close</button>
          {isPending && !showCounter && (
            <>
              <button className="btn btn-danger" disabled={busy} onClick={handleReject}>Reject PO</button>
              {!awaitingPartner && (
                <button className="btn btn-primary" disabled={busy} onClick={() => setShowCounter(true)}>
                  Propose Different Date
                </button>
              )}
              {!awaitingPartner && (
                <button className="btn btn-primary" disabled={busy} onClick={handleConfirm}>
                  {busy ? 'Saving...' : 'Confirm & Send to Partner'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
