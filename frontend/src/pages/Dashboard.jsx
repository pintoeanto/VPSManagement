import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { Meter } from '../components/Meter.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function unitStatus(state) {
  if (!state?.found) return 'neutral';
  if (state.ActiveState === 'active') return 'ok';
  if (state.ActiveState === 'failed') return 'danger';
  return 'warn';
}

export function Dashboard() {
  const { data: metrics } = usePolling(() => api.metrics(), 5000);
  const { data: servicesData } = usePolling(() => api.detectAction('service.list', {}), 8000);

  const memUsedPct = metrics ? ((metrics.totalMemBytes - metrics.freeMemBytes) / metrics.totalMemBytes) * 100 : 0;

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>

      <div className="panel">
        <h2>System</h2>
        <div className="grid">
          <div className="stat-tile">
            <div className="label">Hostname</div>
            <div className="value" style={{ fontSize: 15 }}>
              {metrics?.hostname ?? '…'}
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">Load average (1/5/15m)</div>
            <div className="value" style={{ fontSize: 15 }}>
              {metrics ? metrics.loadAvg.map((n) => n.toFixed(2)).join(' / ') : '…'}
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">CPU cores</div>
            <div className="value">{metrics?.cpuCount ?? '…'}</div>
          </div>
          <div className="stat-tile">
            <div className="label">Uptime</div>
            <div className="value" style={{ fontSize: 15 }}>
              {formatUptime(metrics?.uptimeSeconds)}
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">Memory</div>
            <div className="value" style={{ fontSize: 15 }}>
              {metrics ? `${formatBytes(metrics.totalMemBytes - metrics.freeMemBytes)} / ${formatBytes(metrics.totalMemBytes)}` : '…'}
            </div>
            <Meter percent={memUsedPct} />
          </div>
        </div>
      </div>

      {metrics?.disks?.length > 0 && (
        <div className="panel">
          <h2>Disks</h2>
          <table>
            <thead>
              <tr>
                <th>Filesystem</th>
                <th>Size</th>
                <th>Used</th>
                <th>Avail</th>
                <th>Use%</th>
                <th>Mounted on</th>
              </tr>
            </thead>
            <tbody>
              {metrics.disks.map((d) => (
                <tr key={d.mounted}>
                  <td className="mono">{d.filesystem}</td>
                  <td>{d.size}</td>
                  <td>{d.used}</td>
                  <td>{d.avail}</td>
                  <td style={{ minWidth: 90 }}>
                    {d.usePercent}
                    <Meter percent={parseInt(d.usePercent, 10) || 0} />
                  </td>
                  <td className="mono">{d.mounted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h2>Managed services</h2>
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {(servicesData?.units ?? []).map((s) => (
              <tr key={s.unit}>
                <td className="mono">{s.unit}</td>
                <td>
                  <StatusBadge status={unitStatus(s)}>{s.found ? s.ActiveState : 'not found'}</StatusBadge>
                </td>
                <td>{s.found ? s.UnitFileState : '—'}</td>
                <td className="hint-text">{s.Description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
