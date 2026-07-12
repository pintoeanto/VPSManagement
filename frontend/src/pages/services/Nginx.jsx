import { useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';
import { RawConfigEditor } from '../../components/RawConfigEditor.jsx';

export function Nginx() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('nginx.detect', {}), 10000);
  const { data: sitesData, refresh: refreshSites } = usePolling(() => api.detectAction('nginx.listSites', {}), 8000);

  const [serverName, setServerName] = useState('');
  const [mode, setMode] = useState('static');
  const [listenPort, setListenPort] = useState(80);
  const [proxyPass, setProxyPass] = useState('');
  const [certEmail, setCertEmail] = useState('');
  const [editingSiteName, setEditingSiteName] = useState(null); // string (existing) or '' (new); null = closed

  function refreshAll() {
    refreshDetect();
    refreshSites();
  }

  const configureParams = () => ({
    serverName,
    mode,
    listenPort: Number(listenPort),
    ...(mode === 'proxy' ? { proxyPass } : {}),
  });

  return (
    <div>
      <h1 className="page-title">NGINX</h1>

      <div className="panel">
        <h2>Install state</h2>
        <div className="row between">
          <div>
            <StatusBadge status={detect?.installed ? 'ok' : 'neutral'}>
              {detect?.installed ? `Installed (${detect.version})` : 'Not installed'}
            </StatusBadge>
          </div>
          {!detect?.installed && <ActionButton actionId="nginx.install" params={{}} label="Install NGINX" className="primary" onApplied={refreshAll} />}
        </div>
      </div>

      <div className="panel">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Server blocks</h2>
          <button onClick={() => setEditingSiteName('')}>New raw config</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Server name</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(sitesData?.sites ?? []).map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td>
                <td>
                  <StatusBadge status={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'enabled' : 'disabled'}</StatusBadge>
                </td>
                <td>
                  <div className="row wrap end">
                    <button onClick={() => setEditingSiteName(s.name)}>Edit</button>
                    <ActionButton
                      actionId="nginx.certbotIssue"
                      params={() => ({ serverName: s.name, email: certEmail || 'admin@example.com' })}
                      label="Issue TLS cert"
                      onApplied={refreshAll}
                    />
                    <ActionButton
                      actionId="nginx.removeSite"
                      params={{ serverName: s.name }}
                      label="Disable"
                      className="danger"
                      onApplied={refreshAll}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {(!sitesData?.sites || sitesData.sites.length === 0) && (
              <tr>
                <td colSpan={3} className="hint-text">
                  No server blocks configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Create / update server block</h2>
        <div className="form-grid">
          <div className="field">
            <label>Server name</label>
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="example.com" />
          </div>
          <div className="field">
            <label>Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="static">Static site</option>
              <option value="proxy">Reverse proxy</option>
            </select>
          </div>
          <div className="field">
            <label>Listen port</label>
            <input type="number" value={listenPort} onChange={(e) => setListenPort(e.target.value)} />
          </div>
          {mode === 'proxy' && (
            <div className="field">
              <label>Proxy pass URL</label>
              <input value={proxyPass} onChange={(e) => setProxyPass(e.target.value)} placeholder="http://127.0.0.1:3001" />
            </div>
          )}
        </div>
        <ActionButton
          actionId="nginx.configureSite"
          params={configureParams}
          label="Apply server block"
          className="primary"
          disabled={!serverName || (mode === 'proxy' && !proxyPass)}
          onApplied={refreshAll}
        />
      </div>

      <div className="panel">
        <h2>Let's Encrypt</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Certbot contact email</label>
          <input value={certEmail} onChange={(e) => setCertEmail(e.target.value)} placeholder="admin@example.com" />
        </div>
        <p className="hint-text">Used when issuing certs from the server-block table above.</p>
      </div>

      {editingSiteName !== null && (
        <RawConfigEditor
          title={editingSiteName ? `Edit ${editingSiteName}` : 'New raw NGINX config'}
          getActionId="nginx.getSiteRaw"
          setActionId="nginx.setSiteRaw"
          name={editingSiteName}
          allowRename={!editingSiteName}
          onClose={() => setEditingSiteName(null)}
          onSaved={refreshAll}
        />
      )}
    </div>
  );
}
