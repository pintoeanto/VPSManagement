import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';
import { RouteConfiguratorPanel, dnsBadge } from '../../components/RouteConfiguratorPanel.jsx';

const CHECK_TTL_MS = 5 * 60 * 1000;

// A fuller, commented starting point than the blank "new site" default —
// meant to be downloaded, edited offline, and uploaded back (via the
// existing Upload button) rather than typed from scratch in the browser.
const NGINX_TEMPLATE = `# NGINX reverse-proxy server block template.
# Rename this file to your site's name and upload it (or paste it into a
# new site here), then fill in server_name/proxy_pass and adjust as needed.

server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example.com;

    # After issuing a TLS certificate for this hostname, NGINX/Certbot will
    # typically add a matching "listen 443 ssl;" server block (or Certbot
    # will extend this one) — leave this HTTP block in place either way,
    # so unencrypted requests still resolve (e.g. for redirects or the
    # ACME HTTP-01 challenge during future renewals).

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Uncomment for a backend that uses WebSockets (e.g. Vite/webpack
        # dev servers, chat/live-update apps):
        # proxy_set_header Upgrade $http_upgrade;
        # proxy_set_header Connection "upgrade";
    }
}
`;

function safeNameFromFilename(filename) {
  return filename
    .replace(/\.[^.]*$/, '') // drop extension
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 122);
}

