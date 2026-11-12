import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';
import NuevoApp from './nuevo/NuevoApp.jsx';

// The new report is the only one; old ?v=actual links land on it too.
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

  return <NuevoApp onLogout={logout} />;
}
