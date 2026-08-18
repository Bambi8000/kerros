/**
 * Kerros nesting.
 *
 * Turns the cut geometry of a job into parts, finds somewhere on each part to
 * engrave its label, and packs the parts onto bed-sized sheets.
 *
 * DELIBERATE CONSTRAINT: no value imports. Node validators load this as the
 * real module, and the stroke font is passed in rather than imported so this
 * file stays independent of it.
 */

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface PartGeometry {
  id: string;
  /** Engraved on the part, e.g. 'L07'. */
  label: string;
  kind: 'slice' | 'spacer';
  /** Outer boundary as a closed ring, always present. */
  outer: number[];
  /** Set when the outline is exactly a circle, so export can emit CIRCLE. */
  outerCircle?: Circle;
  /** Inner boundaries from the field. */
  holes: number[][];
  /** Circular holes: rod clearance and spacer bores. */
  circles: Circle[];
  /** Layer this came from, for the manifest. */
  layer?: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlacedPart extends PartGeometry {
  /** Translation from part coordinates to sheet coordinates. */
  dx: number;
  dy: number;
  /** True when a person put it here and the nester must leave it alone. */
  pinned?: boolean;
  bbox: BBox;
  /** Baseline left of the engraved label, in part coordinates. */
  labelAt: [number, number] | null;
  labelHeight: number;
}

export interface Sheet {
  index: number;
  parts: PlacedPart[];
  /** How much of the usable area the bounding boxes take up, 0..1. */
  fill: number;
}

export interface NestOptions {
  /** Usable sheet size, i.e. bed minus margins, mm. */
  sheetWidth: number;
  sheetHeight: number;
  /** Space left between parts, mm. */
  gap: number;
  /** Engraved label height, mm. 0 turns labelling off. */
  labelHeight: number;
  /** Cap so a runaway job cannot generate sheets forever. */
  maxSheets?: number;
}

export interface NestResult {
  sheets: Sheet[];
  /** Parts too large for a sheet, or that ran past the sheet cap. */
  unplaced: PartGeometry[];
}

const DEFAULT_MAX_SHEETS = 60;

/** Where a person dragged a part to. */
export interface PartPlacement {
  sheet: number;
  dx: number;
  dy: number;
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

export function boundsOf(part: PartGeometry): BBox {
  // A part whose outline is exactly a circle is bounded by that circle, not by
  // the polygon standing in for it. The polygon is inscribed, so it is up to
  // the chord tolerance smaller — and since export emits the true CIRCLE, a
  // bbox taken from the polygon lets the part hang over the edge of the sheet
  // by that much. Small, but the nester has to bound what is actually cut.
  if (part.outerCircle) {
    const { x, y, r } = part.outerCircle;
    return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < part.outer.length; i += 2) {
    if (part.outer[i] < minX) minX = part.outer[i];
    if (part.outer[i] > maxX) maxX = part.outer[i];
    if (part.outer[i + 1] < minY) minY = part.outer[i + 1];
    if (part.outer[i + 1] > maxY) maxY = part.outer[i + 1];
  }

  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function inRing(points: number[], x: number, y: number): boolean {
  const n = points.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is this rectangle entirely on material? */
function boxIsOnMaterial(part: PartGeometry, x: number, y: number, w: number, h: number): boolean {
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x + w / 2, y + h / 2],
  ];

  for (const [cx, cy] of corners) {
    if (!inRing(part.outer, cx, cy)) return false;
    for (const hole of part.holes) if (inRing(hole, cx, cy)) return false;
    for (const circle of part.circles) {
      if (Math.hypot(cx - circle.x, cy - circle.y) <= circle.r) return false;
    }
  }
  return true;
}

/**
 * Somewhere on the part to engrave its label.
 *
 * The centre of a lamp slice is usually a hole, so the obvious answer is wrong
 * most of the time. Candidates are scanned across the bounding box and scored
 * by distance from the centre, so the label lands on the nearest piece of
 * actual material. Text height is halved and retried before giving up, because
 * a small number on the part beats no number at all.
 */
export function findLabelSpot(
  part: PartGeometry,
  width: number,
  height: number,
  steps = 24,
): [number, number] | null {
  const box = boundsOf(part);
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  if (spanX < width || spanY < height) return null;

  const centreX = (box.minX + box.maxX) / 2;
  const centreY = (box.minY + box.maxY) / 2;

  let best: [number, number] | null = null;
  let bestScore = Infinity;

  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = box.minX + (spanX - width) * (i / steps);
      const y = box.minY + (spanY - height) * (j / steps);
      if (!boxIsOnMaterial(part, x, y, width, height)) continue;

      const score = Math.hypot(x + width / 2 - centreX, y + height / 2 - centreY);
      if (score < bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * Shelf packing
 * ------------------------------------------------------------------ */

/**
 * Bounding-box shelf packing, tallest first.
 *
 * Parts are placed left to right along a shelf; when one no longer fits, a new
 * shelf opens above at the height of the tallest part on the one below. It is
 * the classic first-fit decreasing-height algorithm: not optimal, but
 * deterministic, instant, and easy to look at and understand. True-shape
 * nesting, which would let a small part sit inside a large ring's waste, is on
 * the roadmap.
 *
 * Parts are not rotated. For lamp slices, which are mostly round, rotation
 * buys nothing and costs determinism.
 */
export function nestParts(parts: PartGeometry[], options: NestOptions): NestResult {
  const { sheetWidth, sheetHeight, gap } = options;
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS;
  const labelHeight = Math.max(options.labelHeight, 0);

  const measured = parts.map((part) => ({ part, bbox: boundsOf(part) }));
  measured.sort((a, b) => {
    const heightDiff = b.bbox.maxY - b.bbox.minY - (a.bbox.maxY - a.bbox.minY);
    if (Math.abs(heightDiff) > 1e-9) return heightDiff;
    // Stable tie-break so the same job always nests the same way.
    return a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0;
  });

  const sheets: Sheet[] = [];
  const unplaced: PartGeometry[] = [];

  let sheet: Sheet | undefined;
  let cursorX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let usedArea = 0;

  const closeSheet = () => {
    if (!sheet) return;
    sheet.fill = usedArea / Math.max(sheetWidth * sheetHeight, 1);
    sheets.push(sheet);
    sheet = undefined;
  };

  const openSheet = (): Sheet => {
    closeSheet();
    cursorX = 0;
    shelfY = 0;
    shelfHeight = 0;
    usedArea = 0;
    return { index: sheets.length + 1, parts: [], fill: 0 };
  };

  for (const { part, bbox } of measured) {
    const w = bbox.maxX - bbox.minX;
    const h = bbox.maxY - bbox.minY;

    if (w > sheetWidth || h > sheetHeight) {
      unplaced.push(part);
      continue;
    }

    if (!sheet) {
      if (sheets.length >= maxSheets) {
        unplaced.push(part);
        continue;
      }
      sheet = openSheet();
    }

    if (cursorX + w > sheetWidth) {
      // Next shelf up.
      shelfY += shelfHeight + gap;
      cursorX = 0;
      shelfHeight = 0;
    }

    if (shelfY + h > sheetHeight) {
      if (sheets.length + 1 >= maxSheets) {
        unplaced.push(part);
        continue;
      }
      sheet = openSheet();
    }

    const labelWidth = labelHeight > 0 ? part.label.length * (labelHeight * 0.8) : 0;
    let labelAt: [number, number] | null = null;
    let usedLabelHeight = labelHeight;

    if (labelHeight > 0 && part.label.length > 0) {
      labelAt = findLabelSpot(part, labelWidth, labelHeight);
      if (!labelAt) {
        usedLabelHeight = labelHeight * 0.6;
        labelAt = findLabelSpot(part, labelWidth * 0.6, usedLabelHeight);
      }
      if (!labelAt) usedLabelHeight = 0;
    }

    const placed: PlacedPart = {
      ...part,
      bbox,
      dx: cursorX - bbox.minX,
      dy: shelfY - bbox.minY,
      labelAt,
      labelHeight: usedLabelHeight,
    };

    sheet.parts.push(placed);
    usedArea += w * h;
    cursorX += w + gap;
    shelfHeight = Math.max(shelfHeight, h);
  }

  closeSheet();
  return { sheets, unplaced };
}

/** Total parts across all sheets, for the readout. */
export function countParts(sheets: Sheet[]): number {
  let total = 0;
  for (const sheet of sheets) total += sheet.parts.length;
  return total;
}

/* ------------------------------------------------------------------ *
 * Manual placement
 * ------------------------------------------------------------------ */

/** Sheet-space bounding box of a placed part. */
export function placedBox(part: PlacedPart): BBox {
  return {
    minX: part.bbox.minX + part.dx,
    minY: part.bbox.minY + part.dy,
    maxX: part.bbox.maxX + part.dx,
    maxY: part.bbox.maxY + part.dy,
  };
}

/**
 * Which parts on a sheet have overlapping bounding boxes.
 *
 * Kept because it is the measure the automatic nester works to, so it explains
 * why the shelf algorithm placed things where it did. It is NOT a manufacturing
 * check: two crescents can share a bounding box while their material never
 * touches, and nesting one part into another's concavity is good practice, not
 * an error. Use `analyseSheet` for what can actually be cut.
 */
export function findOverlaps(sheet: Sheet, tolerance = 1e-6): string[] {
  const hit = new Set<string>();

  for (let i = 0; i < sheet.parts.length; i++) {
    for (let j = i + 1; j < sheet.parts.length; j++) {
      const a = placedBox(sheet.parts[i]);
      const b = placedBox(sheet.parts[j]);
      const separated =
        a.maxX <= b.minX + tolerance ||
        b.maxX <= a.minX + tolerance ||
        a.maxY <= b.minY + tolerance ||
        b.maxY <= a.minY + tolerance;
      if (!separated) {
        hit.add(sheet.parts[i].id);
        hit.add(sheet.parts[j].id);
      }
    }
  }

  return Array.from(hit);
}

/**
 * Overlay manual placements on an automatic layout.
 *
 * Pinned parts go where they were put, on the sheet they were put on, and the
 * rest keep the layout the nester produced. Overlap is not prevented: a person
 * dragging a part has a reason, and the honest response is to show what
 * happened rather than to refuse the drag. `findOverlaps` reports it.
 *
 * A placement naming a sheet that no longer exists is clamped into range
 * rather than dropped, so shrinking a job does not silently lose parts.
 */
export function applyPlacements(
  result: NestResult,
  placements: Record<string, PartPlacement>,
): NestResult {
  if (Object.keys(placements).length === 0) return result;

  const sheetCount = result.sheets.length;
  if (sheetCount === 0) return result;

  const buckets = new Map<number, PlacedPart[]>();
  for (let i = 1; i <= sheetCount; i++) buckets.set(i, []);

  let sheetArea = 0;

  for (const sheet of result.sheets) {
    for (const part of sheet.parts) {
      const placement = placements[part.id];
      if (!placement) {
        (buckets.get(sheet.index) as PlacedPart[]).push(part);
        continue;
      }
      const target = Math.min(Math.max(Math.round(placement.sheet), 1), sheetCount);
      (buckets.get(target) as PlacedPart[]).push({
        ...part,
        dx: placement.dx,
        dy: placement.dy,
        pinned: true,
      });
    }
    // Recover the sheet size from the fill the nester recorded, so this
    // function needs no options of its own.
    if (sheetArea === 0 && sheet.fill > 0) {
      let used = 0;
      for (const part of sheet.parts) {
        used += (part.bbox.maxX - part.bbox.minX) * (part.bbox.maxY - part.bbox.minY);
      }
      sheetArea = used / sheet.fill;
    }
  }

  const sheets: Sheet[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    const parts = buckets.get(i) as PlacedPart[];
    let used = 0;
    for (const part of parts) {
      used += (part.bbox.maxX - part.bbox.minX) * (part.bbox.maxY - part.bbox.minY);
    }
    sheets.push({
      index: i,
      parts,
      fill: sheetArea > 0 ? used / sheetArea : 0,
    });
  }

  return { sheets, unplaced: result.unplaced };
}

/**
 * Keep a part inside the sheet.
 *
 * Dragging is free-form, but a part half off the bed is not a placement, it is
 * a mistake, and the laser would happily cut the part of it that is on the
 * material.
 */
export function clampPlacement(
  part: PlacedPart,
  dx: number,
  dy: number,
  sheetWidth: number,
  sheetHeight: number,
): [number, number] {
  const width = part.bbox.maxX - part.bbox.minX;
  const height = part.bbox.maxY - part.bbox.minY;
  const minDx = -part.bbox.minX;
  const minDy = -part.bbox.minY;
  const maxDx = minDx + Math.max(sheetWidth - width, 0);
  const maxDy = minDy + Math.max(sheetHeight - height, 0);
  return [
    Math.min(Math.max(dx, minDx), maxDx),
    Math.min(Math.max(dy, minDy), maxDy),
  ];
}

/** The part under a point in sheet coordinates, or null. */
export function partAt(sheet: Sheet, x: number, y: number): PlacedPart | null {
  let material: PlacedPart | null = null;
  let materialArea = Infinity;
  let boxed: PlacedPart | null = null;
  let boxedArea = Infinity;

  for (const part of sheet.parts) {
    const box = placedBox(part);
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;

    const area = (box.maxX - box.minX) * (box.maxY - box.minY);
    const localX = x - part.dx;
    const localY = y - part.dy;

    let onMaterial = inRing(part.outer, localX, localY);
    if (onMaterial) {
      for (const hole of part.holes) {
        if (inRing(hole, localX, localY)) onMaterial = false;
      }
      for (const circle of part.circles) {
        if (Math.hypot(localX - circle.x, localY - circle.y) <= circle.r) onMaterial = false;
      }
    }

    if (onMaterial) {
      // Material wins, and the smallest part wins among those, so a small part
      // sitting in a large ring's waste is still reachable.
      if (area < materialArea) {
        materialArea = area;
        material = part;
      }
    } else if (area < boxedArea) {
      boxedArea = area;
      boxed = part;
    }
  }

  return material ?? boxed;
}

/* ------------------------------------------------------------------ *
 * True-shape collision check
 * ------------------------------------------------------------------ */

export interface PairReport {
  a: string;
  b: string;
  /** Closest approach between the two outlines, mm. 0 when they cross. */
  distance: number;
  /** True when the outlines cross or one part sits on the other's material. */
  colliding: boolean;
}

export interface SheetReport {
  /** Ids of parts whose material actually collides with another part's. */
  colliding: string[];
  /** Ids of parts closer to another part than the required clearance. */
  tight: string[];
  /** Every pair worth mentioning, closest first. */
  pairs: PairReport[];
  /** Closest approach anywhere on the sheet, mm, or Infinity. */
  closest: number;
}

function segmentDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  // Proper intersection means zero distance.
  const r1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const r2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const r3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const r4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (r1 * r2 < 0 && r3 * r4 < 0) return 0;

  const pointToSegment = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const lengthSquared = vx * vx + vy * vy;
    if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * vx + (py - y1) * vy) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
  };

  return Math.min(
    pointToSegment(ax, ay, cx, cy, dx, dy),
    pointToSegment(bx, by, cx, cy, dx, dy),
    pointToSegment(cx, cy, ax, ay, bx, by),
    pointToSegment(dx, dy, ax, ay, bx, by),
  );
}

/** Outer ring in sheet coordinates, thinned when it is very dense. */
function sheetOutline(part: PlacedPart, maxPoints = 400): number[] {
  const pts = part.outer;
  const count = pts.length / 2;
  const stride = Math.max(1, Math.ceil(count / maxPoints));
  const out: number[] = [];
  for (let i = 0; i < count; i += stride) {
    out.push(pts[i * 2] + part.dx, pts[i * 2 + 1] + part.dy);
  }
  return out;
}

/** Is this point on the part's material, in sheet coordinates? */
function onMaterial(part: PlacedPart, x: number, y: number): boolean {
  const localX = x - part.dx;
  const localY = y - part.dy;
  if (!inRing(part.outer, localX, localY)) return false;
  for (const hole of part.holes) if (inRing(hole, localX, localY)) return false;
  for (const circle of part.circles) {
    if (Math.hypot(localX - circle.x, localY - circle.y) <= circle.r) return false;
  }
  return true;
}

/**
 * What can actually be cut.
 *
 * Bounding boxes cannot answer this. A crescent nested into another crescent's
 * concavity shares a bounding box and cuts perfectly; two discs whose boxes
 * barely touch can still be a millimetre apart and burn into each other. So
 * this measures the real thing: closest approach between outlines, plus a
 * containment test for the case where one part sits wholly on another's
 * material without any outline crossing.
 *
 * Only pairs whose bounding boxes overlap by more than `clearance` are
 * examined, so the cost stays with the handful of pairs that could possibly be
 * in trouble.
 *
 * `clearance` is the gap you want between parts. Below it a pair is `tight`;
 * at zero it is `colliding`.
 */
export function analyseSheet(sheet: Sheet, clearance = 0): SheetReport {
  const colliding = new Set<string>();
  const tight = new Set<string>();
  const pairs: PairReport[] = [];
  let closest = Infinity;

  const boxes = sheet.parts.map(placedBox);
  const outlines = sheet.parts.map((part) => sheetOutline(part));

  for (let i = 0; i < sheet.parts.length; i++) {
    for (let j = i + 1; j < sheet.parts.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const margin = Math.max(clearance, 0);
      const apart =
        a.maxX + margin <= b.minX ||
        b.maxX + margin <= a.minX ||
        a.maxY + margin <= b.minY ||
        b.maxY + margin <= a.minY;
      if (apart) continue;

      const pa = outlines[i];
      const pb = outlines[j];
      let distance = Infinity;

      for (let s = 0; s < pa.length && distance > 0; s += 2) {
        const ax = pa[s];
        const ay = pa[s + 1];
        const an = (s + 2) % pa.length;
        const bx = pa[an];
        const by = pa[an + 1];

        for (let t = 0; t < pb.length; t += 2) {
          const cx = pb[t];
          const cy = pb[t + 1];
          const bn = (t + 2) % pb.length;
          const dx = pb[bn];
          const dy = pb[bn + 1];

          const d = segmentDistance(ax, ay, bx, by, cx, cy, dx, dy);
          if (d < distance) {
            distance = d;
            if (distance === 0) break;
          }
        }
      }

      // One part entirely on the other's material crosses nothing.
      const contained =
        onMaterial(sheet.parts[j], pa[0], pa[1]) ||
        onMaterial(sheet.parts[i], pb[0], pb[1]);

      const isColliding = distance <= 1e-9 || contained;
      if (isColliding) {
        colliding.add(sheet.parts[i].id);
        colliding.add(sheet.parts[j].id);
      } else if (distance < clearance) {
        tight.add(sheet.parts[i].id);
        tight.add(sheet.parts[j].id);
      }

      if (distance < closest) closest = distance;

      if (isColliding || distance < clearance) {
        pairs.push({
          a: sheet.parts[i].id,
          b: sheet.parts[j].id,
          distance: isColliding ? 0 : distance,
          colliding: isColliding,
        });
      }
    }
  }

  pairs.sort((x, y) => x.distance - y.distance);

  return {
    colliding: Array.from(colliding),
    tight: Array.from(tight),
    pairs,
    closest,
  };
}
