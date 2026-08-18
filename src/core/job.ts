/**
 * Job composition.
 *
 * The layer that knows about all the other layers: it turns sliced geometry
 * and spacer plans into parts, hands them to the nester, and turns the result
 * into DXF and a build manifest. Everything below it stays independent and
 * separately validated; this file is the wiring.
 */

import { circleFitsInPart, groupContours } from './slice';
import type { Slice, SliceSet } from './slice';
import { circlePoints } from './rig';
import type { SpacerPlan } from './rig';
import { textStrokes, textWidth } from './font';
import { LAYER_CUT, LAYER_ENGRAVE } from './dxf';
import type { DxfDocument } from './dxf';
import type { PartGeometry, Sheet } from './nest';

/** Layer labels, e.g. L07. A layer cut into several pieces gets L07A, L07B. */
function layerLabel(slice: Slice, partIndex: number, partCount: number): string {
  const base = `L${String(slice.index).padStart(2, '0')}`;
  if (partCount <= 1) return base;
  return `${base}${String.fromCharCode(65 + partIndex)}`;
}

/**
 * Every cuttable part in the job.
 *
 * Rod holes are filtered through `circleFitsInPart` here as well as in the
 * preview: a hole that crosses a contour is not cuttable, and it must not
 * reach the DXF either.
 */
export function buildParts(
  set: SliceSet,
  spacers: SpacerPlan[],
  windows: { label: string; set: SliceSet }[] = [],
): PartGeometry[] {
  const parts: PartGeometry[] = [];

  for (const slice of set.slices) {
    const groups = groupContours(slice.contours);
    groups.forEach((group, i) => {
      parts.push({
        id: `slice-${slice.index}-${i}`,
        label: layerLabel(slice, i, groups.length),
        kind: 'slice',
        material: 'stock',
        outer: group.outer.points,
        holes: group.holes.map((h) => h.points),
        circles: slice.circles
          .filter((circle) => circleFitsInPart(group, circle))
          .map((circle) => ({ x: circle.x, y: circle.y, r: circle.r })),
        layer: slice.index,
      });
    });
  }

  for (const plan of spacers) {
    for (let i = 0; i < plan.total; i++) {
      parts.push({
        id: `spacer-${plan.rodId}-${i}`,
        label: plan.label.length <= 4 ? plan.label : 'SP',
        kind: 'spacer',
        material: 'stock',
        outer: circlePoints(0, 0, plan.outerR),
        outerCircle: { x: 0, y: 0, r: plan.outerR },
        holes: [],
        circles: [{ x: 0, y: 0, r: plan.innerR }],
      });
    }
  }

  // Window plugs are cut from something else, so they carry their own material
  // and never share a sheet with the stock.
  for (const window of windows) {
    for (const slice of window.set.slices) {
      const groups = groupContours(slice.contours);
      groups.forEach((group, i) => {
        parts.push({
          id: `window-${window.label}-${slice.index}-${i}`,
          label: `W${String(slice.index).padStart(2, '0')}${
            groups.length > 1 ? String.fromCharCode(65 + i) : ''
          }`,
          kind: 'window',
          material: 'window',
          outer: group.outer.points,
          holes: group.holes.map((h) => h.points),
          circles: [],
          layer: slice.index,
        });
      });
    }
  }

  return parts;
}

/** One nested sheet as a DXF document, in sheet coordinates. */
export function sheetToDxf(sheet: Sheet): DxfDocument {
  const doc: DxfDocument = { polylines: [], circles: [] };

  for (const part of sheet.parts) {
    const shift = (points: number[]) => {
      const out = new Array<number>(points.length);
      for (let i = 0; i < points.length; i += 2) {
        out[i] = points[i] + part.dx;
        out[i + 1] = points[i + 1] + part.dy;
      }
      return out;
    };

    if (part.outerCircle) {
      // An exact circle beats a polygon approximation of one.
      doc.circles.push({
        x: part.outerCircle.x + part.dx,
        y: part.outerCircle.y + part.dy,
        r: part.outerCircle.r,
        layer: LAYER_CUT,
      });
    } else {
      doc.polylines.push({ points: shift(part.outer), layer: LAYER_CUT, closed: true });
    }

    for (const hole of part.holes) {
      doc.polylines.push({ points: shift(hole), layer: LAYER_CUT, closed: true });
    }

    for (const circle of part.circles) {
      doc.circles.push({
        x: circle.x + part.dx,
        y: circle.y + part.dy,
        r: circle.r,
        layer: LAYER_CUT,
      });
    }

    if (part.labelAt && part.labelHeight > 0) {
      const strokes = textStrokes(
        part.label,
        part.labelAt[0] + part.dx,
        part.labelAt[1] + part.dy,
        part.labelHeight,
      );
      for (const stroke of strokes) {
        doc.polylines.push({ points: stroke, layer: LAYER_ENGRAVE, closed: false });
      }
    }
  }

  return doc;
}

