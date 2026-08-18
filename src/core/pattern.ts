/**
 * Kerros wall patterns.
 *
 * Perforation in the wall of a slice, applied per layer in 2D rather than as a
 * 3D volume subtraction. That is a manufacturability decision, not a shortcut:
 * a hole carved through the solid becomes a different, unpredictable shape on
 * every layer it crosses, and the layer where it is 0.4 mm wide is the one that
 * falls apart on the bed. Placing holes per slice means every hole is checked
 * against the material it is actually cut from.
 *
 * The region a hole may occupy is not computed by offsetting polygons. The
 * clearance to the edge is measured **in the plane of the slice**, against the
 * slice's own contours, and the inside/outside sign comes from the field.
 *
 * Using the 3D field for the distance as well — which the first version did —
 * is wrong, and visibly so. Near the top of a curved form the nearest surface
 * to a point in the middle of a slice is above or below it, not out at the
 * edge, so the field reports a millimetre of depth where the flat part has
 * fifty. Holes then vanish from the middle of a perfectly solid slice in an
 * irregular blotch. The slice is a flat piece of 3 mm board: the only bridge
 * that matters is the one you could measure on it with calipers.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export const PATTERN_KINDS = ['grid', 'hex', 'scatter', 'radial'] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export const PATTERN_LABELS: Record<PatternKind, string> = {
  grid: 'Square grid',
  hex: 'Hex grid',
  scatter: 'Seeded scatter',
  radial: 'Radial rings',
};

export interface PatternCircle {
  x: number;
  y: number;
  /** Radius of the cut path, kerf-compensated. */
  r: number;
  label: string;
}

export interface PatternOptions {
  kind: PatternKind;
  /**
   * Perforate only within this distance of an edge, mm. 0 fills the whole
   * part. A shelled slice is already a narrow band, but a solid slice — a cap,
   * a foot, a layer where the form has narrowed past the wall thickness —
   * fills edge to edge without it.
   */
  band?: number;
  /** Finished hole radius, mm. The cut path is half a kerf smaller. */
  radius: number;
  /** Centre-to-centre spacing, mm. */
  pitch: number;
  /**
   * Narrowest strip of material the pattern may leave, mm. Enforced against
   * the wall, against rod holes and between pattern holes alike.
   */
  minBridge: number;
  /** Fraction of candidates kept, 0..1. Below 1 the pattern thins out. */
  density: number;
  kerf: number;
  seed: number;
  /** Turn each layer's lattice by a seeded angle, so no two layers match. */
  rotatePerLayer: boolean;
}

export interface Existing {
  x: number;
  y: number;
  /** Cut radius of a hole already in the slice. */
  r: number;
}

/** A ring of the slice, flat [x0, y0, x1, y1, ...]. */
export interface Ring {
  points: number[];
}

export interface PatternInput {
  /** Plane the slice was taken on. */
  z: number;
  /**
   * The slice's own contours, outer and holes alike. Clearance is measured
   * against these, in the plane, because that is the material being cut.
   */
  contours: Ring[];
  /** Where to look, in mm. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Holes already placed, e.g. rod clearances. */
  existing: Existing[];
  /** The field the slice came from. Negative inside the material. */
  sample: (x: number, y: number, z: number) => number;
  /** Layer number, so each layer can differ reproducibly. */
  layer: number;
}

/* ------------------------------------------------------------------ *
 * In-plane distance
 * ------------------------------------------------------------------ */

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Nearest-edge lookup for one slice.
 *
 * Segments are bucketed on a uniform grid and the search walks outwards a ring
 * of cells at a time, stopping as soon as no closer segment is possible. Every
 * query is bounded by `limit`, because the callers only ever ask "is there at
 * least this much room", never "exactly how far".
 */
export class EdgeIndex {
  private readonly cell: number;
  private readonly buckets = new Map<string, Segment[]>();

