/**
 * Kerros slicer.
 *
 * Takes a scalar field and turns it into per-layer polygons ready for cutting.
 * The slicer deliberately knows nothing about SDF trees: it is handed a
 * sampler `(x, y, z) => distance`, so the same code slices a feature tree, an
 * imported mesh's field, or an analytic test shape. That is what lets the
 * validator check it against surfaces whose contours are known exactly.
 *
 * DELIBERATE CONSTRAINT: no value imports. Node validators load this as the
 * real module.
 *
 * Conventions: Z up, mm throughout. Outer contours come out counter-clockwise
 * (positive signed area), holes clockwise (negative).
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** A closed ring, flat [x0, y0, x1, y1, ...], first point not repeated. */
export interface Contour {
  points: number[];
  /** Signed area in mm². Positive is an outer boundary, negative a hole. */
  area: number;
  isHole: boolean;
  /**
   * The feature that put this here, when something did.
   *
   * Absent on contours that came out of the field — those belong to the whole
   * accumulated form and no single feature owns them. Present on holes cut per
   * slice, which is what lets a person point at one in the slice view and have
   * the program know whose it is.
   *
   * Stamped at the moment the hole is made rather than worked out later. The
   * model view has to ask every feature for its distance, because a merged
   * surface cannot say who owns a patch of it; a hole cut per slice was made by
   * exactly one feature, and it is cheaper and more truthful to remember that
   * than to reconstruct it.
   */
  owner?: string;
}

/** A circular cut, kept as a circle rather than polygonised. */
export interface CircleHole {
  x: number;
  y: number;
  /** Radius of the cut path, already kerf-compensated. */
  r: number;
  /** What put it there, e.g. 'M5 rod'. */
  label: string;
  /** The id of the feature that put it there, for pointing at it. */
  owner?: string;
  /** For a pin, the other sheet it also passes through. */
  pinTo?: number;
  /** For a pin, which one it is: `gap:position`. */
  pinKey?: string;
}

export interface Slice {
  /** 1-based layer number, counted from the bottom over non-empty layers. */
  index: number;
  /** Z of the plane the field was sampled on, mm. */
  z: number;
  /** Z of the underside of the physical sheet, mm. */
  zBottom: number;
  contours: Contour[];
  /** Circular holes added by rig features. Empty until rods are applied. */
  circles: CircleHole[];
  /** Upright assemblies use local sheet coordinates and a rigid placement. */
  part?: {
    id: string;
    label: string;
    kind: 'rib' | 'support' | 'backplate';
    origin: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
    n: [number, number, number];
    thickness: number;
    kerf: number;
    material: string;
    wallOffset?: number;
  };
}

export interface SliceSet {
  slices: Slice[];
  /** Oblique rods in horizontal stacks. Refused cuts block manufacturing export. */
  rods?: {
    routes: { id: string; label: string; start: [number, number, number]; end: [number, number, number]; diameter: number; layers: number[] }[];
    issues: { id: string; severity: 'error' | 'warning'; message: string }[];
  };
  assembly?: {
    id: string;
    cuttable: boolean;
    issues: { severity: 'error' | 'warning' | 'info'; ids: string[]; message: string; ribCollision?: [string, string] }[];
    joints: { id: string; parts: string[]; instruction: string }[];
    channels: {
      id: string; hits: string[]; status: string; kind?: 'rod';
      /** Route anchor in world and assembly coordinates, independent of fitted ends. */
      origin: [number, number, number]; localOrigin: [number, number, number];
      start: [number, number, number]; end: [number, number, number];
      u: [number, number, number]; v: [number, number, number]; width: number; height: number;
    }[];
  };
  /** Layer pitch used, mm (material thickness + spacer height). */
  pitch: number;
  /** Every plane examined, in order from the bottom. */
  planes: LayerPlane[];
  thickness: number;
  /** Z where the stack starts, mm. */
  z0: number;
  /** Candidate planes examined, including ones that came out empty. */
  planesExamined: number;
  /** XY sample spacing used, mm. */
  step: number;
  /** Kerf the contours were compensated for, mm. */
  kerf: number;
}

/**
 * One sheet's plane.
 *
 * The stack used to be described by a single pitch, which is true only while
 * every gap is the same. A list says the same thing when the gaps are equal and
 * keeps saying it when they are not.
 *
 * `index` counts planes **examined** from the bottom of the model, from 0 —
 * not slices produced. A model with a gap along Z skips a slice but not a
 * plane, and per-layer window rolls are seeded from this number, so it has to
 * mean the same thing it has always meant.
 */
