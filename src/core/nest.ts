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
  kind: 'slice' | 'spacer' | 'window';
  /**
   * What this part is cut from. Parts of different materials never share a
   * sheet, because they are never on the machine at the same time.
   */
  material?: string;
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
  /** Rotation already baked into this part's geometry, degrees. */
  rot?: number;
  /**
   * The point rotation turns about, in part coordinates.
   *
   * This is the centre of the part's *unrotated* bounding box. Rotating a shape
   * about a point does not leave the resulting bounding box centred on that
   * point, so the pivot has to be carried rather than recomputed from `bbox` —
   * otherwise a rotation handle drifts away from the part as it turns.
   */
  pivot: [number, number];
  /** True when a person put it here and the nester must leave it alone. */
  pinned?: boolean;
  bbox: BBox;
  /** Baseline left of the engraved label, in part coordinates. */
  labelAt: [number, number] | null;
  labelHeight: number;
}

export interface Sheet {
  index: number;
  /** Material every part on this sheet is cut from. */
  material: string;
  /** Position within this material's own run of sheets, from 1. */
  ordinal: number;
  parts: PlacedPart[];
  /** How much of the usable area the bounding boxes take up, 0..1. */
  /**
   * Share of the sheet covered by **material**, holes excluded.
   *
   * Not the share covered by bounding boxes: once parts nest inside each other's
   * holes those boxes overlap and their total can pass 100%, which would make the
   * number meaningless exactly where it matters most.
   */
  fill: number;
}

export interface NestOptions {
  /**
   * Pack against the real outline rather than the bounding box.
   *
   * The prize is the hole in the middle of a ring: a fourteen-layer lamp leaves
   * large central voids that bounding-box packing cannot use at all.
   */
  trueShape?: boolean;
  /**
   * Grid the true-shape packer works on, mm. Finer packs tighter and costs more.
   */
  cell?: number;
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

/**
 * Roughly how wide a label will be.
 *
 * The real width comes from the stroke font, which this module deliberately
 * does not import. Slightly generous, so a spot that passes here has room for
 * the real thing.
 */
export function estimateLabelWidth(label: string, height: number): number {
  return label.length * height * 0.8;
}

/** Where a person dragged a part to, and how far they turned it. */
export interface PartPlacement {
  sheet: number;
  dx: number;
  dy: number;
  /** Rotation about the part's own centre, degrees. */
  rot?: number;
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

  const material = parts.length > 0 ? parts[0].material ?? 'stock' : 'stock';

  const openSheet = (): Sheet => {
    closeSheet();
    cursorX = 0;
    shelfY = 0;
    shelfHeight = 0;
    usedArea = 0;
    return {
      index: sheets.length + 1,
      material,
      ordinal: sheets.length + 1,
      parts: [],
      fill: 0,
    };
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

    const labelWidth = labelHeight > 0 ? estimateLabelWidth(part.label, labelHeight) : 0;
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
      pivot: [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2],
      dx: cursorX - bbox.minX,
      dy: shelfY - bbox.minY,
      labelAt,
      labelHeight: usedLabelHeight,
    };

    sheet.parts.push(placed);
    usedArea += partArea(part);
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
  sheetSize?: { width: number; height: number },
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
      const rot = placement.rot ?? 0;

      // Rotation is baked in, so the bounding box, the label spot and every
      // downstream check are all computed from the geometry as it will be cut.
      //
      // Any rotation already on the part is undone first, about the same
      // pivot, so this function is safe to run on its own output: turning to
      // 40 degrees and then to 80 gives the same geometry as turning to 80
      // once, rather than compounding to 120.
      const base = part.rot ? rotatePart(part, -part.rot, part.pivot) : part;
      const spun = rot !== 0 ? rotatePart(base, rot, part.pivot) : base;
      const bbox = boundsOf(spun);

