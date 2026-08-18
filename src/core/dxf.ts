/**
 * DXF R12 writer.
 *
 * R12 (AC1009) because that is what the target laser accepts, and because it
 * is small enough to write correctly by hand. Two things follow from that:
 *
 *   - LWPOLYLINE is R13+. Closed rings go out as POLYLINE with a VERTEX per
 *     point and a SEQEND, with group 66 = 1 to say vertices follow and
 *     group 70 = 1 to say the polyline is closed.
 *   - R12 has no real unit tag. Coordinates are simply millimetres, and
 *     $INSUNITS is written as a hint that newer readers will honour.
 *
 * Circles go out as CIRCLE entities rather than polygonised rings: a rod hole
 * is a circle, and giving the laser the exact primitive beats approximating it
 * with chords.
 *
 * DELIBERATE CONSTRAINT: no value imports. Node validators load this as the
 * real module.
 */

export const LAYER_CUT = 'CUT';
export const LAYER_ENGRAVE = 'ENGRAVE';

/** AutoCAD colour numbers: 1 is red, 5 is blue. Same pairing as the UI. */
const LAYER_COLORS: Record<string, number> = {
  [LAYER_CUT]: 1,
  [LAYER_ENGRAVE]: 5,
};

export interface DxfPolyline {
  /** Flat [x0, y0, x1, y1, ...] in mm. */
  points: number[];
  layer: string;
  /** Closed rings are the norm; open runs are used by engraved strokes. */
  closed?: boolean;
}

export interface DxfCircle {
  x: number;
  y: number;
  r: number;
  layer: string;
}

export interface DxfDocument {
  polylines: DxfPolyline[];
  circles: DxfCircle[];
}

/** Fixed notation, no exponents, and no negative zero. */
function fmt(value: number): string {
  const v = Math.abs(value) < 5e-5 ? 0 : value;
  return v.toFixed(4);
}

function pair(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

function extents(doc: DxfDocument) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polyline of doc.polylines) {
    for (let i = 0; i < polyline.points.length; i += 2) {
      minX = Math.min(minX, polyline.points[i]);
      maxX = Math.max(maxX, polyline.points[i]);
      minY = Math.min(minY, polyline.points[i + 1]);
      maxY = Math.max(maxY, polyline.points[i + 1]);
    }
  }
  for (const circle of doc.circles) {
    minX = Math.min(minX, circle.x - circle.r);
    maxX = Math.max(maxX, circle.x + circle.r);
    minY = Math.min(minY, circle.y - circle.r);
    maxY = Math.max(maxY, circle.y + circle.r);
  }

  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function layersUsed(doc: DxfDocument): string[] {
  const used = new Set<string>([LAYER_CUT, LAYER_ENGRAVE]);
  for (const polyline of doc.polylines) used.add(polyline.layer);
  for (const circle of doc.circles) used.add(circle.layer);
  return Array.from(used);
}