export interface LayerPlane {
  index: number;
  /** Bottom of the sheet, mm. */
  z0: number;
  /** Mid-plane: where the field is sampled, splitting the error on a steep wall. */
  z: number;
  thickness: number;
  /** Gap to the sheet above, mm. */
  gapAbove: number;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SliceOptions {
  /** Material thickness, mm. */
  thickness: number;
  /** Gap between sheets at the bottom of the stack, mm. 0 is a tight stack. */
  spacerHeight: number;
  /** Gap at the top, mm. Omitted or equal to `spacerHeight` means uniform. */
  spacerHeightTop?: number;
  /**
   * Gap in the **middle** of the stack, mm. Omitted is a straight run between
   * the two ends.
   *
   * With it, the gradient is two runs rather than one, so the stack can be
   * tight in the middle and open out both ways — or the other way round. The
   * shape people actually asked for once they had a dial with two ends.
   */
  spacerHeightMid?: number;
  /** Thickness of one spacer ring, mm. Defaults to the sheet thickness. */
  spacerThickness?: number;
  /** Samples along the longest XY axis. */
  resolution: number;
  /** RDP tolerance, mm. Larger drops more points. */
  tolerance: number;
  /** Chaikin passes. 0 leaves the marching-squares staircase in place. */
  smoothing: number;
  /**
   * Cut width, mm. The contour is taken at the iso-level kerf/2 instead of 0,
   * which grows outer boundaries and shrinks holes by half a kerf each — the
   * whole of kerf compensation, in one number, with no polygon offsetting.
   */
  kerf?: number;
  /** Hard cap so a silly pitch cannot lock the app up. */
  maxLayers?: number;
}

export type Sampler = (x: number, y: number, z: number) => number;

const DEFAULT_MAX_LAYERS = 400;

/** Trace in a sheet's own coordinates. The caller supplies an in-plane field. */
export function traceSheet(
  sample: (x: number, y: number) => number,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  step: number,
  iso = 0,
  tolerance = 0.02,
): Contour[] {
  const pad = Math.max(2 * step, Math.abs(iso) + step);
  const x0 = box.minX - pad, y0 = box.minY - pad;
  const nx = Math.ceil((box.maxX - box.minX + 2 * pad) / step) + 1;
  const ny = Math.ceil((box.maxY - box.minY + 2 * pad) / step) + 1;
  const field = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) field[y * nx + x] = sample(x0 + x * step, y0 + y * step) - iso;
  }
  return contoursFromField(field, nx, ny, x0, y0, step).flatMap((ring) => {
    const points = simplifyRing(ring, tolerance);
    const area = signedArea(points);
    return Math.abs(area) < step * step * 0.25 ? [] : [{ points, area, isHole: area < 0 }];
  });
}

/* ------------------------------------------------------------------ *
 * Polygon helpers
 * ------------------------------------------------------------------ */

/** Shoelace area. Positive for counter-clockwise rings. */
export function signedArea(points: number[]): number {
  const n = points.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum / 2;
}

export function perimeter(points: number[]): number {
  const n = points.length / 2;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += Math.hypot(points[j * 2] - points[i * 2], points[j * 2 + 1] - points[i * 2 + 1]);
  }
  return sum;
}