      let labelAt = part.labelAt;
      if (rot !== 0 && part.labelHeight > 0 && part.label.length > 0) {
        // The label stays upright — a rotated part number is hard to read —
        // so its spot has to be found again on the turned material.
        const width = estimateLabelWidth(part.label, part.labelHeight);
        labelAt =
          findLabelSpot(spun, width, part.labelHeight) ??
          findLabelSpot(spun, width * 0.6, part.labelHeight * 0.6);
      }

      let { dx, dy } = placement;
      if (sheetSize) {
        [dx, dy] = clampPlacement(
          { ...spun, bbox, pivot: part.pivot, dx, dy, labelAt, labelHeight: part.labelHeight },
          dx,
          dy,
          sheetSize.width,
          sheetSize.height,
        );
      }

      (buckets.get(target) as PlacedPart[]).push({
        ...spun,
        bbox,
        // The pivot stays where it was: rotation is always applied to the
        // original geometry about the original centre, so turning a part twice
        // gives the same result as turning it once by the sum.
        pivot: part.pivot,
        dx,
        dy,
        rot,
        labelAt,
        labelHeight: labelAt ? part.labelHeight : 0,
        pinned: true,
      });
    }
    // Recover the sheet size from the fill the nester recorded, so this
    // function needs no options of its own.
    if (sheetArea === 0 && sheet.fill > 0) {
      let used = 0;
      for (const part of sheet.parts) {
        used += partArea(part);
      }
      sheetArea = used / sheet.fill;
    }
  }

  const sheets: Sheet[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    const parts = buckets.get(i) as PlacedPart[];
    let used = 0;
    for (const part of parts) {
      used += partArea(part);
    }
    const source = result.sheets[i - 1];
    sheets.push({
      index: i,
      material: source ? source.material : 'stock',
      ordinal: source ? source.ordinal : i,
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

/* ------------------------------------------------------------------ *
 * Rotation
 * ------------------------------------------------------------------ */

/**
 * Turn a part about its own centre.
 *
 * Rotation is baked into the geometry rather than carried as a transform, so
 * everything downstream — bounds, clamping, hit testing, collision, export —
 * reads the same fields it always did and needs no special case. The part's
 * bounding-box centre is the pivot, which is what turning a piece on the bed
 * feels like.
 *
 * Corrugated board is the reason this exists. The flutes inside run one way,
 * and a cut edge exposes them; every part cut at the same angle gives every
 * layer an identical edge and an identical way of passing light. Turning parts
 * against the flute is a material decision, not a packing one.
 */
export function rotatePart(
  part: PartGeometry,
  degrees: number,
  pivot?: [number, number],
): PartGeometry {
  const angle = (degrees * Math.PI) / 180;
  if (Math.abs(angle) < 1e-12) return part;

  const box = boundsOf(part);
  const cx = pivot ? pivot[0] : (box.minX + box.maxX) / 2;
  const cy = pivot ? pivot[1] : (box.minY + box.maxY) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const spin = (points: number[]) => {
    const out = new Array<number>(points.length);
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i] - cx;
      const y = points[i + 1] - cy;
      out[i] = cx + x * cos - y * sin;
      out[i + 1] = cy + x * sin + y * cos;
    }
    return out;
  };

  const spinCircle = (circle: Circle): Circle => {
    const x = circle.x - cx;
    const y = circle.y - cy;
    return {
      x: cx + x * cos - y * sin,
      y: cy + x * sin + y * cos,
      r: circle.r,
    };
  };

  return {
    ...part,
    outer: spin(part.outer),
    outerCircle: part.outerCircle ? spinCircle(part.outerCircle) : undefined,
    holes: part.holes.map(spin),
    circles: part.circles.map(spinCircle),
  };
}

/** Deterministic PRNG, the same one the rest of Kerros seeds from. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rotation for every part, drawn from the seed.
 *
 * Same seed, same angles, every time — a lamp is reproducible or it is not a
 * design. Angles are derived per part from the seed mixed with the part's
 * position in the list, so adding a part at the end does not reshuffle the
 * ones before it.
 */
export function scatterRotations(
  ids: string[],
  seed: number,
  maxAngle = 180,
): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, index) => {
    const random = mulberry32(seed * 2654435761 + index * 40503);
    out[id] = Math.round((random() * 2 - 1) * maxAngle * 10) / 10;
  });
  return out;
}

