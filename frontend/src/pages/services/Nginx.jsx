import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';

export function Nginx() {
  const { data: detect, refresh: refreshDetect } = usePolling(() => api.detectAction('nginx.detect', {}), 10000);
  const { data: sitesData, refresh: refreshSites } = usePolling(() => api.detectAction('nginx.listSites', {}), 8000);

  const [selectedName, setSelectedName] = useState(null);
  const [content, setContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');

  const [certEmail, setCertEmail] = useState('');

  const sites = sitesData?.sites ?? [];

  function refreshAll() {
    refreshDetect();
    refreshSites();
  }

  function selectSite(name) {
    setCreatingNew(false);
    setSaveError(null);
    setSelectedName(name);
  }

  useEffect(() => {
    if (!selectedName || creatingNew) return;
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
  }, [selectedName, creatingNew]);

  function startNew() {
    setCreatingNew(true);
    setSelectedName(null);
    setNewName('');
    setContent('server {\n    listen 80;\n    server_name example.com;\n\n    location / {\n        \n    }\n}\n');
    setSaveError(null);
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
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const editingName = creatingNew ? newName : selectedName;

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
          <div className="explorer-header">
            <span>SITES</span>
            <button onClick={startNew} title="New site">
              +
            </button>
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
        </div>

        <div className="editor-pane">
          {creatingNew || selectedName ? (
            <>
              <div className="editor-toolbar">
                <span className="filename">{editingName || '(untitled — type a name on the left)'}</span>
                <div className="row wrap">
                  <button className="primary" onClick={handleSave} disabled={saving || loadingContent}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {!creatingNew && selectedName && (
                    <>
                      <ActionButton
                        actionId="nginx.certbotIssue"
                        params={() => ({ serverName: selectedName, email: certEmail || 'admin@example.com' })}
                        label="Issue TLS cert"
                        onApplied={refreshAll}
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
              {loadingContent ? (
                <div className="editor-placeholder">Loading…</div>
              ) : (
                <textarea className="editor-textarea" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} disabled={saving} />
              )}
              {saveError && <div className="editor-error">{saveError}</div>}
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
    </div>
  );
}
