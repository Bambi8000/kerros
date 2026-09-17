import type { SliceSet } from '../core/slice';
import { useKerros } from '../core/store';
export function AssemblyPartView({ set, pending }: { set: SliceSet | null; pending: boolean }) {
  const id = useKerros((s) => s.selectedId), index = useKerros((s) => s.currentLayer);
  const select = useKerros((s) => s.selectFeature), setIndex = useKerros((s) => s.setCurrentLayer);
  const indexed = set?.slices[Math.min(Math.max(index - 1, 0), (set?.slices.length || 1) - 1)];
  const slice = indexed?.part?.featureId === id ? indexed : set?.slices.find((s) => s.part?.id === id || s.part?.featureId === id) ?? indexed;
  const points = slice?.contours.flatMap((c) => c.points) ?? [0, 0, 100, 100];
  const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const pad = Math.max(w, h, 10) * 0.1;
  const path = slice?.contours.map((c) => c.points.reduce((out, value, i) => i % 2 ? out : `${out}${i === 0 ? 'M' : 'L'}${value},${-c.points[i + 1]} `, '') + 'Z').join(' ');
  return <section className="assembly-canvas assembly-part-view">
    <div className="assembly-overlay"><strong>Part</strong><select aria-label="Assembly part" value={slice?.part?.id ?? ''} onChange={(e) => { const selected = set!.slices.find(s => s.part?.id === e.target.value)!; select(selected.part!.featureId ?? selected.part!.id); setIndex(selected.index); }}>{set?.slices.map((s) => <option key={s.part?.id} value={s.part?.id}>{s.part?.label} · {s.part?.kind}</option>)}</select><span>{pending ? 'Rebuilding…' : 'Cut paths'}</span></div>
    <svg aria-label="Selected part cut drawing" viewBox={`${x0 - pad} ${-y0 - h - pad} ${w + 2 * pad} ${h + 2 * pad}`}><path d={path} fill="#ded2ba" fillRule="evenodd" stroke="#e04a2f" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg>
    <div className="assembly-caption"><strong>{slice?.part?.label}</strong> · {w.toFixed(1)} × {h.toFixed(1)} mm cut bounds<br />{slice?.part?.material}<br />Local sheet coordinates: U right, V up. All openings include laser kerf.</div>
  </section>;
}