/**
 * Nest each material onto its own sheets.
 *
 * Cardboard and plexi are never on the machine at the same time, so they are
 * never on the same sheet. Sheets keep a global index for the viewer and an
 * ordinal within their own material for the filename, so "plexi sheet 1" means
 * what it says.
 */
export function nestByMaterial(parts: PartGeometry[], options: NestOptions): NestResult {
  const pack = options.trueShape ? nestTrueShape : nestParts;
  const groups = new Map<string, PartGeometry[]>();
  for (const part of parts) {
    const material = part.material ?? 'stock';
    const group = groups.get(material);
    if (group) group.push(part);
    else groups.set(material, [part]);
  }

  // Sorted so the order does not depend on which part happened to come first.
  const materials = Array.from(groups.keys()).sort();

  const sheets: Sheet[] = [];
  const unplaced: PartGeometry[] = [];

  for (const material of materials) {
    const nested = pack(groups.get(material) as PartGeometry[], options);
    for (const sheet of nested.sheets) {
      sheets.push({
        ...sheet,
        index: sheets.length + 1,
        material,
        ordinal: sheet.index,
      });
    }
    unplaced.push(...nested.unplaced);
  }

  return { sheets, unplaced };
}


/* ------------------------------------------------------------------ *
 * True-shape nesting
 *
 * Bounding-box shelf packing wastes the inside of every ring, and a lamp is
 * mostly rings. This packs against the real outline by rasterising each part —
 * material solid, holes free — and looking for somewhere its cells do not
 * collide with what is already on the sheet.
 *
 * Why a raster rather than no-fit polygons: NFP is the tighter method, but it
 * needs Minkowski sums and convex decomposition, and every one of its failure
 * modes is a subtly wrong polygon that looks plausible until it is cut. A raster
 * is coarse in a way that is measurable, obvious, and always conservative — a
 * cell is either free or it is not.
 *
 * Rotation is deliberately not searched. Turning parts is already a feature, and
 * it is an aesthetic one: in corrugated stock the flute direction is what makes a
 * stack look alive, and the maker chooses it with scatter. A nester that rotated
 * freely to save material would silently overwrite that choice.
 * ------------------------------------------------------------------ */

/**
 * Enclosed area of a closed ring, by the shoelace formula.
 *
 * Local rather than borrowed from the slicer: this module has no imports so that
 * a validator can load it as the real thing, and one small formula is a cheaper
 * price than breaking that.
 */
function ringArea(points: number[]): number {
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return Math.abs(sum) / 2;
}

/** How many cells the sparse overlap pass skips between samples. */
const SAMPLE_STRIDE = 8;

/** Area of the material in a part: the outline less its holes. */
export function partArea(part: PartGeometry): number {
  let area = ringArea(part.outer);
  for (const hole of part.holes) area -= ringArea(hole);
  return Math.max(area, 0);
}

interface PartRaster {
  /** Cells across and up. */
  w: number;
  h: number;
  /** Offsets into a w×h grid that hold material, after the gap dilation. */
  cells: Int32Array;
  /** Part-space position of the raster's lower-left corner. */
  originX: number;
  originY: number;
}

/**
 * Rasterise a part: material solid, holes free.
 *
 * Circles are ignored. A rod hole or a perforation is a real hole in the
 * material, but nothing in a lamp is small enough to nest inside one, and
 * treating them as free space would only add noise to the search.
 *
 * The gap is applied by dilating the bitmap rather than by insetting polygons.
 * Box dilation makes the clearance slightly generous on the diagonal, which errs
 * in the direction of parts not touching.
 */
