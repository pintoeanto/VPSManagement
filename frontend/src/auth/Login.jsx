import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { TotpEnroll } from './TotpEnroll.jsx';
import { TotpVerify } from './TotpVerify.jsx';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState('credentials'); // credentials | totp_setup | totp_verify
  const [pendingId, setPendingId] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await login(username, password);
      setPendingId(data.pendingId);
      setStep(data.status === 'totp_setup_required' ? 'totp_setup' : 'totp_verify');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>VPS Console</h1>
        <p className="subtitle">
          {step === 'credentials' && 'Sign in to continue'}
          {step === 'totp_setup' && 'Set up two-factor authentication'}
          {step === 'totp_verify' && 'Enter your verification code'}
        </p>

        {step === 'credentials' && (
          <form onSubmit={submitCredentials}>
            <div className="field">
              <label htmlFor="username">Username</label>
              <input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="primary" type="submit" disabled={busy || !username || !password} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {step === 'totp_setup' && <TotpEnroll pendingId={pendingId} onDone={() => navigate('/')} />}
        {step === 'totp_verify' && <TotpVerify pendingId={pendingId} onDone={() => navigate('/')} />}
      </div>
    </div>
  );
}
