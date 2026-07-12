import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { api } from '../api/client.js';

export function TotpEnroll({ pendingId, onDone }) {
  const { totpSetupConfirm, completeAuth } = useAuth();
  const [qr, setQr] = useState(null);
  const [otpauthUri, setOtpauthUri] = useState(null);
  const [token, setToken] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [enrolledUser, setEnrolledUser] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .totpSetupInit(pendingId)
      .then((data) => {
        setQr(data.qrDataUrl);
        setOtpauthUri(data.otpauthUri);
      })
      .catch((err) => setError(err.message));
  }, [pendingId]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await totpSetupConfirm(pendingId, token.trim());
      setEnrolledUser(data.user);
      setBackupCodes(data.backupCodes);
    } catch (err) {
      setError(err.message || 'Enrollment failed');
    } finally {
      setBusy(false);
    }
  }

  if (backupCodes) {
    return (
      <div>
        <p className="hint-text">
          Save these one-time backup codes somewhere safe. Each can be used once if you lose access to your
          authenticator app. They will not be shown again.
        </p>
        <div className="backup-codes">
          {backupCodes.map((code) => (
            <div key={code}>{code}</div>
          ))}
        </div>
        <button
          className="primary"
          onClick={() => {
            completeAuth(enrolledUser);
            onDone();
          }}
          style={{ width: '100%' }}
        >
          Continue to dashboard
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="hint-text">Scan this QR code with Google Authenticator, Authy, or any TOTP app.</p>
      {qr && (
        <div className="qr-box">
          <img src={qr} alt="TOTP enrollment QR code" width={180} height={180} />
        </div>
      )}
      {otpauthUri && (
        <p className="hint-text" style={{ wordBreak: 'break-all', marginTop: 8 }}>
          Or enter manually: <code>{otpauthUri.match(/secret=([^&]+)/)?.[1]}</code>
        </p>
      )}
      <form onSubmit={submit} style={{ marginTop: 16 }}>
        <div className="field">
          <label htmlFor="totp-confirm">Enter the 6-digit code to confirm</label>
          <input
            id="totp-confirm"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456"
            maxLength={6}
            autoComplete="one-time-code"
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy || token.length !== 6} style={{ width: '100%' }}>
          {busy ? 'Confirming…' : 'Confirm & enable 2FA'}
        </button>
      </form>
    </div>
  );
}