export function rasterisePart(part: PartGeometry, cell: number, gap: number): PartRaster {
  const bbox = boundsOf(part);
  const margin = Math.max(gap, 0) / 2;
  const step = Math.max(cell, 0.05);

  const originX = bbox.minX - margin;
  const originY = bbox.minY - margin;
  const w = Math.max(Math.ceil((bbox.maxX - bbox.minX + 2 * margin) / step), 1);
  const h = Math.max(Math.ceil((bbox.maxY - bbox.minY + 2 * margin) / step), 1);

  const solid = new Uint8Array(w * h);

  for (let j = 0; j < h; j++) {
    const y = originY + (j + 0.5) * step;
    for (let i = 0; i < w; i++) {
      const x = originX + (i + 0.5) * step;
      if (!inRing(part.outer, x, y)) continue;
      let inHole = false;
      for (const hole of part.holes) {
        if (inRing(hole, x, y)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) solid[i + j * w] = 1;
    }
  }

  const grow = Math.round(margin / step);
  const dilated = grow > 0 ? new Uint8Array(w * h) : solid;

  if (grow > 0) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (solid[i + j * w] === 0) continue;
        const loI = Math.max(i - grow, 0);
        const hiI = Math.min(i + grow, w - 1);
        const loJ = Math.max(j - grow, 0);
        const hiJ = Math.min(j + grow, h - 1);
        for (let b = loJ; b <= hiJ; b++) {
          for (let a = loI; a <= hiI; a++) dilated[a + b * w] = 1;
        }
      }
    }
  }

  const list: number[] = [];
  for (let k = 0; k < dilated.length; k++) if (dilated[k] === 1) list.push(k);

  return { w, h, cells: new Int32Array(list), originX, originY };
}

/**
 * Pack parts against their real outlines.
 *
 * Biggest first, then bottom-left first fit. Every candidate position is rejected
 * in constant time by a summed-area table over the sheet: if the part's bounding
 * box covers nothing occupied, it fits, no further work. Only when the box
 * overlaps something does the exact cell test run — which is precisely the
 * interesting case, a part dropping into a ring's hole.
 */
