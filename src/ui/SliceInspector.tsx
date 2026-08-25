import { useEffect, useMemo, useRef, useState } from 'react';
// Aliased: the DOM has a `PointerEvent` of its own, and the two are not the
// same type. Naming it here keeps which one is meant obvious at the handlers.
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useKerros } from '../core/store';
import { groupContours, pointInRing } from '../core/slice';
import type { CircleHole, Contour, GapReport, Slice, SliceSet } from '../core/slice';

const COLORS = {
  background: '#121110',
  grid: '#241f1c',
  gridMajor: '#2f2926',
  axis: '#3a3330',
  fill: 'rgba(210, 200, 188, 0.10)',
  cut: '#e04a2f',
  ghost: 'rgba(210, 200, 188, 0.16)',
  label: '#9a918a',
  warn: '#d9a441',
  selected: '#f0b429',
};

/** How close to a hole's edge still counts as pointing at it, in screen pixels. */
const GRAB_SLOP_PX = 4;

/**
 * What the pointer is doing.
 *
 * A layer of intent rather than a drag handler, because a drag is not the only
 * thing that will want the left button here. A push brush belongs in this view
 * for the same reasons a drag does — one layer at a time, true scale, the
 * neighbours visible — and if the drag were wired straight into the canvas
 * events, the brush would be written on top of it and the two would argue over
 * the same button. Model mode already learned this: sculpting is a *mode*, and
 * orbit moves to the right button for its duration.
 */
type SliceTool = 'select';

interface DragState {
  owner: string;
  /** Where the pointer took hold, in model millimetres. */
  startX: number;
  startY: number;
  /** How far it has come since, mm. A delta needs no origin and cannot be in
   *  the wrong frame — which an attached fixture's stored position would be. */
  dx: number;
  dy: number;
  /** Released, waiting for the slices to catch up. */
  settling: boolean;
}

/** Screen and world agree only if they are derived once, so the draw records them. */
interface ViewTransform {
  width: number;
  height: number;
  scale: number;
  cx: number;
  cy: number;
}

/** Drawn margin around the fitted extent, as a fraction of the canvas. */
const FIT_MARGIN = 0.12;

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyExtent(): Extent {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function growExtent(extent: Extent, points: number[]) {
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < extent.minX) extent.minX = points[i];
    if (points[i] > extent.maxX) extent.maxX = points[i];
    if (points[i + 1] < extent.minY) extent.minY = points[i + 1];
    if (points[i + 1] > extent.maxY) extent.maxY = points[i + 1];
  }
}

function extentOf(slices: Slice[]): Extent | null {
  const extent = emptyExtent();
  let any = false;
  for (const slice of slices) {
    for (const contour of slice.contours) {
      growExtent(extent, contour.points);
      any = true;
    }
  }
  return any ? extent : null;
}

interface Props {
  slices: SliceSet | null;
  reports: GapReport[];
  ms: number;
  pending: boolean;
}

