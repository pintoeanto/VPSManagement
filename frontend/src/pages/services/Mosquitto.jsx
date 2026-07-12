import { useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';

export function Mosquitto() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('mosquitto.detect', {}), 10000);
  const { data: usersData, refresh: refreshUsers } = usePolling(() => api.detectAction('mosquitto.listUsers', {}), 8000);

  const [port, setPort] = useState(1883);
  const [allowAnonymous, setAllowAnonymous] = useState(false);
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [certPath, setCertPath] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function refreshAll() {
    refreshDetect();
    refreshUsers();
  }

  return (
    <div>
      <h1 className="page-title">Mosquitto MQTT</h1>

      <div className="panel">
        <h2>Install state</h2>
        <div className="row between">
          <StatusBadge status={detect?.installed ? 'ok' : 'neutral'}>{detect?.installed ? 'Installed' : 'Not installed'}</StatusBadge>
          {!detect?.installed && <ActionButton actionId="mosquitto.install" params={{}} label="Install Mosquitto" className="primary" onApplied={refreshAll} />}
        </div>
      </div>

      <div className="panel">
        <h2>Listener</h2>
        <div className="form-grid">
          <div className="field">
            <label>Port</label>
            <input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className="field">
            <label>Allow anonymous</label>
            <select value={allowAnonymous ? '1' : '0'} onChange={(e) => setAllowAnonymous(e.target.value === '1')}>
              <option value="0">No (require auth)</option>
              <option value="1">Yes</option>
            </select>
          </div>
          <div className="field">
            <label>TLS</label>
            <select value={tlsEnabled ? '1' : '0'} onChange={(e) => setTlsEnabled(e.target.value === '1')}>
              <option value="0">Disabled</option>
              <option value="1">Enabled</option>
            </select>
          </div>
          {tlsEnabled && (
            <>
              <div className="field">
                <label>Cert path</label>
                <input value={certPath} onChange={(e) => setCertPath(e.target.value)} placeholder="/etc/letsencrypt/live/host/fullchain.pem" />
              </div>
              <div className="field">
                <label>Key path</label>
                <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="/etc/letsencrypt/live/host/privkey.pem" />
              </div>
            </>
          )}
        </div>
        <ActionButton
          actionId="mosquitto.configureListener"
          params={() => ({
            port: Number(port),
            allowAnonymous,
            tlsEnabled,
            ...(tlsEnabled ? { certPath, keyPath } : {}),
          })}
          label="Apply listener config"
          className="primary"
          disabled={tlsEnabled && (!certPath || !keyPath)}
          onApplied={refreshAll}
        />
      </div>

      <div className="panel">
        <h2>Users</h2>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(usersData?.users ?? []).map((u) => (
              <tr key={u}>
                <td className="mono">{u}</td>
                <td>
                  <ActionButton actionId="mosquitto.removeUser" params={{ username: u }} label="Remove" className="danger" onApplied={refreshAll} />
                </td>
              </tr>
            ))}
            {(!usersData?.users || usersData.users.length === 0) && (
              <tr>
                <td colSpan={2} className="hint-text">
                  No password-file users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 style={{ marginTop: 18 }}>Add / update user</h2>
        <div className="form-grid">
          <div className="field">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <ActionButton
          actionId="mosquitto.setUser"
          params={() => ({ username, password })}
          label="Save user"
          className="primary"
          disabled={!username || password.length < 8}
          onApplied={() => {
            refreshAll();
            setPassword('');
          }}
        />
      </div>
    </div>
  );
}
