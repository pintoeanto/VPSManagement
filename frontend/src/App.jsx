import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { Login } from './auth/Login.jsx';
import { Layout } from './components/Layout.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { GenericServices } from './pages/services/GenericServices.jsx';
import { Nginx } from './pages/services/Nginx.jsx';
import { WireGuard } from './pages/services/WireGuard.jsx';
import { Mosquitto } from './pages/services/Mosquitto.jsx';
import { NodeJs } from './pages/services/NodeJs.jsx';
import { Files } from './pages/Files.jsx';
import { Audit } from './pages/Audit.jsx';

function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  const { user, ready } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={!ready ? null : user ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="services" element={<GenericServices />} />
        <Route path="nginx" element={<Nginx />} />
        <Route path="wireguard" element={<WireGuard />} />
        <Route path="mosquitto" element={<Mosquitto />} />
        <Route path="nodejs" element={<NodeJs />} />
        <Route path="files" element={<Files />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
