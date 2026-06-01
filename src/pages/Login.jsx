// Login Page — Step 1: Role Selection → Step 2: Login Form
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { portalPrefixFor } from '../lib/portalPaths';

const ROLE_OPTIONS = [
  { key: 'admin',      label: 'Admin',           color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'employee',   label: 'Operations',      color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'accountant', label: 'Accountant',      color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
  { key: 'partner',    label: 'Channel Partner', color: '#2563eb', bg: '#f8faff', border: '#e2e8f0' },
];

// Persist the last-used role so repeat visitors land straight on their
// login form instead of the role-picker every time.
const LAST_ROLE_KEY = 'bridgethings:lastRole';
// Persist the operations sub-team (operations / dispatch). Surfaces in
// MainLayout for the sidebar branding and in Fulfillment for view-filter.
const LAST_TEAM_KEY = 'bridgethings:lastTeam';

// Sub-teams shown only when the chosen role is 'employee'. The DB role
// remains 'employee' for both — the team is a UI/workflow distinction.
const TEAM_OPTIONS = [
  { key: 'operations', label: 'Operations' },
  { key: 'dispatch',   label: 'Dispatch' },
];

export default function Login() {
  const { login, user, loading } = useAuth();
  const navigate = useNavigate();

  // Initialise from localStorage — if the user picked a role + team
  // before, skip straight to the login form with those pre-selected.
  const initialRole = (() => {
    try {
      const stored = localStorage.getItem(LAST_ROLE_KEY);
      return stored ? ROLE_OPTIONS.find(r => r.key === stored) || null : null;
    } catch { return null; }
  })();
  const initialTeam = (() => {
    try {
      const stored = localStorage.getItem(LAST_TEAM_KEY);
      return stored ? TEAM_OPTIONS.find(t => t.key === stored) || null : null;
    } catch { return null; }
  })();

  // Step machine: 'role' → 'team' (only when role=employee) → 'login'.
  const initialStep = (() => {
    if (!initialRole) return 'role';
    if (initialRole.key === 'employee' && !initialTeam) return 'team';
    return 'login';
  })();

  const [step, setStep]                 = useState(initialStep);
  const [selectedRole, setSelectedRole] = useState(initialRole);
  const [selectedTeam, setSelectedTeam] = useState(initialTeam);
  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [error, setError]               = useState('');
  const [submitting, setSubmitting]     = useState(false);

  useEffect(() => {
    if (!loading && user) {
      // For employees, the DB-assigned team always wins over whatever
      // they may have picked from the local picker. Mirror it into
      // localStorage so MainLayout + Fulfillment read it consistently.
      if (user.role === 'employee' && user.team) {
        try { localStorage.setItem(LAST_TEAM_KEY, user.team); } catch { /* ignore */ }
      }
      navigate(portalPrefixFor(user), { replace: true });
    }
  }, [user, loading, navigate]);

  const handleRoleSelect = (role) => {
    setSelectedRole(role);
    setError('');
    try { localStorage.setItem(LAST_ROLE_KEY, role.key); } catch { /* ignore */ }
    // Operations role splits further into operations / dispatch teams.
    if (role.key === 'employee') {
      setStep('team');
    } else {
      setStep('login');
    }
  };

  const handleTeamSelect = (team) => {
    setSelectedTeam(team);
    setError('');
    try { localStorage.setItem(LAST_TEAM_KEY, team.key); } catch { /* ignore */ }
    setStep('login');
  };

  const handleBack = () => {
    // From login form, go back to the previous picker (team if employee, role otherwise).
    if (step === 'login' && selectedRole?.key === 'employee') {
      setStep('team');
    } else if (step === 'team') {
      setStep('role');
      setSelectedTeam(null);
      try { localStorage.removeItem(LAST_TEAM_KEY); } catch { /* ignore */ }
    } else {
      setStep('role');
      setSelectedRole(null);
      setSelectedTeam(null);
      try {
        localStorage.removeItem(LAST_ROLE_KEY);
        localStorage.removeItem(LAST_TEAM_KEY);
      } catch { /* ignore */ }
    }
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
      <div style={{ width: '100%', maxWidth: step === 'role' ? '560px' : '460px', transition: 'max-width 0.3s ease' }}>

        {/* Logo — always visible */}
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <img src={`${import.meta.env.BASE_URL}BridgeThings.png`} alt="Bridge Things" style={{ height: '60px', objectFit: 'contain' }} />
          <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '0.4rem', letterSpacing: '0.03em' }}>
            B2B Industrial IoT ERP Portal
          </div>
        </div>

        {/* STEP role — Role Selection */}
        {step === 'role' && (
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

        {/* STEP team — Operations / Dispatch picker (only when employee role) */}
        {step === 'team' && (
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.05)',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '1.25rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Choose Your Team</div>
              <button
                onClick={handleBack}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                  color: '#64748b', fontSize: '0.85rem', padding: '0.35rem 0.6rem', borderRadius: '6px',
                  fontFamily: 'inherit', transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.target.style.background = '#f1f5f9'}
                onMouseLeave={e => e.target.style.background = 'none'}
              >
                ← Back
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', padding: '1rem 1.75rem 1.5rem' }}>
              {TEAM_OPTIONS.map(team => (
                <button
                  key={team.key}
                  onClick={() => handleTeamSelect(team)}
                  style={{
                    background: '#fff',
                    border: '1.5px solid #e2e8f0',
                    borderRadius: '10px',
                    padding: '1.1rem 1.25rem',
                    cursor: 'pointer',
                    textAlign: 'center',
                    transition: 'all 0.15s',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#2563eb'; e.currentTarget.style.background = '#f0f5ff'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.background = '#fff'; }}
                >
                  <div style={{ fontWeight: 700, fontSize: '1.35rem', color: '#0f172a' }}>{team.label}</div>
                </button>
              ))}
            </div>
            <div style={{ borderTop: '1px solid #f1f5f9', padding: '0.85rem', textAlign: 'center', color: '#cbd5e1', fontSize: '0.72rem' }}>
              © 2026 Bridge Things. All rights reserved.
            </div>
          </div>
        )}

        {/* STEP login — Login Form */}
        {step === 'login' && roleInfo && (
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
