import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/services', label: 'Services' },
  { to: '/nginx', label: 'NGINX' },
  { to: '/wireguard', label: 'WireGuard' },
  { to: '/mosquitto', label: 'Mosquitto MQTT' },
  { to: '/nodejs', label: 'Node.js' },
  { to: '/files', label: 'Files' },
  { to: '/audit', label: 'Audit Log' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">VPS CONSOLE</div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p className="hint-text mono">{user?.username}</p>
          <button onClick={handleLogout} style={{ width: '100%', marginTop: 6 }}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
