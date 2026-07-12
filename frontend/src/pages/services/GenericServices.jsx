import { useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ActionButton } from '../../components/ActionButton.jsx';

function unitStatus(state) {
  if (!state?.found) return 'neutral';
  if (state.ActiveState === 'active') return 'ok';
  if (state.ActiveState === 'failed') return 'danger';
  return 'warn';
}

export function GenericServices() {
  const { data, refresh } = usePolling(() => api.detectAction('service.list', {}), 6000);
  const [logsUnit, setLogsUnit] = useState(null);
  const [logs, setLogs] = useState(null);
  const [logsError, setLogsError] = useState(null);

  async function viewLogs(unit) {
    setLogsUnit(unit);
    setLogs(null);
    setLogsError(null);
    try {
      const result = await api.applyAction('service.logs', { unit, lines: 100 });
      setLogs(result.result.lines);
    } catch (err) {
      setLogsError(err.message);
    }
  }

  return (
    <div>
      <h1 className="page-title">Services</h1>
      <div className="panel">
        <h2>Whitelisted units</h2>
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Status</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.units ?? []).map((s) => (
              <tr key={s.unit}>
                <td className="mono">{s.unit}</td>
                <td>
                  <StatusBadge status={unitStatus(s)}>{s.found ? s.ActiveState : 'not found'}</StatusBadge>
                </td>
                <td>{s.found ? s.UnitFileState : '—'}</td>
                <td>
                  <div className="row wrap end">
                    <ActionButton
                      actionId="service.control"
                      params={{ unit: s.unit, action: 'start' }}
                      label="Start"
                      onApplied={refresh}
                    />
                    <ActionButton
                      actionId="service.control"
                      params={{ unit: s.unit, action: 'stop' }}
                      label="Stop"
                      className="danger"
                      onApplied={refresh}
                    />
                    <ActionButton
                      actionId="service.control"
                      params={{ unit: s.unit, action: 'restart' }}
                      label="Restart"
                      onApplied={refresh}
                    />
                    <button onClick={() => viewLogs(s.unit)}>Logs</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {logsUnit && (
        <div className="panel">
          <h2>Recent logs — {logsUnit}</h2>
          {logsError && <p className="error-text">{logsError}</p>}
          {!logsError && !logs && <p className="hint-text">Loading…</p>}
          {logs && <pre className="code-block">{logs.join('\n')}</pre>}
        </div>
      )}
    </div>
  );
}
