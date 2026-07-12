import { useMemo, useState } from 'react';
import { StatusBadge } from './StatusBadge.jsx';
import { STATUS, STATUS_SEVERITY, peerStatus, formatHandshakeAge, formatBytes, isGatewayPeer, extraNetworks } from '../lib/peerStatus.js';

const badgeVariant = { good: 'ok', warning: 'warn', critical: 'danger' };

const COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'name', label: 'Name' },
  { key: 'allowedIps', label: 'Allowed IPs' },
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'latestHandshake', label: 'Last handshake' },
  { key: 'rxBytes', label: 'RX' },
  { key: 'txBytes', label: 'TX' },
];

function sortValue(peer, key) {
  if (key === 'status') return STATUS_SEVERITY[peerStatus(peer.latestHandshake)];
  return peer[key] ?? '';
}

/**
 * Dense sortable table — the ops-triage view: default sort is worst-status
 * first (critical, then warning, then good) so anything that needs
 * attention is already at the top, the same convention alarm lists use.
 */
export function NetworkList({ peers }) {
  const [sortKey, setSortKey] = useState('status');
  const [sortDir, setSortDir] = useState('asc');

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = useMemo(() => {
    const copy = [...peers];
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [peers, sortKey, sortDir]);

  if (peers.length === 0) {
    return <p className="hint-text">No peers yet.</p>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} onClick={() => toggleSort(c.key)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                {c.label}
                {sortKey === c.key && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const status = peerStatus(p.latestHandshake);
            return (
              <tr key={p.publicKey}>
                <td>
                  <StatusBadge status={badgeVariant[status]}>{STATUS[status].label}</StatusBadge>
                </td>
                <td className="mono">
                  {p.name}
                  {isGatewayPeer(p.allowedIps) && (
                    <span style={{ color: 'var(--accent-dim)', marginLeft: 5 }} title={`Routes: ${extraNetworks(p.allowedIps).join(', ')}`}>
                      ▸
                    </span>
                  )}
                </td>
                <td className="mono hint-text">{p.allowedIps}</td>
                <td className="mono hint-text">{p.endpoint || 'none'}</td>
                <td className="hint-text">{formatHandshakeAge(p.latestHandshake)}</td>
                <td className="mono hint-text">{formatBytes(p.rxBytes)}</td>
                <td className="mono hint-text">{formatBytes(p.txBytes)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
