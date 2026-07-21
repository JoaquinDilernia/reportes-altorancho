import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

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

  return <Dashboard onLogout={logout} />;
}
