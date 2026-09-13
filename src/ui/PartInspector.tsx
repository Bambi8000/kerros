import { useKerros } from '../core/store';
import { placedBox } from '../core/nest';
import { NumberField } from './NumberField';
import type { SheetResult } from './useSheets';

interface Props {
  sheets: SheetResult;
}

/**
 * The inspector for a part on a sheet.
 *
 * A part is not a feature: it has no parameters of its own, it is the output
 * of the tree. What it does have is a place on the bed and an angle, and those
 * are worth typing exact numbers into rather than only dragging.
 */
export function PartInspector({ sheets }: Props) {
  const currentSheet = useKerros((s) => s.currentSheet);
  const selectedPartId = useKerros((s) => s.selectedPartId);
  const setPartPlacement = useKerros((s) => s.setPartPlacement);
  const clearPartPlacement = useKerros((s) => s.clearPartPlacement);
  const fluteDirection = useKerros((s) => s.fluteDirection);

  const total = sheets.sheets.length;
  const index = total > 0 ? Math.min(Math.max(currentSheet, 1), total) : 0;
  const sheet = index > 0 ? sheets.sheets[index - 1] : null;
  const part = sheet?.parts.find((p) => p.id === selectedPartId) ?? null;

  if (!part) {
    return (
      <div className="inspector-empty">
        Click a part on the sheet to place it by hand. Drag to move, the knob
        above it to turn, arrow keys to nudge.
      </div>
    );
  }

  const box = placedBox(part);
  const rot = part.rot ?? 0;
  const report = sheets.reports[index];
  const colliding = report?.colliding.includes(part.id) ?? false;
  const tight = report?.tight.includes(part.id) ?? false;

  const move = (dx: number, dy: number, nextRot: number) => {
    setPartPlacement(part.id, { sheet: index, dx, dy, rot: nextRot });
  };

  return (
    <>
      <div className="group">
        <div className="group-head">{part.kind === 'spacer' ? 'Spacer' : 'Part'}</div>
        <div className="derived derived-strong">
          {part.label}
          <span className="derived-sub">
            {part.kind === 'spacer'
              ? 'spacer ring'
              : /^f\d+-/.test(part.id) ? `${part.id.split('-')[0]} / ${part.material}` : `layer ${part.layer ?? '-'}`}{' '}
            · sheet {index} · {(box.maxX - box.minX).toFixed(1)} ×{' '}
            {(box.maxY - box.minY).toFixed(1)} mm
          </span>
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <NumberField
          label="X"
          value={part.dx}
          unit="mm"
          step={0.5}
          onChange={(v) => move(v, part.dy, rot)}
        />
        <NumberField
          label="Y"
          value={part.dy}
          unit="mm"
          step={0.5}
          onChange={(v) => move(part.dx, v, rot)}
        />
        <NumberField
          label="Rotation"
          value={rot}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => move(part.dx, part.dy, v)}
        />
        <div className="derived">
          {part.pinned
            ? 'Pinned. It stays here when the job is nested again.'
            : 'Placed by the nester. Move or turn it and it becomes pinned.'}
        </div>
        <button
          type="button"
          className="btn btn-wide"
          disabled={!part.pinned}
          onClick={() => clearPartPlacement(part.id)}
        >
          Unpin, let the nester place it
        </button>
      </div>

      {fluteDirection !== 'none' ? (
        <div className="group">
          <div className="group-head">Against the grain</div>
          <div className="derived">
            Flutes run {fluteDirection}. This part is cut at{' '}
            {(((rot % 180) + 180) % 180).toFixed(1)}° to them, so its edge
            exposes the corrugation at that angle.
          </div>
        </div>
      ) : null}

      {colliding || tight ? (
        <div className="group">
          <div className="group-head">Clearance</div>
          {colliding ? (
            <div className="warn">
              This part's outline meets another. They will burn into each other.
            </div>
          ) : (
            <div className="derived">
              Closer to a neighbour than the part gap, but nothing overlaps.
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