/** Even-odd point-in-ring test. */
export function pointInRing(points: number[], x: number, y: number): boolean {
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

/* ------------------------------------------------------------------ *
 * Simplification and smoothing
 * ------------------------------------------------------------------ */

function perpendicularDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer-Douglas-Peucker on an open polyline given as indices into `points`. */
function rdpRange(points: number[], first: number, last: number, tolerance: number, keep: boolean[]) {
  if (last <= first + 1) return;

  let worst = -1;
  let worstDistance = 0;
  const ax = points[first * 2];
  const ay = points[first * 2 + 1];
  const bx = points[last * 2];
  const by = points[last * 2 + 1];

  for (let i = first + 1; i < last; i++) {
    const d = perpendicularDistance(points[i * 2], points[i * 2 + 1], ax, ay, bx, by);
    if (d > worstDistance) {
      worstDistance = d;
      worst = i;
    }
  }

  if (worstDistance <= tolerance || worst < 0) return;

  keep[worst] = true;
  rdpRange(points, first, worst, tolerance, keep);
  rdpRange(points, worst, last, tolerance, keep);
}

/**
 * RDP for a closed ring.
 *
 * A ring has no natural endpoints, so it is split at the vertex farthest from
 * the first one and simplified as two arcs. Anchoring on the first vertex
 * alone would leave a kink there.
 */
export function simplifyRing(points: number[], tolerance: number): number[] {
  const n = points.length / 2;
  if (n < 4 || tolerance <= 0) return points.slice();

  let farthest = 1;
  let farthestDistance = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(points[i * 2] - points[0], points[i * 2 + 1] - points[1]);
    if (d > farthestDistance) {
      farthestDistance = d;
      farthest = i;
    }
  }

  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[farthest] = true;

  rdpRange(points, 0, farthest, tolerance, keep);

  // Second arc wraps past the end, so walk it on a rotated copy.
  const tailLength = n - farthest + 1;
  const tail: number[] = [];
  for (let i = 0; i < tailLength; i++) {
    const src = (farthest + i) % n;
    tail.push(points[src * 2], points[src * 2 + 1]);
  }
  const tailKeep = new Array<boolean>(tailLength).fill(false);
  tailKeep[0] = true;
  tailKeep[tailLength - 1] = true;
  rdpRange(tail, 0, tailLength - 1, tolerance, tailKeep);
  for (let i = 1; i < tailLength - 1; i++) {
    if (tailKeep[i]) keep[(farthest + i) % n] = true;
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out.length >= 6 ? out : points.slice();
}

/**
 * Chaikin corner cutting on a closed ring. Each pass replaces every vertex
 * with two points at 1/4 and 3/4 along its edges, which rounds the
 * marching-squares staircase without inventing detail.
 */
export function smoothRing(points: number[], passes: number): number[] {
  let current = points.slice();
  for (let pass = 0; pass < passes; pass++) {
    const n = current.length / 2;
    if (n < 3) return current;
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = current[i * 2];
      const ay = current[i * 2 + 1];
      const bx = current[j * 2];
      const by = current[j * 2 + 1];
      next.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25);
      next.push(ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    current = next;
  }
  return current;
}

/* ------------------------------------------------------------------ *
 * Marching squares
 * ------------------------------------------------------------------ */

/**
 * Segment table, indexed by the mask of corners with a negative value.
 *
 * Corners run counter-clockwise from the cell's low corner:
 *   0 = (i, j)   1 = (i+1, j)   2 = (i+1, j+1)   3 = (i, j+1)
 * Cell edges: 0 = bottom (c0-c1), 1 = right (c1-c2), 2 = top (c3-c2),
 * 3 = left (c0-c3).
 *
 * Every segment is directed so the solid lies on its left, which makes outer
 * rings counter-clockwise and holes clockwise with no post-processing.
 * Masks 5 and 10 are saddles and resolved from the cell's mean value.
 */
const SEGMENTS: number[][] = [
  [], // 0
  [0, 3], // 1: c0
  [1, 0], // 2: c1
  [1, 3], // 3: c0 c1
  [2, 1], // 4: c2
  [], // 5: saddle
  [2, 0], // 6: c1 c2
  [2, 3], // 7: all but c3
  [3, 2], // 8: c3
  [0, 2], // 9: c0 c3
  [], // 10: saddle
  [1, 2], // 11: all but c2
  [3, 1], // 12: c2 c3
  [0, 1], // 13: all but c1
  [3, 0], // 14: all but c0
  [], // 15
];

const SADDLE_5_CONNECTED = [0, 1, 2, 3]; // centre inside: pockets at c1 and c3
const SADDLE_5_SEPARATE = [0, 3, 2, 1]; // centre outside: solids at c0 and c2
const SADDLE_10_CONNECTED = [3, 0, 1, 2]; // centre inside: pockets at c0 and c2
const SADDLE_10_SEPARATE = [1, 0, 3, 2]; // centre outside: solids at c1 and c3

/**
 * Extract closed contours from a 2D scalar field.
 *
 * Crossing points are identified by which grid edge they sit on, not by
 * coordinates, so rings stitch together exactly instead of relying on
 * floating-point endpoint matching.
 *
 * The field must be positive on the whole grid boundary; `sliceModel` pads the
 * sampling window to guarantee that, and open contours are dropped rather than
 * closed with a guess.
 */
export function contoursFromField(
  field: Float32Array | Float64Array,
  nx: number,
  ny: number,
  originX: number,
  originY: number,
  step: number,
): number[][] {
  if (nx < 2 || ny < 2) return [];

  const at = (i: number, j: number) => field[i + nx * j];
  const horizontalCount = (nx - 1) * ny;

  // Crossing point ids: horizontal edges first, then vertical.
  const idH = (i: number, j: number) => j * (nx - 1) + i;
  const idV = (i: number, j: number) => horizontalCount + j * nx + i;

  const pointX = new Map<number, number>();
  const pointY = new Map<number, number>();
  const next = new Map<number, number>();

  const crossH = (i: number, j: number) => {
    const id = idH(i, j);
    if (!pointX.has(id)) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const t = a === b ? 0.5 : a / (a - b);
      pointX.set(id, originX + (i + t) * step);
      pointY.set(id, originY + j * step);
    }
    return id;
  };

  const crossV = (i: number, j: number) => {
    const id = idV(i, j);
    if (!pointX.has(id)) {
      const a = at(i, j);
      const b = at(i, j + 1);
      const t = a === b ? 0.5 : a / (a - b);
      pointX.set(id, originX + i * step);
      pointY.set(id, originY + (j + t) * step);
    }
    return id;
  };

  /** Crossing id for one of the four cell edges. */
  const edgePoint = (edge: number, i: number, j: number) => {
    if (edge === 0) return crossH(i, j);
    if (edge === 1) return crossV(i + 1, j);
    if (edge === 2) return crossH(i, j + 1);
    return crossV(i, j);
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v0 = at(i, j);
      const v1 = at(i + 1, j);
      const v2 = at(i + 1, j + 1);
      const v3 = at(i, j + 1);

      let mask = 0;
      if (v0 < 0) mask |= 1;
      if (v1 < 0) mask |= 2;
      if (v2 < 0) mask |= 4;
      if (v3 < 0) mask |= 8;

      let pairs: number[];
      if (mask === 5) {
        const centre = (v0 + v1 + v2 + v3) / 4;
        pairs = centre < 0 ? SADDLE_5_CONNECTED : SADDLE_5_SEPARATE;
      } else if (mask === 10) {
        const centre = (v0 + v1 + v2 + v3) / 4;
        pairs = centre < 0 ? SADDLE_10_CONNECTED : SADDLE_10_SEPARATE;
      } else {
        pairs = SEGMENTS[mask];
      }

      for (let s = 0; s < pairs.length; s += 2) {
        const from = edgePoint(pairs[s], i, j);
        const to = edgePoint(pairs[s + 1], i, j);
        next.set(from, to);
      }
    }
  }

  const rings: number[][] = [];
  const visited = new Set<number>();

  for (const start of next.keys()) {
    if (visited.has(start)) continue;

    const ring: number[] = [];
    let current = start;
    let closed = false;

    for (let guard = 0; guard <= next.size; guard++) {
      if (visited.has(current)) {
        closed = current === start;
        break;
      }
      visited.add(current);
      ring.push(pointX.get(current) as number, pointY.get(current) as number);
      const step = next.get(current);
      if (step === undefined) break;
      current = step;
      if (current === start) {
        closed = true;
        break;
      }
    }

    // Open chains mean the surface ran off the sampling window. Dropping them
    // is honest; closing them would invent an edge and cut a wrong part.
    if (closed && ring.length >= 6) rings.push(ring);
  }

  return rings;
}

