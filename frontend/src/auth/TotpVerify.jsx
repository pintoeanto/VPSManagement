import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';

export function TotpVerify({ pendingId, onDone }) {
  const { totpVerify } = useAuth();
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await totpVerify(pendingId, token.trim());
      onDone();
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="hint-text">Enter the 6-digit code from your authenticator app, or a backup code.</p>
      <div className="field">
        <label htmlFor="totp">Authentication code</label>
        <input
          id="totp"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456"
          maxLength={11}
          autoComplete="one-time-code"
        />
      </div>
      {error && <p className="error-text">{error}</p>}
      <button className="primary" type="submit" disabled={busy || !token} style={{ width: '100%' }}>
        {busy ? 'Verifying…' : 'Verify'}
      </button>
    </form>
  );
}
