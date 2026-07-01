// Admin — Fulfillment: manage active orders, update status, fill in per-unit details
import { useEffect, useMemo, useState } from 'react';
import { usePartners } from '../../lib/partners';
import {
  useOrders, updateFulfillment, orderRef,
  ITEM_PRODUCTION_STATUSES, ITEM_PRODUCTION_LABEL,
  deriveOpsOrderStatus, OPS_STATUS_BADGE,
} from '../../lib/orders';
import {
  loadUnitDetailsForItems, upsertUnitDetail,
  setUnitsProductionStatus, sendUnitsBackToOps,
} from '../../lib/orderUnits';
import { staffProductName } from '../../lib/productName';
import { CABLE_FREE_METERS } from '../../lib/cable';
import ShipmentsPanel from '../../components/ShipmentsPanel';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { resolveOpsTeam } from '../../lib/portalPaths';

// The fulfillment-status badge on each order card. 'calibration' and
// 'ready_to_ship' are mapped to 'In Process' so any historical rows that
// still carry those values render sensibly — neither is settable anymore.
const STATUS_LABELS = { in_process:'In Process', calibration:'In Process', ready_to_ship:'In Process', shipped:'Shipped', delivered:'Delivered' };
const STATUS_COLORS = { in_process:'badge-gray', calibration:'badge-gray', ready_to_ship:'badge-gray', shipped:'badge-purple', delivered:'badge-success' };

// Tab filter options — the "All" tab plus each user-facing fulfillment status.
// Dispatch/admin view: shipping-stage filters.
const TAB_FILTERS = ['all', 'in_process', 'shipped', 'delivered'];
// Operations view: production-stage filters. Shipped/delivered are dispatch's
// concern and intentionally hidden here.
const OPS_TAB_FILTERS = ['all', 'hold', 'production', 'partial_ready', 'ready_to_dispatch', 'sent_back'];
const OPS_TAB_LABELS  = {
  hold:              'In Progress',
  production:        'In Production',
  partial_ready:     'Partial Ready',
  ready_to_dispatch: 'Sent for Dispatch',
  sent_back:         'Sent Back',
};

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