export function writeDxfR12(doc: DxfDocument): string {
  const box = extents(doc);
  const layers = layersUsed(doc);
  let out = '';

  out += pair(0, 'SECTION') + pair(2, 'HEADER');
  out += pair(9, '$ACADVER') + pair(1, 'AC1009');
  out += pair(9, '$INSUNITS') + pair(70, 4);
  out += pair(9, '$EXTMIN') + pair(10, fmt(box.minX)) + pair(20, fmt(box.minY)) + pair(30, fmt(0));
  out += pair(9, '$EXTMAX') + pair(10, fmt(box.maxX)) + pair(20, fmt(box.maxY)) + pair(30, fmt(0));
  out += pair(0, 'ENDSEC');

  out += pair(0, 'SECTION') + pair(2, 'TABLES');
  out += pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.length);
  for (const layer of layers) {
    out += pair(0, 'LAYER');
    out += pair(2, layer);
    out += pair(70, 0);
    out += pair(62, LAYER_COLORS[layer] ?? 7);
    out += pair(6, 'CONTINUOUS');
  }
  out += pair(0, 'ENDTAB') + pair(0, 'ENDSEC');

  out += pair(0, 'SECTION') + pair(2, 'ENTITIES');

  for (const polyline of doc.polylines) {
    const count = polyline.points.length / 2;
    if (count < 2) continue;
    const closed = polyline.closed !== false;

    out += pair(0, 'POLYLINE');
    out += pair(8, polyline.layer);
    out += pair(66, 1);
    out += pair(70, closed ? 1 : 0);
    out += pair(10, fmt(0)) + pair(20, fmt(0)) + pair(30, fmt(0));

    for (let i = 0; i < count; i++) {
      out += pair(0, 'VERTEX');
      out += pair(8, polyline.layer);
      out += pair(10, fmt(polyline.points[i * 2]));
      out += pair(20, fmt(polyline.points[i * 2 + 1]));
      out += pair(30, fmt(0));
    }

    out += pair(0, 'SEQEND');
    out += pair(8, polyline.layer);
  }

  for (const circle of doc.circles) {
    out += pair(0, 'CIRCLE');
    out += pair(8, circle.layer);
    out += pair(10, fmt(circle.x));
    out += pair(20, fmt(circle.y));
    out += pair(30, fmt(0));
    out += pair(40, fmt(circle.r));
  }

  out += pair(0, 'ENDSEC');
  out += pair(0, 'EOF');

  return out;
}

/* ------------------------------------------------------------------ *
 * Kerf test figure
 * ------------------------------------------------------------------ */

export interface KerfTestOptions {
  /** Outer square side, mm. */
  outerSize: number;
  /** Concentric square hole side, mm. */
  innerSize: number;
  /** Circular hole diameter, mm. */
  holeDiameter: number;
  /** Slot widths to try, mm. */
  slotWidths: number[];
  /** Slot length, mm. */
  slotLength: number;
}

export const DEFAULT_KERF_TEST: KerfTestOptions = {
  outerSize: 60,
  innerSize: 20,
  holeDiameter: 20,
  slotWidths: [1, 1.5, 2, 2.5, 3],
  slotLength: 24,
};

function rectangle(cx: number, cy: number, w: number, h: number): number[] {
  const hw = w / 2;
  const hh = h / 2;
  return [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh];
}

/**
 * The figure you cut once per material to measure kerf.
 *
 * Nothing here is kerf-compensated — that is the entire point. Cut it, measure
 * it, and the differences give you the number:
 *
 *   - outer square: kerf = nominal − measured (the cut eats the part)
 *   - square hole and round hole: kerf = measured − nominal (the cut widens it)
 *   - slot ladder: the narrowest slot that still opens up tells you the
 *     smallest feature this material and this machine can hold
 *
 * The two square measurements must agree. If they do not, the beam is not
 * perpendicular to the bed, and no single kerf number will save the fit.
 */
export function kerfTestDocument(options: KerfTestOptions = DEFAULT_KERF_TEST): DxfDocument {
  const polylines: DxfPolyline[] = [];
  const circles: DxfCircle[] = [];

  const { outerSize, innerSize, holeDiameter, slotWidths, slotLength } = options;

  // Left tile: outer square with a concentric square hole.
  const leftX = 0;
  polylines.push({ points: rectangle(leftX, 0, outerSize, outerSize), layer: LAYER_CUT });
  polylines.push({ points: rectangle(leftX, 0, innerSize, innerSize), layer: LAYER_CUT });

  // Right tile: same outer square with a round hole and the slot ladder.
  const rightX = outerSize + 10;
  polylines.push({ points: rectangle(rightX, 0, outerSize, outerSize), layer: LAYER_CUT });
  circles.push({
    x: rightX,
    y: outerSize / 2 - holeDiameter / 2 - 6,
    r: holeDiameter / 2,
    layer: LAYER_CUT,
  });

  const ladderTop = -4;
  const spacing = 7;
  for (let i = 0; i < slotWidths.length; i++) {
    polylines.push({
      points: rectangle(rightX, ladderTop - i * spacing, slotLength, slotWidths[i]),
      layer: LAYER_CUT,
    });
  }

  return { polylines, circles };
}
