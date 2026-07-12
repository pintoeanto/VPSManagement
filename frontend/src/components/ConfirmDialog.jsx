export function ConfirmDialog({ title, children, onCancel, onConfirm, confirmLabel = 'Apply', busy, error, confirmDisabled }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        {error && <p className="error-text">{error}</p>}
        <div className="row end" style={{ marginTop: 18 }}>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? 'Applying…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