  constructor(contours: Ring[], cell: number) {
    this.cell = Math.max(cell, 0.5);

    for (const ring of contours) {
      const n = ring.points.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const seg: Segment = {
          x1: ring.points[i * 2],
          y1: ring.points[i * 2 + 1],
          x2: ring.points[j * 2],
          y2: ring.points[j * 2 + 1],
        };
        this.insert(seg);
      }
    }
  }

  private key(cx: number, cy: number) {
    return `${cx}:${cy}`;
  }

  private insert(seg: Segment) {
    const minX = Math.floor(Math.min(seg.x1, seg.x2) / this.cell);
    const maxX = Math.floor(Math.max(seg.x1, seg.x2) / this.cell);
    const minY = Math.floor(Math.min(seg.y1, seg.y2) / this.cell);
    const maxY = Math.floor(Math.max(seg.y1, seg.y2) / this.cell);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const k = this.key(cx, cy);
        const bucket = this.buckets.get(k);
        if (bucket) bucket.push(seg);
        else this.buckets.set(k, [seg]);
      }
    }
  }

  /** Distance to the nearest edge, or `limit` when nothing is closer. */
  distance(x: number, y: number, limit: number): number {
    let best = limit;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const maxRing = Math.ceil(limit / this.cell) + 1;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Anything in a further ring is at least this far away already.
      if ((ring - 1) * this.cell > best) break;

      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const bucket = this.buckets.get(this.key(cx + dx, cy + dy));
          if (!bucket) continue;
          for (const seg of bucket) {
            const d = pointToSegment(x, y, seg);
            if (d < best) best = d;
          }
        }
      }
    }

    return best;
  }
}

function pointToSegment(px: number, py: number, seg: Segment): number {
  const vx = seg.x2 - seg.x1;
  const vy = seg.y2 - seg.y1;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return Math.hypot(px - seg.x1, py - seg.y1);
  let t = ((px - seg.x1) * vx + (py - seg.y1) * vy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (seg.x1 + t * vx), py - (seg.y1 + t * vy));
}

/** Deterministic PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cut path radius for a finished hole of `radius`. */
export function patternCutRadius(radius: number, kerf: number): number {
  return Math.max(radius - Math.max(kerf, 0) / 2, 0.05);
}

/**
 * Is there room for a finished hole of `radius` centred here?
 *
 * Three clearances, all the same number, because a bridge is a bridge whatever
 * is on the other side of it:
 *   - to the wall: the field says how deep the material is
 *   - to a hole already in the slice, at its finished size
 *   - to the pattern holes placed so far
 */
export function holeFits(
  x: number,
  y: number,
  input: PatternInput,
  options: PatternOptions,
  placed: PatternCircle[],
  edges?: EdgeIndex,
): boolean {
  const { radius, minBridge, kerf } = options;
  const need = radius + minBridge;

  // Sign from the field, magnitude from the contours: the field knows which
  // side of the surface a point is on, the contours know how far the edge is
  // in the plane that will actually be cut.
  if (input.sample(x, y, input.z) >= 0) return false;

  const band = options.band ?? 0;
  const limit = band > 0 ? Math.max(need, band) + 1 : need;
  const index = edges ?? new EdgeIndex(input.contours, Math.max(need, 2));
  const edge = index.distance(x, y, limit);

  if (!(edge >= need)) return false;
  if (band > 0 && edge > band) return false;

  for (const hole of input.existing) {
    // Cut radii come back one half kerf larger once cut.
    const finished = hole.r + kerf / 2;
    if (Math.hypot(x - hole.x, y - hole.y) - finished - radius < minBridge) return false;
  }

  for (const hole of placed) {
    const finished = hole.r + kerf / 2;
    if (Math.hypot(x - hole.x, y - hole.y) - finished - radius < minBridge) return false;
  }

  return true;
}

/**
 * Perforate one slice.
 *
 * Every generator ends up in the same acceptance test, so `minBridge` is
 * respected by construction rather than by each generator remembering to. A
 * generator that cannot place anything returns nothing, which is the honest
 * answer for a wall too thin to perforate.
 */