// Best-effort extraction from a raw hand-written or tool-generated server
// block, just enough to seed the route configurator form for an on-demand
// test — the configurator's own validation is the source of truth, this is
// only a starting point so the user isn't re-typing hostname/backend by hand.
function parseSiteForConfigurator(content, fallbackName) {
  const serverNameMatch = content.match(/^\s*server_name\s+([^;]+);/m);
  const hostname = serverNameMatch
    ? (serverNameMatch[1].trim().split(/\s+/).find((n) => n !== '_') ?? '')
    : '';
  const proxyPassMatch = content.match(/proxy_pass\s+(https?):\/\/([^:/\s]+)(?::(\d+))?([^;\s]*)\s*;/);
  const backendProtocol = proxyPassMatch ? proxyPassMatch[1] : 'http';
  const backendHost = proxyPassMatch ? proxyPassMatch[2] : '';
  const backendPort = proxyPassMatch ? (proxyPassMatch[3] || (backendProtocol === 'https' ? '443' : '80')) : '';
  const backendBasePath = (proxyPassMatch && proxyPassMatch[4]) || '/';
  const websocketEnabled = /proxy_set_header\s+Upgrade/i.test(content);
  const ignoreBackendTlsErrors = /proxy_ssl_verify\s+off/i.test(content);
  return { name: fallbackName, hostname, backendProtocol, backendHost, backendPort, backendBasePath, websocketEnabled, ignoreBackendTlsErrors };
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

// Backup filenames carry a UTC timestamp as YYYYMMDDTHHMMSSZ.
function parseBackupTimestamp(ts) {
  if (!ts || ts.length !== 16) return null;
  const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function certBadge(certificate) {
  if (!certificate) return { variant: 'neutral', label: 'No SSL certificate — site is HTTP-only' };
  if (certificate.status === 'valid') {
    const soon = certificate.daysRemaining != null && certificate.daysRemaining < 14;
    return { variant: soon ? 'warn' : 'ok', label: `Valid — expires ${certificate.expiry} (${certificate.daysRemaining}d)` };
  }
  if (certificate.status === 'none') return { variant: 'neutral', label: 'No ssl_certificate directive found' };
  if (certificate.status === 'missing') return { variant: 'danger', label: 'Certificate file missing on disk' };
  if (certificate.status === 'unreadable') return { variant: 'warn', label: 'Certificate present but unreadable' };
  return { variant: 'danger', label: certificate.error || 'Could not determine certificate status' };
}

// Diagnostic results for one existing site — DNS/backend/firewall reuse the
// same checks the route configurator runs for candidates, plus checks only
// meaningful for an already-deployed site: NGINX syntax, certificate
// expiry, and an end-to-end fetch through NGINX itself (catches proxy_pass
// misconfigurations a backend-only check can't see).
function RouteCheckResult({ result, checking, checkError, onRecheck }) {
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
  if (!result.exists) {
    return (
      <div style={{ padding: 16 }}>
        <StatusBadge status="danger">This site's config file no longer exists</StatusBadge>
      </div>
    );
  }

  const cert = certBadge(result.certificate);

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
            <td>Hostnames</td>
            <td className="mono">{result.hostnames.length ? result.hostnames.join(', ') : <span className="hint-text">none found</span>}</td>
          </tr>
          <tr>
            <td>NGINX config syntax</td>
            <td>
              <StatusBadge status={result.configSyntax.valid ? 'ok' : 'danger'}>{result.configSyntax.valid ? 'Valid' : 'Syntax error'}</StatusBadge>
              {!result.configSyntax.valid && result.configSyntax.output && (
                <pre className="mono hint-text" style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 11 }}>
                  {result.configSyntax.output}
                </pre>
              )}
            </td>
          </tr>
          {result.dns && (
            <tr>
              <td>DNS</td>
              <td>
                <StatusBadge status={dnsBadge(result.dns.status).variant}>{dnsBadge(result.dns.status).label}</StatusBadge>{' '}
                <span className="hint-text mono">
                  {result.dns.resolvedAddresses.join(', ') || 'no records'} vs VPS {result.dns.vpsPublicIp ?? 'unknown'}
                </span>
              </td>
            </tr>
          )}
          {result.firewall.port80 && (
            <tr>
              <td>Port 80</td>
              <td>
                <StatusBadge status={result.firewall.port80.ufwAllowed ? 'ok' : 'warn'}>
                  {result.firewall.port80.ufwAllowed ? 'Firewall allows' : 'Not allowed in ufw'}
                </StatusBadge>{' '}
                <StatusBadge status={result.firewall.port80.listening ? 'ok' : 'neutral'}>
                  {result.firewall.port80.listening ? 'Listening' : 'Not listening'}
                </StatusBadge>
              </td>
            </tr>
          )}
          {result.firewall.port443 && (
            <tr>
              <td>Port 443</td>
              <td>
                <StatusBadge status={result.firewall.port443.ufwAllowed ? 'ok' : 'warn'}>
                  {result.firewall.port443.ufwAllowed ? 'Firewall allows' : 'Not allowed in ufw'}
                </StatusBadge>{' '}
                <StatusBadge status={result.firewall.port443.listening ? 'ok' : 'neutral'}>
                  {result.firewall.port443.listening ? 'Listening' : 'Not listening'}
                </StatusBadge>
              </td>
            </tr>
          )}
          {result.backend && (
            <>
              <tr>
                <td>Backend TCP</td>
                <td>
                  <StatusBadge status={result.backend.tcp.reachable ? 'ok' : 'danger'}>
                    {result.backend.tcp.reachable ? `Reachable (${result.backend.tcp.responseTimeMs}ms)` : result.backend.tcp.error}
                  </StatusBadge>
                </td>
              </tr>
              {result.backend.http && (
                <tr>
                  <td>Backend HTTP</td>
                  <td>
                    <StatusBadge status={result.backend.http.reachable ? (result.backend.http.tlsBypassed ? 'warn' : 'ok') : 'danger'}>
                      {result.backend.http.reachable
                        ? `HTTP ${result.backend.http.httpStatus}${result.backend.http.tlsBypassed ? ' (TLS verification bypassed)' : ''}`
                        : result.backend.http.error}
                    </StatusBadge>
                  </td>
                </tr>
              )}
            </>
          )}
          {cert && (
            <tr>
              <td>TLS certificate</td>
              <td>
                <StatusBadge status={cert.variant}>{cert.label}</StatusBadge>
              </td>
            </tr>
          )}
          {result.publicHttp && (
            <tr>
              <td>Public URL (through NGINX)</td>
              <td>
                <StatusBadge status={result.publicHttp.reachable ? 'ok' : 'danger'}>
                  {result.publicHttp.reachable ? `HTTP ${result.publicHttp.httpStatus}` : result.publicHttp.error}
                </StatusBadge>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Nginx() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('nginx.detect', {}), 10000);
  const { data: sitesData, refresh: refreshSites } = usePolling(() => api.detectAction('nginx.listSites', {}), 8000);

  const [activeTab, setActiveTab] = useState('sites'); // 'sites' | 'backups'

  const [selectedName, setSelectedName] = useState(null);
  const [viewMode, setViewMode] = useState('check'); // 'check' | 'edit' — meaningless while creatingNew
  const [content, setContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const fileInputRef = useRef(null);

  const [checkCache, setCheckCache] = useState({}); // { [siteName]: { result, checkedAt } }
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);

  const [allBackups, setAllBackups] = useState([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsError, setBackupsError] = useState(null);
  const [selectedBackup, setSelectedBackup] = useState(null); // { name, backupFilename }
  const [backupPreview, setBackupPreview] = useState('');
  const [backupPreviewLoading, setBackupPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(null);

  const [certEmail, setCertEmail] = useState('');

  const [configuratorPrefill, setConfiguratorPrefill] = useState(null);
  const [configuratorNonce, setConfiguratorNonce] = useState(0);
  const configuratorRef = useRef(null);

  const sites = sitesData?.sites ?? [];

  function refreshAll() {
    refreshDetect();
    refreshSites();
  }

  function selectSite(name) {
    setCreatingNew(false);
    setSaveError(null);
    setSelectedName(name);
    setViewMode('check');
  }

  async function runCheck(name, { force }) {
    if (!force) {
      const cached = checkCache[name];
      if (cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return;
    }
    setChecking(true);
    setCheckError(null);
    try {
      const result = await api.detectAction('nginx.checkSite', { name });
      setCheckCache((prev) => ({ ...prev, [name]: { result, checkedAt: Date.now() } }));
    } catch (err) {
      setCheckError(err.message || 'Check failed');
    } finally {
      setChecking(false);
    }
  }

  // Auto-runs (or reuses a fresh cached) check whenever the user lands on
  // the check view for a site — a manual "Recheck now" button covers the
  // on-demand case, this covers "don't make me remember to check".
  useEffect(() => {
    if (!selectedName || creatingNew || viewMode !== 'check') return;
    runCheck(selectedName, { force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedName, viewMode, creatingNew]);

  useEffect(() => {
    if (!selectedName || creatingNew || viewMode !== 'edit') return;
    let cancelled = false;
    setLoadingContent(true);
    api
      .detectAction('nginx.getSiteRaw', { name: selectedName })
      .then((data) => {
        if (!cancelled) setContent(data.content ?? '');
      })
      .catch((err) => !cancelled && setSaveError(err.message))
      .finally(() => !cancelled && setLoadingContent(false));
    return () => {
      cancelled = true;
    };
  }, [selectedName, creatingNew, viewMode]);

  useEffect(() => {
    if (activeTab !== 'backups') return;
    loadAllBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function loadAllBackups() {
    setBackupsLoading(true);
    setBackupsError(null);
    try {
      const data = await api.detectAction('nginx.listAllBackups', {});
      setAllBackups(data.backups ?? []);
    } catch (err) {
      setBackupsError(err.message || 'Failed to list backups');
    } finally {
      setBackupsLoading(false);
    }
  }

  function selectBackup(backup) {
    setSelectedBackup(backup);
    setRestoreError(null);
    setBackupPreviewLoading(true);
    api
      .detectAction('nginx.getBackup', { name: backup.name, backupFilename: backup.backupFilename })
      .then((data) => setBackupPreview(data.content ?? ''))
      .catch((err) => setRestoreError(err.message || 'Failed to load backup'))
      .finally(() => setBackupPreviewLoading(false));
  }

  async function handleRestoreBackup() {
    if (!selectedBackup) return;
    if (!confirm(`Restore ${selectedBackup.name} from ${selectedBackup.backupFilename}? The current live config will be backed up first.`)) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await api.applyAction('nginx.restoreBackup', selectedBackup);
      refreshAll();
      loadAllBackups();
      // Invalidate any cached check for this site — the config just changed.
      setCheckCache((prev) => {
        const next = { ...prev };
        delete next[selectedBackup.name];
        return next;
      });
      setActiveTab('sites');
      selectSite(selectedBackup.name);
      setSelectedBackup(null);
    } catch (err) {
      setRestoreError(err.message || 'Restore failed');
    } finally {
      setRestoring(false);
    }
  }

  function startNew() {
    setCreatingNew(true);
    setSelectedName(null);
    setNewName('');
    setContent('server {\n    listen 80;\n    server_name example.com;\n\n    location / {\n        \n    }\n}\n');
    setSaveError(null);
  }

  function cancelCreateNew() {
    setCreatingNew(false);
    setNewName('');
    setContent('');
    setSaveError(null);
  }

  // Switching back to "Route check" is enough to discard the edit — the
  // content-loading effect below refetches fresh from the server the next
  // time viewMode becomes 'edit' again, so the in-progress buffer is never
  // reused stale.
  function cancelEditConfig() {
    setSaveError(null);
    setViewMode('check');
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleDownloadTemplate() {
    const blob = new Blob([NGINX_TEMPLATE], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nginx-site-template.conf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCreatingNew(true);
      setSelectedName(null);
      setNewName(safeNameFromFilename(file.name));
      setContent(typeof reader.result === 'string' ? reader.result : '');
      setSaveError(null);
    };
    reader.onerror = () => setSaveError('Could not read that file');
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleSave() {
    const name = creatingNew ? newName.trim() : selectedName;
    if (!name) {
      setSaveError('Name is required');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api.applyAction('nginx.setSiteRaw', { name, content });
      refreshAll();
      setCreatingNew(false);
      setSelectedName(name);
      setCheckCache((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function handlePushToConfigurator() {
    const parsed = parseSiteForConfigurator(content, editingName || '');
    setConfiguratorPrefill(parsed);
    setConfiguratorNonce((n) => n + 1);
    configuratorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const editingName = creatingNew ? newName : selectedName;
  const cached = selectedName ? checkCache[selectedName] : null;

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

      <div className="explorer-shell">
        <div className="explorer-sidebar">
          <div className="explorer-tabs">
            <button className={activeTab === 'sites' ? 'active' : ''} onClick={() => setActiveTab('sites')}>
              SITES
            </button>
            <button className={activeTab === 'backups' ? 'active' : ''} onClick={() => setActiveTab('backups')}>
              BACKUPS
            </button>
          </div>

          {activeTab === 'sites' ? (
            <>
              <div className="explorer-header">
                <span>{sites.length} site{sites.length === 1 ? '' : 's'}</span>
                <div className="row" style={{ gap: 4 }}>
                  <button onClick={handleDownloadTemplate} title="Download a commented reverse-proxy config template to edit offline">
                    Template
                  </button>
                  <button onClick={handleUploadClick} title="Upload a config file">
                    Upload
                  </button>
                  <button onClick={startNew} title="New site">
                    +
                  </button>
                  <input ref={fileInputRef} type="file" accept=".conf,.txt,text/plain" style={{ display: 'none' }} onChange={handleFileSelected} />
                </div>
              </div>
              <div className="explorer-list">
                {sites.map((s) => (
                  <div key={s.name} className={`explorer-item ${selectedName === s.name && !creatingNew ? 'active' : ''}`} onClick={() => selectSite(s.name)}>
                    <span className={`dot ${s.enabled ? 'on' : 'off'}`} title={s.enabled ? 'enabled' : 'disabled'} />
                    <span className="name">{s.name}</span>
                  </div>
                ))}
                {creatingNew && (
                  <div className="explorer-item active">
                    <span className="dot off" />
                    <input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="new-site-name"
                      style={{ border: 'none', padding: 0, background: 'transparent' }}
                    />
                  </div>
                )}
                {sites.length === 0 && !creatingNew && <div className="explorer-empty">No sites yet. Click + to create one.</div>}
              </div>
            </>
          ) : (
            <>
              <div className="explorer-header">
                <span>{allBackups.length} backup{allBackups.length === 1 ? '' : 's'}</span>
                <button onClick={loadAllBackups} disabled={backupsLoading}>
                  {backupsLoading ? '…' : 'Refresh'}
                </button>
              </div>
              <div className="explorer-list">
                {backupsError && <div className="explorer-empty error-text">{backupsError}</div>}
                {!backupsLoading && !backupsError && allBackups.length === 0 && <div className="explorer-empty">No backups yet.</div>}
                {allBackups.map((b) => {
                  const when = parseBackupTimestamp(b.timestamp);
                  const active = selectedBackup?.backupFilename === b.backupFilename && selectedBackup?.name === b.name;
                  return (
                    <div key={b.backupFilename} className={`explorer-item ${active ? 'active' : ''}`} onClick={() => selectBackup(b)}>
                      <span className="name">
                        {b.name}
                        <br />
                        <span className="hint-text">{when ? when.toLocaleString() : b.timestamp}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="editor-pane">
          {activeTab === 'backups' ? (
            selectedBackup ? (
              <>
                <div className="editor-toolbar">
                  <span className="filename">
                    {selectedBackup.name} — {selectedBackup.backupFilename}
                  </span>
                  <div className="row wrap">
                    <button className="danger" onClick={handleRestoreBackup} disabled={restoring || backupPreviewLoading}>
                      {restoring ? 'Restoring…' : 'Restore this backup'}
                    </button>
                  </div>
                </div>
                {restoreError && <div className="editor-error">{restoreError}</div>}
                {backupPreviewLoading ? (
                  <div className="editor-placeholder">Loading…</div>
                ) : (
                  <textarea className="editor-textarea" value={backupPreview} readOnly spellCheck={false} />
                )}
              </>
            ) : (
              <div className="editor-placeholder">Select a backup on the left to preview or restore it.</div>
            )
          ) : creatingNew || selectedName ? (
            <>
              <div className="editor-toolbar">
                <span className="filename">{editingName || '(untitled — type a name on the left)'}</span>
                <div className="row wrap">
                  {creatingNew ? (
                    <>
                      <button className="primary" onClick={handleSave} disabled={saving || loadingContent}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={cancelCreateNew} disabled={saving}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button className={viewMode === 'check' ? 'primary' : ''} onClick={() => setViewMode('check')}>
                        Route check
                      </button>
                      <button className={viewMode === 'edit' ? 'primary' : ''} onClick={() => setViewMode('edit')}>
                        Edit config
                      </button>
                      {viewMode === 'edit' && (
                        <>
                          <button className="primary" onClick={handleSave} disabled={saving || loadingContent}>
                            {saving ? 'Saving…' : 'Save'}
                          </button>
                          <button onClick={cancelEditConfig} disabled={saving}>
                            Cancel
                          </button>
                        </>
                      )}
                      <ActionButton
                        actionId="nginx.certbotIssue"
                        params={() => ({ serverName: selectedName, email: certEmail || 'admin@example.com' })}
                        label="Issue TLS cert"
                        onApplied={() => {
                          refreshAll();
                          setCheckCache((prev) => {
                            const next = { ...prev };
                            delete next[selectedName];
                            return next;
                          });
                        }}
                      />
                      <ActionButton
                        actionId="nginx.removeSite"
                        params={{ serverName: selectedName }}
                        label="Disable"
                        className="danger"
                        onApplied={refreshAll}
                      />
                    </>
                  )}
                </div>
              </div>

              {viewMode === 'edit' || creatingNew ? (
                <>
                  {!creatingNew && (
                    <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
                      <button onClick={handlePushToConfigurator} disabled={loadingContent || !content} title="Parse this config's hostname/backend and test it in the route configurator below">
                        Test in Route Configurator
                      </button>
                    </div>
                  )}
                  {loadingContent ? (
                    <div className="editor-placeholder">Loading…</div>
                  ) : (
                    <textarea className="editor-textarea" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} disabled={saving} />
                  )}
                  {saveError && <div className="editor-error">{saveError}</div>}
                </>
              ) : (
                <RouteCheckResult
                  result={cached?.result ?? null}
                  checking={checking}
                  checkError={checkError}
                  onRecheck={() => runCheck(selectedName, { force: true })}
                />
              )}
            </>
          ) : (
            <div className="editor-placeholder">Select a site on the left, or click + to create one.</div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Let's Encrypt</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Certbot contact email</label>
          <input value={certEmail} onChange={(e) => setCertEmail(e.target.value)} placeholder="admin@example.com" />
        </div>
        <p className="hint-text">Used when issuing certs from the editor toolbar above.</p>
      </div>

      <div ref={configuratorRef}>
        <RouteConfiguratorPanel onDeployed={refreshAll} prefill={configuratorPrefill} prefillNonce={configuratorNonce} />
      </div>
    </div>
  );
}
