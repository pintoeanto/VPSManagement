import { useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';

export function WireGuard() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('wireguard.detect', {}), 10000);
  const { data: status, refresh: refreshStatus } = usePolling(() => api.detectAction('wireguard.status', {}), 5000);

  const [listenPort, setListenPort] = useState(51820);
  const [serverAddress, setServerAddress] = useState('10.8.0.1/24');
  const [peerName, setPeerName] = useState('');
  const [allowedIps, setAllowedIps] = useState('10.8.0.2/32');
  const [newPeer, setNewPeer] = useState(null);

  function refreshAll() {
    refreshDetect();
    refreshStatus();
  }

  async function handlePeerAdded(result) {
    if (result.result && !result.result.alreadySatisfied) {
      setNewPeer(result.result);
    }
    refreshAll();
  }

  return (
    <div>
      <h1 className="page-title">WireGuard</h1>

      <div className="panel">
        <h2>Install state</h2>
        <div className="row between">
          <StatusBadge status={detect?.installed ? 'ok' : 'neutral'}>{detect?.installed ? 'Installed' : 'Not installed'}</StatusBadge>
          {!detect?.installed && <ActionButton actionId="wireguard.install" params={{}} label="Install WireGuard" className="primary" onApplied={refreshAll} />}
        </div>
      </div>

      {detect?.installed && !status?.initialized && (
        <div className="panel">
          <h2>Initialize wg0 interface</h2>
          <div className="form-grid">
            <div className="field">
              <label>Listen port</label>
              <input type="number" value={listenPort} onChange={(e) => setListenPort(e.target.value)} />
            </div>
            <div className="field">
              <label>Server address (CIDR)</label>
              <input value={serverAddress} onChange={(e) => setServerAddress(e.target.value)} />
            </div>
          </div>
          <ActionButton
            actionId="wireguard.initInterface"
            params={() => ({ listenPort: Number(listenPort), serverAddress })}
            label="Initialize wg0"
            className="primary"
            onApplied={refreshAll}
          />
        </div>
      )}

      {status?.initialized && (
        <>
          <div className="panel">
            <h2>Interface</h2>
            <div className="grid">
              <div className="stat-tile">
                <div className="label">Listen port</div>
                <div className="value">{status.interface?.listenPort}</div>
              </div>
              <div className="stat-tile">
                <div className="label">Public key</div>
                <div className="value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {status.interface?.publicKey}
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Peers</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Allowed IPs</th>
                  <th>Endpoint</th>
                  <th>Last handshake</th>
                  <th>RX / TX</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(status.peers ?? []).map((p) => (
                  <tr key={p.publicKey}>
                    <td>{p.name}</td>
                    <td className="mono">{p.allowedIps}</td>
                    <td className="mono">{p.endpoint || '—'}</td>
                    <td>{p.latestHandshake || 'never'}</td>
                    <td className="mono">
                      {p.rxBytes} / {p.txBytes}
                    </td>
                    <td>
                      <ActionButton actionId="wireguard.peerRemove" params={{ peerName: p.name }} label="Remove" className="danger" onApplied={refreshAll} />
                    </td>
                  </tr>
                ))}
                {(!status.peers || status.peers.length === 0) && (
                  <tr>
                    <td colSpan={6} className="hint-text">
                      No peers yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Add peer</h2>
            <div className="form-grid">
              <div className="field">
                <label>Peer name</label>
                <input value={peerName} onChange={(e) => setPeerName(e.target.value)} placeholder="laptop" />
              </div>
              <div className="field">
                <label>Allowed IPs (CIDR)</label>
                <input value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="10.8.0.2/32" />
              </div>
            </div>
            <ActionButton
              actionId="wireguard.peerAdd"
              params={() => ({ peerName, allowedIps })}
              label="Add peer"
              className="primary"
              disabled={!peerName || !allowedIps}
              onApplied={handlePeerAdded}
            />
          </div>

          {newPeer && (
            <div className="panel">
              <h2>New peer credentials — shown once</h2>
              <p className="hint-text">
                The private key below is never stored server-side. Copy it into the peer's WireGuard client config now.
              </p>
              <pre className="code-block">
{`[Interface]
PrivateKey = ${newPeer.CLIENT_PRIVATE_KEY}
Address = ${newPeer.ALLOWED_IPS}

[Peer]
PublicKey = ${newPeer.SERVER_PUBLIC_KEY}
Endpoint = <your-server-ip-or-hostname>:${newPeer.SERVER_LISTEN_PORT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`}
              </pre>
              <button onClick={() => setNewPeer(null)}>Dismiss</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
