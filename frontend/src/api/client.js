export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3055';
const TOKEN_KEY = 'altorancho_reportes_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(password) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Login failed');
  setToken(data.token);
  return data.token;
}

export async function getReport({ period, date, start, end, channel }) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const params = period === 'custom'
    ? new URLSearchParams({ period, start, end })
    : new URLSearchParams({ period, date });
  if (channel) params.set('channels', channel);

  const res = await fetch(`${API_URL}/api/report?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Report fetch failed');
  return data;
}
