export function Meter({ percent }) {
  const p = Math.max(0, Math.min(100, percent));
  const cls = p > 90 ? 'danger' : p > 75 ? 'warn' : '';
  return (
    <div className="meter">
      <div className={`meter-fill ${cls}`} style={{ width: `${p}%` }} />
    </div>
  );
}
