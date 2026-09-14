/** Calculation state shared by all cut views, including source inspectors. */
export function SliceStatus({ pending, error, completedAt, ms, hasResult, onRecalculate }: {
  pending: boolean; error: string | null; completedAt: number | null;
  ms: number; hasResult: boolean; onRecalculate: () => void;
}) {
  return <div className="group" aria-label="Calculation status">
    {error ? <div className="derived" role="alert">Calculation failed: {error} {hasResult ? 'The previous result is shown. ' : ''}Exports are unavailable until a new calculation succeeds.</div>
      : <div className="derived" role="status">{pending
        ? `Calculating layers and supports…${hasResult ? ' Previous result shown.' : ''}`
        : completedAt !== null ? `Calculated ${new Date(completedAt).toLocaleTimeString('en-GB')} · ${(ms / 1000).toFixed(1)} s.`
          : 'No current calculation.'}</div>}
    <button type="button" className="btn btn-wide" disabled={pending} onClick={onRecalculate}>
      {pending ? 'Calculating…' : error ? 'Retry calculation' : 'Recalculate'}
    </button>
  </div>;
}
