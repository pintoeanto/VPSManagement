// Access token lives in memory only (never localStorage) — it's re-acquired
// via the httpOnly refresh cookie on page load / after a 401.
let accessToken = null;
let onUnauthorized = null;

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onSessionExpired(handler) {
  onUnauthorized = handler;
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function rawFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const isCookieAuthed = path === '/auth/refresh' || path === '/auth/logout';
  if (isCookieAuthed) {
    const csrf = readCookie('csrf_token');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  return res;
}

// The refresh token rotates on every use — the server revokes the presented
// token and treats a second presentation of it as reuse (compromise signal),
// killing the whole session. Without this dedup, two callers racing to
// refresh at once (React StrictMode's double effect in dev, or two API calls
// hitting a 401 at the same moment in prod) would trip that detection and
// log the user out. Concurrent callers now share one in-flight request.
let refreshInFlight = null;

function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await rawFetch('/auth/refresh', { method: 'POST' });
      if (!res.ok) {
        accessToken = null;
        if (onUnauthorized) onUnauthorized();
        throw new ApiError(res.status, 'Session expired');
      }
      const data = await res.json();
      accessToken = data.accessToken;
      return data;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function request(path, options = {}) {
  let res = await rawFetch(path, options);
  if (res.status === 401 && accessToken !== null && path !== '/auth/refresh') {
    try {
      await refreshSession();
      res = await rawFetch(path, options);
    } catch {
      // fall through with the original 401 response handling below
    }
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    throw new ApiError(res.status, body?.error || res.statusText, body?.details);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return res;
}

export const api = {
  refreshSession,

  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  totpSetupInit: (pendingId) => request('/auth/totp/setup/init', { method: 'POST', body: JSON.stringify({ pendingId }) }),
  totpSetupConfirm: (pendingId, token) =>
    request('/auth/totp/setup/confirm', { method: 'POST', body: JSON.stringify({ pendingId, token }) }).then((data) => {
      accessToken = data.accessToken;
      return data;
    }),
  totpVerify: (pendingId, token) =>
    request('/auth/totp/verify', { method: 'POST', body: JSON.stringify({ pendingId, token }) }).then((data) => {
      accessToken = data.accessToken;
      return data;
    }),
  logout: () =>
    request('/auth/logout', { method: 'POST' }).finally(() => {
      accessToken = null;
    }),
  me: () => request('/auth/me'),

  listActions: () => request('/actions'),
  detectAction: (id, params = {}) => request(`/actions/${id}/detect`, { method: 'POST', body: JSON.stringify(params) }),
  planAction: (id, params = {}) => request(`/actions/${id}/plan`, { method: 'POST', body: JSON.stringify(params) }),
  applyAction: (id, params = {}) => request(`/actions/${id}/apply`, { method: 'POST', body: JSON.stringify(params) }),

  metrics: () => request('/metrics'),

  listFiles: (dir = '.') => request(`/files?dir=${encodeURIComponent(dir)}`),
  deleteFile: (path) => request(`/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  fileDownloadUrl: (path) => `/api/files/download?path=${encodeURIComponent(path)}`,
  uploadFile: async (dir, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/files/upload?dir=${encodeURIComponent(dir)}`, { method: 'POST', body: form });
  },

  auditLog: (limit = 100) => request(`/audit?limit=${limit}`),
  auditVerify: () => request('/audit/verify'),
};
