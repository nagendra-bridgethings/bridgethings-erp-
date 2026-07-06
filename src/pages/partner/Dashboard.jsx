// Partner — Dashboard
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useOrders } from '../../lib/orders';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function PartnerDashboard() {
  const { user } = useAuth();
  // RLS scopes to the partner's own orders. Accepted orders (active /
  // completed) drive the at-a-glance stats.
  // limit: null — these cards are whole-history aggregates; a 50-row cap
  // would silently drop older orders (and hide old unpaid balances) once a
  // partner passes 50 orders.
  const { orders: myOrders } = useOrders({
    includeStatuses: ['active', 'completed'],
    limit: null,
  });
  const pendingPayment = myOrders.filter(o => o.payment_status !== 'completed');
  const totalOrdered = myOrders.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Welcome{user?.name ? `, ${user.name}` : ''}!</div>
          <div className="page-subtitle">Here's an overview of your account activity.</div>
        </div>
        <Link to="/partner/catalog" className="btn btn-primary">New Purchase Order</Link>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div><div className="stat-label">Total Orders</div><div className="stat-value">{myOrders.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Pending Payments</div><div className="stat-value">{pendingPayment.length}</div></div>
        </div>
        <div className="stat-card">
          <div><div className="stat-label">Total Ordered Value</div><div className="stat-value" style={{fontSize:'1.3rem'}}>{fmtINR(totalOrdered)}</div></div>
        </div>
      </div>
    </>
  );
}
