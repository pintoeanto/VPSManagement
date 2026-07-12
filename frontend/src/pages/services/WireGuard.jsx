import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';
import { NetworkRadar } from '../../components/NetworkRadar.jsx';
import { NetworkTopology } from '../../components/NetworkTopology.jsx';
import { NetworkIsometric } from '../../components/NetworkIsometric.jsx';
import { NetworkList } from '../../components/NetworkList.jsx';
import { STATUS, peerStatus, isGatewayPeer, extraNetworks } from '../../lib/peerStatus.js';

const CHECK_TTL_MS = 5 * 60 * 1000;

function nextInterfaceName(interfaces) {
  const used = new Set(interfaces.map((i) => i.name));
  for (let n = 0; n < 1000; n++) {
    if (!used.has(`wg${n}`)) return `wg${n}`;
  }
  return 'wg0';
}

function formatRelativeTime(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 45_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// Diagnostic results for one tunnel — mirrors the NGINX route-check panel:
// config syntax, live up/down + peer-status breakdown, and a firewall check
// for the listen port (checked as udp — WireGuard's actual protocol).
function TunnelCheckResult({ result, checking, checkError, onRecheck }) {
  if (checkError && !result) {
    return (
      <div style={{ padding: 16 }}>
        <p className="error-text">{checkError}</p>
        <button onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Retry check'}
        </button>
      </div>
    );
  }
  if (!result) {
    return <div className="editor-placeholder">{checking ? 'Running checks…' : 'No check yet.'}</div>;
  }

  const counts = result.peerStatusCounts ?? { good: 0, warning: 0, critical: 0 };

  return (
    <div style={{ padding: 14, overflowY: 'auto' }}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="hint-text">Checked {formatRelativeTime(result.checkedAt ? new Date(result.checkedAt).getTime() : null)}</span>
        <button onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Recheck now'}
        </button>
      </div>
      {checkError && <p className="error-text">{checkError}</p>}

      <table>
        <tbody>
          <tr>
            <td>Interface state</td>
            <td>
              <StatusBadge status={result.up ? 'ok' : 'danger'}>{result.up ? 'Up' : result.upError || 'Down'}</StatusBadge>
            </td>
          </tr>
          <tr>
            <td>Config syntax</td>
            <td>
              <StatusBadge status={result.configSyntax.valid ? 'ok' : 'danger'}>{result.configSyntax.valid ? 'Valid' : 'Syntax error'}</StatusBadge>
              {!result.configSyntax.valid && result.configSyntax.output && (
                <pre className="mono hint-text" style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 11 }}>
                  {result.configSyntax.output}
                </pre>
              )}
            </td>
          </tr>
          <tr>
            <td>Listen port</td>
            <td className="mono">{result.listenPort ?? 'unknown'}</td>
          </tr>
          {result.firewall && (
            <tr>
              <td>Firewall (udp)</td>
              <td>
                <StatusBadge status={result.firewall.ufwAllowed ? 'ok' : 'warn'}>{result.firewall.ufwAllowed ? 'Firewall allows' : 'Not allowed in ufw'}</StatusBadge>{' '}
                <StatusBadge status={result.firewall.listening ? 'ok' : 'neutral'}>{result.firewall.listening ? 'Listening' : 'Not listening'}</StatusBadge>
              </td>
            </tr>
          )}
          <tr>
            <td>Peers</td>
            <td>
              <span className="mono">{result.peerCount}</span> total —{' '}
              <StatusBadge status="ok">{counts.good} connected</StatusBadge> <StatusBadge status="warn">{counts.warning} idle</StatusBadge>{' '}
              <StatusBadge status="danger">{counts.critical} offline</StatusBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function WireGuard() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('wireguard.detect', {}), 10000);
  const { data: interfacesData, refresh: refreshInterfaces } = usePolling(() => api.detectAction('wireguard.listInterfaces', {}), 8000);

  const [activeTab, setActiveTab] = useState('tunnels'); // 'tunnels' | 'peers'
  const [selectedInterface, setSelectedInterface] = useState(null);
  const [tunnelViewMode, setTunnelViewMode] = useState('check'); // 'check' | 'edit'
  const [selectedPeerName, setSelectedPeerName] = useState(null);
  const [networkView, setNetworkView] = useState('radar'); // 'radar' | 'topology' | 'isometric' | 'list'

  const [creatingTunnel, setCreatingTunnel] = useState(false);
  const [newInterfaceName, setNewInterfaceName] = useState('');
  const [newListenPort, setNewListenPort] = useState(51820);
  const [newServerAddress, setNewServerAddress] = useState('10.8.0.1/24');

  const [content, setContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [tunnelCheckCache, setTunnelCheckCache] = useState({}); // { [name]: { result, checkedAt } }
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);

  const [peerName, setPeerName] = useState('');
  const [allowedIps, setAllowedIps] = useState('10.8.0.2/32');
  const [peerGroup, setPeerGroup] = useState('');
  const [newPeer, setNewPeer] = useState(null);

  const [editingPeer, setEditingPeer] = useState(false);
  const [editPeerName, setEditPeerName] = useState('');
  const [editAllowedIps, setEditAllowedIps] = useState('');
  const [editGroup, setEditGroup] = useState('');

  const interfaces = interfacesData?.interfaces ?? [];

  const { data: status, refresh: refreshStatus } = usePolling(
    () => (selectedInterface ? api.detectAction('wireguard.status', { interfaceName: selectedInterface }) : Promise.resolve(null)),
    5000,
    [selectedInterface]
  );

  function refreshAll() {
    refreshDetect();
    refreshInterfaces();
    refreshStatus();
  }

  // Auto-select the first tunnel once the list loads, if nothing is selected yet.
  useEffect(() => {
    if (!selectedInterface && interfaces.length > 0) setSelectedInterface(interfaces[0].name);
  }, [interfaces, selectedInterface]);

  function selectTunnel(name) {
    setCreatingTunnel(false);
    setSaveError(null);
    setSelectedInterface(name);
    setTunnelViewMode('check');
  }

  async function runTunnelCheck(name, { force }) {
    if (!force) {
      const cached = tunnelCheckCache[name];
      if (cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return;
    }
    setChecking(true);
    setCheckError(null);
    try {
      const result = await api.detectAction('wireguard.checkTunnel', { interfaceName: name });
      setTunnelCheckCache((prev) => ({ ...prev, [name]: { result, checkedAt: Date.now() } }));
    } catch (err) {
      setCheckError(err.message || 'Check failed');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!selectedInterface || activeTab !== 'tunnels' || tunnelViewMode !== 'check') return;
    runTunnelCheck(selectedInterface, { force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInterface, activeTab, tunnelViewMode]);

  useEffect(() => {
    if (!selectedInterface || activeTab !== 'tunnels' || tunnelViewMode !== 'edit') return;
    let cancelled = false;
    setLoadingContent(true);
    api
      .detectAction('wireguard.getConfigRaw', { interfaceName: selectedInterface })
      .then((data) => !cancelled && setContent(data.content ?? ''))
      .catch((err) => !cancelled && setSaveError(err.message))
      .finally(() => !cancelled && setLoadingContent(false));
    return () => {
      cancelled = true;
    };
  }, [selectedInterface, activeTab, tunnelViewMode]);

  async function handleSaveConfig() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.applyAction('wireguard.setConfigRaw', { interfaceName: selectedInterface, content });
      refreshAll();
      setTunnelCheckCache((prev) => {
        const next = { ...prev };
        delete next[selectedInterface];
        return next;
      });
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function startCreateTunnel() {
    setCreatingTunnel(true);
    setActiveTab('tunnels');
    setNewInterfaceName(nextInterfaceName(interfaces));
    setNewListenPort(51820);
    setNewServerAddress('10.8.0.1/24');
  }

  async function handleCreateTunnel() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.applyAction('wireguard.initInterface', {
        interfaceName: newInterfaceName,
        listenPort: Number(newListenPort),
        serverAddress: newServerAddress,
      });
      refreshInterfaces();
      setCreatingTunnel(false);
      selectTunnel(newInterfaceName);
    } catch (err) {
      setSaveError(err.message || 'Failed to create tunnel');
    } finally {
      setSaving(false);
    }
  }

  async function handlePeerAdded(result) {
    if (result.result && !result.result.alreadySatisfied) {
      setNewPeer(result.result);
    }
    refreshAll();
  }

  function selectPeer(name) {
    setEditingPeer(false);
    setSelectedPeerName(name);
  }

  function startEditPeer(peer) {
    setEditPeerName(peer.name);
    setEditAllowedIps(peer.allowedIps);
    setEditGroup(peer.group || '');
    setEditingPeer(true);
  }

  const selectedPeer = (status?.peers ?? []).find((p) => p.name === selectedPeerName);
  const cachedCheck = selectedInterface ? tunnelCheckCache[selectedInterface] : null;

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

      {detect?.installed && (
        <>
          {status?.initialized && (
            <div className="panel">
              <div className="row between">
                <h2 style={{ margin: 0 }}>Interface — {selectedInterface}</h2>
                <div className="row wrap">
                  <ActionButton actionId="service.control" params={{ unit: `wg-quick@${selectedInterface}`, action: 'restart' }} label="Restart" onApplied={refreshAll} />
                  <ActionButton actionId="service.control" params={{ unit: `wg-quick@${selectedInterface}`, action: 'stop' }} label="Stop" className="danger" onApplied={refreshAll} />
                  <ActionButton actionId="service.control" params={{ unit: `wg-quick@${selectedInterface}`, action: 'start' }} label="Start" onApplied={refreshAll} />
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
          )}

          {(status?.peers?.length ?? 0) > 0 && (
            <div className="panel">
              <h2>Network</h2>
              <div className="view-tabs">
                <button className={networkView === 'radar' ? 'active' : ''} onClick={() => setNetworkView('radar')}>
                  Radar
                </button>
                <button className={networkView === 'topology' ? 'active' : ''} onClick={() => setNetworkView('topology')}>
                  Topology
                </button>
                <button className={networkView === 'isometric' ? 'active' : ''} onClick={() => setNetworkView('isometric')}>
                  Isometric
                </button>
                <button className={networkView === 'list' ? 'active' : ''} onClick={() => setNetworkView('list')}>
                  List
                </button>
              </div>
              {networkView === 'radar' && <NetworkRadar interfaceLabel={selectedInterface} peers={status.peers} />}
              {networkView === 'topology' && <NetworkTopology interfaceLabel={selectedInterface} peers={status.peers} />}
              {networkView === 'isometric' && <NetworkIsometric interfaceLabel={selectedInterface} peers={status.peers} />}
              {networkView === 'list' && <NetworkList peers={status.peers} />}
            </div>
          )}

          <div className="explorer-shell">
            <div className="explorer-sidebar">
              <div className="explorer-tabs">
                <button className={activeTab === 'tunnels' ? 'active' : ''} onClick={() => setActiveTab('tunnels')}>
                  TUNNELS
                </button>
                <button className={activeTab === 'peers' ? 'active' : ''} onClick={() => setActiveTab('peers')}>
                  PEERS
                </button>
              </div>

              {activeTab === 'tunnels' ? (
                <>
                  <div className="explorer-header">
                    <span>
                      {interfaces.length} tunnel{interfaces.length === 1 ? '' : 's'}
                    </span>
                    <button onClick={startCreateTunnel} title="New tunnel">
                      +
                    </button>
                  </div>
                  <div className="explorer-list">
                    {interfaces.map((i) => (
                      <div key={i.name} className={`explorer-item ${selectedInterface === i.name && !creatingTunnel ? 'active' : ''}`} onClick={() => selectTunnel(i.name)}>
                        <span className={`dot ${i.up ? 'on' : 'off'}`} title={i.up ? 'up' : 'down'} />
                        <span className="name">{i.name}</span>
                        <span className="hint-text" style={{ fontSize: 10 }}>
                          {i.peerCount}
                        </span>
                      </div>
                    ))}
                    {creatingTunnel && (
                      <div className="explorer-item active">
                        <span className="dot off" />
                        <input
                          autoFocus
                          value={newInterfaceName}
                          onChange={(e) => setNewInterfaceName(e.target.value)}
                          placeholder="wg1"
                          style={{ border: 'none', padding: 0, background: 'transparent' }}
                        />
                      </div>
                    )}
                    {interfaces.length === 0 && !creatingTunnel && <div className="explorer-empty">No tunnels yet. Click + to create one.</div>}
                  </div>
                </>
              ) : (
                <>
                  <div className="explorer-header">
                    <span>PEERS — {selectedInterface || 'none'}</span>
                    <span>{status?.peers?.length ?? 0}</span>
                  </div>
                  <div className="explorer-list">
                    {(status?.peers ?? []).map((p) => {
                      const st = peerStatus(p.latestHandshake);
                      return (
                        <div key={p.publicKey} className={`explorer-item ${selectedPeerName === p.name ? 'active' : ''}`} onClick={() => selectPeer(p.name)}>
                          <span className="dot" style={{ background: STATUS[st].color }} />
                          <span className="name">{p.name}</span>
                          {isGatewayPeer(p.allowedIps) && (
                            <span style={{ color: 'var(--accent-dim)', fontSize: 10 }} title="Routes an additional subnet">
                              ▲
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {(!status?.peers || status.peers.length === 0) && <div className="explorer-empty">No peers yet on this tunnel.</div>}
                  </div>
                </>
              )}
            </div>

            <div className="editor-pane">
              {activeTab === 'tunnels' ? (
                creatingTunnel ? (
                  <div style={{ padding: 16 }}>
                    <h2 style={{ marginTop: 0 }}>New tunnel — {newInterfaceName}</h2>
                    <div className="form-grid">
                      <div className="field">
                        <label>Listen port</label>
                        <input type="number" value={newListenPort} onChange={(e) => setNewListenPort(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>Server address (CIDR)</label>
                        <input value={newServerAddress} onChange={(e) => setNewServerAddress(e.target.value)} />
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="primary" onClick={handleCreateTunnel} disabled={saving || !newInterfaceName}>
                        {saving ? 'Creating…' : 'Create tunnel'}
                      </button>
                      <button onClick={() => setCreatingTunnel(false)} disabled={saving}>
                        Cancel
                      </button>
                    </div>
                    {saveError && <p className="error-text">{saveError}</p>}
                  </div>
                ) : selectedInterface ? (
                  <>
                    <div className="editor-toolbar">
                      <span className="filename">{selectedInterface}.conf</span>
                      <div className="row wrap">
                        <button className={tunnelViewMode === 'check' ? 'primary' : ''} onClick={() => setTunnelViewMode('check')}>
                          Tunnel check
                        </button>
                        <button className={tunnelViewMode === 'edit' ? 'primary' : ''} onClick={() => setTunnelViewMode('edit')}>
                          Edit config
                        </button>
                        {tunnelViewMode === 'edit' && (
                          <button className="primary" onClick={handleSaveConfig} disabled={saving || loadingContent}>
                            {saving ? 'Saving…' : 'Save'}
                          </button>
                        )}
                      </div>
                    </div>
                    {tunnelViewMode === 'edit' ? (
                      <>
                        {loadingContent ? (
                          <div className="editor-placeholder">Loading…</div>
                        ) : (
                          <textarea className="editor-textarea" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} disabled={saving} />
                        )}
                        {saveError && <div className="editor-error">{saveError}</div>}
                        <div className="editor-error" style={{ background: 'transparent', color: 'var(--text-dim)' }}>
                          The server's private key is shown as &lt;REDACTED&gt; and never sent to the browser — leave that
                          line untouched to keep the current key, or replace it deliberately to rotate.
                        </div>
                      </>
                    ) : (
                      <TunnelCheckResult
                        result={cachedCheck?.result ?? null}
                        checking={checking}
                        checkError={checkError}
                        onRecheck={() => runTunnelCheck(selectedInterface, { force: true })}
                      />
                    )}
                  </>
                ) : (
                  <div className="editor-placeholder">Select a tunnel on the left, or click + to create one.</div>
                )
              ) : selectedPeer ? (
                <>
                  <div className="editor-toolbar">
                    <span className="filename">{selectedPeer.name}</span>
                    <div className="row wrap">
                      {editingPeer ? (
                        <>
                          <ActionButton
                            actionId="wireguard.peerUpdate"
                            params={() => ({
                              interfaceName: selectedInterface,
                              peerName: selectedPeer.name,
                              newPeerName: editPeerName,
                              allowedIps: editAllowedIps,
                              group: editGroup.trim() || undefined,
                            })}
                            label="Save"
                            className="primary"
                            disabled={!editPeerName || !editAllowedIps}
                            onApplied={() => {
                              setEditingPeer(false);
                              selectPeer(editPeerName);
                              refreshAll();
                            }}
                          />
                          <button onClick={() => setEditingPeer(false)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEditPeer(selectedPeer)}>Edit peer</button>
                          <ActionButton
                            actionId="wireguard.peerRemove"
                            params={{ interfaceName: selectedInterface, peerName: selectedPeer.name }}
                            label="Remove peer"
                            className="danger"
                            onApplied={refreshAll}
                          />
                        </>
                      )}
                    </div>
                  </div>
                  {editingPeer ? (
                    <div style={{ padding: 16 }}>
                      <p className="hint-text" style={{ marginTop: 0 }}>
                        The public key is fixed — renaming or changing group/allowed IPs never touches it.
                      </p>
                      <div className="form-grid">
                        <div className="field">
                          <label>Peer name</label>
                          <input value={editPeerName} onChange={(e) => setEditPeerName(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Allowed IPs (CIDR, comma-separated)</label>
                          <input value={editAllowedIps} onChange={(e) => setEditAllowedIps(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Group (optional)</label>
                          <input value={editGroup} onChange={(e) => setEditGroup(e.target.value)} placeholder="office" />
                        </div>
                      </div>
                    </div>
                  ) : (
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
                          <div className="label">Group</div>
                          <div className="value mono" style={{ fontSize: 13 }}>
                            {selectedPeer.group || 'none'}
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
                        {isGatewayPeer(selectedPeer.allowedIps) && (
                          <div className="stat-tile">
                            <div className="label">Additional networks</div>
                            <div className="value mono" style={{ fontSize: 13, color: 'var(--accent-dim)' }}>
                              ▲ {extraNetworks(selectedPeer.allowedIps).join(', ')}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="editor-placeholder">Select a peer on the left.</div>
              )}
            </div>
          </div>

          {selectedInterface && (
            <div className="panel">
              <h2>Add peer to {selectedInterface}</h2>
              <div className="form-grid">
                <div className="field">
                  <label>Peer name</label>
                  <input value={peerName} onChange={(e) => setPeerName(e.target.value)} placeholder="laptop" />
                </div>
                <div className="field">
                  <label>Allowed IPs (CIDR)</label>
                  <input value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="10.8.0.2/32" />
                </div>
                <div className="field">
                  <label>Group (optional)</label>
                  <input value={peerGroup} onChange={(e) => setPeerGroup(e.target.value)} placeholder="office" title="Clusters this peer with others sharing the same group in the network views" />
                </div>
              </div>
              <ActionButton
                actionId="wireguard.peerAdd"
                params={() => ({ interfaceName: selectedInterface, peerName, allowedIps, group: peerGroup.trim() || undefined })}
                label="Add peer"
                className="primary"
                disabled={!peerName || !allowedIps}
                onApplied={handlePeerAdded}
              />
            </div>
          )}

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

          {interfaces.length === 0 && !creatingTunnel && (
            <div className="panel">
              <h2>No tunnels yet</h2>
              <p className="hint-text">Create the first WireGuard tunnel (e.g. wg0) to get started.</p>
              <button className="primary" onClick={startCreateTunnel}>
                New tunnel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
