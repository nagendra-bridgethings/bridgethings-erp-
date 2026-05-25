import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './lib/toast';
import { CartProvider } from './lib/cart';
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

const ROLE_HOME = { admin: '/admin', employee: '/admin', accountant: '/finance', partner: '/partner' };

// Per-role allow-lists for each route family. Anyone landing on a route their
// role doesn't own gets bounced to their role's home page.
const ADMIN_ROLES   = ['admin', 'employee']; // shared admin portal
const ADMIN_ONLY    = ['admin'];             // admin-only within admin portal
const FINANCE_ROLES = ['accountant'];
const PARTNER_ROLES = ['partner'];
// Subscriptions: accountant activates dashboards after payment received.
// Admin can view & override. Employees are scoped to fulfillment only.
const SUBSCRIPTION_ROLES = ['admin', 'accountant'];

function RoleGate({ allowed, role, children }) {
  if (!allowed.includes(role)) {
    return <Navigate to={ROLE_HOME[role] || '/login'} replace />;
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

  const role = user.role;

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to={ROLE_HOME[role] || '/login'} replace />} />

        {/* Admin/Employee Routes */}
        <Route path="/admin"             element={<RoleGate allowed={ADMIN_ROLES} role={role}><AdminDashboard /></RoleGate>} />
        <Route path="/admin/products"    element={<RoleGate allowed={ADMIN_ROLES} role={role}><ProductsPage /></RoleGate>} />
        <Route path="/admin/po-received" element={<RoleGate allowed={ADMIN_ONLY} role={role}><POReceived /></RoleGate>} />
        <Route path="/admin/fulfillment"   element={<RoleGate allowed={ADMIN_ROLES} role={role}><Fulfillment /></RoleGate>} />
        <Route path="/admin/subscriptions" element={<RoleGate allowed={SUBSCRIPTION_ROLES} role={role}><Subscriptions /></RoleGate>} />
        <Route path="/admin/partners"      element={<RoleGate allowed={ADMIN_ONLY} role={role}><Partners /></RoleGate>} />
        <Route path="/admin/audit"         element={<RoleGate allowed={ADMIN_ONLY} role={role}><AuditLogs /></RoleGate>} />

        {/* Partner Routes */}
        <Route path="/partner"          element={<RoleGate allowed={PARTNER_ROLES} role={role}><PartnerDashboard /></RoleGate>} />
        <Route path="/partner/catalog"  element={<RoleGate allowed={PARTNER_ROLES} role={role}><Catalog /></RoleGate>} />
        <Route path="/partner/po"       element={<RoleGate allowed={PARTNER_ROLES} role={role}><CreatePO /></RoleGate>} />
        <Route path="/partner/orders"   element={<RoleGate allowed={PARTNER_ROLES} role={role}><MyOrders /></RoleGate>} />
        <Route path="/partner/devices"  element={<RoleGate allowed={PARTNER_ROLES} role={role}><PartnerDevices /></RoleGate>} />
        <Route path="/partner/invoices" element={<RoleGate allowed={PARTNER_ROLES} role={role}><Invoices /></RoleGate>} />
        <Route path="/partner/profile"  element={<RoleGate allowed={PARTNER_ROLES} role={role}><Profile /></RoleGate>} />

        {/* Finance Routes — accountant only */}
        <Route path="/finance"               element={<RoleGate allowed={FINANCE_ROLES} role={role}><Finance /></RoleGate>} />
        <Route path="/finance/pending"       element={<RoleGate allowed={FINANCE_ROLES} role={role}><Finance /></RoleGate>} />
        <Route path="/finance/history"       element={<RoleGate allowed={FINANCE_ROLES} role={role}><Finance /></RoleGate>} />
        <Route path="/finance/subscriptions" element={<RoleGate allowed={SUBSCRIPTION_ROLES} role={role}><Subscriptions /></RoleGate>} />

        {/* Catch-all: any unknown route under the protected tree → role home */}
        <Route path="*" element={<Navigate to={ROLE_HOME[role] || '/login'} replace />} />
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
