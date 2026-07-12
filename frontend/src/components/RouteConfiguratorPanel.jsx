import { useState } from 'react';
import { api } from '../api/client.js';
import { StatusBadge } from './StatusBadge.jsx';

function dnsBadge(status) {
  if (status === 'passed') return { variant: 'ok', label: 'Passed' };
  if (status === 'missing') return { variant: 'danger', label: 'Missing' };
  if (status === 'points_elsewhere') return { variant: 'danger', label: 'Points elsewhere' };
  if (status === 'multiple_records') return { variant: 'warn', label: 'Multiple records' };
  return { variant: 'neutral', label: 'Unknown' };
}

/**
 * Milestone 2 slice: hostname/DNS/backend/firewall validation + the
 * structured config generator + chicken-egg-safe TLS deploy, reachable
 * through the API built this round. This is a working single-page form,
 * not yet the full multi-step wizard (tabs, live progress stream, dashboard
 * cards) — that's the next milestone's UI polish pass.
 */
export function RouteConfiguratorPanel({ onDeployed }) {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [backendProtocol, setBackendProtocol] = useState('http');
  const [backendHost, setBackendHost] = useState('');
  const [backendPort, setBackendPort] = useState('');
  const [backendBasePath, setBackendBasePath] = useState('/');
  const [websocketEnabled, setWebsocketEnabled] = useState(false);

  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState(null);
  const [validateError, setValidateError] = useState(null);

  const [creating, setCreating] = useState(false);
  const [route, setRoute] = useState(null);
  const [createError, setCreateError] = useState(null);

  const [issueTls, setIssueTls] = useState(false);
  const [certbotEmail, setCertbotEmail] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null);
  const [deployError, setDeployError] = useState(null);

  async function handleValidate() {
    setValidating(true);
    setValidateError(null);
    try {
      const result = await api.nginxRoutes.validate({
        hostname,
        configFileName: validation?.suggestedConfigFileName,
        backendProtocol,
        backendHost,
        backendPort: backendPort ? Number(backendPort) : undefined,
        backendBasePath,
      });
      setValidation(result);
    } catch (err) {
      setValidateError(err.message || 'Validation failed');
    } finally {
      setValidating(false);
    }
  }

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const { route: created } = await api.nginxRoutes.create({
        name: name || hostname,
        publicHostname: hostname,
        configFileName: validation?.suggestedConfigFileName,
        backendProtocol,
        backendHost,
        backendPort: Number(backendPort),
        backendBasePath,
        websocketEnabled,
      });
      setRoute(created);
    } catch (err) {
      setCreateError(err.message || 'Create failed');
    } finally {
      setCreating(false);
    }
  }

  async function handleDeploy() {
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await api.nginxRoutes.deploy(route.id, { issueTls, certbotEmail: issueTls ? certbotEmail : undefined });
      setDeployResult(result);
      if (onDeployed) onDeployed();
    } catch (err) {
      setDeployError(err.message || 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="panel">
      <h2>Route configurator</h2>

      <div className="form-grid">
        <div className="field">
          <label>Display name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
        </div>
        <div className="field">
          <label>Public hostname</label>
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" />
        </div>
        <div className="field">
          <label>Backend protocol</label>
          <select value={backendProtocol} onChange={(e) => setBackendProtocol(e.target.value)}>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
        </div>
        <div className="field">
          <label>Backend host</label>
          <input value={backendHost} onChange={(e) => setBackendHost(e.target.value)} placeholder="10.200.200.2" />
        </div>
        <div className="field">
          <label>Backend port</label>
          <input type="number" value={backendPort} onChange={(e) => setBackendPort(e.target.value)} placeholder="5173" />
        </div>
        <div className="field">
          <label>Backend base path</label>
          <input value={backendBasePath} onChange={(e) => setBackendBasePath(e.target.value)} placeholder="/" />
        </div>
        <div className="field">
          <label>WebSocket support</label>
          <select value={websocketEnabled ? '1' : '0'} onChange={(e) => setWebsocketEnabled(e.target.value === '1')}>
            <option value="0">Disabled</option>
            <option value="1">Enabled</option>
          </select>
        </div>
      </div>

      {backendHost && backendPort && (
        <p className="hint-text mono">
          Backend URL: {backendProtocol}://{backendHost}:{backendPort}
          {backendBasePath}
        </p>
      )}

      <button onClick={handleValidate} disabled={validating || !hostname || !backendHost || !backendPort}>
        {validating ? 'Validating…' : 'Validate'}
      </button>
      {validateError && <p className="error-text">{validateError}</p>}

      {validation && (
        <div style={{ marginTop: 14 }}>
          <table>
            <tbody>
              <tr>
                <td>Hostname format</td>
                <td>
                  <StatusBadge status={validation.hostname.valid ? 'ok' : 'danger'}>
                    {validation.hostname.valid ? 'Valid' : validation.hostname.reason}
                  </StatusBadge>
                </td>
              </tr>
              <tr>
                <td>Duplicate hostname</td>
                <td>
                  <StatusBadge status={validation.hostname.duplicate ? 'danger' : 'ok'}>
                    {validation.hostname.duplicate ? 'Already exists' : 'Available'}
                  </StatusBadge>
                </td>
              </tr>
              {validation.hostname.nearMatches?.length > 0 && (
                <tr>
                  <td>Possible typo</td>
                  <td>
                    <StatusBadge status="warn">Similar to: {validation.hostname.nearMatches.join(', ')}</StatusBadge>
                  </td>
                </tr>
              )}
              <tr>
                <td>Configuration file name</td>
                <td>
                  <span className="mono">{validation.suggestedConfigFileName}</span>{' '}
                  {validation.configFileName.duplicate && <StatusBadge status="danger">Duplicate</StatusBadge>}
                </td>
              </tr>
              {validation.dns && (
                <tr>
                  <td>DNS</td>
                  <td>
                    <StatusBadge status={dnsBadge(validation.dns.status).variant}>{dnsBadge(validation.dns.status).label}</StatusBadge>{' '}
                    <span className="hint-text mono">
                      {validation.dns.resolvedAddresses.join(', ') || 'no records'} vs VPS {validation.dns.vpsPublicIp ?? 'unknown'}
                    </span>
                  </td>
                </tr>
              )}
              <tr>
                <td>Port 80</td>
                <td>
                  <StatusBadge status={validation.firewall.port80.ufwAllowed ? 'ok' : 'warn'}>
                    {validation.firewall.port80.ufwAllowed ? 'Firewall allows' : 'Not allowed in ufw'}
                  </StatusBadge>{' '}
                  <StatusBadge status={validation.firewall.port80.listening ? 'ok' : 'neutral'}>
                    {validation.firewall.port80.listening ? 'Listening' : 'Not listening'}
                  </StatusBadge>
                </td>
              </tr>
              <tr>
                <td>Port 443</td>
                <td>
                  <StatusBadge status={validation.firewall.port443.ufwAllowed ? 'ok' : 'warn'}>
                    {validation.firewall.port443.ufwAllowed ? 'Firewall allows' : 'Not allowed in ufw'}
                  </StatusBadge>{' '}
                  <StatusBadge status={validation.firewall.port443.listening ? 'ok' : 'neutral'}>
                    {validation.firewall.port443.listening ? 'Listening' : 'Not listening'}
                  </StatusBadge>
                </td>
              </tr>
              {validation.backend && (
                <>
                  <tr>
                    <td>Backend TCP</td>
                    <td>
                      <StatusBadge status={validation.backend.tcp.reachable ? 'ok' : 'danger'}>
                        {validation.backend.tcp.reachable ? `Reachable (${validation.backend.tcp.responseTimeMs}ms)` : validation.backend.tcp.error}
                      </StatusBadge>
                    </td>
                  </tr>
                  {validation.backend.http && (
                    <tr>
                      <td>Backend HTTP</td>
                      <td>
                        <StatusBadge status={validation.backend.http.reachable ? 'ok' : 'danger'}>
                          {validation.backend.http.reachable ? `HTTP ${validation.backend.http.httpStatus}` : validation.backend.http.error}
                        </StatusBadge>
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>

          {!route && (
            <div style={{ marginTop: 14 }}>
              <button className="primary" onClick={handleCreate} disabled={creating || validation.hostname.duplicate || validation.configFileName.duplicate}>
                {creating ? 'Creating…' : 'Create route'}
              </button>
              {createError && <p className="error-text">{createError}</p>}
            </div>
          )}
        </div>
      )}

      {route && (
        <div className="panel" style={{ marginTop: 14, background: 'var(--bg-panel-raised)' }}>
          <h2>
            Deploy — {route.public_hostname} (route #{route.id})
          </h2>
          <div className="form-grid">
            <div className="field">
              <label>Issue TLS certificate</label>
              <select value={issueTls ? '1' : '0'} onChange={(e) => setIssueTls(e.target.value === '1')}>
                <option value="0">No — HTTP only for now</option>
                <option value="1">Yes — webroot method</option>
              </select>
            </div>
            {issueTls && (
              <div className="field">
                <label>Certbot contact email</label>
                <input value={certbotEmail} onChange={(e) => setCertbotEmail(e.target.value)} placeholder="admin@example.com" />
              </div>
            )}
          </div>
          <button className="primary" onClick={handleDeploy} disabled={deploying || (issueTls && !certbotEmail)}>
            {deploying ? 'Deploying…' : 'Deploy'}
          </button>
          {deployError && <p className="error-text">{deployError}</p>}

          {deployResult && (
            <div style={{ marginTop: 12 }}>
              {deployResult.steps.map((s) => (
                <div key={s.step} className="row between" style={{ padding: '4px 0' }}>
                  <span className="mono">{s.step}</span>
                  <StatusBadge status={s.status === 'passed' ? 'ok' : 'danger'}>{s.status}</StatusBadge>
                </div>
              ))}
              <p className="hint-text" style={{ marginTop: 8 }}>
                {deployResult.tlsSuccess === false
                  ? 'Deployed over HTTP; TLS issuance failed — the site is still up on plain HTTP, see the step detail above.'
                  : deployResult.certificateStatus === 'valid'
                    ? `Live at https://${route.public_hostname}`
                    : `Live at http://${route.public_hostname}`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