export function nestTrueShape(parts: PartGeometry[], options: NestOptions): NestResult {
  const { sheetWidth, sheetHeight, gap } = options;
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS;
  const labelHeight = Math.max(options.labelHeight, 0);
  const cell = Math.max(options.cell ?? 2, 0.2);
  // Roughly 4 mm of search granularity whatever the cell size.
  const searchStep = Math.max(Math.round(4 / cell), 1);

  const W = Math.max(Math.floor(sheetWidth / cell), 1);
  const H = Math.max(Math.floor(sheetHeight / cell), 1);

  const measured = parts.map((part) => ({
    part,
    bbox: boundsOf(part),
    raster: rasterisePart(part, cell, gap),
    area: partArea(part),
  }));

  // Largest first by material area, with a stable tie-break so the same job
  // always nests the same way.
  measured.sort((a, b) => {
    if (Math.abs(b.area - a.area) > 1e-9) return b.area - a.area;
    return a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0;
  });

  const material = parts.length > 0 ? parts[0].material ?? 'stock' : 'stock';
  const sheets: Sheet[] = [];
  const unplaced: PartGeometry[] = [];

  interface Board {
    occupied: Uint8Array;
    sat: Int32Array;
    dirty: boolean;
    parts: PlacedPart[];
    area: number;
  }

  const boards: Board[] = [];

  const rebuildSat = (board: Board) => {
    const sat = board.sat;
    sat.fill(0);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        sat[(j + 1) * (W + 1) + (i + 1)] =
          board.occupied[i + j * W] +
          sat[j * (W + 1) + (i + 1)] +
          sat[(j + 1) * (W + 1) + i] -
          sat[j * (W + 1) + i];
      }
    }
    board.dirty = false;
  };

  const boxSum = (board: Board, i: number, j: number, w: number, h: number) => {
    const sat = board.sat;
    const i2 = i + w;
    const j2 = j + h;
    return (
      sat[j2 * (W + 1) + i2] -
      sat[j * (W + 1) + i2] -
      sat[j2 * (W + 1) + i] +
      sat[j * (W + 1) + i]
    );
  };

  /** Bottom-left first fit, or null when the part will not go on this board. */
  const findSpot = (board: Board, raster: PartRaster): [number, number] | null => {
    if (raster.w > W || raster.h > H) return null;
    if (board.dirty) rebuildSat(board);
    const step = searchStep;

    // Candidates are tried on a coarser lattice than the raster itself. The
    // raster decides whether a part fits; this only decides how finely the
    // search looks, and looking at every single cell costs four times as much
    // for a placement no one could measure.
    for (let j = 0; j <= H - raster.h; j += step) {
      for (let i = 0; i <= W - raster.w; i += step) {
        // Constant-time rejection: an empty box needs no further test.
        if (boxSum(board, i, j, raster.w, raster.h) === 0) return [i, j];

        // A sparse pass before the full one. Without it the exact test walks
        // tens of thousands of cells for nearly every candidate on a filling
        // sheet, which took seconds; a real overlap almost always hits one of
        // every eighth cell, so the expensive walk is left for near misses.
        let clash = false;
        for (let k = 0; k < raster.cells.length; k += SAMPLE_STRIDE) {
          const offset = raster.cells[k];
          if (board.occupied[i + (offset % raster.w) + (j + Math.floor(offset / raster.w)) * W] === 1) {
            clash = true;
            break;
          }
        }
        if (clash) continue;

        for (let k = 0; k < raster.cells.length; k++) {
          const offset = raster.cells[k];
          const ci = i + (offset % raster.w);
          const cj = j + Math.floor(offset / raster.w);
          if (board.occupied[ci + cj * W] === 1) {
            clash = true;
            break;
          }
        }
        if (!clash) return [i, j];
      }
    }

    return null;
  };

  const stamp = (board: Board, raster: PartRaster, i: number, j: number) => {
    for (let k = 0; k < raster.cells.length; k++) {
      const offset = raster.cells[k];
      const ci = i + (offset % raster.w);
      const cj = j + Math.floor(offset / raster.w);
      board.occupied[ci + cj * W] = 1;
    }
    board.dirty = true;
  };

  for (const { part, bbox, raster, area } of measured) {
    if (bbox.maxX - bbox.minX > sheetWidth || bbox.maxY - bbox.minY > sheetHeight) {
      unplaced.push(part);
      continue;
    }

    let target: Board | undefined;
    let spot: [number, number] | null = null;

    // Existing sheets first, in order: a part that fits an earlier sheet's waste
    // belongs there rather than on a fresh one.
    for (const board of boards) {
      const found = findSpot(board, raster);
      if (found) {
        target = board;
        spot = found;
        break;
      }
    }

    if (!target) {
      if (boards.length >= maxSheets) {
        unplaced.push(part);
        continue;
      }
      const board: Board = {
        occupied: new Uint8Array(W * H),
        sat: new Int32Array((W + 1) * (H + 1)),
        dirty: true,
        parts: [],
        area: 0,
      };
      const found = findSpot(board, raster);
      if (!found) {
        unplaced.push(part);
        continue;
      }
      boards.push(board);
      target = board;
      spot = found;
    }

    const [i, j] = spot as [number, number];
    stamp(target, raster, i, j);

    const labelWidth = labelHeight > 0 ? estimateLabelWidth(part.label, labelHeight) : 0;
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

    // The raster's origin sits a margin below and left of the part's box, so the
    // translation has to put the raster corner on the cell, not the box corner.
    target.parts.push({
      ...part,
      bbox,
      pivot: [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2],
      dx: i * cell - raster.originX,
      dy: j * cell - raster.originY,
      labelAt,
      labelHeight: usedLabelHeight,
    });
    target.area += area;
  }

  const sheetArea = Math.max(sheetWidth * sheetHeight, 1);
  boards.forEach((board, index) => {
    sheets.push({
      index: index + 1,
      material,
      ordinal: index + 1,
      parts: board.parts,
      fill: board.area / sheetArea,
    });
  });

  return { sheets, unplaced };
}
