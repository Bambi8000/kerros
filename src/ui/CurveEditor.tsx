import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import type { CurveLoop, CurvePoint, CurveSketch } from '../core/curves';
import { copyCurveLoops, copyCurveSketch, curveBounds, curveNodeMode, curveSketchError, ellipseCurve, moveCurveNode, resizeCurveLoops, splitCurve } from '../core/curves';
import { useKerros } from '../core/store';
import { NumberField } from './NumberField';
import { curveKeyLabel } from './curveSession';

type Tool = 'select' | 'pen' | 'ellipse';
type Box = { x: number; y: number; w: number; h: number };
type Pick = { loop: number; node: number; part: 'point' | 'incoming' | 'outgoing' };
type Gesture = {
  kind: 'node' | 'pen' | 'ellipse' | 'pan'; pointer: number; start: CurvePoint; client: CurvePoint;
  loops: CurveLoop[]; sketch: CurveSketch; project: number; box: Box; pick?: Pick;
};

function curvePath(loop: CurveLoop, closed = true): string {
  if (!loop.length) return '';
  let path = `M ${loop[0].point.join(' ')}`;
  for (let i = 0; i < (closed ? loop.length : loop.length - 1); i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    path += ` C ${a.point[0] + a.outgoing[0]} ${a.point[1] + a.outgoing[1]} ${b.point[0] + b.incoming[0]} ${b.point[1] + b.incoming[1]} ${b.point[0]} ${b.point[1]}`;
  }
  return path + (closed ? ' Z' : '');
}

function fitBox(loops: CurveLoop[]): Box {
  try {
    const b = curveBounds(loops), span = Math.max(b.width, b.height, 20) * 1.35;
    return { x: b.cx - span / 2, y: -b.cy - span / 2, w: span, h: span };
  } catch { return { x: -60, y: -60, w: 120, h: 120 }; }
}

