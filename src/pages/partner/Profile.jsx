// Partner — Profile Page
// Fields are read-only by default. Click "Edit" to make them editable,
// then "Save Changes" persists or "Cancel" reverts to the last saved values.
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { supabase } from '../../lib/supabase';

const buildForm = (user) => ({
  name:         user?.name         || '',
  company_name: user?.company_name || '',
  phone:        user?.phone        || '',
  gst_number:   user?.gst_number   || '',
  address:      user?.address      || '',
  city:         user?.city         || '',
  state:        user?.state        || '',
  pincode:      user?.pincode      || '',
});

export default function Profile() {
  const { user, refreshProfile } = useAuth();
  const { addToast } = useToast();
  const [saving, setSaving]   = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState(() => buildForm(user));

  // Re-sync when the auth profile hydrates AFTER mount (stub-role cache
  // hydration fills name/address in the background). Without this, a
  // reload on this page shows blank fields — and saving that blank form
  // would null out the partner's entire profile. Gated on !editing so
  // in-progress edits are never clobbered. Uses the render-time
  // "adjust state when props change" pattern (React docs) instead of an
  // effect; keyed on the field values since `user` is a fresh object
  // every auth render.
  const userKey = JSON.stringify(buildForm(user));
  const [syncedUserKey, setSyncedUserKey] = useState(userKey);
  if (!editing && userKey !== syncedUserKey) {
    setSyncedUserKey(userKey);
    setForm(buildForm(user));
  }

  // Until the full profile row is loaded (stub hydration has no row id),
  // editing must stay disabled — a Save from a stub-built form would
  // overwrite real data with empty strings.
  const profileHydrated = Boolean(user?.id);

  const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!user?.supabaseId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('bridgethings_channelpartners')
        .update({
          name:         form.name.trim()         || null,
          company_name: form.company_name.trim() || null,
          phone:        form.phone.trim()        || null,
          gst_number:   form.gst_number.trim()   || null,
          address:      form.address.trim()      || null,
          city:         form.city.trim()         || null,
          state:        form.state.trim()        || null,
          pincode:      form.pincode.trim()      || null,
        })
        .eq('id', user.supabaseId);

      if (error) throw error;

      await refreshProfile();
      setEditing(false);
      addToast('Profile updated successfully', 'success');
    } catch (err) {
      console.error('[profile] save failed:', err);
      addToast(err.message || 'Failed to update profile', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    // Snap form back to the auth profile's current values so any unsaved
    // edits are discarded.
    setForm(buildForm(user));
    setEditing(false);
  };

  const displayName = form.name || form.company_name || user?.email || 'Partner';
  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  const readOnly = !editing;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">My Profile</div>
          <div className="page-subtitle">Manage your account and business details</div>
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:'1.5rem'}}>
        {/* Avatar Card */}
        <div className="card" style={{textAlign:'center', padding:'2rem'}}>
          <div style={{width:'80px', height:'80px', background:'var(--primary)', borderRadius:'50%', margin:'0 auto 1rem', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.75rem', fontWeight:700, color:'white'}}>
            {initials}
          </div>
          <div style={{fontWeight:700, fontSize:'1.1rem'}}>{displayName}</div>
          <div className="text-sm text-muted" style={{marginTop:'0.25rem'}}>{user?.email}</div>
          <span className="badge badge-info" style={{marginTop:'0.75rem'}}>Channel Partner</span>
        </div>

        {/* Edit Form */}
        <div className="card">
          <div className="card-header">
            <h2>Account Details</h2>
            {!editing && (
              <button
                className="btn btn-secondary btn-sm"
                disabled={!profileHydrated}
                title={profileHydrated ? undefined : 'Loading your profile...'}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            )}
          </div>
          <div className="card-body">
            <div className="form-grid form-grid-2">
              <div className="form-group">
                <label className="form-label">Full Name</label>
                <input className="form-input" value={form.name} disabled={readOnly} onChange={e => update('name', e.target.value)} placeholder="e.g. Nagendra" />
              </div>
              <div className="form-group">
                <label className="form-label">Company Name</label>
                <input className="form-input" value={form.company_name} disabled={readOnly} onChange={e => update('company_name', e.target.value)} placeholder="e.g. Bridgethings IoT" />
              </div>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input className="form-input" type="email" value={user?.email || ''} disabled />
              </div>
              <div className="form-group">
                <label className="form-label">Mobile Number</label>
                <input className="form-input" value={form.phone} disabled={readOnly} onChange={e => update('phone', e.target.value)} placeholder="10-digit mobile number" />
              </div>
              <div className="form-group">
                <label className="form-label">GST Number</label>
                <input className="form-input" value={form.gst_number} disabled={readOnly} onChange={e => update('gst_number', e.target.value)} placeholder="e.g. 29ABCDE1234F1Z5" />
              </div>
              <div className="form-group" style={{gridColumn:'1 / -1'}}>
                <label className="form-label">Business Address</label>
                <textarea className="form-textarea" value={form.address} disabled={readOnly} onChange={e => update('address', e.target.value)} rows={3} placeholder="Street, locality, landmark..." />
              </div>
              <div className="form-group">
                <label className="form-label">City</label>
                <input className="form-input" value={form.city} disabled={readOnly} onChange={e => update('city', e.target.value)} placeholder="e.g. Hyderabad" />
              </div>
              <div className="form-group">
                <label className="form-label">State</label>
                <input className="form-input" value={form.state} disabled={readOnly} onChange={e => update('state', e.target.value)} placeholder="e.g. Telangana" />
              </div>
              <div className="form-group">
                <label className="form-label">Pincode</label>
                <input className="form-input" value={form.pincode} disabled={readOnly} onChange={e => update('pincode', e.target.value)} placeholder="e.g. 500084" />
              </div>
            </div>
            {editing && (
              <div style={{marginTop:'1.25rem', display:'flex', justifyContent:'flex-end', gap:'0.5rem'}}>
                <button className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