export function generatePattern(
  input: PatternInput,
  options: PatternOptions,
): PatternCircle[] {
  const { kind, radius, minBridge } = options;
  const pitch = Math.max(options.pitch, 2 * radius + minBridge);
  const density = Math.min(Math.max(options.density, 0), 1);
  if (radius <= 0 || density <= 0) return [];

  // Seeded per layer, so each layer differs but the lamp is reproducible.
  const random = mulberry32(options.seed * 2654435761 + input.layer * 40503 + 17);
  const angle = options.rotatePerLayer ? random() * Math.PI * 2 : 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const { minX, minY, maxX, maxY } = input.bounds;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const reach = Math.hypot(maxX - minX, maxY - minY) / 2 + pitch;

  const cutR = patternCutRadius(radius, options.kerf);
  const placed: PatternCircle[] = [];

  // Built once per slice rather than once per candidate.
  const band = options.band ?? 0;
  const edges = new EdgeIndex(
    input.contours,
    Math.max(radius + minBridge, band > 0 ? band : 0, 2),
  );

  const tryPlace = (lx: number, ly: number) => {
    // Lattice coordinates are rotated about the centre, not the origin, so a
    // turned pattern stays centred on the part.
    const x = centreX + lx * cos - ly * sin;
    const y = centreY + lx * sin + ly * cos;
    if (density < 1 && random() > density) return;
    if (!holeFits(x, y, input, options, placed, edges)) return;
    placed.push({ x, y, r: cutR, label: 'pattern' });
  };

  if (kind === 'grid' || kind === 'hex') {
    const rowStep = kind === 'hex' ? pitch * Math.sqrt(3) / 2 : pitch;
    const rows = Math.ceil((2 * reach) / rowStep);
    const cols = Math.ceil((2 * reach) / pitch);
    for (let j = -rows; j <= rows; j++) {
      const ly = j * rowStep;
      const offset = kind === 'hex' && (j & 1) !== 0 ? pitch / 2 : 0;
      for (let i = -cols; i <= cols; i++) {
        tryPlace(i * pitch + offset, ly);
      }
    }
  } else if (kind === 'radial') {
    // Rings out from the centre, with the angular step chosen so spacing along
    // each ring matches the radial spacing.
    for (let ring = 1; ring * pitch <= reach; ring++) {
      const r = ring * pitch;
      const count = Math.max(4, Math.round((2 * Math.PI * r) / pitch));
      const phase = options.rotatePerLayer ? random() * Math.PI * 2 : 0;
      for (let k = 0; k < count; k++) {
        const a = phase + (k / count) * Math.PI * 2;
        tryPlace(r * Math.cos(a), r * Math.sin(a));
      }
    }
  } else {
    // Scatter: dart throwing over the bounding box. The attempt count is set
    // from the area a packed lattice would fill, so density means roughly the
    // same thing here as it does for a grid.
    const area = Math.max((maxX - minX) * (maxY - minY), 1);
    const attempts = Math.min(Math.ceil((area / (pitch * pitch)) * 12), 20000);
    for (let n = 0; n < attempts; n++) {
      const lx = (random() * 2 - 1) * reach;
      const ly = (random() * 2 - 1) * reach;
      // Density is applied through the attempt count here, not per candidate.
      if (!holeFits(centreX + lx, centreY + ly, input, options, placed, edges)) continue;
      if (placed.length > 0 && random() > density) continue;
      placed.push({ x: centreX + lx, y: centreY + ly, r: cutR, label: 'pattern' });
    }
  }

  return placed;
}

/**
 * Narrowest bridge the pattern actually left, mm.
 *
 * The generator enforces the limit as it places; this measures the result, so
 * the check and the construction are not the same code. Returns Infinity when
 * there is nothing to measure.
 */
export function measuredBridge(
  circles: PatternCircle[],
  input: PatternInput,
  kerf: number,
): number {
  let worst = Infinity;
  const edges = new EdgeIndex(input.contours, 4);

  for (let i = 0; i < circles.length; i++) {
    const a = circles[i];
    const finishedA = a.r + kerf / 2;

    const depth = edges.distance(a.x, a.y, 1e6) - finishedA;
    if (depth < worst) worst = depth;

    for (const hole of input.existing) {
      const gap = Math.hypot(a.x - hole.x, a.y - hole.y) - finishedA - (hole.r + kerf / 2);
      if (gap < worst) worst = gap;
    }

    for (let j = i + 1; j < circles.length; j++) {
      const b = circles[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - finishedA - (b.r + kerf / 2);
      if (gap < worst) worst = gap;
    }
  }

  return worst;
}
