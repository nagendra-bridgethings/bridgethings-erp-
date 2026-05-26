// Product Management — CRUD against bridgethings_products
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import ImageLightbox from '../../components/ImageLightbox';

const EMPTY = { name: '', description: '', features: '', base_price: '', subscription_price: '', image_urls: [] };
const PRODUCT_IMAGES_BUCKET = 'bridgethings-product-images';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');

// Convert the textarea-friendly comma string ⇄ DB array
const featuresToArray = s => (s || '').split(',').map(f => f.trim()).filter(Boolean);
const featuresToString = arr => (arr || []).join(', ');

// Generate a unique storage path for an uploaded image.
const buildImagePath = (file) => {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const slug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return `products/${slug}`;
};

export default function ProductsPage() {
  const { addToast } = useToast();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [showDetail, setShowDetail] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  // URL passed to <ImageLightbox> when admin clicks an image to verify it.
  const [lightboxSrc, setLightboxSrc] = useState(null);

  // Upload one or more files in sequence, appending each public URL to
  // the form's image_urls array. The first image (index 0) is treated
  // as the primary — used for cards and the card thumbnail.
  const handleImageUpload = async (fileList) => {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        addToast(`Skipped "${file.name}" — not an image`, 'error');
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        addToast(`Skipped "${file.name}" — larger than 5 MB`, 'error');
        continue;
      }
      setUploading(true);
      try {
        const path = buildImagePath(file);
        const { error: uploadErr } = await supabase.storage
          .from(PRODUCT_IMAGES_BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (uploadErr) throw uploadErr;

        const { data } = supabase.storage
          .from(PRODUCT_IMAGES_BUCKET)
          .getPublicUrl(path);
        setForm(prev => ({ ...prev, image_urls: [...(prev.image_urls || []), data.publicUrl] }));
      } catch (err) {
        console.error('[products] image upload failed:', err);
        addToast(err.message || `Failed to upload "${file.name}"`, 'error');
      } finally {
        setUploading(false);
      }
    }
    addToast('Images uploaded', 'success');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Remove image at index from the array. If it was the primary, the
  // next image automatically becomes primary.
  const removeImageAt = (idx) => {
    setForm(prev => ({
      ...prev,
      image_urls: (prev.image_urls || []).filter((_, i) => i !== idx),
    }));
  };

  // Promote image at idx to position 0 (primary). Used by the "Set as
  // primary" thumbnail action.
  const makePrimaryImage = (idx) => {
    setForm(prev => {
      const arr = [...(prev.image_urls || [])];
      if (idx <= 0 || idx >= arr.length) return prev;
      const [picked] = arr.splice(idx, 1);
      arr.unshift(picked);
      return { ...prev, image_urls: arr };
    });
  };

  const loadProducts = async () => {
    setLoading(true);
    await supabase.auth.getSession(); // Fix race condition before querying
    const { data, error } = await supabase
      .from('bridgethings_products')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[products] load failed:', error);
      addToast(error.message || 'Failed to load products', 'error');
    } else {
      setProducts(data || []);
    }
    setLoading(false);
  };

  useEffect(() => { loadProducts(); }, []);

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const openNew = () => { setForm(EMPTY); setEditing(null); setShowModal(true); };
  const openEdit = p => {
    // Hydrate the form's image_urls from the new column. Fall back to
    // the legacy image_url for products created before the multi-image
    // migration ran, so admins can still edit and add more.
    const existing = (p.image_urls && p.image_urls.length)
      ? p.image_urls
      : (p.image_url ? [p.image_url] : []);
    setForm({
      name: p.name || '',
      description: p.description || '',
      features: featuresToString(p.features),
      base_price: p.base_price ?? '',
      subscription_price: p.subscription_price ?? '',
      image_urls: existing,
    });
    setEditing(p.id);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { addToast('Product name is required', 'error'); return; }
    setSaving(true);
    const cleanImages = (form.image_urls || []).map(u => u.trim()).filter(Boolean);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      features: featuresToArray(form.features),
      base_price: parseFloat(form.base_price) || 0,
      subscription_price: parseFloat(form.subscription_price) || 0,
      image_urls: cleanImages,
      // Mirror the primary image back to the legacy column so anywhere
      // that still reads image_url (card thumbnails, invoices, etc.)
      // keeps showing the picture without code changes.
      image_url: cleanImages[0] || null,
    };

    try {
      if (editing) {
        const { data, error } = await supabase
          .from('bridgethings_products')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', editing)
          .select()
          .single();
        if (error) throw error;
        setProducts(prev => prev.map(p => p.id === editing ? data : p));
        addToast('Product updated successfully', 'success');
      } else {
        const { data, error } = await supabase
          .from('bridgethings_products')
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        setProducts(prev => [data, ...prev]);
        addToast('Product added successfully', 'success');
      }
      setShowModal(false);
    } catch (err) {
      console.error('[products] save failed:', err);
      addToast(err.message || 'Failed to save product', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      const { error } = await supabase
        .from('bridgethings_products')
        .delete()
        .eq('id', id);
      if (error) throw error;
      setProducts(prev => prev.filter(p => p.id !== id));
      addToast('Product deleted', 'info');
    } catch (err) {
      console.error('[products] delete failed:', err);
      addToast(err.message || 'Failed to delete product', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Product Catalog</div>
          <div className="page-subtitle">Manage all Bridge Things products</div>
        </div>
        <button className="btn btn-primary" onClick={openNew}>Add Product</button>
      </div>

      {/* Search */}
      <div className="card" style={{marginBottom:'1.5rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input className="form-input" placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading products...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No products match "${search}"` : 'No products yet. Click "Add Product" to create one.'}</p></div></div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:'1.25rem'}}>
          {filtered.map(p => (
            <div key={p.id} className="card" style={{overflow:'visible'}}>
              {p.image_url && (
                <img src={p.image_url} alt={p.name}
                  style={{width:'100%', height:'180px', objectFit:'contain', background:'#f8fafc', borderRadius:'10px 10px 0 0', borderBottom:'1px solid var(--border)', padding:'0.5rem'}}
                  onError={e => e.target.style.display = 'none'} />
              )}
              <div style={{padding:'1.25rem'}}>
                <div style={{fontWeight:700, fontSize:'0.95rem', marginBottom:'0.25rem', color:'var(--text)'}}>{p.name}</div>
                <div style={{fontSize:'0.8rem', color:'var(--text-muted)', marginBottom:'0.75rem', lineHeight:'1.4'}}>{(p.description || '').slice(0,90)}{p.description && p.description.length > 90 ? '...' : ''}</div>
                <div style={{display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem'}}>
                  {(p.features||[]).slice(0,3).map(f => (
                    <span key={f} className="badge badge-info" style={{fontSize:'0.68rem'}}>{f}</span>
                  ))}
                </div>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
                  <div style={{fontWeight:700, fontSize:'1rem', color:'var(--primary)'}}>{fmtINR(p.base_price)}</div>
                  <div style={{display:'flex', gap:'0.5rem'}}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setShowDetail(p)}>View</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                    <button className="btn btn-danger btn-sm" disabled={deletingId === p.id} onClick={() => handleDelete(p.id, p.name)}>
                      {deletingId === p.id ? '...' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => !saving && setShowModal(false)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Edit Product' : 'Add New Product'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">Product Name *</label>
                  <input className="form-input" value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. WFM-100 Electromagnetic Flow Meter" />
                </div>
                <div className="form-group">
                  <label className="form-label">Base Price (₹)</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={form.base_price} onChange={e => setForm({...form, base_price: e.target.value})} placeholder="45000" />
                </div>
                <div className="form-group">
                  <label className="form-label">Subscription Price (₹/year)</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={form.subscription_price} onChange={e => setForm({...form, subscription_price: e.target.value})} placeholder="6000" />
                </div>
                <div className="form-group" style={{gridColumn:'1 / -1'}}>
                  <label className="form-label">Description</label>
                  <textarea className="form-textarea" value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Detailed product description..." rows={3}/>
                </div>
                <div className="form-group" style={{gridColumn:'1 / -1'}}>
                  <label className="form-label">Features (comma-separated)</label>
                  <input className="form-input" value={form.features} onChange={e => setForm({...form, features: e.target.value})} placeholder="DN50 to DN2000, HART Output, IP68 Rating" />
                </div>
                <div className="form-group" style={{gridColumn:'1 / -1'}}>
                  <label className="form-label">Product Images</label>
                  <div className="text-xs text-muted" style={{marginBottom:'0.5rem'}}>
                    Upload one or more shots — the first image is the primary one shown on cards. Click "Set as primary" on any thumbnail to promote it.
                  </div>
                  <div style={{display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.75rem'}}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={e => handleImageUpload(e.target.files)}
                      disabled={uploading || saving}
                      style={{flex:'1', fontSize:'0.85rem'}}
                    />
                  </div>
                  {uploading && <div className="text-xs text-muted" style={{marginBottom:'0.5rem'}}>Uploading...</div>}
                  {(form.image_urls || []).length === 0 ? (
                    <div className="text-xs text-muted" style={{marginTop:'0.25rem'}}>No images yet.</div>
                  ) : (
                    <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))', gap:'0.75rem', marginTop:'0.25rem'}}>
                      {form.image_urls.map((url, idx) => (
                        <div
                          key={url + idx}
                          style={{
                            border: idx === 0 ? '2px solid var(--primary)' : '1px solid var(--border)',
                            borderRadius:'8px',
                            padding:'0.4rem',
                            background:'#f8fafc',
                            display:'flex',
                            flexDirection:'column',
                            gap:'0.4rem',
                          }}
                        >
                          <img
                            src={url}
                            alt={`product ${idx + 1}`}
                            style={{width:'100%', height:'90px', objectFit:'contain', background:'#fff', borderRadius:'4px'}}
                            onError={e => e.target.style.display='none'}
                          />
                          {idx === 0 && (
                            <span className="badge badge-info" style={{fontSize:'0.65rem', alignSelf:'flex-start'}}>Primary</span>
                          )}
                          <div style={{display:'flex', gap:'0.25rem'}}>
                            {idx !== 0 && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{fontSize:'0.7rem', padding:'0.25rem 0.4rem'}}
                                onClick={() => makePrimaryImage(idx)}
                                disabled={uploading || saving}
                              >
                                Set as primary
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{fontSize:'0.7rem', padding:'0.25rem 0.4rem', color:'var(--danger)', marginLeft:'auto'}}
                              onClick={() => removeImageAt(idx)}
                              disabled={uploading || saving}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" disabled={saving} onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
                {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Add Product')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {showDetail && (
        <div className="modal-overlay" onClick={() => setShowDetail(null)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{showDetail.name}</h3>
              <button className="modal-close" onClick={() => setShowDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              {(() => {
                const imgs = (showDetail.image_urls && showDetail.image_urls.length)
                  ? showDetail.image_urls
                  : (showDetail.image_url ? [showDetail.image_url] : []);
                if (!imgs.length) return null;
                return (
                  <div style={{marginBottom:'1rem'}}>
                    <img
                      src={imgs[0]}
                      alt={showDetail.name}
                      onClick={() => setLightboxSrc(imgs[0])}
                      title="Click to zoom"
                      style={{width:'100%', maxHeight:'320px', objectFit:'contain', background:'#f8fafc', borderRadius:'8px', padding:'0.5rem', cursor:'zoom-in'}}
                      onError={e => e.target.style.display='none'}
                    />
                    {imgs.length > 1 && (
                      <div style={{display:'flex', gap:'0.4rem', flexWrap:'wrap', marginTop:'0.5rem'}}>
                        {imgs.slice(1).map((u, i) => (
                          <img
                            key={u + i}
                            src={u}
                            alt={`${showDetail.name} ${i + 2}`}
                            onClick={() => setLightboxSrc(u)}
                            title="Click to zoom"
                            style={{width:'72px', height:'72px', objectFit:'contain', background:'#f8fafc', border:'1px solid var(--border)', borderRadius:'6px', cursor:'zoom-in'}}
                            onError={e => e.target.style.display='none'}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <p style={{color:'var(--text-muted)', fontSize:'0.9rem', marginBottom:'1rem', whiteSpace:'pre-wrap'}}>{showDetail.description}</p>
              <div style={{fontWeight:600, marginBottom:'0.5rem'}}>Features:</div>
              <div style={{display:'flex', flexWrap:'wrap', gap:'0.5rem'}}>
                {(showDetail.features||[]).map(f => <span key={f} className="badge badge-info">{f}</span>)}
              </div>
              <div className="divider"/>
              <div style={{fontSize:'1.25rem', fontWeight:700, color:'var(--primary)'}}>{fmtINR(showDetail.base_price)}</div>
            </div>
          </div>
        </div>
      )}

      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          alt={showDetail?.name}
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </>
  );
}