/* ------------------------------------------------------------------ *
 * Contour grouping
 * ------------------------------------------------------------------ */

export interface ContourGroup {
  outer: Contour;
  holes: Contour[];
}

/**
 * Pair holes with the outer ring that contains them, so each group can be
 * extruded, nested and cut as one part.
 *
 * A hole is assigned to the smallest outer ring containing it. Islands sitting
 * inside a hole are treated as their own parts, which is correct for cutting:
 * they fall out and are placed back by hand.
 */
export function groupContours(contours: Contour[]): ContourGroup[] {
  const outers = contours.filter((c) => !c.isHole);
  const holes = contours.filter((c) => c.isHole);

  const groups: ContourGroup[] = outers.map((outer) => ({ outer, holes: [] }));

  for (const hole of holes) {
    const x = hole.points[0];
    const y = hole.points[1];
    let bestGroup: ContourGroup | null = null;
    let bestArea = Infinity;

    for (const group of groups) {
      const area = Math.abs(group.outer.area);
      if (area < bestArea && pointInRing(group.outer.points, x, y)) {
        bestArea = area;
        bestGroup = group;
      }
    }

    if (bestGroup) bestGroup.holes.push(hole);
  }

  return groups;
}

/**
 * Can this circular hole actually be cut in this part?
 *
 * A rod hole that crosses a contour is not a hole, it is a bite out of the
 * edge. Geometrically it also breaks polygon triangulation — feed a hole path
 * that crosses the outline into a tessellator and it emits a fan of garbage
 * across the part, which is exactly what an intersecting rod hole looked like
 * in the stack view before this check existed.
 *
 * A hole qualifies when its centre is inside the outer ring, outside every
 * existing hole, and no ring comes within `clearance` of its edge.
 */