/** Local drawing preview during a gesture; one guarded project edit on release. */
export function CurveEditor({ feature, slices }: { feature: Feature; slices: SliceSet | null }) {
  const features = useKerros(s => s.features), selectedKey = useKerros(s => s.curveKeyId), project = useKerros(s => s.projectRevision);
  const update = useKerros(s => s.setCurveSketch), close = useKerros(s => s.closeCurveEditor);
  const radial = feature.params.profileMode === 'radial', axisX = Number(feature.params.axisX ?? 0);
  const keyId = radial ? null : selectedKey;
  const sketch = feature.sketch!, key = radial ? undefined : sketch.keys.find(k => k.id === keyId), source = key?.loops ?? sketch.base;
  const svg = useRef<SVGSVGElement>(null), gesture = useRef<Gesture | null>(null);
  const draftRef = useRef<CurveLoop[] | null>(null), penRef = useRef<CurveLoop | null>(null);
  const [draft, setDraft] = useState<CurveLoop[] | null>(null), [pen, setPen] = useState<CurveLoop | null>(null);
  const [tool, setTool] = useState<Tool>('select'), [append, setAppend] = useState(false), [selected, setSelected] = useState<Pick | null>(null);
  const [box, setBox] = useState(() => fitBox(source)), [size, setSize] = useState({ w: 800, h: 600 });
  const [message, setMessage] = useState(''), [history, setHistory] = useState<{ undo: CurveSketch[]; redo: CurveSketch[] }>({ undo: [], redo: [] });
  const owned = useRef(sketch), ownerProject = useRef(project);
  const loops = draft ?? source, unit = Math.max(box.w / size.w, box.h / size.h);
  const setDrawing = (value: CurveLoop[] | null) => { draftRef.current = value; setDraft(value); };
  const setPenDrawing = (value: CurveLoop | null) => { penRef.current = value; setPen(value); };
  const currentNode = selected ? loops[selected.loop]?.[selected.node] : undefined;

  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ w: Math.max(node.clientWidth, 1), h: Math.max(node.clientHeight, 1) }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (owned.current !== sketch || ownerProject.current !== project) {
      gesture.current = null; draftRef.current = null; penRef.current = null;
      setDraft(null); setPen(null); setSelected(null); setHistory({ undo: [], redo: [] }); setMessage('');
      owned.current = sketch; ownerProject.current = project;
    }
  }, [sketch, project]);

  const world = (event: ReactPointerEvent): CurvePoint => {
    const p = svg.current!.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
    const at = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [at.x, -at.y];
  };
  const commit = (next: CurveLoop[], expected = sketch) => {
    const live = useKerros.getState();
    if (live.projectRevision !== project || live.curveEditorId !== feature.id || live.curveKeyId !== selectedKey) return false;
    const changed = copyCurveSketch(expected);
    if (keyId) {
      const target = changed.keys.find(k => k.id === keyId);
      if (!target) return false;
      target.loops = copyCurveLoops(next);
    } else changed.base = copyCurveLoops(next);
    const error = curveSketchError(changed);
    if (error) { setMessage(`Not applied: ${error} Exports still use the last applied drawing. Adjust this drawing or press Esc to cancel.`); return false; }
    if (!update(feature.id, changed, expected)) { setMessage('The project changed during this edit. Please try again.'); return false; }
    owned.current = useKerros.getState().features.find(f => f.id === feature.id)!.sketch!;
    setHistory(h => ({ undo: [...h.undo.slice(-29), copyCurveSketch(expected)], redo: [] }));
    setDrawing(null); setMessage(''); return true;
  };
  const undo = (redo = false) => {
    const list = redo ? history.redo : history.undo, value = list.at(-1);
    if (!value || gesture.current || penRef.current) return;
    if (!update(feature.id, value, sketch)) { setMessage('The drawing changed outside this editor.'); return; }
    owned.current = useKerros.getState().features.find(f => f.id === feature.id)!.sketch!;
    setHistory(h => redo ? { undo: [...h.undo, copyCurveSketch(sketch)], redo: h.redo.slice(0, -1) }
      : { undo: h.undo.slice(0, -1), redo: [...h.redo, copyCurveSketch(sketch)] });
    setDrawing(null); setSelected(null); setMessage('');
  };
  const replaceLoop = (loop: CurveLoop, existing = loops): CurveLoop[] => append || !existing.length
    ? [...copyCurveLoops(existing), loop]
    : existing.map((old, i) => i === (selected?.loop ?? 0) ? loop : copyCurveLoops([old])[0]);
  const closePen = () => {
    const drawn = penRef.current;
    if (!drawn || drawn.length < 3) { setMessage('Place at least three points before closing the path.'); return; }
    const next = replaceLoop(drawn); setDrawing(next);
    if (commit(next)) { setPenDrawing(null); setTool('select'); setSelected(null); }
  };
  const begin = (event: ReactPointerEvent, pick?: Pick) => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault(); event.stopPropagation(); svg.current?.focus();
    const start = world(event), kind = event.button !== 0 ? 'pan' : tool === 'select' ? 'node' : tool;
    if (kind === 'node' && !pick) { setSelected(null); return; }
    if (kind === 'node') setSelected(pick!);
    if (kind === 'pen') {
      const existing = penRef.current ?? [];
      if (existing.length >= 3 && Math.hypot(start[0] - existing[0].point[0], start[1] - existing[0].point[1]) < 10 * unit) { closePen(); return; }
      if (existing.length >= 256) { setMessage('A curve can have at most 256 points.'); return; }
      setPenDrawing([...existing, { point: start, incoming: [0, 0], outgoing: [0, 0], smooth: false }]);
    }
    gesture.current = { kind, pointer: event.pointerId, start, client: [event.clientX, event.clientY], loops: copyCurveLoops(loops), sketch, project, box, pick };
    svg.current!.setPointerCapture(event.pointerId); setMessage('');
  };
  const move = (event: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const at = world(event);
    if (g.kind === 'pan') {
      setBox({ ...g.box, x: g.box.x - (event.clientX - g.client[0]) * unit, y: g.box.y - (event.clientY - g.client[1]) * unit }); return;
    }
    if (g.kind === 'pen') {
      const nodes = copyCurveLoops([penRef.current!])[0], last = nodes.at(-1)!;
      const dx = at[0] - g.start[0], dy = at[1] - g.start[1];
      last.incoming = [-dx, -dy]; last.outgoing = [dx, dy]; last.smooth = Math.hypot(dx, dy) > unit;
      setPenDrawing(nodes); return;
    }
    if (g.kind === 'ellipse') {
      let dx = at[0] - g.start[0], dy = at[1] - g.start[1];
      if (event.shiftKey) { const side = Math.max(Math.abs(dx), Math.abs(dy)); dx = (dx < 0 ? -1 : 1) * side; dy = (dy < 0 ? -1 : 1) * side; }
      if (Math.abs(dx) < 0.1 || Math.abs(dy) < 0.1) return;
      setDrawing(replaceLoop(ellipseCurve(g.start[0] + dx / 2, g.start[1] + dy / 2, Math.abs(dx) / 2, Math.abs(dy) / 2), g.loops)); return;
    }
    const p = g.pick!, next = copyCurveLoops(g.loops);
    next[p.loop] = moveCurveNode(next[p.loop], p.node, p.part, at); setDrawing(next);
  };
  const end = (event: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
    if (event.type === 'pointercancel' || useKerros.getState().projectRevision !== g.project) { setDrawing(null); setPenDrawing(null); return; }
    if ((g.kind === 'node' || g.kind === 'ellipse') && draftRef.current) {
      if (commit(draftRef.current, g.sketch) && g.kind === 'ellipse') { setTool('select'); setSelected(null); }
    }
  };
  const editNode = (fn: (loop: CurveLoop, at: number) => CurveLoop) => {
    if (!selected) return;
    const next = copyCurveLoops(loops); next[selected.loop] = fn(next[selected.loop], selected.node);
    setDrawing(next); commit(next);
  };
  const removeNode = () => {
    if (!selected) return;
    if (loops[selected.loop].length <= 3) { setMessage('A closed path needs at least three points.'); return; }
    editNode((loop, at) => loop.filter((_, i) => i !== at)); setSelected(null);
  };
  const changeTool = (value: Tool) => { gesture.current = null; setPenDrawing(null); setDrawing(null); setTool(value); setMessage(''); };
  const zoom = (factor: number) => setBox(b => ({ x: b.x + b.w * (1 - factor) / 2, y: b.y + b.h * (1 - factor) / 2, w: b.w * factor, h: b.h * factor }));
  let bounds: ReturnType<typeof curveBounds> | null = null;
  try { bounds = curveBounds(source); } catch { /* An invalid loaded drawing can be replaced with Ellipse or Pen. */ }
  const title = radial ? 'Radial side profile · radius → · height ↑' : key ? `Editing ${curveKeyLabel(feature, features, slices, key.z)}` : 'Editing base profile · repeats through the full height';
  const ghost = radial ? [] : sketch.keys.filter(k => k.id !== keyId).flatMap(k => k.loops);
  return <div className="curve-editor" onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); undo(event.shiftKey); }
    else if (event.key === 'Escape') { gesture.current = null; setPenDrawing(null); setDrawing(null); setTool('select'); setMessage('Edit cancelled.'); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeNode(); }
    else if (selected && currentNode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const delta = event.shiftKey ? 5 : 1;
      const p: CurvePoint = [currentNode.point[0] + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), currentNode.point[1] + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0)];
      editNode((loop, at) => moveCurveNode(loop, at, 'point', p));
    }
  }}>
    <div className="curve-toolbar">
      <strong>{title}</strong>
      <div className="curve-tool-row">
        {(['select', 'pen', 'ellipse'] as const).map(value => <button className={`btn${tool === value ? ' is-active' : ''}`} aria-pressed={tool === value} key={value} onClick={() => changeTool(value)}>{value === 'pen' ? 'Bézier pen' : value === 'ellipse' ? 'Ellipse / circle' : 'Select points'}</button>)}
        <label><input type="checkbox" checked={append} onChange={e => setAppend(e.target.checked)} /> Add loop / hole</label>
        <button className="btn" disabled={!history.undo.length || !!pen} onClick={() => undo()}>Undo</button>
        <button className="btn" disabled={!history.redo.length || !!pen} onClick={() => undo(true)}>Redo</button>
        <button className="btn" onClick={() => setBox(fitBox(loops))}>Fit drawing</button>
        <button className="btn" aria-label="Zoom in drawing" onClick={() => zoom(0.8)}>+</button>
        <button className="btn" aria-label="Zoom out drawing" onClick={() => zoom(1.25)}>−</button>
        <button className="btn" onClick={close}>View cuts</button>
      </div>
    </div>
    <div className="curve-canvas-wrap">
      <svg ref={svg} role="application" aria-label="Curve drawing canvas" tabIndex={0} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        onContextMenu={e => e.preventDefault()} onPointerDown={e => begin(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onLostPointerCapture={() => { if (gesture.current) { gesture.current = null; setDrawing(null); setPenDrawing(null); } }}>
        <defs><pattern id="curve-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="#302923" strokeWidth={unit} /></pattern></defs>
        <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="url(#curve-grid)" />
        <g transform="scale(1 -1)">
          <line x1={box.x} x2={box.x + box.w} y1={0} y2={0} stroke="#554536" strokeWidth={unit} />
          <line x1={0} x2={0} y1={-box.y} y2={-box.y - box.h} stroke="#554536" strokeWidth={unit} />
          {ghost.map((loop, i) => <path key={i} d={curvePath(loop)} fill="none" stroke="#66817b" strokeWidth={unit} opacity={0.3} pointerEvents="none" />)}
          <path d={loops.map(loop => curvePath(loop)).join(' ')} fill="#d0b690" fillOpacity={0.16} fillRule="evenodd" stroke="#e6bd82" strokeWidth={1.6 * unit} pointerEvents="none" />
          {radial && <g pointerEvents="none">
            <rect x={box.x} y={-box.y - box.h} width={Math.max(0, Math.min(box.w, axisX - box.x))} height={box.h} fill="#141211" opacity={0.65} />
            <line x1={axisX} x2={axisX} y1={-box.y} y2={-box.y - box.h} stroke="#82b4a0" strokeWidth={2 * unit} strokeDasharray={`${6 * unit} ${4 * unit}`} />
          </g>}
          {tool === 'select' && loops.map((loop, li) => loop.map((node, ni) => {
            const chosen = selected?.loop === li && selected.node === ni;
            return <g key={`${li}:${ni}`}>
              {chosen && (['incoming', 'outgoing'] as const).map(part => {
                const x = node.point[0] + node[part][0], y = node.point[1] + node[part][1];
                return <g key={part}><line x1={node.point[0]} y1={node.point[1]} x2={x} y2={y} stroke="#bd8972" strokeWidth={unit} />
                  <circle cx={x} cy={y} r={4.5 * unit} fill="#ba8c72" stroke="#201b17" strokeWidth={unit} role="button" aria-label={`${part === 'incoming' ? 'In' : 'Out'} handle ${ni + 1}`} onPointerDown={e => begin(e, { loop: li, node: ni, part })} />
                </g>;
              })}
              <circle cx={node.point[0]} cy={node.point[1]} r={(chosen ? 6 : 4.5) * unit} fill={chosen ? '#ffad69' : '#d6c4a8'} stroke="#201b17" strokeWidth={unit} role="button" tabIndex={0} aria-label={`Loop ${li + 1} point ${ni + 1}`} onFocus={() => setSelected({ loop: li, node: ni, part: 'point' })} onPointerDown={e => begin(e, { loop: li, node: ni, part: 'point' })} />
            </g>;
          }))}
          {pen && <g pointerEvents="none"><path d={curvePath(pen, false)} fill="none" stroke="#ffad69" strokeWidth={2 * unit} />{pen.map((node, i) => <circle key={i} cx={node.point[0]} cy={node.point[1]} r={5 * unit} fill={i === 0 ? '#82b4a0' : '#ffad69'} />)}</g>}
        </g>
        {radial && <text x={Math.max(box.x + 8 * unit, Math.min(axisX + 8 * unit, box.x + box.w - 120 * unit))} y={box.y + 20 * unit} fill="#82b4a0" fontSize={12 * unit} pointerEvents="none">Rotation axis · Z</text>}
      </svg>
    </div>
    <div className="curve-toolbar curve-bottom">
      <div className="curve-tool-row">
        {pen ? <button className="btn" disabled={pen.length < 3} onClick={closePen}>Close path</button> : <>
          <button className="btn" disabled={!selected} onClick={() => editNode((loop, at) => splitCurve(loop, at))}>Insert point after</button>
          <button className="btn" disabled={!selected} onClick={() => editNode((loop, at) => curveNodeMode(loop, at, true))}>Smooth point</button>
          <button className="btn" disabled={!selected} onClick={() => editNode((loop, at) => curveNodeMode(loop, at, false))}>Corner point</button>
          <button className="btn" disabled={!selected} onClick={removeNode}>Remove point</button>
          <button className="btn" disabled={!selected || loops.length < 2} onClick={() => { const next = loops.filter((_, i) => i !== selected?.loop); setDrawing(next); if (commit(next)) setSelected(null); }}>Remove loop</button>
        </>}
      </div>
      <div className="curve-dimensions">
        {currentNode && <><NumberField label="Point X" value={currentNode.point[0]} unit="mm" onChange={v => editNode((loop, at) => moveCurveNode(loop, at, 'point', [v, currentNode.point[1]]))} />
          <NumberField label={radial ? 'Point height' : 'Point Y'} value={currentNode.point[1]} unit="mm" onChange={v => editNode((loop, at) => moveCurveNode(loop, at, 'point', [currentNode.point[0], v]))} /></>}
        {bounds && <><NumberField label="Drawing width" value={bounds.width} unit="mm" min={0.1} onChange={v => { const next = resizeCurveLoops(source, v, bounds!.height); setDrawing(next); commit(next); }} />
          <NumberField label="Drawing height" value={bounds.height} unit="mm" min={0.1} onChange={v => { const next = resizeCurveLoops(source, bounds!.width, v); setDrawing(next); commit(next); }} /></>}
      </div>
      <div className="curve-help" role="status">{message || (tool === 'pen' ? 'Click for corners; drag for smooth handles. Close on the first point or use Close path. Esc cancels.' : tool === 'ellipse' ? 'Drag a bounding rectangle. Hold Shift for a circle. Replaces the selected loop unless Add loop / hole is checked.' : radial ? 'The right side of the axis generates the lamp; the shaded left side is retained but unused. Move Axis X in the inspector. Drag points or handles; right-drag pans. Grid: 10 mm.' : 'Drag points or handles. Arrow keys move a selected point 1 mm, Shift 5 mm. Right-drag pans. Other keys appear faintly. Grid: 10 mm. Drawing coordinates are local to this profile.')}</div>
    </div>
  </div>;
}
