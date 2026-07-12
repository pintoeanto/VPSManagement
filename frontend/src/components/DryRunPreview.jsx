export function DryRunPreview({ detect, plan }) {
  const changes = plan?.changes;
  return (
    <div>
      {plan?.description && <p>{plan.description}</p>}
      {Array.isArray(changes) && changes.length > 0 && (
        <ul>
          {changes.map((c, i) => (
            <li key={i} className="mono">
              {c}
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(changes) && changes.length === 0 && <p className="hint-text">No changes — already satisfied.</p>}
      <details style={{ marginTop: 10 }}>
        <summary className="hint-text">Detect result</summary>
        <pre className="code-block">{JSON.stringify(detect, null, 2)}</pre>
      </details>
    </div>
  );
}