export function circleFitsInPart(
  group: ContourGroup,
  circle: { x: number; y: number; r: number },
  clearance = 0,
): boolean {
  if (!pointInRing(group.outer.points, circle.x, circle.y)) return false;
  for (const hole of group.holes) {
    if (pointInRing(hole.points, circle.x, circle.y)) return false;
  }

  const limit = circle.r + clearance;
  for (const contour of [group.outer, ...group.holes]) {
    const pts = contour.points;
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      // Simplified outlines can have very long edges. Vertices alone miss a
      // circle crossing the middle of one, even on a four-vertex rectangle.
      if (perpendicularDistance(circle.x, circle.y, pts[i], pts[i + 1], pts[j], pts[j + 1]) <= limit) return false;
    }
  }

  return true;
}

/**
 * Can this polygon be cut as a hole in this part?
 *
 * The circle version of this test exists because a rod hole crossing a contour
 * breaks triangulation and cuts a bite out of the edge instead of a hole. The
 * same applies to a pocket, and more often: a Wago chamber is large, and the
 * layer it lands on may be a narrow ring with nowhere near enough material.
 *
 * Every vertex must be inside the outer ring, outside every existing hole, and
 * at least `clearance` from any edge.
 */
export function polygonFitsInPart(
  group: ContourGroup,
  points: number[],
  clearance = 0,
): boolean {
  if (points.length < 6) return false;

  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];

    if (!pointInRing(group.outer.points, x, y)) return false;
    for (const hole of group.holes) {
      if (pointInRing(hole.points, x, y)) return false;
    }

    if (clearance > 0) {
      for (const contour of [group.outer, ...group.holes]) {
        const pts = contour.points;
        for (let j = 0; j < pts.length; j += 2) {
          if (Math.hypot(pts[j] - x, pts[j + 1] - y) < clearance) return false;
        }
      }
    }
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Slicing
 * ------------------------------------------------------------------ */

/**
 * Plane positions for the stack.
 *
 * Layer k's sheet occupies [z0 + k·pitch, z0 + k·pitch + thickness] and the
 * field is sampled at its mid-plane. Mid-plane sampling means a steep wall is
 * represented by its cross-section halfway up the sheet, which splits the
 * error evenly between over- and under-cut; top/bottom-plane union is on the
 * roadmap for stepped accuracy.
 */
/** Whole rings that fit a requested gap. A ring is one sheet of its own material. */
export function ringsForGap(gap: number, spacerThickness: number): number {
  if (!(spacerThickness > 0)) return 0;
  return Math.max(Math.round(Math.max(gap, 0) / spacerThickness), 0);
}

/**
 * Where every sheet sits.
 *
 * Gaps are counted in **rings**, not millimetres, because a ring is one sheet
 * of spacer material and half a ring does not exist. Planning on the requested
 * gap rather than the achievable one designs a lamp that will not close on its
 * rods once everything is cut.
 *
 * A gradient interpolates the ring count by **height**, not by gap number: the
 * number of gaps depends on the gradient, so a gradient defined per gap would
 * be defined in terms of its own result. Height also matches what a gradient
 * physically means — the gap depends on where in the form you are.
 */
