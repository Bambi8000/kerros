import { useEffect, useRef } from 'react';
import { useKerros } from '../core/store';
import { labelStrokes } from '../core/job';
import { clampPlacement, partAt, placedBox } from '../core/nest';
import type { PlacedPart, Sheet } from '../core/nest';
import type { SheetResult } from './useSheets';

const COLORS = {
  background: '#121110',
  bed: '#3f3a36',
  usable: '#6f6862',
  fill: 'rgba(210, 200, 188, 0.10)',
  fillSelected: 'rgba(224, 74, 47, 0.16)',
  cut: '#e04a2f',
  engrave: '#4a9fd8',
  pinned: '#d9a441',
  collision: '#d9a441',
  tight: '#8a7f6e',
  label: '#9a918a',
};

const MARGIN_FRACTION = 0.06;

/** Dragged positions land on this grid, mm. */
const DRAG_SNAP_MM = 0.5;
/** Arrow-key nudge, mm. Shift multiplies it. */
const NUDGE_MM = 1;
const NUDGE_COARSE_MM = 10;

interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Props {
  sheets: SheetResult;
  pending: boolean;
}

export function SheetView({ sheets, pending }: Props) {
  const machine = useKerros((s) => s.machine);
  const currentSheet = useKerros((s) => s.currentSheet);
  const setCurrentSheet = useKerros((s) => s.setCurrentSheet);
  const selectedPartId = useKerros((s) => s.selectedPartId);
  const selectPart = useKerros((s) => s.selectPart);
  const setPartPlacement = useKerros((s) => s.setPartPlacement);
  const clearPartPlacement = useKerros((s) => s.clearPartPlacement);
  const partPlacements = useKerros((s) => s.partPlacements);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ id: string; grabX: number; grabY: number } | null>(null);

  const total = sheets.sheets.length;
  const index = total > 0 ? Math.min(Math.max(currentSheet, 1), total) : 0;
  const sheet: Sheet | null = total > 0 ? sheets.sheets[index - 1] : null;

  const usableW = Math.max(machine.bedWidth - machine.margin * 2, 1);
  const usableH = Math.max(machine.bedHeight - machine.margin * 2, 1);

  const report = sheets.reports[index];
  const colliding = new Set(report?.colliding ?? []);
  const tight = new Set(report?.tight ?? []);
  const selected = sheet?.parts.find((p) => p.id === selectedPartId) ?? null;

  /** Move a part, snapped and clamped to the sheet. */
  const place = (part: PlacedPart, dx: number, dy: number) => {
    const snap = (v: number) => Math.round(v / DRAG_SNAP_MM) * DRAG_SNAP_MM;
    const [cx, cy] = clampPlacement(part, snap(dx), snap(dy), usableW, usableH);
    setPartPlacement(part.id, { sheet: index, dx: cx, dy: cy });
  };

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

      // The whole bed is always in view: nesting is about the bed, and a view
      // that framed the parts would hide the free space you are judging.
      const scale =
        Math.min(width / machine.bedWidth, height / machine.bedHeight) *
        (1 - MARGIN_FRACTION * 2);
      const offsetX = (width - machine.bedWidth * scale) / 2;
      const offsetY = (height + machine.bedHeight * scale) / 2;
      viewRef.current = { scale, offsetX, offsetY };

      const sx = (x: number) => offsetX + x * scale;
      const sy = (y: number) => offsetY - y * scale;

      ctx.strokeStyle = COLORS.bed;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        sx(-machine.margin),
        sy(usableH + machine.margin),
        machine.bedWidth * scale,
        machine.bedHeight * scale,
      );
      ctx.strokeStyle = COLORS.usable;
      ctx.strokeRect(sx(0), sy(usableH), usableW * scale, usableH * scale);

      if (!sheet) return;

      for (const part of sheet.parts) {
        const isSelected = part.id === selectedPartId;
        const isColliding = colliding.has(part.id);
        const isTight = !isColliding && tight.has(part.id);
        const path = new Path2D();

        const trace = (points: number[]) => {
          path.moveTo(sx(points[0] + part.dx), sy(points[1] + part.dy));
          for (let i = 2; i < points.length; i += 2) {
            path.lineTo(sx(points[i] + part.dx), sy(points[i + 1] + part.dy));
          }
          path.closePath();
        };

        trace(part.outer);
        for (const hole of part.holes) trace(hole);
        for (const circle of part.circles) {
          path.moveTo(sx(circle.x + part.dx + circle.r), sy(circle.y + part.dy));
          path.arc(
            sx(circle.x + part.dx),
            sy(circle.y + part.dy),
            circle.r * scale,
            0,
            Math.PI * 2,
          );
        }

        ctx.fillStyle = isSelected ? COLORS.fillSelected : COLORS.fill;
        ctx.fill(path, 'evenodd');
        ctx.strokeStyle = isColliding
          ? COLORS.collision
          : isTight
            ? COLORS.tight
            : COLORS.cut;
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke(path);

        // Engraved label, drawn as the strokes that will be burned.
        ctx.strokeStyle = COLORS.engrave;
        ctx.lineWidth = 1;
        for (const stroke of labelStrokes(part)) {
          ctx.beginPath();
          ctx.moveTo(sx(stroke[0] + part.dx), sy(stroke[1] + part.dy));
          for (let i = 2; i < stroke.length; i += 2) {
            ctx.lineTo(sx(stroke[i] + part.dx), sy(stroke[i + 1] + part.dy));
          }
          ctx.stroke();
        }

        // A pinned part gets a corner tick, so an automatic layout and a
        // deliberate one are never confused.
        if (part.pinned) {
          const box = placedBox(part);
          ctx.strokeStyle = COLORS.pinned;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx(box.minX), sy(box.minY) - 6);
          ctx.lineTo(sx(box.minX), sy(box.minY));
          ctx.lineTo(sx(box.minX) + 6, sy(box.minY));
          ctx.stroke();
        }
      }

      if (selected) {
        const box = placedBox(selected);
        ctx.strokeStyle = COLORS.pinned;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(
          sx(box.minX),
          sy(box.maxY),
          (box.maxX - box.minX) * scale,
          (box.maxY - box.minY) * scale,
        );
        ctx.setLineDash([]);
      }

      ctx.fillStyle = COLORS.label;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(
        `bed ${machine.bedWidth} × ${machine.bedHeight} mm · usable ${usableW} × ${usableH} mm · drag to place`,
        16,
        height - 14,
      );
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [sheet, machine, usableW, usableH, selectedPartId, partPlacements, sheets, report]);

  /* -------------------- dragging -------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sheet) return;

    const toSheet = (event: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const { scale, offsetX, offsetY } = viewRef.current;
      return [
        (event.clientX - rect.left - offsetX) / scale,
        (offsetY - (event.clientY - rect.top)) / scale,
      ];
    };

    const onPointerDown = (event: PointerEvent) => {
      const [x, y] = toSheet(event);
      const part = partAt(sheet, x, y);

      if (!part) {
        selectPart(null);
        return;
      }

      selectPart(part.id);
      dragRef.current = { id: part.id, grabX: x - part.dx, grabY: y - part.dy };
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const part = sheet.parts.find((p) => p.id === drag.id);
      if (!part) return;
      const [x, y] = toSheet(event);
      place(part, x - drag.grabX, y - drag.grabY);
    };

    const onPointerUp = (event: PointerEvent) => {
      dragRef.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [sheet, index, usableW, usableH, selectPart, setPartPlacement]);

  /* -------------------- keyboard -------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!selected) return;

      const step = event.shiftKey ? NUDGE_COARSE_MM : NUDGE_MM;
      let dx = selected.dx;
      let dy = selected.dy;

      if (event.key === 'ArrowLeft') dx -= step;
      else if (event.key === 'ArrowRight') dx += step;
      else if (event.key === 'ArrowDown') dy -= step;
      else if (event.key === 'ArrowUp') dy += step;
      else if (event.key === 'Escape') {
        selectPart(null);
        return;
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        clearPartPlacement(selected.id);
        event.preventDefault();
        return;
      } else {
        return;
      }

      place(selected, dx, dy);
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, index, usableW, usableH, clearPartPlacement, selectPart, setPartPlacement]);

  const unlabelled = sheet ? sheet.parts.filter((p) => !p.labelAt).length : 0;

  return (
    <div className="slice-view">
      <div className="slice-canvas-wrap slice-canvas-drag" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {!sheet ? (
          <div className="slice-placeholder">
            {pending ? 'Slicing…' : 'Nothing to nest yet. Add a shape first.'}
          </div>
        ) : null}
      </div>

      <div className="slice-bar">
        <button
          type="button"
          className="btn"
          disabled={index <= 1}
          onClick={() => setCurrentSheet(index - 1)}
        >
          ← Prev
        </button>
        <input
          type="range"
          min={1}
          max={Math.max(total, 1)}
          value={index || 1}
          disabled={total === 0}
          onChange={(e) => setCurrentSheet(Number(e.target.value))}
        />
        <button
          type="button"
          className="btn"
          disabled={total === 0 || index >= total}
          onClick={() => setCurrentSheet(index + 1)}
        >
          Next →
        </button>

        {selected ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={index <= 1}
              title="Move this part to the previous sheet"
              onClick={() =>
                setPartPlacement(selected.id, {
                  sheet: index - 1,
                  dx: selected.dx,
                  dy: selected.dy,
                })
              }
            >
              ⇤ sheet
            </button>
            <button
              type="button"
              className="btn"
              disabled={index >= total}
              title="Move this part to the next sheet"
              onClick={() =>
                setPartPlacement(selected.id, {
                  sheet: index + 1,
                  dx: selected.dx,
                  dy: selected.dy,
                })
              }
            >
              sheet ⇥
            </button>
            <button
              type="button"
              className="btn"
              disabled={!selected.pinned}
              title="Let the nester place this part again"
              onClick={() => clearPartPlacement(selected.id)}
            >
              Unpin
            </button>
          </>
        ) : null}

        <span className="slice-readout">
          {sheet ? (
            <>
              Sheet {index} / {total} · {sheet.parts.length} parts ·{' '}
              {(sheet.fill * 100).toFixed(0)}% of the bed
              {sheets.pinnedCount > 0 ? ` · ${sheets.pinnedCount} pinned` : ''}
              {selected ? (
                <>
                  {' '}
                  · {selected.label} at {selected.dx.toFixed(1)},{' '}
                  {selected.dy.toFixed(1)}
                </>
              ) : null}
              {colliding.size > 0 ? (
                <span className="slice-warn"> · {colliding.size} colliding</span>
              ) : null}
              {colliding.size === 0 && report && Number.isFinite(report.closest) ? (
                <span className={tight.size > 0 ? 'slice-note' : ''}>
                  {' '}
                  · closest {report.closest.toFixed(2)} mm
                </span>
              ) : null}
              {unlabelled > 0 ? (
                <span className="slice-warn"> · {unlabelled} unlabelled</span>
              ) : null}
              {sheets.unplaced.length > 0 ? (
                <span className="slice-warn">
                  {' '}
                  · {sheets.unplaced.length} too big for the bed
                </span>
              ) : null}
            </>
          ) : (
            'No sheets'
          )}
        </span>
      </div>
    </div>
  );
}
