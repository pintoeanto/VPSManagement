import { Fragment, useState } from 'react';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { StatusBadge } from '../components/StatusBadge.jsx';

export function Audit() {
  const { data } = usePolling(() => api.auditLog(150), 10000);
  const [expanded, setExpanded] = useState(null);
  const [chain, setChain] = useState(null);

  async function verifyChain() {
    const result = await api.auditVerify();
    setChain(result);
  }

  return (
    <div>
      <h1 className="page-title">Audit Log</h1>

      <div className="panel">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Tamper-evident hash chain</h2>
          <button onClick={verifyChain}>Verify chain</button>
        </div>
        {chain && (
          <p style={{ marginTop: 10 }}>
            <StatusBadge status={chain.valid ? 'ok' : 'danger'}>{chain.valid ? 'Chain intact' : `Broken at entry ${chain.brokenAtId}`}</StatusBadge>
          </p>
        )}
      </div>

      <div className="panel">
        <h2>Recent entries</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((entry) => (
              <Fragment key={entry.id}>
                <tr>
                  <td className="mono hint-text">{new Date(entry.ts).toLocaleString()}</td>
                  <td>{entry.username ?? '—'}</td>
                  <td className="mono">{entry.action_id}</td>
                  <td>
                    <StatusBadge status={entry.success ? 'ok' : 'danger'}>{entry.success ? 'success' : 'failed'}</StatusBadge>
                  </td>
                  <td>
                    <button onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                      {expanded === entry.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
                {expanded === entry.id && (
                  <tr>
                    <td colSpan={5}>
                      <pre className="code-block">
                        {JSON.stringify({ params: entry.params, detect: entry.detect, result: entry.result, backupPath: entry.backup_path }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {(!data?.entries || data.entries.length === 0) && (
              <tr>
                <td colSpan={5} className="hint-text">
                  No audit entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