export function planLayers(
  bounds: Bounds,
  options: Pick<
    SliceOptions,
    | 'thickness'
    | 'spacerHeight'
    | 'spacerHeightTop'
    | 'spacerHeightMid'
    | 'spacerThickness'
    | 'maxLayers'
  >,
): LayerPlane[] {
  const thickness = options.thickness;
  if (!(thickness > 0)) return [];

  const ringT =
    options.spacerThickness !== undefined && options.spacerThickness > 0
      ? options.spacerThickness
      : thickness;

  const ringsLow = ringsForGap(options.spacerHeight, ringT);
  const ringsHigh =
    options.spacerHeightTop === undefined
      ? ringsLow
      : ringsForGap(options.spacerHeightTop, ringT);
  const ringsMid =
    options.spacerHeightMid === undefined
      ? null
      : ringsForGap(options.spacerHeightMid, ringT);

  const z0 = bounds.min[2];
  const height = bounds.max[2] - z0;
  const cap = options.maxLayers ?? DEFAULT_MAX_LAYERS;

  /*
   * Uniform stays a closed form.
   *
   * Marching `z += pitch` accumulates rounding, and `z0 + k * pitch` does not.
   * They agree to about 1e-12, which is not the same as agreeing, and a uniform
   * stack is the case that must come out bit-identical to what it always has.
   * So a gradient is not a generalisation of uniform here — uniform is its own
   * branch, on purpose.
   */
  /*
   * Two runs when there is a middle, one when there is not.
   *
   * **Halfway up in height, not halfway up in layers.** The number of layers
   * depends on the gradient, so a midpoint defined by layer number would be
   * defined in terms of its own result — the same reason the two-ended version
   * interpolates by height. Height is also what a gradient physically means:
   * the gap depends on where in the form you are.
   */
  const ringsAtHeight = (u: number): number => {
    if (ringsMid === null) return ringsLow + (ringsHigh - ringsLow) * u;
    return u <= 0.5
      ? ringsLow + (ringsMid - ringsLow) * (u / 0.5)
      : ringsMid + (ringsHigh - ringsMid) * ((u - 0.5) / 0.5);
  };

  const uniform =
    ringsLow === ringsHigh && (ringsMid === null || ringsMid === ringsLow);

  if (uniform) {
    const pitch = thickness + ringsLow * ringT;
    if (!(pitch > 0)) return [];
    const count = Math.min(Math.max(Math.ceil(height / pitch), 1), cap);
    const out: LayerPlane[] = [];
    for (let k = 0; k < count; k++) {
      const bottom = z0 + k * pitch;
      out.push({
        index: k,
        z0: bottom,
        z: bottom + thickness / 2,
        thickness,
        gapAbove: ringsLow * ringT,
      });
    }
    return out;
  }

  const out: LayerPlane[] = [];
  let bottom = z0;
  for (let k = 0; k < cap; k++) {
    const u = height > 1e-9 ? Math.min(Math.max((bottom - z0) / height, 0), 1) : 0;
    const rings = Math.max(Math.round(ringsAtHeight(u)), 0);
    const gap = rings * ringT;
    out.push({ index: k, z0: bottom, z: bottom + thickness / 2, thickness, gapAbove: gap });
    bottom += thickness + gap;
    if (bottom >= z0 + height) break;
  }
  return out;
}

/**
 * Pitch at a height: the sheet there plus the gap above it.
 *
 * The one thing a caller outside the slicer still legitimately wants a single
 * pitch for — sizing a fixture's band, for instance — and the honest answer
 * once gaps vary is "which pitch, where".
 */
export function pitchAt(planes: LayerPlane[], z: number): number {
  if (planes.length === 0) return 0;
  let best = planes[0];
  for (const plane of planes) {
    if (Math.abs(plane.z - z) < Math.abs(best.z - z)) best = plane;
  }
  return best.thickness + best.gapAbove;
}

/**
 * Plane bottoms only.
 *
 * Kept because it is what the layer-planning validator measures, and because
 * the arithmetic it pins — one pitch apart, first at the bottom, the cap, the
 * zero-pitch case — is still the arithmetic `planLayers` performs.
 */
export function planeZs(bounds: Bounds, options: SliceOptions): number[] {
  return planLayers(bounds, options).map((plane) => plane.z0);
}

/**
 * Slice a field into layers.
 *
 * Only layers that produced geometry are returned, numbered 1..n from the
 * bottom. Each keeps its own z, so a model with a gap along Z does not lose
 * that gap — there is simply no part for the empty layer.
 */
