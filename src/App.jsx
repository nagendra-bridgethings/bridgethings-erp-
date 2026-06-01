import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './lib/toast';
import { CartProvider } from './lib/cart';
import { portalPrefixFor } from './lib/portalPaths';
import MainLayout from './components/MainLayout';

// Pages
import Login from './pages/Login';

// Admin / Employee
import AdminDashboard    from './pages/admin/Dashboard';
import ProductsPage      from './pages/admin/Products';
import POReceived        from './pages/admin/POReceived';
import Fulfillment       from './pages/admin/Fulfillment';
import Subscriptions     from './pages/admin/Subscriptions';
import Partners          from './pages/admin/Partners';
import AuditLogs         from './pages/admin/AuditLogs';

// Partner
import PartnerDashboard  from './pages/partner/Dashboard';
import Catalog           from './pages/partner/Catalog';
import CreatePO          from './pages/partner/CreatePO';
import MyOrders          from './pages/partner/Orders';
import PartnerDevices    from './pages/partner/Devices';
import Invoices          from './pages/partner/Invoices';
import Profile           from './pages/partner/Profile';

// Accountant
import Finance           from './pages/accountant/Finance';

// Per-role allow-lists for each route family. Anyone landing on a route their
// role doesn't own gets bounced to their role's home page.
const ADMIN_ROLES   = ['admin', 'employee']; // shared admin portal
const ADMIN_ONLY    = ['admin'];             // admin-only within admin portal
const FINANCE_ROLES = ['accountant'];
const PARTNER_ROLES = ['partner'];
// Subscriptions: accountant activates dashboards after payment received.
// Admin can view & override. Employees are scoped to fulfillment only.
const SUBSCRIPTION_ROLES = ['admin', 'accountant'];

function RoleGate({ allowed, user, children }) {
  if (!allowed.includes(user?.role)) {
    return <Navigate to={portalPrefixFor(user)} replace />;
  }
  return children;
}

function ProtectedRoutes() {
  const { user, rawUser, loading } = useAuth();

  const loadingScreen = (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div style={{ fontSize: '0.875rem', color: '#64748b' }}>Loading Bridge Things ERP...</div>
    </div>
  );

  if (loading) return loadingScreen;
  // No supabase session at all → genuinely logged out.
  if (!rawUser) return <Navigate to="/login" replace />;
  // Session exists but profile hasn't finished loading yet. Do NOT redirect
  // to /login here — that's how the "auto logout then auto login" flicker
  // happens when the safety timer races the profile fetch.
  if (!user) return loadingScreen;

  const home = portalPrefixFor(user);
  const isEmployee = user?.role === 'employee';

  // Mount the three shared admin-portal pages (Dashboard, Products,
  // Fulfillment) at /admin, /operations, and /dispatch — same component,
  // URL just reflects the team. Admin-only pages (po-received, subscriptions,
  // partners, audit) stay under /admin only.
  const adminPortalRoutes = (prefix) => (
    <>
      <Route path={prefix}                 element={<RoleGate allowed={ADMIN_ROLES} user={user}><AdminDashboard /></RoleGate>} />
      <Route path={`${prefix}/products`}   element={<RoleGate allowed={ADMIN_ROLES} user={user}><ProductsPage /></RoleGate>} />
      <Route path={`${prefix}/fulfillment`} element={<RoleGate allowed={ADMIN_ROLES} user={user}><Fulfillment /></RoleGate>} />
    </>
  );

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to={home} replace />} />

        {/* Employees hitting the shared /admin/* URLs get bounced to their
            team-prefixed equivalent so the browser URL reflects the portal
            label (Operations / Dispatch). Declared before the actual
            mounts so React Router matches these first for employees. */}
        {isEmployee && (
          <>
            <Route path="/admin"             element={<Navigate to={home} replace />} />
            <Route path="/admin/products"    element={<Navigate to={`${home}/products`} replace />} />
            <Route path="/admin/fulfillment" element={<Navigate to={`${home}/fulfillment`} replace />} />
          </>
        )}

        {/* Admin / Operations / Dispatch — same components, team-prefixed URLs */}
        {adminPortalRoutes('/admin')}
        {adminPortalRoutes('/operations')}
        {adminPortalRoutes('/dispatch')}

        {/* Admin-only routes */}
        <Route path="/admin/po-received"   element={<RoleGate allowed={ADMIN_ONLY} user={user}><POReceived /></RoleGate>} />
        <Route path="/admin/subscriptions" element={<RoleGate allowed={SUBSCRIPTION_ROLES} user={user}><Subscriptions /></RoleGate>} />
        <Route path="/admin/partners"      element={<RoleGate allowed={ADMIN_ONLY} user={user}><Partners /></RoleGate>} />
        <Route path="/admin/audit"         element={<RoleGate allowed={ADMIN_ONLY} user={user}><AuditLogs /></RoleGate>} />

        {/* Partner Routes */}
        <Route path="/partner"          element={<RoleGate allowed={PARTNER_ROLES} user={user}><PartnerDashboard /></RoleGate>} />
        <Route path="/partner/catalog"  element={<RoleGate allowed={PARTNER_ROLES} user={user}><Catalog /></RoleGate>} />
        <Route path="/partner/po"       element={<RoleGate allowed={PARTNER_ROLES} user={user}><CreatePO /></RoleGate>} />
        <Route path="/partner/orders"   element={<RoleGate allowed={PARTNER_ROLES} user={user}><MyOrders /></RoleGate>} />
        <Route path="/partner/devices"  element={<RoleGate allowed={PARTNER_ROLES} user={user}><PartnerDevices /></RoleGate>} />
        <Route path="/partner/invoices" element={<RoleGate allowed={PARTNER_ROLES} user={user}><Invoices /></RoleGate>} />
        <Route path="/partner/profile"  element={<RoleGate allowed={PARTNER_ROLES} user={user}><Profile /></RoleGate>} />

        {/* Finance Routes — accountant only */}
        <Route path="/finance"               element={<RoleGate allowed={FINANCE_ROLES} user={user}><Finance /></RoleGate>} />
        <Route path="/finance/pending"       element={<RoleGate allowed={FINANCE_ROLES} user={user}><Finance /></RoleGate>} />
        <Route path="/finance/history"       element={<RoleGate allowed={FINANCE_ROLES} user={user}><Finance /></RoleGate>} />
        <Route path="/finance/subscriptions" element={<RoleGate allowed={SUBSCRIPTION_ROLES} user={user}><Subscriptions /></RoleGate>} />

        {/* Catch-all: any unknown route under the protected tree → role home */}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <CartProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/*" element={<ProtectedRoutes />} />
          </Routes>
        </CartProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
