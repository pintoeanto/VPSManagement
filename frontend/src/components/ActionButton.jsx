import { useState } from 'react';
import { api } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { DryRunPreview } from './DryRunPreview.jsx';

/**
 * The standard way every mutating catalog action is triggered from the UI:
 * click -> fetch a dry-run plan (detect + plan, no mutation) -> show it in a
 * confirmation dialog -> only on explicit confirm does /apply actually run.
 */
export function ActionButton({ actionId, params, label, onApplied, className = '', disabled, confirmLabel }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);

  async function handleClick() {
    setError(null);
    setLoadingPlan(true);
    setOpen(true);
    try {
      const resolvedParams = typeof params === 'function' ? params() : params;
      const data = await api.planAction(actionId, resolvedParams);
      setPreview({ ...data, params: resolvedParams });
    } catch (err) {
      setError(err.message || 'Failed to compute plan');
    } finally {
      setLoadingPlan(false);
    }
  }

  async function handleConfirm() {
    setApplying(true);
    setError(null);
    try {
      const result = await api.applyAction(actionId, preview.params);
      setOpen(false);
      setPreview(null);
      if (onApplied) onApplied(result);
    } catch (err) {
      setError(err.message || 'Apply failed');
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <button className={className} onClick={handleClick} disabled={disabled}>
        {label}
      </button>
      {open && (
        <ConfirmDialog
          title={label}
          busy={applying}
          error={error}
          confirmLabel={confirmLabel || 'Apply'}
          confirmDisabled={loadingPlan || !preview}
          onCancel={() => {
            if (!applying) {
              setOpen(false);
              setPreview(null);
              setError(null);
            }
          }}
          onConfirm={handleConfirm}
        >
          {loadingPlan ? <p className="hint-text">Computing plan…</p> : preview && <DryRunPreview detect={preview.detect} plan={preview.plan} />}
        </ConfirmDialog>
      )}
    </>
  );
}
