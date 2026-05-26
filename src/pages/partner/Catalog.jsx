// Partner — Product Catalog (All Products)
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { Link } from 'react-router-dom';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');

// Apply the partner's flat discount % to a base price. Rounded to 2dp so
// the displayed price always matches what gets saved on PO submit.
const applyDiscount = (basePrice, discountPercent) => {
  const base = Number(basePrice) || 0;
  const pct  = Number(discountPercent) || 0;
  if (!pct) return base;
  return Math.round((base * (1 - pct / 100)) * 100) / 100;
};

export default function Catalog() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const { add, has, items } = useCart();
  const discountPct = Number(user?.discount_percent) || 0;
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);
  // Index of the gallery thumbnail currently displayed as the big image in
  // the detail modal. Resets when the modal opens for a new product.
  const [activeImage, setActiveImage] = useState(0);
  useEffect(() => { setActiveImage(0); }, [detail?.id]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  // Qty prompt state. When the partner clicks "+ Add to PO" we ask for a
  // quantity first instead of silently adding 1.
  const [qtyPromptProduct, setQtyPromptProduct] = useState(null);
  const [qtyValue, setQtyValue] = useState(1);

  const openQtyPrompt = (product) => {
    setQtyPromptProduct(product);
    setQtyValue(1);
  };

  const confirmAdd = () => {
    if (!qtyPromptProduct) return;
    const qty = Math.max(1, Math.floor(Number(qtyValue) || 1));
    const already = has(qtyPromptProduct.id);
    add(qtyPromptProduct, qty);
    addToast(
      already
        ? `Added ${qty} more of "${qtyPromptProduct.name}" to your PO`
        : `Added ${qty} × "${qtyPromptProduct.name}" to your PO`,
      'success'
    );
    setQtyPromptProduct(null);
    setDetail(null); // close detail modal too, if it was open
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await supabase.auth.getSession(); // Fix race condition before querying
      const { data, error } = await supabase
        .from('bridgethings_products')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        console.error('[catalog] load failed:', error);
        addToast(error.message || 'Failed to load products', 'error');
      } else {
        setProducts(data || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.features||[]).some(f => f.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Product Catalog</div>
          <div className="page-subtitle">
            Browse Bridge Things products
            {discountPct > 0 && (
              <>
                {' '}— <span style={{color:'var(--success)', fontWeight:600}}>
                  You get {discountPct}% off on all products
                </span>
              </>
            )}
          </div>
        </div>
        {items.length > 0 && (
          <Link to="/partner/po" className="btn btn-primary">
            Review PO ({items.length})
          </Link>
        )}
      </div>

      <div style={{marginBottom:'1.5rem'}}>
        <div className="global-search" style={{border:'1px solid var(--border)', borderRadius:'8px', padding:'0.6rem 1rem', background:'var(--card)'}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or feature..." style={{width:'100%', fontSize:'0.9rem'}} />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading products...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No products found for "${search}"` : 'No products available yet.'}</p></div></div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:'1.25rem'}}>
          {filtered.map(p => (
            <div key={p.id} className="card" style={{transition:'transform 0.2s, box-shadow 0.2s', cursor:'pointer'}}
              onMouseEnter={e => { e.currentTarget.style.transform='translateY(-3px)'; e.currentTarget.style.boxShadow='var(--shadow-lg)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow=''; }}>
              {p.image_url && (
                <img src={p.image_url} alt={p.name}
                  style={{width:'100%', height:'200px', objectFit:'contain', background:'#f8fafc', borderRadius:'10px 10px 0 0', borderBottom:'1px solid var(--border)', padding:'0.5rem'}}
                  onError={e => e.target.style.display = 'none'} />
              )}
              <div style={{padding:'1.25rem'}}>
                <div style={{fontWeight:700, fontSize:'0.95rem', marginBottom:'0.25rem'}}>{p.name}</div>
                <div style={{fontSize:'0.8rem', color:'var(--text-muted)', marginBottom:'0.75rem', lineHeight:'1.45'}}>{(p.description || '').slice(0,100)}{p.description && p.description.length > 100 ? '...' : ''}</div>
                <div style={{display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'1rem'}}>
                  {(p.features||[]).slice(0,4).map(f => (
                    <span key={f} className="badge badge-info" style={{fontSize:'0.68rem'}}>{f}</span>
                  ))}
                </div>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'0.5rem'}}>
                  <div>
                    <div style={{fontWeight:700, fontSize:'1.1rem', color:'var(--primary)'}}>
                      {fmtINR(applyDiscount(p.base_price, discountPct))}
                    </div>
                    {discountPct > 0 && (
                      <div style={{fontSize:'0.75rem', color:'var(--text-muted)', marginTop:'2px'}}>
                        <span style={{textDecoration:'line-through'}}>{fmtINR(p.base_price)}</span>
                        {' '}<span className="badge badge-success" style={{fontSize:'0.65rem'}}>{discountPct}% off</span>
                      </div>
                    )}
                  </div>
                  <div style={{display:'flex', gap:'0.4rem'}}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDetail(p)}>View</button>
                    <button className="btn btn-primary btn-sm" onClick={() => openQtyPrompt(p)}>
                      {has(p.id) ? '+ Add Again' : '+ Add to PO'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{detail.name}</h3>
              <button className="modal-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              {(() => {
                // Use the new image_urls array; fall back to image_url for
                // products created before the multi-image migration.
                const gallery = (detail.image_urls && detail.image_urls.length)
                  ? detail.image_urls
                  : (detail.image_url ? [detail.image_url] : []);
                if (!gallery.length) return null;
                const active = Math.min(activeImage, gallery.length - 1);
                return (
                  <div style={{marginBottom:'1.25rem'}}>
                    <img
                      src={gallery[active]}
                      alt={detail.name}
                      style={{width:'100%', maxHeight:'340px', objectFit:'contain', background:'#f8fafc', borderRadius:'8px', padding:'0.5rem'}}
                      onError={e => e.target.style.display = 'none'}
                    />
                    {gallery.length > 1 && (
                      <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', marginTop:'0.6rem'}}>
                        {gallery.map((url, i) => (
                          <button
                            key={url + i}
                            type="button"
                            onClick={() => setActiveImage(i)}
                            style={{
                              padding:0,
                              border: i === active ? '2px solid var(--primary)' : '1px solid var(--border)',
                              borderRadius:'6px',
                              background:'#f8fafc',
                              cursor:'pointer',
                              overflow:'hidden',
                            }}
                            aria-label={`View image ${i + 1}`}
                          >
                            <img
                              src={url}
                              alt={`${detail.name} ${i + 1}`}
                              style={{width:'68px', height:'68px', objectFit:'contain', display:'block'}}
                              onError={e => e.target.style.display='none'}
                            />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <div style={{color:'var(--text-muted)', marginBottom:'1.25rem', lineHeight:'1.6', whiteSpace:'pre-wrap'}}>{detail.description}</div>
              <h4 style={{fontWeight:600, marginBottom:'0.75rem'}}>Key Features</h4>
              <div style={{display:'flex', flexWrap:'wrap', gap:'0.5rem', marginBottom:'1.25rem'}}>
                {(detail.features||[]).map(f => <span key={f} className="badge badge-info">{f}</span>)}
              </div>
              <div className="divider"/>
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'0.75rem', flexWrap:'wrap'}}>
                <div>
                  <div style={{fontSize:'1.5rem', fontWeight:700, color:'var(--primary)'}}>
                    {fmtINR(applyDiscount(detail.base_price, discountPct))}
                  </div>
                  {discountPct > 0 && (
                    <div style={{fontSize:'0.8rem', color:'var(--text-muted)', marginTop:'2px'}}>
                      <span style={{textDecoration:'line-through'}}>{fmtINR(detail.base_price)}</span>
                      {' '}<span className="badge badge-success" style={{fontSize:'0.7rem'}}>{discountPct}% off</span>
                    </div>
                  )}
                </div>
                <div style={{display:'flex', gap:'0.5rem'}}>
                  <button className="btn btn-primary" onClick={() => openQtyPrompt(detail)}>
                    {has(detail.id) ? '+ Add Again to PO' : '+ Add to PO'}
                  </button>
                  <Link to="/partner/po" className="btn btn-secondary" onClick={() => setDetail(null)}>Review PO</Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quantity Prompt Modal */}
      {qtyPromptProduct && (
        <div className="modal-overlay" onClick={() => setQtyPromptProduct(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth:'380px'}}>
            <div className="modal-header">
              <h3>Add to Purchase Order</h3>
              <button className="modal-close" onClick={() => setQtyPromptProduct(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{marginBottom:'1rem'}}>
                <div className="font-semibold">{qtyPromptProduct.name}</div>
                <div className="text-sm text-muted">
                  {fmtINR(applyDiscount(qtyPromptProduct.base_price, discountPct))} per unit
                  {discountPct > 0 && (
                    <> &middot; <span style={{textDecoration:'line-through'}}>{fmtINR(qtyPromptProduct.base_price)}</span> ({discountPct}% off)</>
                  )}
                </div>
              </div>
              <div className="form-group" style={{marginBottom:'0.5rem'}}>
                <label className="form-label">Quantity</label>
                <div style={{display:'flex', alignItems:'center', gap:'0.5rem'}}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setQtyValue(q => Math.max(1, Math.floor(Number(q) || 1) - 1))}
                    style={{minWidth:'2.25rem'}}
                  >−</button>
                  <input
                    type="number"
                    min="1"
                    className="form-input"
                    value={qtyValue}
                    onChange={e => setQtyValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') confirmAdd(); }}
                    style={{textAlign:'center', maxWidth:'100px'}}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setQtyValue(q => Math.floor(Number(q) || 1) + 1)}
                    style={{minWidth:'2.25rem'}}
                  >+</button>
                </div>
              </div>
              <div className="text-sm" style={{color:'var(--text-muted)', marginTop:'0.75rem'}}>
                Subtotal: <strong style={{color:'var(--primary)'}}>{fmtINR(applyDiscount(qtyPromptProduct.base_price, discountPct) * Math.max(1, Math.floor(Number(qtyValue) || 1)))}</strong>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setQtyPromptProduct(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmAdd}>Add to PO</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
