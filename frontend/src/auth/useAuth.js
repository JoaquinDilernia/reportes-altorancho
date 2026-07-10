import { useState, useCallback } from 'react';
import { login as apiLogin, getToken, clearToken } from '../api/client.js';

export function useAuth() {
  const [token, setTokenState] = useState(() => getToken());

  const login = useCallback(async (password) => {
    const newToken = await apiLogin(password);
    setTokenState(newToken);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  return { isAuthenticated: !!token, login, logout };
}