export function sliceModel(
  sample: Sampler,
  bounds: Bounds,
  options: SliceOptions,
): SliceSet {
  const planes = planLayers(bounds, options);

  /*
   * The pitch this set reports.
   *
   * Taken from the plan rather than from `thickness + spacerHeight`, so it is
   * the pitch that will actually be built: gaps are whole rings, and 4 mm of
   * 3 mm rings is 3 mm. On a graded stack one number cannot be the whole
   * answer, so this is the pitch at the **bottom** — `planes` carries the rest,
   * and a readout that wants the range takes it from there.
   */
  const pitch =
    planes.length > 0 ? planes[0].thickness + planes[0].gapAbove : options.thickness;

  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const longest = Math.max(sizeX, sizeY, 1);
  const resolution = Math.max(16, Math.round(options.resolution));
  const step = longest / resolution;

  // Two cells of air on every side so the surface never touches the window
  // edge, which is what keeps every contour closed.
  const pad = 2 * step;
  const originX = bounds.min[0] - pad;
  const originY = bounds.min[1] - pad;
  const nx = Math.ceil((sizeX + 2 * pad) / step) + 1;
  const ny = Math.ceil((sizeY + 2 * pad) / step) + 1;

  /**
   * Kerf compensation.
   *
   * A laser cutting along a path removes kerf/2 on each side of it, so a part
   * cut on its true outline comes out kerf/2 undersized and a hole comes out
   * kerf/2 oversized. Shifting the iso-level to +kerf/2 fixes both at once:
   * the contour moves away from the solid everywhere, which means outward on
   * an outer boundary and inward on a hole, because the field's sign already
   * knows which side the material is on.
   *
   * This is why Kerros needs no polygon offsetting library. It is also more
   * robust than one: a wall thinner than the kerf simply vanishes from the
   * field instead of producing a self-intersecting offset polygon.
   */
  const kerf = Math.max(options.kerf ?? 0, 0);
  const isoLevel = kerf / 2;

  const field = new Float64Array(nx * ny);
  const slices: Slice[] = [];

  for (const plane of planes) {
    const zBottom = plane.z0;
    const z = plane.z;

    let index = 0;
    for (let j = 0; j < ny; j++) {
      const y = originY + j * step;
      for (let i = 0; i < nx; i++) {
        field[index++] = sample(originX + i * step, y, z) - isoLevel;
      }
    }

    const rings = contoursFromField(field, nx, ny, originX, originY, step);
    const contours: Contour[] = [];

    for (const ring of rings) {
      // Smooth BEFORE simplifying, not after.
      //
      // Marching squares emits one vertex per cell crossing, so every edge is
      // about one sample long and Chaikin only rounds corners by a fraction of
      // a cell — the same scale as the staircase it is removing. Simplify
      // first and a real 90-degree corner collapses to a single vertex between
      // two long straight runs; Chaikin then cuts a quarter off each of those
      // runs and a square slice comes out visibly rounded. The validator cuts
      // a sharp box and checks its area to pin this order down.
      let points = ring;
      if (options.smoothing > 0) points = smoothRing(points, options.smoothing);
      points = simplifyRing(points, options.tolerance);
      const area = signedArea(points);
      if (Math.abs(area) < step * step) continue; // specks, not parts
      contours.push({ points, area, isHole: area < 0 });
    }

    if (contours.length === 0) continue;

    slices.push({
      index: slices.length + 1,
      z,
      zBottom,
      contours,
      circles: [],
    });
  }

  return {
    slices,
    pitch,
    thickness: options.thickness,
    z0: bounds.min[2],
    planes,
    planesExamined: planes.length,
    step,
    kerf,
  };
}

/* ------------------------------------------------------------------ *
 * Manufacturability check
 * ------------------------------------------------------------------ */

export interface GapReport {
  /** Smallest gap found, mm. Equals `threshold` when nothing came closer. */
  minGap: number;
  /** Where it was, or null when nothing was below the threshold. */
  at: [number, number] | null;
  /** True when the slice has a feature narrower than the threshold. */
  tooThin: boolean;
}

interface GapEdge {
  ax: number; ay: number; bx: number; by: number;
  minX: number; maxX: number; minY: number; maxY: number;
  ring: number; index: number; count: number;
  start: number; length: number; perimeter: number;
}

/** Parameter of the closest point on an edge, including degenerate edges. */
function gapProjection(edge: GapEdge, x: number, y: number): number {
  const dx = edge.bx - edge.ax, dy = edge.by - edge.ay;
  const squared = dx * dx + dy * dy;
  return squared > 0 ? Math.max(0, Math.min(1, ((x - edge.ax) * dx + (y - edge.ay) * dy) / squared)) : 0;
}

/**
 * Distance between cut paths, including segment interiors and circular holes.
 * The X sweep rejects disjoint boxes before measuring candidate edge pairs.
 * On the same ring, skip adjacent edges and points less than two thresholds
 * apart along the perimeter: dense samples on a curve are not a thin neck.
 * This neighbourhood is measured in mm, so simplification cannot change it.
 */
