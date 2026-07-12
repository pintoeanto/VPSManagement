import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, onSessionExpired, setAccessToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onSessionExpired(() => setUser(null));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.refreshSession();
        setUser(data.user);
      } catch {
        setAccessToken(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const login = useCallback((username, password) => api.login(username, password), []);
  const totpSetupInit = useCallback((pendingId) => api.totpSetupInit(pendingId), []);
  // Deliberately does NOT set `user` here: setting it would flip the /login
  // route guard immediately and unmount the enrollment screen before the
  // one-time backup codes are ever shown. The access token is already usable
  // (set inside api.totpSetupConfirm) — completeAuth() below is what actually
  // finalizes the session, called only after the user dismisses the codes.
  const totpSetupConfirm = useCallback((pendingId, token) => api.totpSetupConfirm(pendingId, token), []);
  const completeAuth = useCallback((user) => setUser(user), []);
  const totpVerify = useCallback(async (pendingId, token) => {
    const data = await api.totpVerify(pendingId, token);
    setUser(data.user);
    return data;
  }, []);
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, ready, login, totpSetupInit, totpSetupConfirm, completeAuth, totpVerify, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
