// Admin — Channel Partners + their flat product discount.
// Lists every partner with Name, Email, Company, Discount %. The discount
// cell is inline-editable: click Edit → type a new %, Save persists it.
// The partner's catalog and PO submissions automatically use the new %
// after this saves.
import { useState } from 'react';
import { usePartners, updatePartnerDiscount } from '../../lib/partners';
import { useToast } from '../../lib/toast';

export default function Partners() {
  const { addToast } = useToast();
  const { partners, loading, reload } = usePartners();
  const [search, setSearch] = useState('');
  // Inline edit state — only one partner editable at a time.
  const [editingId, setEditingId] = useState(null);
  const [draftPct, setDraftPct]   = useState('');
  const [savingId, setSavingId]   = useState(null);

  const filtered = (() => {
    const term = search.trim().toLowerCase();
    if (!term) return partners;
    return partners.filter(p => {
      const hay = [p.name, p.email, p.company_name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  })();

  const startEdit = (p) => {
    setEditingId(p.id);
    setDraftPct(String(p.discount_percent ?? 0));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraftPct('');
  };
  const saveEdit = async (p) => {
    setSavingId(p.id);
    try {
      const saved = await updatePartnerDiscount(p.id, draftPct);
      await reload();
      cancelEdit();
      addToast(`${p.name || 'Partner'} discount set to ${saved}%`, 'success');
    } catch (err) {
      console.error('[partners] update failed:', err);
      addToast(err.message || 'Failed to update discount', 'error');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Channel Partners</div>
          <div className="page-subtitle">View partner accounts and set their product discount.</div>
        </div>
      </div>

      <div className="card" style={{marginBottom:'1rem'}}>
        <div className="card-body" style={{padding:'0.75rem 1.25rem'}}>
          <input
            className="form-input"
            placeholder="Search by name, email or company..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="empty-state"><p>Loading partners...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty-state"><p>{search ? `No partners match "${search}".` : 'No channel partners yet.'}</p></div></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th style={{textAlign:'right'}}>Discount %</th>
                  <th style={{textAlign:'right'}}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const isEditing = editingId === p.id;
                  const isSaving  = savingId  === p.id;
                  return (
                    <tr key={p.id}>
                      <td className="font-semibold text-sm">{p.name || '—'}</td>
                      <td className="text-sm">{p.email || '—'}</td>
                      <td className="text-sm">{p.company_name || '—'}</td>
                      <td style={{textAlign:'right'}}>
                        {isEditing ? (
                          <input
                            type="number"
                            min="0" max="100" step="0.5"
                            className="form-input"
                            style={{width:'90px', display:'inline-block', textAlign:'right'}}
                            value={draftPct}
                            disabled={isSaving}
                            onChange={e => setDraftPct(e.target.value)}
                            autoFocus
                          />
                        ) : (
                          <span className="font-semibold text-sm">
                            {Number(p.discount_percent || 0).toFixed(2).replace(/\.00$/, '')}%
                          </span>
                        )}
                      </td>
                      <td style={{textAlign:'right'}}>
                        {isEditing ? (
                          <div style={{display:'inline-flex', gap:'0.4rem'}}>
                            <button className="btn btn-secondary btn-sm" disabled={isSaving} onClick={cancelEdit}>Cancel</button>
                            <button className="btn btn-primary btn-sm" disabled={isSaving} onClick={() => saveEdit(p)}>
                              {isSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(p)}>Edit</button>
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
    </>
  );
}