export function minFeatureGap(slice: Slice, threshold: number): GapReport {
  if (!(threshold > 0)) return { minGap: Infinity, at: null, tooThin: false };
  const edges: GapEdge[] = [];
  for (let r = 0; r < slice.contours.length; r++) {
    const pts = slice.contours[r].points;
    const count = pts.length / 2;
    const first = edges.length;
    let start = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
      const length = Math.hypot(bx - ax, by - ay);
      edges.push({ ax, ay, bx, by, minX: Math.min(ax, bx), maxX: Math.max(ax, bx),
        minY: Math.min(ay, by), maxY: Math.max(ay, by), ring: r, index: i, count,
        start, length, perimeter: 0 });
      start += length;
    }
    for (let i = first; i < edges.length; i++) edges[i].perimeter = start;
  }
  edges.sort((a, b) => a.minX - b.minX);
  let best = threshold;
  let at: [number, number] | null = null;
  const record = (ax: number, ay: number, bx: number, by: number) => {
    const gap = Math.hypot(ax - bx, ay - by);
    if (gap < best) {
      best = gap;
      at = [(ax + bx) / 2, (ay + by) / 2];
    }
  };
  const compare = (a: GapEdge, ta: number, b: GapEdge, tb: number) => {
    if (a.ring === b.ring) {
      const along = Math.abs(a.start + ta * a.length - b.start - tb * b.length);
      if (Math.min(along, a.perimeter - along) < 2 * threshold) return;
    }
    record(a.ax + ta * (a.bx - a.ax), a.ay + ta * (a.by - a.ay),
      b.ax + tb * (b.bx - b.ax), b.ay + tb * (b.by - b.ay));
  };
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (b.minX > a.maxX + threshold) break;
      if (b.minY > a.maxY + threshold || a.minY > b.maxY + threshold) continue;
      if (a.ring === b.ring) {
        const apart = Math.abs(a.index - b.index);
        if (Math.min(apart, a.count - apart) <= 1) continue;
      }
      // Non-crossing, non-parallel segments have their closest pair at an
      // endpoint of at least one edge. Midpoints also measure the interior of
      // a long parallel neck whose end is excluded as a local neighbourhood.
      for (const t of [0, 0.5, 1]) {
        compare(a, t, b, gapProjection(b, a.ax + t * (a.bx - a.ax), a.ay + t * (a.by - a.ay)));
        compare(a, gapProjection(a, b.ax + t * (b.bx - b.ax), b.ay + t * (b.by - b.ay)), b, t);
      }
      const adx = a.bx - a.ax, ady = a.by - a.ay;
      const bdx = b.bx - b.ax, bdy = b.by - b.ay;
      const cross = adx * bdy - ady * bdx;
      if (Math.abs(cross) > 1e-12) {
        const dx = b.ax - a.ax, dy = b.ay - a.ay;
        const ta = (dx * bdy - dy * bdx) / cross;
        const tb = (dx * ady - dy * adx) / cross;
        if (ta >= 0 && ta <= 1 && tb >= 0 && tb <= 1) compare(a, ta, b, tb);
      }
    }
  }

  for (let c = 0; c < slice.circles.length; c++) {
    const circle = slice.circles[c];
    for (const edge of edges) {
      const reach = circle.r + threshold;
      if (edge.minX > circle.x + reach) break;
      if (edge.maxX < circle.x - reach || edge.minY > circle.y + reach || edge.maxY < circle.y - reach) continue;
      const t = gapProjection(edge, circle.x, circle.y);
      let x = edge.ax + t * (edge.bx - edge.ax), y = edge.ay + t * (edge.by - edge.ay);
      const near = Math.hypot(x - circle.x, y - circle.y);
      const da = Math.hypot(edge.ax - circle.x, edge.ay - circle.y);
      const db = Math.hypot(edge.bx - circle.x, edge.by - circle.y);
      if (near <= circle.r && Math.max(da, db) >= circle.r) {
        // The segment crosses the circumference. The nearest point can be an
        // endpoint, so include its projection along the line in the root.
        const endX = da > db ? edge.ax : edge.bx, endY = da > db ? edge.ay : edge.by;
        const length = Math.hypot(endX - x, endY - y);
        if (length > 0) {
          const ux = (endX - x) / length, uy = (endY - y) / length;
          const along = (x - circle.x) * ux + (y - circle.y) * uy;
          const distance = -along + Math.sqrt(Math.max(0, along * along + circle.r * circle.r - near * near));
          x += ux * distance;
          y += uy * distance;
        }
        record(x, y, x, y);
      } else {
        if (Math.max(da, db) < circle.r) {
          x = da > db ? edge.ax : edge.bx;
          y = da > db ? edge.ay : edge.by;
        }
        const distance = Math.hypot(x - circle.x, y - circle.y);
        const ux = distance > 0 ? (x - circle.x) / distance : 1;
        const uy = distance > 0 ? (y - circle.y) / distance : 0;
        record(x, y, circle.x + ux * circle.r, circle.y + uy * circle.r);
      }
    }
    for (let d = c + 1; d < slice.circles.length; d++) {
      const other = slice.circles[d];
      const distance = Math.hypot(circle.x - other.x, circle.y - other.y);
      const gap = Math.max(0, distance - circle.r - other.r, Math.abs(circle.r - other.r) - distance);
      if (gap < best) {
        best = gap;
        at = [(circle.x + other.x) / 2, (circle.y + other.y) / 2];
      }
    }
  }
  return { minGap: best, at, tooThin: at !== null };
}
