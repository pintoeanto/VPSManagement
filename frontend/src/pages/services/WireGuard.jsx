import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';
import { NetworkDiagram, STATUS, peerStatus } from '../../components/NetworkDiagram.jsx';

export function WireGuard() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('wireguard.detect', {}), 10000);
  const { data: status, refresh: refreshStatus } = usePolling(() => api.detectAction('wireguard.status', {}), 5000);

  const [listenPort, setListenPort] = useState(51820);
  const [serverAddress, setServerAddress] = useState('10.8.0.1/24');
  const [peerName, setPeerName] = useState('');
  const [allowedIps, setAllowedIps] = useState('10.8.0.2/32');
  const [newPeer, setNewPeer] = useState(null);

  // Explorer selection: 'config' (the raw wg0.conf editor) or a peer name.
  const [selected, setSelected] = useState('config');
  const [content, setContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

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

  useEffect(() => {
    if (selected !== 'config' || !status?.initialized) return;
    let cancelled = false;
    setLoadingContent(true);
    api
      .detectAction('wireguard.getConfigRaw', {})
      .then((data) => !cancelled && setContent(data.content ?? ''))
      .catch((err) => !cancelled && setSaveError(err.message))
      .finally(() => !cancelled && setLoadingContent(false));
    return () => {
      cancelled = true;
    };
  }, [selected, status?.initialized]);

  async function handleSaveConfig() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.applyAction('wireguard.setConfigRaw', { content });
      refreshAll();
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const selectedPeer = (status?.peers ?? []).find((p) => p.name === selected);

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
            <div className="row between">
              <h2 style={{ margin: 0 }}>Interface</h2>
              <div className="row wrap">
                <ActionButton actionId="service.control" params={{ unit: 'wg-quick@wg0', action: 'restart' }} label="Restart" onApplied={refreshAll} />
                <ActionButton actionId="service.control" params={{ unit: 'wg-quick@wg0', action: 'stop' }} label="Stop" className="danger" onApplied={refreshAll} />
                <ActionButton actionId="service.control" params={{ unit: 'wg-quick@wg0', action: 'start' }} label="Start" onApplied={refreshAll} />
              </div>
            </div>
            <div className="grid" style={{ marginTop: 12 }}>
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

          {(status.peers?.length ?? 0) > 0 && (
            <div className="panel">
              <h2>Network</h2>
              <NetworkDiagram interfaceLabel="wg0" peers={status.peers} />
            </div>
          )}

          <div className="explorer-shell">
            <div className="explorer-sidebar">
              <div className="explorer-header">
                <span>WG0</span>
              </div>
              <div className="explorer-list">
                <div className={`explorer-item ${selected === 'config' ? 'active' : ''}`} onClick={() => setSelected('config')}>
                  <span className="dot on" />
                  <span className="name">wg0.conf</span>
                </div>
              </div>
              <div className="explorer-header">
                <span>PEERS</span>
              </div>
              <div className="explorer-list">
                {(status.peers ?? []).map((p) => {
                  const st = peerStatus(p.latestHandshake);
                  return (
                    <div key={p.publicKey} className={`explorer-item ${selected === p.name ? 'active' : ''}`} onClick={() => setSelected(p.name)}>
                      <span className="dot" style={{ background: STATUS[st].color }} />
                      <span className="name">{p.name}</span>
                    </div>
                  );
                })}
                {(!status.peers || status.peers.length === 0) && <div className="explorer-empty">No peers yet.</div>}
              </div>
            </div>

            <div className="editor-pane">
              {selected === 'config' ? (
                <>
                  <div className="editor-toolbar">
                    <span className="filename">wg0.conf</span>
                    <button className="primary" onClick={handleSaveConfig} disabled={saving || loadingContent}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  {loadingContent ? (
                    <div className="editor-placeholder">Loading…</div>
                  ) : (
                    <textarea className="editor-textarea" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} disabled={saving} />
                  )}
                  {saveError && <div className="editor-error">{saveError}</div>}
                  <div className="editor-error" style={{ background: 'transparent', color: 'var(--text-dim)' }}>
                    The server's private key is shown as &lt;REDACTED&gt; and never sent to the browser — leave that line
                    untouched to keep the current key, or replace it deliberately to rotate.
                  </div>
                </>
              ) : selectedPeer ? (
                <>
                  <div className="editor-toolbar">
                    <span className="filename">{selectedPeer.name}</span>
                    <ActionButton actionId="wireguard.peerRemove" params={{ peerName: selectedPeer.name }} label="Remove peer" className="danger" onApplied={refreshAll} />
                  </div>
                  <div style={{ padding: 16 }}>
                    <div className="grid">
                      <div className="stat-tile">
                        <div className="label">Status</div>
                        <div className="value" style={{ fontSize: 14 }}>
                          <StatusBadge status={peerStatus(selectedPeer.latestHandshake) === 'good' ? 'ok' : peerStatus(selectedPeer.latestHandshake) === 'warning' ? 'warn' : 'danger'}>
                            {STATUS[peerStatus(selectedPeer.latestHandshake)].label}
                          </StatusBadge>
                        </div>
                      </div>
                      <div className="stat-tile">
                        <div className="label">Allowed IPs</div>
                        <div className="value mono" style={{ fontSize: 13 }}>
                          {selectedPeer.allowedIps}
                        </div>
                      </div>
                      <div className="stat-tile">
                        <div className="label">Endpoint</div>
                        <div className="value mono" style={{ fontSize: 13 }}>
                          {selectedPeer.endpoint || 'none'}
                        </div>
                      </div>
                      <div className="stat-tile">
                        <div className="label">RX / TX</div>
                        <div className="value mono" style={{ fontSize: 13 }}>
                          {selectedPeer.rxBytes} / {selectedPeer.txBytes}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="editor-placeholder">Select wg0.conf or a peer on the left.</div>
              )}
            </div>
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
