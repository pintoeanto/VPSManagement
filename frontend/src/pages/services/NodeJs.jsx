import { useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';

export function NodeJs() {
  const { data: detect, refresh } = usePolling(() => api.detectAction('nodejs.detect', {}), 10000);
  const [majorVersion, setMajorVersion] = useState(20);
  const [confirmOverride, setConfirmOverride] = useState(false);

  const conflict = detect?.installed && detect.major !== Number(majorVersion);

  return (
    <div>
      <h1 className="page-title">Node.js</h1>

      <div className="panel">
        <h2>Installed version</h2>
        <StatusBadge status={detect?.installed ? 'ok' : 'neutral'}>{detect?.installed ? detect.version : 'Not installed'}</StatusBadge>
      </div>

      <div className="panel">
        <h2>Install / change pinned version</h2>
        <div className="form-grid">
          <div className="field">
            <label>Major version</label>
            <select value={majorVersion} onChange={(e) => setMajorVersion(Number(e.target.value))}>
              {[18, 20, 22].map((v) => (
                <option key={v} value={v}>
                  {v}.x LTS
                </option>
              ))}
            </select>
          </div>
        </div>
        {conflict && (
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              id="confirm-override"
              type="checkbox"
              style={{ width: 'auto' }}
              checked={confirmOverride}
              onChange={(e) => setConfirmOverride(e.target.checked)}
            />
            <label htmlFor="confirm-override" style={{ margin: 0, textTransform: 'none' }}>
              Replace installed v{detect.major}.x with v{majorVersion}.x
            </label>
          </div>
        )}
        <ActionButton
          actionId="nodejs.install"
          params={() => ({ majorVersion, confirmOverride })}
          label={conflict ? 'Replace Node.js version' : 'Install Node.js'}
          className="primary"
          disabled={conflict && !confirmOverride}
          onApplied={refresh}
        />
      </div>
    </div>
  );
}