/** Label strokes in part coordinates, for drawing the sheet preview. */
export function labelStrokes(part: Sheet['parts'][number]): number[][] {
  if (!part.labelAt || part.labelHeight <= 0) return [];
  return textStrokes(part.label, part.labelAt[0], part.labelAt[1], part.labelHeight);
}

export interface ManifestInput {
  set: SliceSet;
  sheets: Sheet[];
  spacers: SpacerPlan[];
  machineName: string;
  materialName: string;
  thickness: number;
  kerf: number;
  spacerHeight: number;
  spacerAchieved: number;
  version: string;
}

/**
 * The sheet of paper that goes to the workshop with the parts.
 *
 * Plain text on purpose: it gets printed, marked up with a pencil, and left
 * next to the pile of slices while the stack goes together.
 */
export function manifestText(input: ManifestInput): string {
  const { set, sheets, spacers } = input;
  const lines: string[] = [];

  const sheetOf = new Map<string, number>();
  for (const sheet of sheets) {
    for (const part of sheet.parts) sheetOf.set(part.id, sheet.index);
  }

  lines.push(`KERROS BUILD MANIFEST  v${input.version}`);
  lines.push('');
  lines.push(`Machine    ${input.machineName}`);
  lines.push(`Material   ${input.materialName}, ${input.thickness} mm, kerf ${input.kerf} mm`);
  lines.push(
    `Pitch      ${set.pitch.toFixed(2)} mm  (${input.thickness} mm sheet + ${input.spacerHeight} mm spacer)`,
  );
  if (Math.abs(input.spacerAchieved - input.spacerHeight) > 1e-6) {
    lines.push(
      `           WARNING: rings of ${input.thickness} mm give a ${input.spacerAchieved} mm gap, not ${input.spacerHeight} mm`,
    );
  }
  lines.push(`Layers     ${set.slices.length}`);
  lines.push(`Sheets     ${sheets.length}`);
  const byMaterial = new Map<string, number>();
  for (const sheet of sheets) {
    byMaterial.set(sheet.material, (byMaterial.get(sheet.material) ?? 0) + 1);
  }
  if (byMaterial.size > 1) {
    lines.push(
      `           ${Array.from(byMaterial.entries())
        .map(([m, n]) => `${n} ${m}`)
        .join(', ')}`,
    );
  }
  lines.push('');

  lines.push('LAYERS');
  lines.push('  #    z (mm)   parts  holes  sheet');
  for (const slice of set.slices) {
    const groups = groupContours(slice.contours);
    const ids = groups.map((_, i) => `slice-${slice.index}-${i}`);
    const on = Array.from(new Set(ids.map((id) => sheetOf.get(id)).filter(Boolean)));
    lines.push(
      `  ${String(slice.index).padStart(3)}  ${slice.z.toFixed(2).padStart(8)}  ` +
        `${String(groups.length).padStart(5)}  ${String(slice.circles.length).padStart(5)}  ` +
        `${on.join(',') || '-'}`,
    );
  }
  lines.push('');

  if (spacers.length > 0) {
    lines.push('SPACERS');
    for (const plan of spacers) {
      lines.push(
        `  ${plan.label}: ${plan.total} rings ` +
          `(${plan.gaps} gaps x ${plan.ringsPerGap}), ` +
          `bore ${(plan.innerR * 2).toFixed(2)} mm, outside ${(plan.outerR * 2).toFixed(2)} mm`,
      );
    }
    lines.push('');
  }

  lines.push('SHEETS');
  for (const sheet of sheets) {
    const labels = sheet.parts.map((p) => p.label).join(' ');
    lines.push(
      `  Sheet ${sheet.index} (${sheet.material} ${sheet.ordinal}): ` +
        `${sheet.parts.length} parts, ${(sheet.fill * 100).toFixed(0)}% of the bed`,
    );
    lines.push(`    ${labels}`);
  }
  lines.push('');
  lines.push('Assemble from L01 upward. Engraved numbers face up.');

  return lines.join('\n');
}

/** Width the label of a part will occupy, for laying out previews. */
export function labelWidthOf(label: string, height: number): number {
  return textWidth(label, height);
}
