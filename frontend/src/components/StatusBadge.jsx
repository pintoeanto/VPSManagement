export function StatusBadge({ status, children }) {
  return <span className={`badge ${status}`}>{children}</span>;
}
