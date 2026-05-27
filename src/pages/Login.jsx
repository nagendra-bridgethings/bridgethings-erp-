// Login Page — Step 1: Role Selection → Step 2: Login Form
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const ROLES_REDIRECT = { admin: '/admin', employee: '/admin', accountant: '/finance', partner: '/partner' };

const ROLE_OPTIONS = [
  { key: 'admin',      label: 'Admin',           color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'employee',   label: 'Operations',      color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'accountant', label: 'Accountant',      color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'partner',    label: 'Channel Partner', color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
];

// Persist the last-used role so repeat visitors land straight on their
// login form instead of the role-picker every time.
const LAST_ROLE_KEY = 'bridgethings:lastRole';

export default function Login() {
  const { login, user, loading } = useAuth();
  const navigate = useNavigate();

  // Initialise from localStorage — if the user picked a role before, jump
  // straight to step 2 with that role pre-selected.
  const initialRole = (() => {
    try {
      const stored = localStorage.getItem(LAST_ROLE_KEY);
      return stored ? ROLE_OPTIONS.find(r => r.key === stored) || null : null;
    } catch { return null; }
  })();

  const [step, setStep]         = useState(initialRole ? 2 : 1); // 1 = role select, 2 = login form
  const [selectedRole, setSelectedRole] = useState(initialRole);
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      navigate(ROLES_REDIRECT[user.role] || '/partner', { replace: true });
    }
  }, [user, loading, navigate]);

  const handleRoleSelect = (role) => {
    setSelectedRole(role);
    setError('');
    setStep(2);
    try { localStorage.setItem(LAST_ROLE_KEY, role.key); } catch { /* ignore quota / privacy-mode errors */ }
  };

  const handleBack = () => {
    setStep(1);
    setEmail('');
    setPassword('');
    setError('');
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email.trim(), password, selectedRole?.key);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div style={{ minHeight:'100vh', background:'#f8fafc', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>
      <div style={{ color:'#64748b', fontSize:'0.875rem' }}>Loading...</div>
    </div>
  );

  const roleInfo = ROLE_OPTIONS.find(r => r.key === selectedRole?.key);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'Inter, -apple-system, sans-serif',
      padding: '1.5rem',
    }}>
      <div style={{ width: '100%', maxWidth: step === 1 ? '560px' : '460px', transition: 'max-width 0.3s ease' }}>

        {/* Logo — always visible */}
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <img src={`${import.meta.env.BASE_URL}BridgeThings.png`} alt="Bridge Things" style={{ height: '60px', objectFit: 'contain' }} />
          <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '0.4rem', letterSpacing: '0.03em' }}>
            B2B Industrial IoT ERP Portal
          </div>
        </div>

        {/* STEP 1 — Role Selection */}
        {step === 1 && (
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.05)',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '2rem 2rem 1rem', textAlign: 'center' }}>
              <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#0f172a' }}>Welcome to BridgeThings ERP</div>
              <div style={{ color: '#64748b', fontSize: '0.82rem', marginTop: '0.35rem' }}>Choose Your Login Type</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', padding: '1rem 1.75rem 2rem' }}>
              {ROLE_OPTIONS.map(role => (
                <button
                  key={role.key}
                  onClick={() => handleRoleSelect(role)}
                  style={{
                    background: '#fff',
                    border: '1.5px solid #e2e8f0',
                    borderRadius: '10px',
                    padding: '1.1rem 1.25rem',
                    cursor: 'pointer',
                    textAlign: 'center',
                    transition: 'all 0.15s',
                    fontFamily: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#2563eb';
                    e.currentTarget.style.background = '#f0f5ff';
                    e.currentTarget.style.transform = 'translateX(3px)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = '#e2e8f0';
                    e.currentTarget.style.background = '#fff';
                    e.currentTarget.style.transform = '';
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: '1.35rem', color: '#0f172a' }}>{role.label}</div>
                </button>
              ))}
            </div>

            <div style={{ borderTop: '1px solid #f1f5f9', padding: '0.85rem', textAlign: 'center', color: '#cbd5e1', fontSize: '0.72rem' }}>
              © 2026 Bridge Things. All rights reserved.
            </div>
          </div>
        )}

        {/* STEP 2 — Login Form */}
        {step === 2 && roleInfo && (
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.05)',
            overflow: 'hidden',
          }}>
            {/* Role indicator */}
            <div style={{
              background: roleInfo.bg,
              borderBottom: `1px solid ${roleInfo.border}`,
              padding: '1rem 2rem',
              display: 'flex', alignItems: 'center', gap: '0.75rem',
            }}>
              <span style={{ fontSize: '1.4rem' }}>{roleInfo.icon}</span>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: '#0f172a' }}>{roleInfo.label}</div>
              <button
                onClick={handleBack}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                  color: '#94a3b8', fontSize: '0.78rem', fontFamily: 'inherit', padding: '0.25rem 0.5rem',
                  borderRadius: '6px',
                }}
                onMouseEnter={e => e.target.style.background = '#f1f5f9'}
                onMouseLeave={e => e.target.style.background = 'none'}
              >
                ← Back
              </button>
            </div>

            <div style={{ padding: '2rem 2rem 1.5rem' }}>
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Sign in to your account</div>
              </div>

              {error && (
                <div style={{
                  background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626',
                  padding: '0.75rem 1rem', borderRadius: '8px', fontSize: '0.85rem',
                  marginBottom: '1.25rem',
                }}>
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#374151', marginBottom: '0.4rem' }}>
                    Email Address
                  </label>
                  <input
                    type="email" value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required autoComplete="email"
                    style={{
                      width: '100%', padding: '0.65rem 0.9rem',
                      border: '1.5px solid #e5e7eb', borderRadius: '8px',
                      fontSize: '0.9rem', color: '#111827', background: '#f9fafb',
                      fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
                    }}
                    onFocus={e => e.target.style.borderColor = roleInfo.color}
                    onBlur={e  => e.target.style.borderColor = '#e5e7eb'}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#374151', marginBottom: '0.4rem' }}>
                    Password
                  </label>
                  <input
                    type="password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required autoComplete="current-password"
                    style={{
                      width: '100%', padding: '0.65rem 0.9rem',
                      border: '1.5px solid #e5e7eb', borderRadius: '8px',
                      fontSize: '0.9rem', color: '#111827', background: '#f9fafb',
                      fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
                    }}
                    onFocus={e => e.target.style.borderColor = roleInfo.color}
                    onBlur={e  => e.target.style.borderColor = '#e5e7eb'}
                  />
                </div>

                <button
                  type="submit" disabled={submitting}
                  style={{
                    marginTop: '0.25rem', width: '100%', padding: '0.75rem',
                    background: submitting ? '#93c5fd' : roleInfo.color,
                    color: '#fff', border: 'none', borderRadius: '8px',
                    fontSize: '0.95rem', fontWeight: 600,
                    fontFamily: 'inherit', cursor: submitting ? 'not-allowed' : 'pointer',
                    transition: 'opacity 0.2s',
                  }}
                >
                  {submitting ? 'Signing in...' : `Sign In as ${roleInfo.label}`}
                </button>
              </form>

              <div style={{ marginTop: '1.25rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.75rem' }}>
                Trouble logging in? Contact your Bridge Things administrator.
              </div>
            </div>

            <div style={{ borderTop: '1px solid #f1f5f9', padding: '0.85rem', textAlign: 'center', color: '#cbd5e1', fontSize: '0.72rem' }}>
              © 2026 Bridge Things. All rights reserved.
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