export function SliceInspector({ slices, reports, ms, pending }: Props) {
  const currentLayer = useKerros((s) => s.currentLayer);
  const fitToLayer = useKerros((s) => s.sliceFitToLayer);
  const setCurrentLayer = useKerros((s) => s.setCurrentLayer);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const selectFeature = useKerros((s) => s.selectFeature);
  const moveOriginWorldBy = useKerros((s) => s.moveOriginWorldBy);

  /**
   * The transform the last paint used.
   *
   * Written by the draw rather than computed twice. The scale depends on the
   * measured canvas, and a hit test that worked it out for itself would agree
   * with the picture only until one of the two was edited.
   */
  const viewRef = useRef<ViewTransform | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** The slice set that was on screen when a drag was released. */
  const settledAgainst = useRef<SliceSet | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hovering, setHovering] = useState(false);
  const tool: SliceTool = 'select';

  const total = slices?.slices.length ?? 0;
  const layerIndex = total > 0 ? Math.min(Math.max(currentLayer, 1), total) : 0;
  const slice = total > 0 ? slices!.slices[layerIndex - 1] : null;
  const report: GapReport | null = layerIndex > 0 ? (reports[layerIndex - 1] ?? null) : null;

  /**
   * The drawing extent.
   *
   * By default this is the whole model's footprint, held constant across every
   * layer. Stepping through a stack is how you read the form narrowing, and
   * refitting each layer to the canvas hides exactly that — a 20 mm cap would
   * fill the view the same as a 200 mm base. Fit-to-layer stays available for
   * inspecting detail on a small layer.
   */
  const modelExtent = useMemo(() => (slices ? extentOf(slices.slices) : null), [slices]);

  const extent = useMemo(() => {
    if (!slice) return null;
    if (!fitToLayer) return modelExtent;
    const own = emptyExtent();
    for (const contour of slice.contours) growExtent(own, contour.points);
    return own;
  }, [slice, fitToLayer, modelExtent]);

  /** The widest layer, drawn faintly as a reference outline. */
  const widest = useMemo(() => {
    if (!slices) return null;
    let best: Slice | null = null;
    let bestArea = -Infinity;
    for (const candidate of slices.slices) {
      const area = candidate.contours.reduce((sum, c) => sum + c.area, 0);
      if (area > bestArea) {
        bestArea = area;
        best = candidate;
      }
    }
    return best;
  }, [slices]);

  /**
   * Which features can be taken hold of here.
   *
   * Perforation is left out on purpose. Its holes are generated in their
   * hundreds and no single one has a position of its own — grabbing the one
   * under the cursor would drag the whole lattice by whichever hole happened to
   * be there, which is not what the gesture looks like it does. They carry an
   * owner anyway, because stamping it costs nothing and the pattern inspector
   * may want it later.
   */
  const grabbable = useMemo(() => {
    const out = new Set<string>();
    for (const f of features) {
      if (!f.enabled) continue;
      if (f.stage === 'PATTERN') continue;
      if (f.kind === 'rod' || f.stage === 'RIG') out.add(f.id);
    }
    return out;
  }, [features]);

  /** Screen point to model millimetres, through the transform the paint used. */
  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!canvas || !view) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return [
      (px - view.width / 2) / view.scale + view.cx,
      view.cy - (py - view.height / 2) / view.scale,
    ];
  };

  /**
   * What is under the point, preferring the smallest thing there.
   *
   * A socket hole can sit inside a Wago pocket, and pointing at the small one
   * should get the small one — the same rule the sheet view uses when a part
   * rests inside a ring's waste.
   */
  const hitAt = (wx: number, wy: number): string | null => {
    if (!slice) return null;
    const view = viewRef.current;
    const slop = view ? GRAB_SLOP_PX / view.scale : 0.5;

    let best: string | null = null;
    let bestSize = Infinity;

    for (const circle of slice.circles as CircleHole[]) {
      if (!circle.owner || !grabbable.has(circle.owner)) continue;
      const d = Math.hypot(wx - circle.x, wy - circle.y);
      if (d <= circle.r + slop && circle.r < bestSize) {
        best = circle.owner;
        bestSize = circle.r;
      }
    }

    for (const contour of slice.contours as Contour[]) {
      if (!contour.owner || !grabbable.has(contour.owner)) continue;
      if (!pointInRing(contour.points, wx, wy)) continue;
      const size = Math.sqrt(Math.abs(contour.area));
      if (size < bestSize) {
        best = contour.owner;
        bestSize = size;
      }
    }

    return best;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool !== 'select' || event.button !== 0) return;
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;

    const owner = hitAt(world[0], world[1]);
    if (!owner) return;

    selectFeature(owner);

    // The pointer's own starting point, not the feature's. Everything below is
    // a delta, so the hole is held exactly where it was grabbed for free.
    const state: DragState = {
      owner,
      startX: world[0],
      startY: world[1],
      dx: 0,
      dy: 0,
      settling: false,
    };
    dragRef.current = state;
    setDrag(state);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /**
   * Nothing is written to the store while the button is down.
   *
   * The first version wrote on every move and drew the preview as the distance
   * from the *stored* position — which the previous move had just updated, so
   * the offset was always about zero and the hole did not appear to move at
   * all. What did move was the slicing, 250 ms behind and restarted by every
   * write, so the hole sat still and then jumped when the hand stopped.
   *
   * A sculpt stroke had the same problem and the same answer: do not re-evaluate
   * during the drag. Draw the offset from where the feature was when the drag
   * began, and commit once on release.
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;

    const active = dragRef.current;
    if (!active || active.settling) {
      setHovering(hitAt(world[0], world[1]) !== null);
      return;
    }

    const next = {
      ...active,
      dx: Math.round((world[0] - active.startX) * 10) / 10,
      dy: Math.round((world[1] - active.startY) * 10) / 10,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!active || active.settling) return;

    if (active.dx === 0 && active.dy === 0) {
      // A click that selected something and moved nothing. Writing a zero move
      // would still touch the tree and cost a re-slice for no change.
      dragRef.current = null;
      setDrag(null);
      return;
    }
    moveOriginWorldBy(active.owner, active.dx, active.dy);

    /*
     * The offset stays on screen until the new slices arrive.
     *
     * Clearing it here would put the hole back where it started for the quarter
     * second the re-slice takes, and then jump it forward — the same flinch,
     * just moved to the end of the gesture.
     */
    const settling = { ...active, settling: true };
    dragRef.current = settling;
    setDrag(settling);
    settledAgainst.current = slices;
  };

  /** Drop the preview once the geometry underneath it has actually changed. */
  useEffect(() => {
    if (!dragRef.current?.settling) return;
    if (slices === settledAgainst.current) return;
    dragRef.current = null;
    setDrag(null);
  }, [slices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width === 0 || height === 0) return;

      // Only the drawing buffer is sized here. The element's layout size comes
      // from CSS: giving the canvas a pixel width makes it an intrinsic size
      // the grid has to honour, and since that width is measured back off the
      // grid the two grow each other until the layout falls apart.
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, width, height);

      if (!slice || !extent) return;

      const spanX = Math.max(extent.maxX - extent.minX, 1);
      const spanY = Math.max(extent.maxY - extent.minY, 1);
      const scale = Math.min(width / spanX, height / spanY) * (1 - FIT_MARGIN * 2);
      const cx = (extent.minX + extent.maxX) / 2;
      const cy = (extent.minY + extent.maxY) / 2;

      const toScreenX = (x: number) => width / 2 + (x - cx) * scale;
      const toScreenY = (y: number) => height / 2 - (y - cy) * scale;

      // The one place these numbers exist. Hit testing reads them back rather
      // than deriving its own, so the picture and the pointer cannot disagree.
      viewRef.current = { width, height, scale, cx, cy };

      // 10 mm grid, heavier every 50 mm.
      const gridSpan = Math.max(spanX, spanY) * 1.5;
      ctx.lineWidth = 1;
      for (let g = Math.floor((cx - gridSpan) / 10) * 10; g <= cx + gridSpan; g += 10) {
        ctx.strokeStyle = g % 50 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(toScreenX(g), 0);
        ctx.lineTo(toScreenX(g), height);
        ctx.stroke();
      }
      for (let g = Math.floor((cy - gridSpan) / 10) * 10; g <= cy + gridSpan; g += 10) {
        ctx.strokeStyle = g % 50 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, toScreenY(g));
        ctx.lineTo(width, toScreenY(g));
        ctx.stroke();
      }

      ctx.strokeStyle = COLORS.axis;
      ctx.beginPath();
      ctx.moveTo(toScreenX(0), 0);
      ctx.lineTo(toScreenX(0), height);
      ctx.moveTo(0, toScreenY(0));
      ctx.lineTo(width, toScreenY(0));
      ctx.stroke();

      const tracePath = (contours: { points: number[] }[]) => {
        const path = new Path2D();
        for (const contour of contours) {
          const pts = contour.points;
          path.moveTo(toScreenX(pts[0]), toScreenY(pts[1]));
          for (let i = 2; i < pts.length; i += 2) {
            path.lineTo(toScreenX(pts[i]), toScreenY(pts[i + 1]));
          }
          path.closePath();
        }
        return path;
      };

      if (!fitToLayer && widest && widest.index !== slice.index) {
        ctx.strokeStyle = COLORS.ghost;
        ctx.lineWidth = 1;
        ctx.stroke(tracePath(widest.contours));
      }

      /*
       * Slicing is debounced, so during a drag the geometry on screen is up to
       * a quarter of a second behind the hand. Offsetting the thing being
       * dragged by how far it has gone since costs nothing and is the
       * difference between dragging and pushing something sticky.
       */
      const liveDX = (owner?: string) => (drag && owner === drag.owner ? drag.dx : 0);
      const liveDY = (owner?: string) => (drag && owner === drag.owner ? drag.dy : 0);

      for (const group of groupContours(slice.contours)) {
        const path = tracePath([group.outer, ...group.holes]);
        for (const circle of slice.circles) {
          const ox = circle.x + liveDX(circle.owner);
          const oy = circle.y + liveDY(circle.owner);
          path.moveTo(toScreenX(ox + circle.r), toScreenY(oy));
          path.arc(toScreenX(ox), toScreenY(oy), circle.r * scale, 0, Math.PI * 2);
        }
        ctx.fillStyle = COLORS.fill;
        ctx.fill(path, 'evenodd');
        ctx.strokeStyle = COLORS.cut;
        ctx.lineWidth = 1.5;
        ctx.stroke(path);
      }

      // What is selected, so a click has visible consequences and the inspector
      // on the right is obviously about the thing under the cursor.
      if (selectedId) {
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 2;
        for (const circle of slice.circles) {
          if (circle.owner !== selectedId) continue;
          const ox = circle.x + liveDX(circle.owner);
          const oy = circle.y + liveDY(circle.owner);
          ctx.beginPath();
          ctx.arc(toScreenX(ox), toScreenY(oy), circle.r * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const contour of slice.contours) {
          if (contour.owner !== selectedId) continue;
          ctx.stroke(tracePath([contour]));
        }
      }

      // Ring the narrowest place so it can be found rather than hunted for.
      if (report?.tooThin && report.at) {
        ctx.strokeStyle = COLORS.warn;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(toScreenX(report.at[0]), toScreenY(report.at[1]), 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Scale bar, so the eye has something absolute to hold on to.
      const barLength = 10 * scale;
      ctx.strokeStyle = COLORS.label;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(16, height - 22);
      ctx.lineTo(16 + barLength, height - 22);
      ctx.moveTo(16, height - 26);
      ctx.lineTo(16, height - 18);
      ctx.moveTo(16 + barLength, height - 26);
      ctx.lineTo(16 + barLength, height - 18);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('10 mm', 16, height - 30);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [slice, extent, fitToLayer, widest, report, selectedId, drag]);

  const selected = features.find((f) => f.id === selectedId) ?? null;
  const selectedHere =
    selected !== null &&
    grabbable.has(selected.id) &&
    slice !== null &&
    (slice.circles.some((c) => c.owner === selected.id) ||
      slice.contours.some((c) => c.owner === selected.id));
  const selectedIsRod = selected?.kind === 'rod';

  const partCount = slice ? groupContours(slice.contours).length : 0;
  const holeCount = slice ? slice.contours.filter((c) => c.isHole).length : 0;
  const area = slice ? slice.contours.reduce((sum, c) => sum + c.area, 0) : 0;

  return (
    <div className="slice-view">
      <div className="slice-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ cursor: drag ? 'grabbing' : hovering ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHovering(false)}
        />
        {!slice ? (
          <div className="slice-placeholder">
            {pending ? 'Slicing…' : 'Nothing to slice. Add a shape first.'}
          </div>
        ) : null}
      </div>

      <div className="slice-bar">
        <button
          type="button"
          className="btn"
          disabled={layerIndex <= 1}
          onClick={() => setCurrentLayer(layerIndex - 1)}
        >
          ↓ Lower
        </button>
        <input
          type="range"
          min={1}
          max={Math.max(total, 1)}
          value={layerIndex || 1}
          disabled={total === 0}
          onChange={(e) => setCurrentLayer(Number(e.target.value))}
        />
        <button
          type="button"
          className="btn"
          disabled={total === 0 || layerIndex >= total}
          onClick={() => setCurrentLayer(layerIndex + 1)}
        >
          ↑ Higher
        </button>

        <span className="slice-readout">
          {slice ? (
            <>
              Layer {layerIndex} / {total} · z {slice.z.toFixed(2)} mm ·{' '}
              {partCount} {partCount === 1 ? 'part' : 'parts'}
              {holeCount > 0 ? ` · ${holeCount} holes` : ''} ·{' '}
              {area.toFixed(0)} mm² · sliced in {ms.toFixed(0)} ms
              {report?.tooThin ? (
                <span className="slice-warn">
                  {' '}
                  · narrowest feature {report.minGap.toFixed(2)} mm
                </span>
              ) : null}
              {selectedHere ? (
                <span className="slice-note">
                  {' '}
                  · {selected?.name}
                  {/*
                    A rod is one rod. Dragging its hole here looks like editing
                    this sheet and is not — the same rod goes through every
                    sheet it reaches, and they all move together. Better said
                    out loud than discovered on the bed.
                  */}
                  {selectedIsRod
                    ? ' — moving a rod moves it on every layer it reaches'
                    : ' — drag to move, or type exact numbers on the right'}
                </span>
              ) : null}
            </>
          ) : (
            'No layers'
          )}
        </span>
      </div>
    </div>
  );
}
