import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import NuevoApp from './nuevo/NuevoApp.jsx';

// The new report is the main one. The previous report stays reachable at
// ?v=actual while the new one's tabs are being built (Hostinger serves a
// static index.html with no rewrites, hence a query param, not a path).
const isActual = () => new URLSearchParams(window.location.search).get('v') === 'actual';

export default function App() {
  const { isAuthenticated, login, logout } = useAuth();
  const [loginError, setLoginError] = useState(null);

  if (!isAuthenticated) {
    return (
      <Login
        error={loginError}
        onLogin={async (password) => {
          try {
            setLoginError(null);
            await login(password);
          } catch (err) {
            setLoginError(err.message);
          }
        }}
      />
    );
  }

  return isActual() ? <Dashboard onLogout={logout} /> : <NuevoApp onLogout={logout} />;
}
