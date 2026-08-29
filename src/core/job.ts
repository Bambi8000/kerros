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
import { commonScale } from './pdf';
import type { PdfPage, PdfPolyline } from './pdf';

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
  /**
   * What the spacer rings are cut from.
   *
   * `stock` while rings are the same sheet as the slices, which is the default
   * and what they always were. Once they have their own thickness they cannot
   * share a sheet with the stock — they are not even the same height of
   * material — so they get their own name and `nestByMaterial` puts them on
   * their own sheet with their own ordinal.
   */
  spacerMaterial = 'stock',
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
        material: spacerMaterial,
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
  // A graded stack has no single pitch, so the manifest prints what is there.
  // The gaps come from the plan, which is what was cut, not from what was asked.
  const gaps = set.planes.map((plane) => plane.gapAbove);
  const gapLow = gaps.length > 0 ? Math.min(...gaps) : 0;
  const gapHigh = gaps.length > 0 ? Math.max(...gaps) : 0;
  if (Math.abs(gapHigh - gapLow) > 1e-9) {
    lines.push(
      `Pitch      ${(input.thickness + gapLow).toFixed(2)}-${(input.thickness + gapHigh).toFixed(2)} mm  ` +
        `(${input.thickness} mm sheet + ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)} mm spacer, graded)`,
    );
  } else {
    lines.push(
      `Pitch      ${set.pitch.toFixed(2)} mm  (${input.thickness} mm sheet + ${gapLow.toFixed(2)} mm spacer)`,
    );
  }
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
      // The ring count per gap is a range now, not a number: a graded stack has
      // more rings at one end than the other, and the count you have to lay out
      // on the bench is the total.
      const perGap =
        plan.ringsMin === plan.ringsMax
          ? `${plan.gaps} gaps x ${plan.ringsMin}`
          : `${plan.gaps} gaps, ${plan.ringsMin}-${plan.ringsMax} each`;
      lines.push(
        `  ${plan.label}: ${plan.total} rings ` +
          `(${perGap}), ` +
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

/* ------------------------------------------------------------------ *
 * Assembly document
 *
 * A numbered stack is not self-explanatory once it is a pile of parts on a
 * bench, and the thing that is actually hard is **telling one part from
 * another** — not remembering the order. So the drawings are the document and
 * the table is the appendix, which is the other way round from the manifest.
 *
 * Deliberately built after a real lamp had been cut, because what it has to say
 * was a guess before there was a pile to sort.
 * ------------------------------------------------------------------ */

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;

interface Pen {
  push: (points: number[], width?: number, grey?: number, closed?: boolean) => void;
}

function penFor(polylines: PdfPolyline[]): Pen {
  return {
    push: (points, width = 0.25, grey = 0, closed = false) =>
      polylines.push({ points, width, grey, closed }),
  };
}

/** Draw a string as the strokes the engraver would burn. */
function write(pen: Pen, text: string, x: number, y: number, height: number, grey = 0): number {
  for (const stroke of textStrokes(text, x, y, height)) {
    pen.push(stroke, Math.max(height * 0.055, 0.15), grey);
  }
  return x + textWidth(text, height);
}

function boxOf(points: number[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export interface AssemblyInput extends ManifestInput {
  /** What one spacer ring is, mm, so a gap can be given in rings. */
  ringThickness: number;
  projectName: string;
}

/**
 * The pages that go to the bench with the parts.
 *
 * Page one is the stack: what it is made of, and a row per layer. The rest are
 * the drawings, every layer at **one scale** so a 40 mm ring and a 200 mm ring
 * are different sizes on the page — which is the whole trick, since fitting
 * each to its own box would make them identical and identifying them is the
 * job.
 */
export function assemblyDocument(input: AssemblyInput): PdfPage[] {
  const { set, sheets, spacers } = input;
  const pages: PdfPage[] = [];

  const sheetOf = new Map<string, number>();
  for (const sheet of sheets) {
    for (const part of sheet.parts) sheetOf.set(part.id, sheet.index);
  }

  /* --- page one: the stack --- */

  const first: PdfPolyline[] = [];
  const pen = penFor(first);
  let y = PAGE_H - MARGIN - 8;

  write(pen, 'KERROS ASSEMBLY', MARGIN, y, 8);
  y -= 8;
  write(pen, input.projectName.toUpperCase().slice(0, 40), MARGIN, y, 4.5, 0.35);
  y -= 10;

  const facts = [
    `MATERIAL ${input.materialName.toUpperCase()}  ${input.thickness} MM  KERF ${input.kerf} MM`,
    `LAYERS ${set.slices.length}   SHEETS ${sheets.length}   RINGS ${spacers.reduce(
      (n, p) => n + p.total,
      0,
    )}`,
  ];
  for (const fact of facts) {
    write(pen, fact, MARGIN, y, 3.4, 0.2);
    y -= 5.5;
  }
  y -= 4;

  pen.push([MARGIN, y, PAGE_W - MARGIN, y], 0.4, 0.4);
  y -= 7;

  const cols = [MARGIN, MARGIN + 18, MARGIN + 42, MARGIN + 66, MARGIN + 96, MARGIN + 126];
  const header = ['LAYER', 'Z MM', 'PARTS', 'HOLES', 'GAP ABOVE', 'SHEET'];
  header.forEach((h, i) => write(pen, h, cols[i], y, 3, 0.45));
  y -= 5.5;

  for (const slice of set.slices) {
    if (y < MARGIN + 8) break;
    const groups = groupContours(slice.contours);
    const on = Array.from(
      new Set(groups.map((_, i) => sheetOf.get(`slice-${slice.index}-${i}`)).filter(Boolean)),
    );
    const plane = set.planes.find((p) => Math.abs(p.z - slice.z) < 1e-9);
    // Rings rather than millimetres: a ring is what you pick up off the bench,
    // and half of one does not exist.
    const gap =
      plane && input.ringThickness > 0
        ? `${Math.round(plane.gapAbove / input.ringThickness)} RINGS`
        : plane
          ? `${plane.gapAbove.toFixed(1)} MM`
          : '-';

    const row = [
      `L${String(slice.index).padStart(2, '0')}`,
      slice.z.toFixed(1),
      String(groups.length),
      String(slice.circles.length),
      slice.index === set.slices[set.slices.length - 1].index ? '-' : gap,
      on.join(',') || '-',
    ];
    row.forEach((cell, i) => write(pen, cell, cols[i], y, 3.2));
    y -= 5;
  }

  pages.push({ width: PAGE_W, height: PAGE_H, polylines: first });

  /* --- the drawings --- */

  const drawings = set.slices.map((slice) => {
    const groups = groupContours(slice.contours);
    const rings: number[][] = [];
    for (const group of groups) {
      rings.push(group.outer.points);
      for (const hole of group.holes) rings.push(hole.points);
    }
    const all = rings.flat();
    return { slice, rings, box: boxOf(all.length > 0 ? all : [0, 0]) };
  });

  const COLS = 4;
  const ROWS = 5;
  const cellW = (PAGE_W - MARGIN * 2) / COLS;
  const cellH = (PAGE_H - MARGIN * 2) / ROWS;
  /*
   * The drawing gets a little over half its cell, and the label sits below
   * that. The first version gave it 0.68 and the number ran into the biggest
   * rings — which is worse than a small drawing, since the label is the part
   * being read.
   */
  const scale = commonScale(
    drawings.map((d) => d.box),
    cellW * 0.8,
    cellH * 0.55,
  );

  for (let start = 0; start < drawings.length; start += COLS * ROWS) {
    const polylines: PdfPolyline[] = [];
    const p = penFor(polylines);
    const batch = drawings.slice(start, start + COLS * ROWS);

    batch.forEach((drawing, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = MARGIN + cellW * (col + 0.5);
      const cy = PAGE_H - MARGIN - cellH * (row + 0.5) + cellH * 0.08;

      const mx = (drawing.box.minX + drawing.box.maxX) / 2;
      const my = (drawing.box.minY + drawing.box.maxY) / 2;

      for (const ring of drawing.rings) {
        const out = new Array<number>(ring.length);
        for (let k = 0; k < ring.length; k += 2) {
          out[k] = cx + (ring[k] - mx) * scale;
          out[k + 1] = cy + (ring[k + 1] - my) * scale;
        }
        p.push(out, 0.25, 0, true);
      }

      for (const circle of drawing.slice.circles) {
        const ring: number[] = [];
        for (let k = 0; k <= 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          ring.push(
            cx + (circle.x + Math.cos(a) * circle.r - mx) * scale,
            cy + (circle.y + Math.sin(a) * circle.r - my) * scale,
          );
        }
        p.push(ring, 0.2, 0.3, true);
      }

      const label = `L${String(drawing.slice.index).padStart(2, '0')}`;
      const labelW = textWidth(label, 5);
      write(p, label, cx - labelW / 2, cy - cellH * 0.43, 5);
    });

    pages.push({ width: PAGE_W, height: PAGE_H, polylines });
  }

  return pages;
}
