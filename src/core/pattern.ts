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
 * distance field already knows how far any point is from the boundary, so a
 * hole of radius r is accepted where the material is at least r plus the bridge
 * width deep. That is exact, needs no offsetting library, and is automatically
 * correct on sloped walls, where the field reports the shortest distance to the
 * surface rather than the in-plane one.
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

export interface PatternInput {
  /** Plane the slice was taken on. */
  z: number;
  /** Where to look, in mm. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Holes already placed, e.g. rod clearances. */
  existing: Existing[];
  /** The field the slice came from. Negative inside the material. */
  sample: (x: number, y: number, z: number) => number;
  /** Layer number, so each layer can differ reproducibly. */
  layer: number;
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
): boolean {
  const { radius, minBridge, kerf } = options;
  const depth = -input.sample(x, y, input.z);
  if (!(depth >= radius + minBridge)) return false;

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

  const tryPlace = (lx: number, ly: number) => {
    // Lattice coordinates are rotated about the centre, not the origin, so a
    // turned pattern stays centred on the part.
    const x = centreX + lx * cos - ly * sin;
    const y = centreY + lx * sin + ly * cos;
    if (density < 1 && random() > density) return;
    if (!holeFits(x, y, input, options, placed)) return;
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
      if (!holeFits(centreX + lx, centreY + ly, input, options, placed)) continue;
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

  for (let i = 0; i < circles.length; i++) {
    const a = circles[i];
    const finishedA = a.r + kerf / 2;

    const depth = -input.sample(a.x, a.y, input.z) - finishedA;
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
