import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import NuevoApp from './nuevo/NuevoApp.jsx';

// The new report lives at ?v=nuevo (Hostinger serves a static index.html with
// no rewrites, so a separate path isn't possible); / stays the current one.
const isNuevo = () => new URLSearchParams(window.location.search).get('v') === 'nuevo';

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

  return isNuevo() ? <NuevoApp onLogout={logout} /> : <Dashboard onLogout={logout} />;
}
