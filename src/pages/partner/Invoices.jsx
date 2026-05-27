// Partner — Invoices (per-shipment).
//
// An order can ship in multiple parcels; each parcel is its own invoice.
// Three views, navigated in order:
//   1. Orders list   — one row per order that has at least one shipment
//   2. Shipments list — one card per shipment for the chosen order, with
//                       View / Download per shipment
//   3. Invoice detail — print-ready invoice scoped to a single shipment,
//                       downloadable as PDF
//
// Per-shipment math:
//   subtotal = sum(shipment_item.qty × order_item.unit_price)
//   IGST     = subtotal × 18%
//   shipping = order.shipping_cost, charged ONLY on the first shipment
//              (chronologically), since it's a one-time order-level fee
//   total    = subtotal + (shipping if first) + IGST
import { useEffect, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { useAuth } from '../../lib/auth';
import { useOrders } from '../../lib/orders';
import { supabase } from '../../lib/supabase';

const fmtINR  = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';
// Invoice number = INV-{shortOrderId}-{shipmentSerial}, e.g. INV-353588CE-01.
const invoiceNo = (orderId, idx) =>
  `INV-${shortId(orderId)}-${String(idx + 1).padStart(2, '0')}`;

const formatAddressLines = (address, partsPerLine = 3) => {
  if (!address) return [];
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const lines = [];
  for (let i = 0; i < parts.length; i += partsPerLine) {
    lines.push(parts.slice(i, i + partsPerLine).join(', '));
  }
  return lines;
};

const COMPANY = {
  name:    'BRIDGETHINGS IOT PRIVATE LIMITED',
  address: '#1-113/41, Flat No.202, Shreyas Building',
  line2:   'Silpa Park Layout, 5th Cross Road,',
  line3:   'Kondapur, Hyderabad 500084',
  state:   'Telangana TS',
  country: 'India',
  gstin:   '36AAHCB0979R1ZW',
};

const GST_RATE = 0.18;

export default function Invoices() {
  const { user } = useAuth();
  // Shipments can exist on active OR completed orders — fetch both buckets.
  const { orders, loading } = useOrders({ includeStatuses: ['active', 'completed'] });
  const [shipmentsByOrder, setShipmentsByOrder] = useState({});
  const [shipmentsLoading, setShipmentsLoading] = useState(true);
  const [productsById, setProductsById]   = useState({});
  const [openOrderId, setOpenOrderId]     = useState(null);
  const [openShipmentId, setOpenShipmentId] = useState(null);
  const [search, setSearch] = useState('');

  // Pull all shipments + their items in one round-trip, then group by order.
  useEffect(() => {
    if (!orders.length) { setShipmentsByOrder({}); setShipmentsLoading(false); return; }
    let cancelled = false;
    (async () => {
      setShipmentsLoading(true);
      const orderIds = orders.map(o => o.id);
      const { data, error } = await supabase
        .from('bridgethings_shipments')
        .select('*, items:bridgethings_shipment_items(*)')
        .in('order_id', orderIds)
        .order('shipped_date', { ascending: true })
        .order('created_at',   { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error('[invoices] shipments load failed:', error);
        setShipmentsByOrder({});
      } else {
        const map = {};
        for (const s of data || []) {
          (map[s.order_id] = map[s.order_id] || []).push(s);
        }
        setShipmentsByOrder(map);
      }
      setShipmentsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [orders]);

  // Defensive product lookup in case the embedded join in useOrders is empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('bridgethings_products')
        .select('id, name, description, base_price');
      if (cancelled || !data) return;
      const map = {};
      data.forEach(p => { map[p.id] = p; });
      setProductsById(map);
    })();
    return () => { cancelled = true; };
  }, []);

  // Orders with at least one shipment — those are the ones with invoices.
  const invoiceableOrders = orders.filter(o => (shipmentsByOrder[o.id] || []).length > 0);

  const openOrder       = openOrderId ? orders.find(o => o.id === openOrderId) : null;
  const orderShipments  = openOrder ? (shipmentsByOrder[openOrder.id] || []) : [];
  const openShipment    = openShipmentId ? orderShipments.find(s => s.id === openShipmentId) : null;
  const openShipmentIdx = openShipment ? orderShipments.findIndex(s => s.id === openShipment.id) : -1;

  // ────────────────────────────────────────────────────────────────────
  // View 3: single-shipment invoice detail (print/download)
  // ────────────────────────────────────────────────────────────────────
  if (openShipment && openOrder) {
    return (
      <InvoiceDetail
        order={openOrder}
        shipment={openShipment}
        shipmentIndex={openShipmentIdx}
        isFirstShipment={openShipmentIdx === 0}
        partner={user}
        productsById={productsById}
        onBack={() => setOpenShipmentId(null)}
      />
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // View 2: list of shipments for the chosen order
  // ────────────────────────────────────────────────────────────────────
  if (openOrder) {
    return (
      <OrderShipmentsList
        order={openOrder}
        shipments={orderShipments}
        productsById={productsById}
        onBack={() => setOpenOrderId(null)}
        onPickShipment={(id) => setOpenShipmentId(id)}
      />
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // View 1: orders that have invoices
  // ────────────────────────────────────────────────────────────────────
  const term = search.trim().toLowerCase();
  const filtered = !term ? invoiceableOrders : invoiceableOrders.filter(o => {
    const hay = [shortId(o.id), o.id, o.delivery_method, o.tracking_number]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(term);
  });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Invoices</div>
          <div className="page-subtitle">Click an order to see its shipment invoices</div>
        </div>
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by order ID, courier, tracking number..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {(loading || shipmentsLoading) ? (
        <div className="card"><div className="empty-state"><p>Loading invoices...</p></div></div>
      ) : invoiceableOrders.length === 0 ? (
        <div className="card"><div className="empty-state"><p>No invoices yet. Invoices appear here once Bridge Things dispatches a shipment.</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>No invoices match "{search}".</p></div></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Order Date</th>
                  <th>Invoices</th>
                  <th style={{textAlign:'right'}}>Order Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => {
                  const ships = shipmentsByOrder[o.id] || [];
                  return (
                    <tr
                      key={o.id}
                      style={{cursor:'pointer'}}
                      onClick={() => setOpenOrderId(o.id)}
                      title="Click to view shipment invoices"
                    >
                      <td>
                        <span className="font-semibold" style={{color:'var(--primary)', textDecoration:'underline'}}>
                          ORD-{shortId(o.id)}
                        </span>
                      </td>
                      <td>{fmtDate(o.created_at)}</td>
                      <td>
                        <span className="badge badge-info">
                          {ships.length} {ships.length === 1 ? 'invoice' : 'invoices'}
                        </span>
                      </td>
                      <td className="font-semibold" style={{textAlign:'right'}}>{fmtINR(o.total_amount)}</td>
                      <td>
                        <span className={`badge ${o.status === 'completed' ? 'badge-success' : 'badge-info'}`}>
                          {o.status === 'completed' ? 'Completed' : 'In Progress'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// View 2 — shipment list for one order. Each card summarises one invoice.
// ────────────────────────────────────────────────────────────────────────
function OrderShipmentsList({ order, shipments, productsById = {}, onBack, onPickShipment }) {
  // Map order_item_id → order_item for quick lookup of unit_price + product.
  const itemById = {};
  for (const it of (order.items || [])) itemById[it.id] = it;
  const resolveProduct = (orderItem) =>
    orderItem?.product || productsById[orderItem?.product_id] || null;

  return (
    <>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onBack} style={{marginBottom:'0.5rem'}}>
            ← Back to invoices
          </button>
          <div className="page-title">Invoices for ORD-{shortId(order.id)}</div>
          <div className="page-subtitle">
            {shipments.length} {shipments.length === 1 ? 'shipment' : 'shipments'} dispatched · Order total {fmtINR(order.total_amount)}
          </div>
        </div>
      </div>

      <div style={{display:'flex', flexDirection:'column', gap:'1rem'}}>
        {shipments.map((s, idx) => {
          const isFirst = idx === 0;
          const subtotal = (s.items || []).reduce((sum, si) => {
            const oi = itemById[si.order_item_id];
            const price = Number(oi?.unit_price) || 0;
            return sum + price * (Number(si.qty) || 0);
          }, 0);
          const shippingOnThis = isFirst ? (Number(order.shipping_cost) || 0) : 0;
          const taxable = subtotal + shippingOnThis;
          const tax     = taxable * GST_RATE;
          const total   = taxable + tax;

          return (
            <div key={s.id} className="card" style={{padding:'1.25rem 1.5rem'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'1rem', flexWrap:'wrap', marginBottom:'0.75rem'}}>
                <div>
                  <div className="font-semibold" style={{color:'var(--primary)', fontSize:'1.05rem'}}>
                    {invoiceNo(order.id, idx)}
                  </div>
                  <div className="text-sm text-muted" style={{marginTop:'0.2rem'}}>
                    Shipped {fmtDate(s.shipped_date)}
                    {s.delivered_date && ` · Delivered ${fmtDate(s.delivered_date)}`}
                    {s.courier && ` · ${s.courier}`}
                    {s.tracking_number && ` · ${s.tracking_number}`}
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => onPickShipment(s.id)}>
                  View / Download
                </button>
              </div>

              <div className="table-wrap">
                <table style={{margin:0}}>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{textAlign:'right'}}>Qty in Shipment</th>
                      <th style={{textAlign:'right'}}>Unit Price</th>
                      <th style={{textAlign:'right'}}>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(s.items || []).map(si => {
                      const oi = itemById[si.order_item_id];
                      const product = resolveProduct(oi);
                      const price = Number(oi?.unit_price) || 0;
                      return (
                        <tr key={si.id}>
                          <td className="font-semibold">{product?.name || 'Unknown product'}</td>
                          <td style={{textAlign:'right'}}>{si.qty}</td>
                          <td style={{textAlign:'right'}}>{fmtINR(price)}</td>
                          <td style={{textAlign:'right'}} className="font-semibold">{fmtINR(price * (Number(si.qty) || 0))}</td>
                        </tr>
                      );
                    })}
                    {(s.items || []).length === 0 && (
                      <tr><td colSpan={4} style={{textAlign:'center', color:'var(--text-muted)', padding:'1rem'}}>No items recorded in this shipment.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{display:'flex', justifyContent:'flex-end', marginTop:'0.75rem'}}>
                <div style={{minWidth:'260px', display:'flex', flexDirection:'column', gap:'0.2rem', fontSize:'0.85rem'}}>
                  <Row label="Subtotal" value={fmtINR(subtotal)} />
                  {isFirst && shippingOnThis > 0 && (
                    <Row label="Shipping (charged once)" value={fmtINR(shippingOnThis)} />
                  )}
                  <Row label={`IGST ${GST_RATE * 100}%`} value={fmtINR(tax)} />
                  <div style={{display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border)', paddingTop:'0.4rem', marginTop:'0.2rem'}}>
                    <span style={{fontWeight:700, color:'var(--primary)'}}>Invoice Total</span>
                    <span style={{fontWeight:700, color:'var(--primary)'}}>{fmtINR(total)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// View 3 — print-ready invoice for a single shipment. PDF export uses
// html2canvas + jspdf, same approach as the previous order-level invoice.
// ────────────────────────────────────────────────────────────────────────
function InvoiceDetail({
  order, shipment, shipmentIndex, isFirstShipment,
  partner, productsById = {}, onBack,
}) {
  const itemById = {};
  for (const it of (order.items || [])) itemById[it.id] = it;
  const resolveProduct = (orderItem) =>
    orderItem?.product || productsById[orderItem?.product_id] || null;

  const lineRows = (shipment.items || []).map(si => {
    const oi      = itemById[si.order_item_id];
    const product = resolveProduct(oi);
    const price   = Number(oi?.unit_price) || Number(product?.base_price) || 0;
    const qty     = Number(si.qty) || 0;
    return { id: si.id, product, price, qty, amount: price * qty };
  });

  const subtotal       = lineRows.reduce((s, r) => s + r.amount, 0);
  const shippingOnThis = isFirstShipment ? (Number(order.shipping_cost) || 0) : 0;
  const taxable        = subtotal + shippingOnThis;
  const tax            = taxable * GST_RATE;
  const total          = taxable + tax;
  const invNo          = invoiceNo(order.id, shipmentIndex);

  const invoiceRef = useRef(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!invoiceRef.current) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(invoiceRef.current, {
        scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageWidth  = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth   = pageWidth;
      const imgHeight  = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position   = 0;
      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }
      pdf.save(`${invNo}.pdf`);
    } catch (err) {
      console.error('[invoices] download failed:', err);
      alert('Failed to download invoice. ' + (err?.message || ''));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onBack} style={{marginBottom:'0.5rem'}}>
            ← Back to shipment invoices
          </button>
          <div className="page-title">Invoice {invNo}</div>
        </div>
        <div style={{display:'flex', gap:'0.5rem'}}>
          <button className="btn btn-secondary btn-sm" onClick={() => window.print()} disabled={downloading}>
            Print
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Preparing...' : 'Download PDF'}
          </button>
        </div>
      </div>

      <div style={{overflowX:'auto'}}>
      <div ref={invoiceRef} className="card invoice-card" style={{padding:0, overflow:'hidden', minWidth:'720px'}}>
        <div style={{
          background:'#fef2ea', padding:'2rem 2.5rem',
          display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem', alignItems:'flex-start',
        }}>
          <div>
            <img src={`${import.meta.env.BASE_URL}BridgeThings.png`} alt="Bridge Things" style={{height:'50px', objectFit:'contain'}} />
          </div>
          <div style={{textAlign:'right', fontSize:'0.85rem', lineHeight:1.55, color:'#1f2937'}}>
            <div style={{fontWeight:700, color:'#0f172a'}}>{COMPANY.name}</div>
            <div>{COMPANY.address}</div>
            <div>{COMPANY.line2}</div>
            <div>{COMPANY.line3}</div>
            <div>{COMPANY.state}</div>
            <div>{COMPANY.country}</div>
            <div style={{marginTop:'0.75rem'}}>
              <span style={{fontWeight:600}}>GSTIN:</span> {COMPANY.gstin}
            </div>
          </div>
        </div>

        <div style={{padding:'2rem 2.5rem 0.5rem'}}>
          <div style={{fontSize:'0.85rem', lineHeight:1.6, color:'#1f2937'}}>
            <div style={{fontWeight:700, color:'#0f172a', textTransform:'uppercase'}}>
              {partner?.name || partner?.company_name || '—'}
            </div>
            {partner?.company_name && partner?.name && partner.name !== partner.company_name && (
              <div>{partner.company_name}</div>
            )}
            {formatAddressLines(partner?.address).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {(partner?.city || partner?.state || partner?.pincode) && (
              <div>
                {[partner.city, partner.state, partner.pincode].filter(Boolean).join(', ')}
              </div>
            )}
            {partner?.gst_number && (
              <div style={{marginTop:'0.5rem'}}>
                <span style={{fontWeight:600}}>GSTIN:</span> {partner.gst_number}
              </div>
            )}
          </div>
        </div>

        <div style={{padding:'1.5rem 2.5rem 0.5rem'}}>
          <h2 style={{fontSize:'1.75rem', fontWeight:700, color:'var(--primary)', margin:0}}>
            Invoice # {invNo}
          </h2>
          <div className="text-sm text-muted" style={{marginTop:'0.25rem'}}>
            Order ORD-{shortId(order.id)} · Shipment {shipmentIndex + 1}
          </div>
        </div>

        <div style={{
          padding:'1rem 2.5rem', background:'#fef2ea',
          display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:'1rem 1.5rem',
        }}>
          <div>
            <div style={{fontSize:'0.78rem', fontWeight:700, color:'var(--primary)'}}>Order Date</div>
            <div style={{fontSize:'0.9rem', color:'#0f172a'}}>{fmtDate(order.created_at)}</div>
          </div>
          <div>
            <div style={{fontSize:'0.78rem', fontWeight:700, color:'var(--primary)'}}>Shipped Date</div>
            <div style={{fontSize:'0.9rem', color:'#0f172a'}}>{fmtDate(shipment.shipped_date)}</div>
          </div>
          <div>
            <div style={{fontSize:'0.78rem', fontWeight:700, color:'var(--primary)'}}>Delivered Date</div>
            <div style={{fontSize:'0.9rem', color:'#0f172a'}}>{fmtDate(shipment.delivered_date)}</div>
          </div>
          <div>
            <div style={{fontSize:'0.78rem', fontWeight:700, color:'var(--primary)'}}>Courier</div>
            <div style={{fontSize:'0.9rem', color:'#0f172a'}}>{shipment.courier || '—'}</div>
          </div>
          <div>
            <div style={{fontSize:'0.78rem', fontWeight:700, color:'var(--primary)'}}>Tracking Number</div>
            <div style={{fontSize:'0.9rem', color:'#0f172a', wordBreak:'break-all'}}>{shipment.tracking_number || '—'}</div>
          </div>
        </div>

        <div style={{padding:'1.5rem 2.5rem 0'}}>
          <div className="table-wrap">
            <table style={{margin:0}}>
              <thead>
                <tr>
                  <th>Product Name</th>
                  <th style={{textAlign:'right'}}>Price</th>
                  <th style={{textAlign:'right'}}>Quantity</th>
                  <th style={{textAlign:'right'}}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineRows.map(row => (
                  <tr key={row.id}>
                    <td className="font-semibold">{row.product?.name || 'Unknown product'}</td>
                    <td style={{textAlign:'right'}}>{fmtINR(row.price)}</td>
                    <td style={{textAlign:'right'}}>{row.qty}</td>
                    <td style={{textAlign:'right'}} className="font-semibold">{fmtINR(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{padding:'1.25rem 2.5rem 2rem', display:'flex', justifyContent:'flex-end'}}>
          <div style={{minWidth:'320px'}}>
            <Row label="Untaxed Amount" value={fmtINR(subtotal)} />
            {isFirstShipment && shippingOnThis > 0 && (
              <Row label={`Shipping${shipment.courier ? ` (${shipment.courier})` : ''}`} value={fmtINR(shippingOnThis)} />
            )}
            <Row label={`IGST ${GST_RATE * 100}%`} value={fmtINR(tax)} />
            <div style={{
              display:'flex', justifyContent:'space-between', alignItems:'center',
              padding:'0.6rem 0', borderTop:'2px solid var(--border)', marginTop:'0.5rem',
            }}>
              <span style={{fontSize:'1rem', fontWeight:700, color:'var(--primary)'}}>Total</span>
              <span style={{fontSize:'1.1rem', fontWeight:700, color:'var(--primary)'}}>{fmtINR(total)}</span>
            </div>
            {!isFirstShipment && (
              <div className="text-xs text-muted" style={{marginTop:'0.5rem'}}>
                Shipping was charged on Invoice {invoiceNo(order.id, 0)}.
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', padding:'0.35rem 0', fontSize:'0.9rem'}}>
      <span style={{color:'#475569'}}>{label}</span>
      <span style={{fontWeight:600, color:'#0f172a'}}>{value}</span>
    </div>
  );
}
