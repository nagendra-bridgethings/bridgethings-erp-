// Product Management — CRUD against bridgethings_products
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';

const EMPTY = { name: '', description: '', features: '', base_price: '', subscription_price: '', image_url: '' };
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

  const handleImageUpload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      addToast('Please select an image file', 'error');
      return;
    }
    // Reasonable cap so we don't bloat storage with huge files.
    if (file.size > 5 * 1024 * 1024) {
      addToast('Image must be smaller than 5 MB', 'error');
      return;
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
      setForm(prev => ({ ...prev, image_url: data.publicUrl }));
      addToast('Image uploaded', 'success');
    } catch (err) {
      console.error('[products] image upload failed:', err);
      addToast(err.message || 'Failed to upload image', 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
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
    setForm({
      name: p.name || '',
      description: p.description || '',
      features: featuresToString(p.features),
      base_price: p.base_price ?? '',
      subscription_price: p.subscription_price ?? '',
      image_url: p.image_url || '',
    });
    setEditing(p.id);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { addToast('Product name is required', 'error'); return; }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      features: featuresToArray(form.features),
      base_price: parseFloat(form.base_price) || 0,
      subscription_price: parseFloat(form.subscription_price) || 0,
      image_url: form.image_url.trim() || null,
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
                  <label className="form-label">Product Image</label>
                  <div style={{display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.5rem'}}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={e => handleImageUpload(e.target.files?.[0])}
                      disabled={uploading || saving}
                      style={{flex:'1', fontSize:'0.85rem'}}
                    />
                    {form.image_url && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{color:'var(--danger)'}}
                        onClick={() => setForm(prev => ({...prev, image_url:''}))}
                        disabled={uploading || saving}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    className="form-input"
                    value={form.image_url}
                    onChange={e => setForm({...form, image_url: e.target.value})}
                    placeholder="…or paste an external image URL"
                    disabled={uploading}
                    style={{fontSize:'0.85rem'}}
                  />
                  {uploading && <div className="text-xs text-muted" style={{marginTop:'0.5rem'}}>Uploading image...</div>}
                  {form.image_url && !uploading && (
                    <img
                      src={form.image_url}
                      alt="preview"
                      className="img-preview"
                      style={{marginTop:'0.5rem', maxHeight:'160px', borderRadius:'6px'}}
                      onError={e => e.target.style.display='none'}
                    />
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
              {showDetail.image_url && <img src={showDetail.image_url} alt={showDetail.name} style={{width:'100%', maxHeight:'320px', objectFit:'contain', background:'#f8fafc', borderRadius:'8px', marginBottom:'1rem', padding:'0.5rem'}} onError={e => e.target.style.display='none'} />}
              <p style={{color:'var(--text-muted)', fontSize:'0.9rem', marginBottom:'1rem'}}>{showDetail.description}</p>
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
    </>
  );
}
