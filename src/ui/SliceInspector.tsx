import { useEffect, useMemo, useRef } from 'react';
import { useKerros } from '../core/store';
import { groupContours } from '../core/slice';
import type { GapReport, Slice, SliceSet } from '../core/slice';

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
};

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

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width === 0 || height === 0) return;

      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

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

      // One path per part so holes punch through with even-odd filling. Rod
      // holes join the same path, so they read as material removed.
      for (const group of groupContours(slice.contours)) {
        const path = tracePath([group.outer, ...group.holes]);
        for (const circle of slice.circles) {
          path.moveTo(toScreenX(circle.x + circle.r), toScreenY(circle.y));
          path.arc(
            toScreenX(circle.x),
            toScreenY(circle.y),
            circle.r * scale,
            0,
            Math.PI * 2,
          );
        }
        ctx.fillStyle = COLORS.fill;
        ctx.fill(path, 'evenodd');
        ctx.strokeStyle = COLORS.cut;
        ctx.lineWidth = 1.5;
        ctx.stroke(path);
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
  }, [slice, extent, fitToLayer, widest, report]);

  const partCount = slice ? groupContours(slice.contours).length : 0;
  const holeCount = slice ? slice.contours.filter((c) => c.isHole).length : 0;
  const area = slice ? slice.contours.reduce((sum, c) => sum + c.area, 0) : 0;

  return (
    <div className="slice-view">
      <div className="slice-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} />
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
            </>
          ) : (
            'No layers'
          )}
        </span>
      </div>
    </div>
  );
}