export default function Fulfillment() {
  const { addToast } = useToast();
  // Orders only become visible here once they've been cleared for dispatch:
  //   - full payment → trigger auto-sets dispatch_approval='approved'
  //   - partial payment → admin manually approves dispatch (or rejects)
  // Orders in 'awaiting_payment', 'pending' (waiting on admin), or 'rejected'
  // stay hidden so the employee only sees ones ready to ship.
  const { user } = useAuth();
  const { orders: allOrders, loading, reload } = useOrders({ includeStatuses: ['active', 'completed'] });
  const team = resolveOpsTeam(user);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  // Map order_id → total units shipped across all that order's parcels.
  // Loaded once after the orders list arrives so each row can show
  // "shipped / ordered" without opening the modal.
  const [shippedByOrder, setShippedByOrder] = useState({});
  // Map order_id → units that are in shipments already marked delivered.
  // Lets the dispatch list show "Delivered" instead of "Shipped" once a
  // parcel has landed.
  const [deliveredByOrder, setDeliveredByOrder] = useState({});
  // Map order_id → array of { courier, tracking_number } per shipment,
  // ordered oldest-first. The list column renders one AWB per line so
  // dispatch can see every parcel's tracking without opening the order.
  const [trackingByOrder, setTrackingByOrder] = useState({});
  // Map order_id → { hold, production, ready_to_dispatch, sent_back, dispatched }
  // unit counts. Used by ops (row breakdown + status label) and dispatch
  // (filter on "any unit ready").
  const [unitStatusByOrder, setUnitStatusByOrder] = useState({});

  // Admin keeps full oversight — sees every active+completed order,
  // including ones still awaiting payment or dispatch approval, so they
  // can manage approvals and prep.
  //
  // Operations & Dispatch EMPLOYEES only see orders that have been cleared
  // for dispatch (dispatch_approval='approved'). Full payment auto-approves
  // via the recompute trigger; a partial payment needs the admin to approve
  // first. Until then the order stays hidden from the floor.
  //
  // Dispatch additionally sees an order ONLY once ops has handed off at
  // least one unit (ready_to_dispatch, or already dispatched so they can
  // keep tracking it). Orders still entirely in hold/production stay
  // invisible to dispatch.
  //
  // Memoized so downstream effects keyed on `orders` don't re-run on
  // every render (Array.filter returns a new ref each time).
  const isAdmin = user?.role === 'admin';
  const orders = useMemo(() => allOrders.filter(o => {
    if (isAdmin) return true;
    if (o.dispatch_approval !== 'approved') return false;
    if (team === 'dispatch') {
      const c = unitStatusByOrder[o.id] || {};
      return ((c.ready_to_dispatch || 0) + (c.dispatched || 0)) > 0;
    }
    return true; // operations employee: any approved order
  }), [allOrders, isAdmin, team, unitStatusByOrder]);

  useEffect(() => {
    // Ops needs counts for the row breakdown badges; dispatch needs them
    // for the filter ("any unit ready_to_dispatch?"). Both load the same
    // aggregate.
    if (team !== 'operations' && team !== 'dispatch') return;
    if (!allOrders.length) return;
    let cancelled = false;
    (async () => {
      const itemIds = allOrders.flatMap(o => (o.items || []).map(i => i.id));
      if (!itemIds.length) return;
      const { data, error } = await supabase
        .from('bridgethings_order_unit_details')
        .select('order_item_id, production_status')
        .in('order_item_id', itemIds);
      if (cancelled) return;
      if (error) {
        console.error('[Fulfillment] unit status load failed:', error);
        return;
      }
      const itemToOrder = {};
      for (const o of allOrders) {
        for (const it of (o.items || [])) itemToOrder[it.id] = o.id;
      }
      const map = {};
      for (const row of data || []) {
        const oid = itemToOrder[row.order_item_id];
        if (!oid) continue;
        if (!map[oid]) map[oid] = {};
        const s = row.production_status || 'hold';
        map[oid][s] = (map[oid][s] || 0) + 1;
      }
      setUnitStatusByOrder(map);
    })();
    return () => { cancelled = true; };
  }, [allOrders, team]);

  useEffect(() => {
    if (!orders.length) return;
    let cancelled = false;
    (async () => {
      const orderIds = orders.map(o => o.id);
      // Pull courier + AWB on the same fetch so the list cell can render
      // every shipment's tracking, not just the trigger-rolled-up latest
      // one (which is what order.tracking_number stores).
      const { data, error } = await supabase
        .from('bridgethings_shipments')
        .select('order_id, courier, tracking_number, shipped_date, delivered_date, items:bridgethings_shipment_items(qty)')
        .in('order_id', orderIds)
        .order('shipped_date', { ascending: true })
        .order('created_at',   { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error('[Fulfillment] shipment qty load failed:', error);
        return;
      }
      const qtyMap = {};
      const deliveredMap = {};
      const trackingMap = {};
      for (const s of data || []) {
        const sumForShipment = (s.items || []).reduce(
          (sum, si) => sum + (Number(si.qty) || 0),
          0,
        );
        qtyMap[s.order_id] = (qtyMap[s.order_id] || 0) + sumForShipment;
        if (s.delivered_date) {
          deliveredMap[s.order_id] = (deliveredMap[s.order_id] || 0) + sumForShipment;
        }
        if (s.tracking_number || s.courier) {
          if (!trackingMap[s.order_id]) trackingMap[s.order_id] = [];
          trackingMap[s.order_id].push({
            courier:         s.courier         || null,
            tracking_number: s.tracking_number || null,
          });
        }
      }
      setShippedByOrder(qtyMap);
      setDeliveredByOrder(deliveredMap);
      setTrackingByOrder(trackingMap);
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
          if (team === 'operations') {
            return deriveOpsOrderStatus(unitStatusByOrder[o.id]) === filter;
          }
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
        orderRef(o), shortId(o.id), o.id, o.partner_po_number, o.tracking_number, o.delivery_method,
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
      const defaultType = staffProductName(item.product) || '';
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
          sim_number:                  '',
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
    // Ops lands on Units (their workspace); Dispatch lands on Shipments.
    setModalTab(team === 'operations' ? 'units' : 'tracking');
    // Wipe stale form state from the previous order so the modal doesn't
    // briefly render with the wrong data during the async unit fetch.
    setForm({ items: order.items || [], units: {} });
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
        u.device_type || u.serial_number || u.sim || u.sim_number || u.calibrated_on
          || u.calibration_certificate_url || u.warranty_certificate_url
      );
      for (const u of nonEmpty) {
        await upsertUnitDetail({
          orderItemId:                u.order_item_id,
          unitIndex:                  u.unit_index,
          deviceType:                 u.device_type,
          serialNumber:               u.serial_number,
          sim:                        u.sim,
          simNumber:                  u.sim_number,
          calibratedOn:               u.calibrated_on,
          calibrationCertificateUrl:  u.calibration_certificate_url,
          warrantyCertificateUrl:     u.warranty_certificate_url,
        });
      }

      await reload();
      addToast(`Order ${orderRef(selected)} updated successfully`, 'success');
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

      {/* Status filter tabs. Ops sees production-stage tabs (Hold / In
          Production / Ready to Dispatch / Sent Back); dispatch + admin see
          the shipping-stage tabs they actually act on. */}
      <div className="tabs">
        {(team === 'operations' ? OPS_TAB_FILTERS : TAB_FILTERS).map(s => {
          const matches = (o) => {
            if (s === 'all') return true;
            if (team === 'operations') return deriveOpsOrderStatus(unitStatusByOrder[o.id]) === s;
            const ff = o.fulfillment_status === 'calibration' ? 'in_process' : o.fulfillment_status;
            return ff === s;
          };
          const count = orders.filter(matches).length;
          const label = s === 'all'
            ? 'All'
            : team === 'operations'
              ? (OPS_TAB_LABELS[s] || s)
              : STATUS_LABELS[s];
          return (
            <button
              key={s}
              className={`tab${filter === s ? ' active' : ''}`}
              onClick={() => setFilter(s)}
            >
              {label} ({count})
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
                  <th>{
                    team === 'operations' ? 'Units (Production)'
                    : team === 'dispatch' ? 'Units (To Ship / Shipped)'
                    : 'Units (Shipped / Ordered)'
                  }</th>
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
                        <span className="font-semibold" style={{color:'var(--primary)'}}>{orderRef(order)}</span>
                      </td>
                      <td className="text-sm">{partner?.name || partner?.company_name || '—'}</td>
                      <td className="text-sm">{(order.items || []).length}</td>
                      <td className="text-sm">
                        {team === 'operations' ? (() => {
                          const counts = unitStatusByOrder[order.id] || {};
                          const ORDER = ['hold', 'production', 'ready_to_dispatch', 'sent_back', 'dispatched'];
                          const LBL = { hold:'In Progress', production:'In Prod', ready_to_dispatch:'Sent', sent_back:'Sent Back', dispatched:'Dispatched' };
                          const CLS = { hold:'badge-info', production:'badge-info', ready_to_dispatch:'badge-warning', sent_back:'badge-danger', dispatched:'badge-success' };
                          const present = ORDER.filter(s => counts[s]);
                          if (!present.length) return <span className="text-muted">—</span>;
                          return (
                            <span style={{display:'inline-flex', gap:'0.25rem', flexWrap:'wrap'}}>
                              {present.map(s => (
                                <span key={s} className={`badge ${CLS[s]}`}>{counts[s]} {LBL[s]}</span>
                              ))}
                            </span>
                          );
                        })() : team === 'dispatch' ? (() => {
                          // Dispatch view: surface what ops has handed off
                          // (ready_to_dispatch = "to ship") and what's already
                          // been packed (dispatched). Of the dispatched units,
                          // the ones whose parcel has a delivered_date show as
                          // "Delivered"; the rest are "Shipped" (in transit).
                          const counts = unitStatusByOrder[order.id] || {};
                          const ready = counts.ready_to_dispatch || 0;
                          const dispatched = counts.dispatched || 0;
                          const delivered = Math.min(dispatched, deliveredByOrder[order.id] || 0);
                          const inTransit = dispatched - delivered;
                          if (ready === 0 && dispatched === 0) {
                            return <span className="text-muted">Nothing from ops yet</span>;
                          }
                          return (
                            <span style={{display:'inline-flex', gap:'0.25rem', flexWrap:'wrap'}}>
                              {ready > 0 && <span className="badge badge-warning">{ready} To Ship</span>}
                              {inTransit > 0 && <span className="badge badge-purple">{inTransit} Shipped</span>}
                              {delivered > 0 && <span className="badge badge-success">{delivered} Delivered</span>}
                            </span>
                          );
                        })() : (
                          <>
                            <span className="font-semibold" style={{color: qtyColor}}>
                              {shippedQty} / {orderedQty}
                            </span>
                            {pendingQty > 0 && (
                              <span className="text-xs" style={{color:'var(--warning)', marginLeft:'0.4rem'}}>
                                · {pendingQty} pending
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="text-sm font-semibold" style={{textAlign:'right'}}>{fmtINR(order.total_amount)}</td>
                      <td>
                        {(() => {
                          // Once the shipment trigger has rolled the order up
                          // to delivered (or the whole order is completed),
                          // show "Delivered" regardless of team. Without this
                          // the ops/admin unit-count rollup sticks on
                          // "Dispatched" forever — the dispatched unit state
                          // is the unit-level terminal, but the parcel-level
                          // story keeps moving (shipped → delivered).
                          if (order.fulfillment_status === 'delivered' || order.status === 'completed') {
                            return <span className="badge badge-success">Delivered</span>;
                          }
                          // Operations view: derive the order-level state from the per-unit
                          // counts (same helper the tab filter uses, so badge ↔ tab can
                          // never drift). The Units column next to this shows the exact
                          // per-unit breakdown.
                          if (team === 'operations') {
                            const counts = unitStatusByOrder[order.id];
                            if (!counts) return <span className="text-muted">—</span>;
                            const key = deriveOpsOrderStatus(counts);
                            const b   = OPS_STATUS_BADGE[key] || OPS_STATUS_BADGE.hold;
                            return <span className={`badge ${b.cls}`}>{b.label}</span>;
                          }
                          return (
                            <span className={`badge ${STATUS_COLORS[order.fulfillment_status]||'badge-gray'}`}>
                              {STATUS_LABELS[order.fulfillment_status]||order.fulfillment_status}
                            </span>
                          );
                        })()}
                      </td>
                      <td>
                        <span className={`badge ${order.payment_status==='completed'?'badge-success':order.payment_status==='partial'?'badge-warning':'badge-danger'}`}>
                          {order.payment_status || 'pending'}
                        </span>
                      </td>
                      <td className="text-sm">
                        {(() => {
                          // One line per shipment so multi-parcel orders
                          // show every AWB. Fall back to the single
                          // rolled-up field if we haven't loaded the
                          // shipments list yet (initial render).
                          const list = trackingByOrder[order.id];
                          if (!list?.length) return order.tracking_number || '—';
                          return (
                            <div style={{display:'flex', flexDirection:'column', gap:'0.15rem'}}>
                              {list.map((t, i) => (
                                <span key={i} style={{wordBreak:'break-all'}}>
                                  {t.courier && <span className="text-muted text-xs">{t.courier}: </span>}
                                  <code style={{fontSize:'0.8rem'}}>{t.tracking_number || '—'}</code>
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
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
                  ? `View Order: ${orderRef(selected)}`
                  : `Update Order: ${orderRef(selected)}`}
              </h3>
              <button className="modal-close" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Tabs: shipments (parcels) — Dispatch only — vs unit
                  details (serial/SIM/etc.) — Operations + Dispatch. Ops also
                  gets a sibling "Sent to Dispatch" tab so units already
                  handed off don't clutter the working list. */}
              <div className="tabs" style={{marginBottom:'1.25rem'}}>
                {team === 'dispatch' && (
                  <button
                    type="button"
                    className={`tab${modalTab === 'tracking' ? ' active' : ''}`}
                    onClick={() => setModalTab('tracking')}
                  >
                    Shipments
                  </button>
                )}
                <button
                  type="button"
                  className={`tab${modalTab === 'units' ? ' active' : ''}`}
                  onClick={() => setModalTab('units')}
                >
                  Unit Details
                </button>
                {team === 'operations' && (() => {
                  // Count units already moved past ops's hands so the badge
                  // tells them at a glance whether there's anything to review.
                  const sentCount = Object.values(form.units || {}).flat().filter(u => {
                    const s = u.production_status;
                    return s === 'ready_to_dispatch' || s === 'dispatched';
                  }).length;
                  return (
                    <button
                      type="button"
                      className={`tab${modalTab === 'sent' ? ' active' : ''}`}
                      onClick={() => setModalTab('sent')}
                    >
                      Sent to Dispatch {sentCount > 0 && <span className="count">{sentCount}</span>}
                    </button>
                  );
                })()}
              </div>

              {team === 'dispatch' && modalTab === 'tracking' && (
                // Each shipment carries its own state (courier, AWB,
                // shipped/delivered dates, In transit/Delivered badge).
                // The DB trigger rolls all shipments up to the order's
                // fulfillment_status, so no manual order-level dropdown
                // is needed — dispatch acts per parcel.
                <>
                  <ShipmentsPanel
                      order={selected}
                      items={form.items || []}
                      partner={getPartner(selected.partner_id)}
                      unitCountsByItem={(() => {
                        // Per-item production-status counts for this order
                        // so the Quantity Status block can break "pending"
                        // down into "ready to ship" vs "still with ops".
                        const map = {};
                        for (const [itemId, arr] of Object.entries(form.units || {})) {
                          const counts = {};
                          for (const u of arr || []) {
                            const s = u.production_status || 'hold';
                            counts[s] = (counts[s] || 0) + 1;
                          }
                          map[itemId] = counts;
                        }
                        return map;
                      })()}
                      onChanged={reload}
                    />
                  </>
              )}

              {(modalTab === 'units' || modalTab === 'sent') && (
                <UnitsTab
                  team={team}
                  view={modalTab === 'sent' ? 'sent' : 'active'}
                  items={form.items || []}
                  units={form.units || {}}
                  onUpdateUnit={updateUnitField}
                  onChanged={async () => {
                    // Refetch this order's items + units so the per-unit
                    // production_status updates land in form.units. Using
                    // direct queries avoids the stale-`selected` ref bug
                    // that previously caused the dropdown to revert.
                    if (!selected) return;
                    const { data: items } = await supabase
                      .from('bridgethings_order_items')
                      .select('*, product:bridgethings_products(id, name, internal_name, base_price, image_url, features)')
                      .eq('order_id', selected.id);
                    const itemIds = (items || []).map(i => i.id);
                    const existing = await loadUnitDetailsForItems(itemIds);
                    setForm(prev => ({
                      ...prev,
                      items: items || prev.items,
                      units: buildUnitMap(items || prev.items, existing),
                    }));
                    await reload(); // keep the orders list in sync
                  }}
                />
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

// Container for the Units tab. Selection is per-UNIT, so ops can move
// some units of an item to "Ready to Dispatch" while keeping others on
// "Hold" (e.g. material out of stock). Status badge + dropdown live on
// each UnitRow. Dispatch only sees units marked ready_to_dispatch.
function UnitsTab({ team, items, units, onUpdateUnit, onChanged, view = 'active' }) {
  const { addToast } = useToast();
  // `picked` is now a Set of UNIT IDs (bridgethings_order_unit_details.id).
  const [picked, setPicked] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackNote, setSendBackNote] = useState('');

  // Ops "Sent to Dispatch" tab: read-only view of units already handed off.
  const isOpsSent = team === 'operations' && view === 'sent';

  // Filter rules per view:
  //   dispatch        — only units waiting on dispatch (ready_to_dispatch)
  //   ops active      — everything still in ops's hands (hide ready/dispatched)
  //   ops sent        — only units already handed off (ready_to_dispatch + dispatched)
  const filterFn = team === 'dispatch'
    ? (u) => u.production_status === 'ready_to_dispatch'
    : isOpsSent
      ? (u) => u.production_status === 'ready_to_dispatch' || u.production_status === 'dispatched'
      : (u) => u.production_status !== 'ready_to_dispatch' && u.production_status !== 'dispatched';

  const filteredUnits = Object.fromEntries(
    Object.entries(units || {}).map(([itemId, arr]) => [itemId, (arr || []).filter(filterFn)]),
  );
  // Hide items entirely when the current view has no units for them.
  const visibleItems = (team === 'dispatch' || isOpsSent)
    ? items.filter(i => (filteredUnits[i.id] || []).length > 0)
    : items;

  // Flat list of unit ids visible in the current view — used by the
  // "select all" checkbox + bulk actions.
  const visibleUnitIds = visibleItems
    .flatMap(it => (filteredUnits[it.id] || []))
    .map(u => u.id)
    .filter(Boolean);

  const togglePick = (unitId) => {
    if (!unitId) return;
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId); else next.add(unitId);
      return next;
    });
  };
  const pickAll = () => setPicked(new Set(visibleUnitIds));
  const clearPicks = () => setPicked(new Set());

  // Persist any in-flight field edits (serial, SIM, calibration, certs)
  // to the DB before a status change. Without this, the user can type
  // values, click Apply, and have onChanged immediately refetch and wipe
  // the form back to the DB's empty state — losing their typing entirely.
  const persistFieldEdits = async () => {
    const allUnits = Object.values(units || {}).flat();
    const dirty = allUnits.filter(u =>
      u.device_type || u.serial_number || u.sim || u.sim_number || u.calibrated_on
        || u.calibration_certificate_url || u.warranty_certificate_url
    );
    for (const u of dirty) {
      await upsertUnitDetail({
        orderItemId:                u.order_item_id,
        unitIndex:                  u.unit_index,
        deviceType:                 u.device_type,
        serialNumber:               u.serial_number,
        sim:                        u.sim,
        simNumber:                  u.sim_number,
        calibratedOn:               u.calibrated_on,
        calibrationCertificateUrl:  u.calibration_certificate_url,
        warrantyCertificateUrl:     u.warranty_certificate_url,
      });
    }
  };

  // Default the bulk target to "In Production" — the most common forward
  // move from the default "In Progress" state. Ops switches it when they
  // want to hand units off to dispatch.
  const [bulkStatus, setBulkStatus] = useState('production');

  const handleBulkApply = async () => {
    if (picked.size === 0) { addToast('Tick at least one unit', 'error'); return; }
    setBulkBusy(true);
    try {
      await persistFieldEdits();
      await setUnitsProductionStatus(Array.from(picked), bulkStatus);
      const label = ITEM_PRODUCTION_LABEL[bulkStatus] || bulkStatus;
      addToast(`${picked.size} unit(s) moved to "${label}"`, 'success');
      clearPicks();
      await onChanged?.();
    } catch (err) {
      console.error('[ops] bulk status update failed:', err);
      addToast(err.message || 'Failed to update status', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleSendBack = async () => {
    if (picked.size === 0)    { addToast('Tick at least one unit', 'error'); return; }
    if (!sendBackNote.trim()) { addToast('Please add a note', 'error'); return; }
    setBulkBusy(true);
    try {
      await sendUnitsBackToOps(Array.from(picked), sendBackNote);
      addToast(`${picked.size} unit(s) sent back to operations`, 'info');
      clearPicks();
      setSendBackNote('');
      setSendBackOpen(false);
      await onChanged?.();
    } catch (err) {
      console.error('[dispatch] send back failed:', err);
      addToast(err.message || 'Failed to send back', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  // Ops "Unit Details" view always shows every line item (so partners
  // can see them even after they've handed everything off) — but when
  // every unit has moved past production into dispatched/ready_to_-
  // dispatch, there's nothing for ops to tick or move. Render the
  // empty-state instead so the bulk action bar (and the misleading
  // "0/0 unit(s) filled" cards) goes away.
  const noActionableOpsUnits = team === 'operations' && !isOpsSent && visibleUnitIds.length === 0;
  if (visibleItems.length === 0 || noActionableOpsUnits) {
    return (
      <div className="empty-state">
        <p>
          {noActionableOpsUnits
            ? 'All units on this order have been sent to dispatch — open the Sent to Dispatch tab to view them.'
            : team === 'dispatch'
              ? 'No units waiting on dispatch right now.'
              : isOpsSent
                ? 'No units sent to dispatch yet. Tick units in the Unit Details tab and click Send to Dispatch.'
                : 'No items on this order.'}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="text-xs text-muted" style={{marginBottom:'0.75rem'}}>
        {team === 'dispatch'
          ? 'Verify each unit below. Tick any wrong unit(s) and click Send Back to Operations with a note.'
          : isOpsSent
            ? 'Units already handed off to dispatch. You can still edit details (e.g. a cert URL that came in late) and click Save Updates — status is locked once sent.'
            : 'Fill in serial, SIM, calibration and certificate URLs. Set per-unit status (In Progress / In Production / Sent for Dispatch). Tick the units to hand off and click Send to Dispatch.'}
      </div>

      {/* Bulk action bar — picks are at the unit level. Hidden in the ops
          "Sent to Dispatch" view since those units are past ops's hands. */}
      {!isOpsSent && (
      <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:'0.5rem', marginBottom:'0.85rem', padding:'0.6rem 0.85rem', background:'var(--bg)', borderRadius:'8px'}}>
        <input
          type="checkbox"
          checked={picked.size > 0 && picked.size === visibleUnitIds.length}
          onChange={e => e.target.checked ? pickAll() : clearPicks()}
        />
        <span className="text-sm text-muted">
          {picked.size === 0 ? 'Tick units to act on them' : `${picked.size} unit(s) selected`}
        </span>
        <div style={{marginLeft:'auto', display:'flex', gap:'0.4rem', alignItems:'center', flexWrap:'wrap'}}>
          {team === 'operations' ? (
            <>
              <span className="text-xs text-muted">Move selected to:</span>
              <select
                className="form-select form-input"
                value={bulkStatus}
                onChange={e => setBulkStatus(e.target.value)}
                disabled={bulkBusy}
                style={{maxWidth:'180px', fontSize:'0.78rem', padding:'0.2rem 0.4rem'}}
              >
                {ITEM_PRODUCTION_STATUSES
                  .filter(s => s.value !== 'dispatched' && s.value !== 'sent_back')
                  .map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                disabled={picked.size === 0 || bulkBusy}
                onClick={handleBulkApply}
              >
                {bulkBusy
                  ? 'Updating...'
                  : picked.size > 0
                    ? `Apply to ${picked.size} unit(s)`
                    : 'Apply'}
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={picked.size === 0 || bulkBusy} onClick={() => setSendBackOpen(true)}>
              Send Back to Operations
            </button>
          )}
        </div>
      </div>
      )}

      {!isOpsSent && sendBackOpen && (
        <div
          className="modal-overlay"
          onClick={() => { if (!bulkBusy) { setSendBackOpen(false); setSendBackNote(''); } }}
          style={{zIndex: 1100}} // sits above the parent Update Order modal
        >
          <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'520px'}}>
            <div className="modal-header">
              <h3>Send {picked.size} unit(s) back to operations</h3>
              <button
                className="modal-close"
                onClick={() => { setSendBackOpen(false); setSendBackNote(''); }}
                disabled={bulkBusy}
              >✕</button>
            </div>
            <div className="modal-body">
              <div className="text-sm text-muted" style={{marginBottom:'0.75rem'}}>
                Tell operations what's wrong with the ticked unit(s) so they can fix it. Your note appears under each unit on the ops side.
              </div>
              <div className="form-group">
                <label className="form-label">Reason (required)</label>
                <textarea
                  className="form-textarea"
                  rows={4}
                  value={sendBackNote}
                  onChange={e => setSendBackNote(e.target.value)}
                  placeholder="e.g. Serial number doesn't match the calibration certificate"
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => { setSendBackOpen(false); setSendBackNote(''); }}
                disabled={bulkBusy}
              >
                Cancel
              </button>
              <button
                className="btn btn-warning"
                onClick={handleSendBack}
                disabled={bulkBusy || !sendBackNote.trim()}
                title={!sendBackNote.trim() ? 'Type a reason to enable' : ''}
              >
                {bulkBusy ? 'Sending...' : `Send ${picked.size} unit(s) back`}
              </button>
            </div>
          </div>
        </div>
      )}

      {visibleItems.map(item => (
        <ItemUnitsEditor
          key={item.id}
          item={item}
          units={filteredUnits[item.id] || []}
          team={team}
          // Ops "sent" view: lock the tick checkbox so units can't be
          // picked for further status moves. Field edits still allowed
          // for late-arriving details.
          frozen={isOpsSent}
          pickedUnitIds={picked}
          onToggleUnitPick={togglePick}
          onUpdate={(unitIndex, field, value) => onUpdateUnit(item.id, unitIndex, field, value)}
        />
      ))}
    </>
  );
}

// One section per order_item — renders `qty` unit rows below the item name.
// Each unit row has 6 inputs (type/serial/SIM/calibrated-on + 2 cert URLs).
// `frozen` is the ops "Sent to Dispatch" mode — units are read-only and the
// per-unit status dropdown is hidden (those units are no longer ops's to move).
function ItemUnitsEditor({ item, units, onUpdate, team = 'operations', frozen = false, pickedUnitIds, onToggleUnitPick }) {
  const [collapsed, setCollapsed] = useState(false);
  const filledCount = units.filter(u =>
    u.device_type || u.serial_number || u.sim || u.sim_number || u.calibrated_on
      || u.calibration_certificate_url || u.warranty_certificate_url
  ).length;

  // Aggregate counts so the item header shows the unit-status mix at a
  // glance ("3 Hold · 2 Ready"). Truth lives on each unit row now.
  const counts = units.reduce((acc, u) => {
    const s = u.production_status || 'hold';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const order = ['hold', 'production', 'ready_to_dispatch', 'sent_back', 'dispatched'];
  const label = { hold: 'In Progress', production: 'In Production', ready_to_dispatch: 'Sent for Dispatch', sent_back: 'Sent Back', dispatched: 'Dispatched' };
  const cls   = { hold: 'badge-info', production: 'badge-info', ready_to_dispatch: 'badge-warning', sent_back: 'badge-danger', dispatched: 'badge-success' };

  // Field edits: only dispatch is read-only. Ops keeps editing rights even
  // in the "Sent to Dispatch" view so they can add details that arrive
  // late (cert URLs, SIM numbers) without yanking units back from dispatch.
  const fieldsReadOnly = team === 'dispatch';

  return (
    <div style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'8px', padding:'1rem', marginBottom:'1rem'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'0.75rem', marginBottom:'0.5rem', flexWrap:'wrap'}}>
        <div style={{display:'flex', alignItems:'center', gap:'0.6rem', flexWrap:'wrap'}}>
          <div className="font-semibold">
            {staffProductName(item.product) || 'Unknown product'}{' '}
            <span className="text-sm text-muted">— {filledCount}/{units.length} unit(s) filled</span>
          </div>
          {Number(item.extra_cable_m) > 0 && (
            <span className="badge badge-warning" style={{fontSize:'0.7rem'}}>
              Cable: {CABLE_FREE_METERS + Number(item.extra_cable_m)} m/unit
            </span>
          )}
          {order.filter(s => counts[s]).map(s => (
            <span key={s} className={`badge ${cls[s]}`}>{counts[s]} {label[s]}</span>
          ))}
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
              fieldsReadOnly={fieldsReadOnly}
              actionsLocked={frozen}
              team={team}
              checked={u.id ? pickedUnitIds?.has(u.id) : false}
              onTogglePick={() => onToggleUnitPick?.(u.id)}
              onChange={(field, value) => onUpdate(u.unit_index, field, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// fieldsReadOnly  — gates the input boxes (dispatch never edits; ops can).
// actionsLocked   — gates the row's action UI (currently just the tick
//                   checkbox). True in ops's "Sent to Dispatch" view so
//                   they can edit late-arriving details but can't pick
//                   units to move. Status changes always happen via the
//                   bulk "Move selected to: __" + Apply flow at the top
//                   of the tab — no fire-on-change per-unit dropdown.
function UnitRow({ unit, onChange, fieldsReadOnly = false, actionsLocked = false, team = 'operations', checked = false, onTogglePick }) {
  const status = unit.production_status || 'hold';
  const statusBadge = {
    hold:              { className: 'badge-info',    label: 'In Progress' },
    production:        { className: 'badge-info',    label: 'In Production' },
    ready_to_dispatch: { className: 'badge-warning', label: 'Sent for Dispatch' },
    sent_back:         { className: 'badge-danger',  label: 'Sent Back' },
    dispatched:        { className: 'badge-success', label: 'Dispatched' },
  }[status] || { className: 'badge-gray', label: status };
  return (
    <div style={{background:'var(--card)', border:'1px solid var(--border)', borderRadius:'6px', padding:'0.75rem'}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:'0.5rem', marginBottom:'0.5rem'}}>
        <div style={{display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap'}}>
          {/* Tick checkbox — hidden for dispatched units (already gone) and
              when row actions are locked (e.g. ops "Sent to Dispatch" tab,
              where they can edit fields but not pick/move units). */}
          {status !== 'dispatched' && !actionsLocked && (
            <input
              type="checkbox"
              checked={checked}
              onChange={onTogglePick}
              disabled={!unit.id}
              aria-label={`Select unit ${unit.unit_index}`}
            />
          )}
          <span className="text-xs" style={{fontWeight:700, color:'var(--primary)'}}>
            Unit #{unit.unit_index}
          </span>
          <span className={`badge ${statusBadge.className}`}>{statusBadge.label}</span>
        </div>
      </div>

      {/* Dispatch's rejection note for this specific unit, bubbled up so
          ops sees exactly what to fix. */}
      {status === 'sent_back' && unit.dispatch_review_note && (
        <div style={{padding:'0.4rem 0.6rem', background:'rgba(239,68,68,0.08)', border:'1px solid var(--danger)', borderRadius:'6px', marginBottom:'0.5rem', fontSize:'0.8rem'}}>
          <span style={{fontWeight:700, color:'var(--danger)'}}>Dispatch sent this back:</span>{' '}
          {unit.dispatch_review_note}
        </div>
      )}
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
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">SIM Name</label>
          <input
            className="form-input"
            value={unit.sim || ''}
            onChange={e => onChange('sim', e.target.value)}
            placeholder="SIM name"
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">SIM Number</label>
          <input
            className="form-input"
            value={unit.sim_number || ''}
            onChange={e => onChange('sim_number', e.target.value)}
            placeholder="SIM Number"
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Calibrated On</label>
          <input
            type="date"
            className="form-input"
            value={unit.calibrated_on || ''}
            onChange={e => onChange('calibrated_on', e.target.value)}
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Calibration Certificate URL</label>
          <input
            className="form-input"
            value={unit.calibration_certificate_url || ''}
            onChange={e => onChange('calibration_certificate_url', e.target.value)}
            placeholder="https://..."
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
        <div className="form-group">
          <label className="form-label text-xs">Warranty Certificate URL</label>
          <input
            className="form-input"
            value={unit.warranty_certificate_url || ''}
            onChange={e => onChange('warranty_certificate_url', e.target.value)}
            placeholder="https://..."
            readOnly={fieldsReadOnly}
            disabled={fieldsReadOnly}
          />
        </div>
      </div>
    </div>
  );
}
