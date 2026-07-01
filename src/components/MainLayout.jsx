// MainLayout — Sidebar + Topbar shell
import { Outlet, NavLink, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ROLES } from '../lib/store';
import { portalPrefixFor } from '../lib/portalPaths';
import { useState } from 'react';


// Per-link role restrictions. If `roles` is omitted, the link is visible to
// everyone in this nav (admin + employee). Use this to gate admin-only links.
// Shared admin-portal links use `${prefix}/...` so the URL reflects the user's
// team (admin → /admin/*, employee → /operations/* or /dispatch/*).
const buildAdminNav = (prefix) => [
  { to: prefix,                  label: 'Dashboard' },
  { to: `${prefix}/products`,    label: 'Products' },
  { to: '/admin/po-received',    label: 'POs Received', roles: ['admin'] },
  { to: `${prefix}/fulfillment`, label: 'Orders' },
  { to: '/admin/subscriptions',  label: 'Subscriptions', roles: ['admin'] },
  { to: '/admin/partners',       label: 'Channel Partners', roles: ['admin'] },
];
const partnerNav = [
  { to: '/partner',          label: 'Dashboard' },
  { to: '/partner/catalog',  label: 'All Products' },
  { to: '/partner/po',       label: 'Purchase Orders' },
  { to: '/partner/orders',   label: 'My Orders' },
  { to: '/partner/devices',  label: 'My Devices' },
  { to: '/partner/invoices', label: 'Invoices' },
  { to: '/partner/profile',  label: 'My Profile' },
];
const financeNav = [
  { to: '/finance',               label: 'Dashboard' },
  { to: '/finance/subscriptions', label: 'Subscriptions' },
];

function getNav(user) {
  const role = user?.role;
  if (role === ROLES.PARTNER) return partnerNav;
  if (role === ROLES.ACCOUNTANT) return financeNav;
  return buildAdminNav(portalPrefixFor(user)); // admin & employee
}

// For employee role, sidebar branding splits by team. The user's
// DB-assigned team (user.team) wins; falls back to the localStorage
// picker value for unassigned users; default is "Operations".
function getRoleLabel(role, user) {
  if (role === 'employee') {
    const dbTeam = user?.team;
    if (dbTeam === 'dispatch') return 'Dispatch';
    if (dbTeam === 'operations') return 'Operations';
    try {
      const team = localStorage.getItem('bridgethings:lastTeam');
      if (team === 'dispatch') return 'Dispatch';
    } catch { /* ignore */ }
    return 'Operations';
  }
  return { admin: 'Admin', accountant: 'Accountant', partner: 'Channel Partner' }[role] || role;
}

export default function MainLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return <Navigate to="/login" replace />;

  // Filter out any nav links that aren't allowed for this specific role.
  // (A link with no `roles` field is shown to everyone in its nav.)
  const nav = getNav(user).filter(
    item => !item.roles || item.roles.includes(user.role)
  );
  const displayName = user.name || user.email || 'User';
  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();

  const [signingOut, setSigningOut] = useState(false);
  // Mobile drawer open/close. Always false on desktop — the CSS just
  // ignores the class on viewports above 768px, so this state doesn't
  // affect desktop layout.
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = () => setMobileOpen(false);

  const handleLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (e) {
      console.error('[logout] failed:', e);
      setSigningOut(false);
    }
  };

  return (
    <div className="app-shell">
      {/* Mobile top bar — only shown via CSS on small screens. */}
      <div className="mobile-topbar">
        <button
          type="button"
          className="mobile-hamburger"
          aria-label="Open menu"
          onClick={() => setMobileOpen(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6"  x2="21" y2="6"  />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <img src={`${import.meta.env.BASE_URL}BridgeThings.png`} alt="Bridge Things" className="mobile-topbar-logo" />
      </div>

      {/* Backdrop to close the drawer when tapped outside it. */}
      {mobileOpen && <div className="mobile-backdrop" onClick={closeMobile} />}

      {/* Sidebar — adds .mobile-open class so the CSS drawer slides in. */}
      <aside className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}>
        <div className="sidebar-logo">
          <img src={`${import.meta.env.BASE_URL}BridgeThings.png`} alt="Bridge Things" className="sidebar-logo-img" />
          <div className="sidebar-portal-label">{getRoleLabel(user.role, user)} Portal</div>
        </div>

        <nav className="nav-links">
          {nav.map(item => (
            <NavLink key={item.to} to={item.to} end={item.to.split('/').length === 2}
              onClick={closeMobile}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{initials}</div>
            <div>
              <div className="user-name" title={displayName}>{displayName}</div>
              <div className="user-role">{getRoleLabel(user.role, user)}</div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            disabled={signingOut}
            className="signout-btn"
            aria-label="Sign out"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{signingOut ? 'Signing out...' : 'Sign Out'}</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="main-area">
        <main className="page-body">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
