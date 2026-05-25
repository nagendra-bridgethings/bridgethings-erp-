// Admin — Fulfillment: manage active orders, update status, fill in per-unit details
import { useEffect, useState } from 'react';
import { usePartners } from '../../lib/partners';
import { useOrders, updateFulfillment } from '../../lib/orders';
import { getOrderStepperSteps, FULFILLMENT_OPTIONS } from '../../lib/orderStepper';
import { loadUnitDetailsForItems, upsertUnitDetail } from '../../lib/orderUnits';
import ShipmentsPanel from '../../components/ShipmentsPanel';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';

// The fulfillment-status badge on each order card. 'calibration' is kept here
// only so historical rows render — the dropdown no longer offers it.
const STATUS_LABELS = { in_process:'In Process', calibration:'In Process', ready_to_ship:'Ready to Ship', shipped:'Shipped', delivered:'Delivered' };
const STATUS_COLORS = { in_process:'badge-gray', calibration:'badge-gray', ready_to_ship:'badge-info', shipped:'badge-purple', delivered:'badge-success' };

// Tab filter options — the "All" tab plus each user-facing fulfillment status.
const TAB_FILTERS = ['all', 'in_process', 'ready_to_ship', 'shipped', 'delivered'];

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function Fulfillment() {
  const { addToast } = useToast();
  // Orders only become visible here once they've been cleared for dispatch:
  //   - full payment → trigger auto-sets dispatch_approval='approved'
  //   - partial payment → admin manually approves dispatch (or rejects)
  // Orders in 'awaiting_payment', 'pending' (waiting on admin), or 'rejected'
  // stay hidden so the employee only sees ones ready to ship.
  const { orders: allOrders, loading, reload } = useOrders({ includeStatuses: ['active', 'completed'] });
  const orders = allOrders.filter(o => o.dispatch_approval === 'approved');
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  // Map order_id → total units shipped across all that order's parcels.
  // Loaded once after the orders list arrives so each row can show
  // "shipped / ordered" without opening the modal.
  const [shippedByOrder, setShippedByOrder] = useState({});

  useEffect(() => {
    if (!orders.length) return;
    let cancelled = false;
    (async () => {
      const orderIds = orders.map(o => o.id);
      const { data, error } = await supabase
        .from('bridgethings_shipments')
        .select('order_id, items:bridgethings_shipment_items(qty)')
        .in('order_id', orderIds);
      if (cancelled) return;
      if (error) {
        console.error('[Fulfillment] shipment qty load failed:', error);
        return;
      }
      const map = {};
      for (const s of data || []) {
        const sumForShipment = (s.items || []).reduce(
          (sum, si) => sum + (Number(si.qty) || 0),
          0,
        );
        map[s.order_id] = (map[s.order_id] || 0) + sumForShipment;
      }
      setShippedByOrder(map);
    })();
    return () => { cancelled = true; };
  }, [orders]);
  // 'tracking' = shipment status / courier / tracking number / delivered date.
  // 'units'    = per-physical-unit details (serial, SIM, calibration, certs).
  const [modalTab, setModalTab] = useState('tracking');

  const { getPartner } = usePartners();

  const visibleOrders = (() => {
    const byStatus = filter === 'all'
      ? orders
      : orders.filter(o => {
          // Map legacy 'calibration' to 'in_process' so historical rows still
          // surface under the In Process tab.
          const ff = o.fulfillment_status === 'calibration' ? 'in_process' : o.fulfillment_status;
          return ff === filter;
        });
    const term = search.trim().toLowerCase();
    if (!term) return byStatus;
    return byStatus.filter(o => {
      const partner = getPartner(o.partner_id);
      const hay = [
        shortId(o.id), o.id, o.tracking_number, o.delivery_method,
        partner?.name, partner?.company_name,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();

  // Build empty unit rows for each item, then overlay any existing rows from
  // the DB. This way employees always see qty input slots, pre-filled with
  // whatever data has already been entered.
  const buildUnitMap = (items, existing) => {
    const map = {};
    for (const item of items || []) {
      const qty = Number(item.qty) || 1;
      const existingForItem = existing[item.id] || [];
      // Default Type to the product name whenever it hasn't been set yet
      // — applies to brand-new units AND any old units in the DB that were
      // saved before this default existed. Employee can still override via
      // the pencil icon if a specific unit needs a different label.
      const defaultType = item.product?.name || '';
      map[item.id] = Array.from({ length: qty }, (_, i) => {
        const found = existingForItem.find(u => u.unit_index === i + 1);
        if (found) {
          return found.device_type
            ? found
            : { ...found, device_type: defaultType };
        }
        return {
          order_item_id: item.id,
          unit_index:    i + 1,
          device_type:                 defaultType,
          serial_number:               '',
          sim:                         '',
          calibrated_on:               '',
          calibration_certificate_url: '',
          warranty_certificate_url:    '',
        };
      });
    }
    return map;
  };

  const openOrder = async (order) => {
    setSelected(order);
    setModalTab('tracking'); // Always land on Tracking when (re)opening
    // Pull any existing unit rows for this order's items first so the UI
    // doesn't render empty fields over already-entered data.
    const itemIds = (order.items || []).map(i => i.id);
    const existing = await loadUnitDetailsForItems(itemIds);
    setForm({
      fulfillment_status: order.fulfillment_status,
      delivery_method:    order.delivery_method || '',
      tracking_number:    order.tracking_number || '',
      delivered_date:     order.delivered_date || '',
      items:              order.items || [],
      units:              buildUnitMap(order.items, existing),
    });
  };

  const updateUnitField = (itemId, unitIndex, field, value) => {
    setForm(prev => ({
      ...prev,
      units: {
        ...prev.units,
        [itemId]: prev.units[itemId].map(u =>
          u.unit_index === unitIndex ? { ...u, [field]: value } : u
        ),
      },
    }));
  };

  const handleSave = async () => {
    if (!selected) return;
    // Once delivered/completed, the order is locked. Unit details can
    // still be backfilled below.
    const isLocked = selected.fulfillment_status === 'delivered' || selected.status === 'completed';
    // After the first shipment exists, the DB trigger drives
    // fulfillment_status / delivery_method / tracking_number / delivered_date
    // — so we only persist the manual status while it's still a
    // pre-shipment state (in_process / ready_to_ship).
    const shipmentsExist = selected.fulfillment_status === 'shipped' || selected.fulfillment_status === 'delivered';
    const statusChanged  = form.fulfillment_status !== selected.fulfillment_status;
    setSaving(true);
    try {
      if (!isLocked && !shipmentsExist && statusChanged) {
        await updateFulfillment(selected.id, {
          fulfillment_status: form.fulfillment_status,
        });
      }

      // Upsert every unit row that has any data set. Skip purely empty rows
      // to avoid creating noise in the DB before the employee fills them in.
      const allUnits = Object.values(form.units || {}).flat();
      const nonEmpty = allUnits.filter(u =>
        u.device_type || u.serial_number || u.sim || u.calibrated_on
          || u.calibration_certificate_url || u.warranty_certificate_url
      );
      for (const u of nonEmpty) {
        await upsertUnitDetail({
          orderItemId:                u.order_item_id,
          unitIndex:                  u.unit_index,
          deviceType:                 u.device_type,
          serialNumber:               u.serial_number,
          sim:                        u.sim,
          calibratedOn:               u.calibrated_on,
          calibrationCertificateUrl:  u.calibration_certificate_url,
          warrantyCertificateUrl:     u.warranty_certificate_url,
        });
      }

      await reload();
      addToast(`Order ORD-${shortId(selected.id)} updated successfully`, 'success');
      setSelected(null);
    } catch (err) {
      console.error('[Fulfillment] save failed:', err);
      addToast(err.message || 'Failed to update order', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Orders</div>
          <div className="page-subtitle">Track and update manufacturing & shipping status</div>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="tabs">
        {TAB_FILTERS.map(s => {
          // Treat the legacy 'calibration' status as 'in_process' for counts
          // so old rows still appear in the tab the admin expects.
          const matches = (o) => {
            if (s === 'all') return true;
            const ff = o.fulfillment_status === 'calibration' ? 'in_process' : o.fulfillment_status;
            return ff === s;
          };
          const count = orders.filter(matches).length;
          return (
            <button
              key={s}
              className={`tab${filter === s ? ' active' : ''}`}
              onClick={() => setFilter(s)}
            >
              {s === 'all' ? 'All' : STATUS_LABELS[s]} ({count})
            </button>
          );
        })}
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by order ID, partner, courier, tracking number..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading orders...</p></div></div>
      ) : visibleOrders.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No orders match "${search}".` : 'No orders in this status.'}</p></div></div>
      ) : null}

      {visibleOrders.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Partner</th>
                  <th>Products</th>
                  <th>Units (Shipped / Ordered)</th>
                  <th style={{textAlign:'right'}}>Amount</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Tracking</th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map(order => {
                  const partner  = getPartner(order.partner_id);
                  // Once an order is delivered/completed it's locked from further edits.
                  const isLocked = order.fulfillment_status === 'delivered' || order.status === 'completed';
                  // Total qty across all line items, vs total shipped across
                  // all parcels for this order. Lets the employee see at a
                  // glance which orders still need parcels going out.
                  const orderedQty = (order.items || []).reduce(
                    (s, i) => s + (Number(i.qty) || 0), 0,
                  );
                  const shippedQty = shippedByOrder[order.id] || 0;
                  const pendingQty = Math.max(0, orderedQty - shippedQty);
                  const qtyColor   = pendingQty === 0
                    ? 'var(--success)'
                    : shippedQty === 0 ? 'var(--danger)' : 'var(--warning)';
                  return (
                    <tr
                      key={order.id}
                      style={{cursor:'pointer'}}
                      onClick={() => openOrder(order)}
                      title={isLocked ? 'Order delivered — opens read-only' : 'Click to update tracking & unit details'}
                    >
                      <td>
                        <span className="font-semibold" style={{color:'var(--primary)'}}>ORD-{shortId(order.id)}</span>
                      </td>
                      <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                      <td className="text-sm">{(order.items || []).length}</td>
                      <td className="text-sm">
                        <span className="font-semibold" style={{color: qtyColor}}>
                          {shippedQty} / {orderedQty}
                        </span>
                        {pendingQty > 0 && (
                          <span className="text-xs" style={{color:'var(--warning)', marginLeft:'0.4rem'}}>
                            · {pendingQty} pending
                          </span>
                        )}
                      </td>
                      <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(order.total_amount)}</td>
                      <td>
                        <span className={`badge ${STATUS_COLORS[order.fulfillment_status]||'badge-gray'}`}>
                          {STATUS_LABELS[order.fulfillment_status]||order.fulfillment_status}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                          {order.payment_status || 'pending'}
                        </span>
                      </td>
                      <td className="text-sm">{order.tracking_number || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Update Modal */}
      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {(selected.fulfillment_status === 'delivered' || selected.status === 'completed')
                  ? `View Order: ORD-${shortId(selected.id)}`
                  : `Update Order: ORD-${shortId(selected.id)}`}
              </h3>
              <button className="modal-close" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Tabs: shipments (parcels) vs unit details (serial/SIM/etc.) */}
              <div className="tabs" style={{marginBottom:'1.25rem'}}>
                <button
                  type="button"
                  className={`tab${modalTab === 'tracking' ? ' active' : ''}`}
                  onClick={() => setModalTab('tracking')}
                >
                  Shipments
                </button>
                <button
                  type="button"
                  className={`tab${modalTab === 'units' ? ' active' : ''}`}
                  onClick={() => setModalTab('units')}
                >
                  Unit Details
                </button>
              </div>

              {modalTab === 'tracking' && (() => {
                // Once delivered/completed, the shipment list is read-only.
                // Pre-shipment, the employee sets in_process / ready_to_ship
                // via the small status dropdown, then logs parcels below.
                const locked = selected.fulfillment_status === 'delivered' || selected.status === 'completed';
                const shipmentsExist =
                  selected.fulfillment_status === 'shipped' || selected.fulfillment_status === 'delivered';
                return (
                  <>
                    {/* Pre-shipment status — only useful before any parcel
                        goes out. Once shipments exist, the trigger drives
                        the status, so this dropdown is informational. */}
                    <div className="form-grid form-grid-2" style={{marginBottom:'1rem'}}>
                      <div className="form-group">
                        <label className="form-label">Order Status</label>
                        <select
                          className="form-select"
                          value={form.fulfillment_status}
                          disabled={locked || shipmentsExist}
                          onChange={e => setForm({...form, fulfillment_status: e.target.value})}
                        >
                          {FULFILLMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {shipmentsExist && !locked && (
                          <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>
                            Status is driven by shipments below.
                          </div>
                        )}
                      </div>
                    </div>

                    <ShipmentsPanel
                      order={selected}
                      items={form.items || []}
                      onChanged={reload}
                    />
                  </>
                );
              })()}

              {modalTab === 'units' && (
                <>
                  <div className="text-xs text-muted" style={{marginBottom:'0.75rem'}}>
                    Fill in type, serial number, SIM name, calibration date, and certificate URLs for each individual unit.
                  </div>
                  {form.items?.map(item => (
                    <ItemUnitsEditor
                      key={item.id}
                      item={item}
                      units={form.units?.[item.id] || []}
                      onUpdate={(unitIndex, field, value) => updateUnitField(item.id, unitIndex, field, value)}
                    />
                  ))}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" disabled={saving} onClick={() => setSelected(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
                {saving ? 'Saving...' : 'Save Updates'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// One section per order_item — renders `qty` unit rows below the item name.
// Each unit row has 6 inputs (type/serial/SIM/calibrated-on + 2 cert URLs).
function ItemUnitsEditor({ item, units, onUpdate }) {
  const [collapsed, setCollapsed] = useState(false);
  const filledCount = units.filter(u =>
    u.device_type || u.serial_number || u.sim || u.calibrated_on
      || u.calibration_certificate_url || u.warranty_certificate_url
  ).length;

  return (
    <div style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem', marginBottom:'1rem'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.75rem'}}>
        <div className="font-semibold">
          {item.product?.name || 'Unknown product'}{' '}
          <span className="text-sm text-muted">— {filledCount}/{units.length} unit(s) filled</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCollapsed(c => !c)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {!collapsed && (
        <div style={{display:'flex', flexDirection:'column', gap:'0.75rem'}}>
          {units.map(u => (
            <UnitRow
              key={u.unit_index}
              unit={u}
              onChange={(field, value) => onUpdate(u.unit_index, field, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UnitRow({ unit, onChange }) {
  return (
    <div style={{background:'var(--card)', border:'1px solid var(--border)', borderRadius:'6px', padding:'0.75rem'}}>
      <div className="text-xs" style={{fontWeight:700, color:'var(--primary)', marginBottom:'0.5rem'}}>
        Unit #{unit.unit_index}
      </div>
      <div className="form-grid form-grid-3" style={{gap:'0.6rem'}}>
        <div className="form-group">
          <label className="form-label text-xs">Type</label>
          <input
            className="form-input"
            value={unit.device_type || ''}
            disabled
            readOnly
            placeholder="Product type"
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Meter Serial Number</label>
          <input
            className="form-input"
            value={unit.serial_number || ''}
            onChange={e => onChange('serial_number', e.target.value)}
            placeholder="e.g. WFM100-0123"
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">SIM Name</label>
          <input
            className="form-input"
            value={unit.sim || ''}
            onChange={e => onChange('sim', e.target.value)}
            placeholder="SIM name"
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Calibrated On</label>
          <input
            type="date"
            className="form-input"
            value={unit.calibrated_on || ''}
            onChange={e => onChange('calibrated_on', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Calibration Certificate URL</label>
          <input
            className="form-input"
            value={unit.calibration_certificate_url || ''}
            onChange={e => onChange('calibration_certificate_url', e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Warranty Certificate URL</label>
          <input
            className="form-input"
            value={unit.warranty_certificate_url || ''}
            onChange={e => onChange('warranty_certificate_url', e.target.value)}
            placeholder="https://..."
          />
        </div>
      </div>
    </div>
  );
}
