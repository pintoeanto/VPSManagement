import { useRef, useState } from 'react';
import { api, request } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function Files() {
  const [dir, setDir] = useState('.');
  const { data, refresh, error } = usePolling(() => api.listFiles(dir), 15000, [dir]);
  const fileInputRef = useRef(null);
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      await api.uploadFile(dir, file);
      refresh();
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(name) {
    const relPath = dir === '.' ? name : `${dir}/${name}`;
    if (!confirm(`Delete ${relPath}?`)) return;
    await api.deleteFile(relPath);
    refresh();
  }

  function enterDir(name) {
    setDir(dir === '.' ? name : `${dir}/${name}`);
  }

  function goUp() {
    if (dir === '.') return;
    const parts = dir.split('/');
    parts.pop();
    setDir(parts.length === 0 ? '.' : parts.join('/'));
  }

  return (
    <div>
      <h1 className="page-title">Files</h1>
      <div className="panel">
        <div className="row between" style={{ marginBottom: 12 }}>
          <div className="mono hint-text">jail:/{data?.dir ?? dir}</div>
          <div className="row">
            <button onClick={goUp} disabled={dir === '.'}>
              Up
            </button>
            <label className="primary" style={{ background: 'var(--accent-dim)', color: 'var(--accent-contrast)', padding: '6px 12px', borderRadius: 5, cursor: 'pointer' }}>
              {uploading ? 'Uploading…' : 'Upload'}
              <input ref={fileInputRef} type="file" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
            </label>
          </div>
        </div>
        {uploadError && <p className="error-text">{uploadError}</p>}
        {error && <p className="error-text">{error.message}</p>}

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((entry) => (
              <tr key={entry.name}>
                <td>
                  {entry.isDirectory ? (
                    <button onClick={() => enterDir(entry.name)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer' }}>
                      📁 {entry.name}
                    </button>
                  ) : (
                    entry.name
                  )}
                </td>
                <td>{entry.isDirectory ? '—' : formatBytes(entry.size)}</td>
                <td className="hint-text">{new Date(entry.modifiedAt).toLocaleString()}</td>
                <td>
                  {!entry.isDirectory && (
                    <div className="row wrap end">
                      <a href={api.fileDownloadUrl(dir === '.' ? entry.name : `${dir}/${entry.name}`)} target="_blank" rel="noreferrer">
                        <button>Download</button>
                      </a>
                      <ChecksumButton dir={dir} name={entry.name} />
                      <button className="danger" onClick={() => handleDelete(entry.name)}>
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {(!data?.entries || data.entries.length === 0) && (
              <tr>
                <td colSpan={4} className="hint-text">
                  Empty directory.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChecksumButton({ dir, name }) {
  const [sha, setSha] = useState(null);
  const [busy, setBusy] = useState(false);

  async function fetchChecksum() {
    setBusy(true);
    try {
      const relPath = dir === '.' ? name : `${dir}/${name}`;
      const data = await request(`/files/checksum?path=${encodeURIComponent(relPath)}`);
      setSha(data.sha256);
    } finally {
      setBusy(false);
    }
  }

  if (sha) return <span className="mono hint-text" title={sha}>{sha.slice(0, 12)}…</span>;
  return (
    <button onClick={fetchChecksum} disabled={busy}>
      {busy ? '…' : 'SHA-256'}
    </button>
  );
}
