import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

/**
 * Generic "open file, edit raw text, save" modal for any catalog action pair
 * that exposes a get/set-raw action (currently nginx.getSiteRaw /
 * nginx.setSiteRaw). Save goes straight to apply() — the backend still backs
 * up the previous file, validates before activating, and rolls back on
 * failure, so this is safe even though there's no dry-run preview step (a
 * text diff isn't a meaningful "plan" the way it is for the structured forms).
 */
export function RawConfigEditor({
  title,
  getActionId,
  setActionId,
  nameParamKey = 'name',
  name: initialName,
  allowRename = false,
  onClose,
  onSaved,
}) {
  const [name, setName] = useState(initialName || '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(!!initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!initialName) return;
    setLoading(true);
    api
      .detectAction(getActionId, { [nameParamKey]: initialName })
      .then((data) => setContent(data.content ?? data.currentContent ?? ''))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [initialName, getActionId, nameParamKey]);

  async function handleSave() {
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    try {
      await api.applyAction(setActionId, { [nameParamKey]: name.trim(), content });
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>

        {allowRename || !initialName ? (
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="site-name" disabled={saving} />
          </div>
        ) : (
          <p className="hint-text mono">{name}</p>
        )}

        {loading ? (
          <p className="hint-text">Loading current content…</p>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            disabled={saving}
            className="mono"
            style={{
              width: '100%',
              minHeight: 360,
              resize: 'vertical',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          />
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="row end" style={{ marginTop: 14 }}>
          <button onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Validating & saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
