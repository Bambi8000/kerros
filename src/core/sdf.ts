/**
 * Kerros SDF core.
 *
 * Signed distance field: negative inside the solid, positive outside, and the
 * magnitude is (approximately) the distance to the surface. Booleans are
 * min/max, blends are smooth min/max, and slicing later is just evaluating
 * this field on a z-plane.
 *
 * DELIBERATE CONSTRAINT: this file has no value imports. Node validators load
 * it directly as the real module, never a stub. Keep it that way — type-only
 * imports are fine (they are erased), value imports are not.
 *
 * World convention: Z up, all lengths in mm.
 */

export type Params = Record<string, number | string | boolean>;

/** Sentinel for "nothing here yet". Large, but far from float limits. */
export const EMPTY = 1e5;

export function num(p: Params, key: string, def: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export function text(p: Params, key: string, def: string): string {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : def;
}

/* ------------------------------------------------------------------ *
 * Combine operations
 * ------------------------------------------------------------------ */

export const OPS = [
  'union',
  'smoothUnion',
  'subtract',
  'smoothSubtract',
  'intersect',
  'smoothIntersect',
] as const;

export type Op = (typeof OPS)[number];

export const OP_LABELS: Record<Op, string> = {
  union: 'Union',
  smoothUnion: 'Smooth union',
  subtract: 'Subtract',
  smoothSubtract: 'Smooth subtract',
  intersect: 'Intersect',
  smoothIntersect: 'Smooth intersect',
};

/** True when the op adds material, which is what bounds estimation cares about. */
export function opIsAdditive(op: Op): boolean {
  return op === 'union' || op === 'smoothUnion';
}

export function opUsesBlend(op: Op): boolean {
  return op === 'smoothUnion' || op === 'smoothSubtract' || op === 'smoothIntersect';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function opApply(op: Op, a: number, b: number, k: number): number {
  switch (op) {
    case 'union':
      return Math.min(a, b);

    case 'smoothUnion': {
      if (k <= 0) return Math.min(a, b);
      const h = clamp01(0.5 + (0.5 * (b - a)) / k);
      return b * (1 - h) + a * h - k * h * (1 - h);
    }

    case 'subtract':
      return Math.max(a, -b);

    case 'smoothSubtract': {
      if (k <= 0) return Math.max(a, -b);
      const h = clamp01(0.5 - (0.5 * (b + a)) / k);
      return a * (1 - h) + -b * h + k * h * (1 - h);
    }

    case 'intersect':
      return Math.max(a, b);

    case 'smoothIntersect': {
      if (k <= 0) return Math.max(a, b);
      const h = clamp01(0.5 - (0.5 * (b - a)) / k);
      return b * (1 - h) + a * h + k * h * (1 - h);
    }

    // A project file could carry an op this build does not know. Fall back to
    // union rather than returning undefined into the field.
    default:
      return Math.min(a, b);
  }
}

/* ------------------------------------------------------------------ *
 * Primitives, evaluated in local space
 * ------------------------------------------------------------------ */

function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function sdSphere(x: number, y: number, z: number, r: number): number {
  return len3(x, y, z) - r;
}

/** Box with half-extents bx,by,bz and corner rounding r. */
export function sdRoundBox(
  x: number,
  y: number,
  z: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): number {
  const qx = Math.abs(x) - (bx - r);
  const qy = Math.abs(y) - (by - r);
  const qz = Math.abs(z) - (bz - r);
  const outside = len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside - r;
}

/** Capsule along the local Z axis, total straight length h, radius r. */
export function sdCapsuleZ(
  x: number,
  y: number,
  z: number,
  h: number,
  r: number,
): number {
  const half = h / 2;
  const zc = z < -half ? -half : z > half ? half : z;
  return len3(x, y, z - zc) - r;
}

/** Torus in the local XY plane, major radius R, tube radius r. */
export function sdTorusZ(
  x: number,
  y: number,
  z: number,
  R: number,
  r: number,
): number {
  const q = Math.sqrt(x * x + y * y) - R;
  return Math.sqrt(q * q + z * z) - r;
}

/**
 * Ellipsoid with semi-axes rx,ry,rz. This is the standard bounded
 * approximation — accurate near the surface, slightly off far away, which is
 * all a blend or a slice ever asks of it.
 */
export function sdEllipsoid(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const k0 = len3(x / rx, y / ry, z / rz);
  if (k0 === 0) return -Math.min(rx, Math.min(ry, rz));
  const k1 = len3(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}

/**
 * Superellipsoid via the p-norm, exponent e.
 *
 *   e < 1   pinched, star-like — the interesting end for organic forms
 *   e = 1   octahedron
 *   e = 2   ellipsoid
 *   e = 4   a rounded box, near enough that the two are hard to tell apart
 *   e > 8   effectively a box
 *
 * The p-norm is not a Euclidean distance, so the raw value is useless as a
 * field: it is compressed or stretched depending on direction, which throws
 * off every blend and every kerf offset that reads it. Dividing by the
 * gradient magnitude gives the first-order distance estimate, which is exact
 * at the surface and close to it nearby — which is all a blend or a slice ever
 * looks at.
 */
export function sdSuperellipsoid(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  e: number,
): number {
  const p = Math.max(e, 0.2);
  const ax = Math.abs(x) / rx;
  const ay = Math.abs(y) / ry;
  const az = Math.abs(z) / rz;

  const value = Math.pow(ax, p) + Math.pow(ay, p) + Math.pow(az, p) - 1;

  // Gradient of the implicit function, in world units.
  const gx = (p * Math.pow(ax, p - 1)) / rx;
  const gy = (p * Math.pow(ay, p - 1)) / ry;
  const gz = (p * Math.pow(az, p - 1)) / rz;
  const grad = Math.sqrt(gx * gx + gy * gy + gz * gz);

  if (!Number.isFinite(grad) || grad < 1e-9) {
    // Only at the centre, where the gradient vanishes.
    return -Math.min(rx, Math.min(ry, rz));
  }

  return value / grad;
}

/* ------------------------------------------------------------------ *
 * Module registry
 *
 * A shape module is { key, name, params, sdf, bounds }. New designs are new
 * entries here (or, later, external files exporting the same shape).
 * ------------------------------------------------------------------ */

export interface ParamSpec {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export interface ShapeModule {
  key: string;
  name: string;
  params: ParamSpec[];
  /** Distance at a point already transformed into the module's local space. */
  sdf: (x: number, y: number, z: number, p: Params) => number;
  /** Local-space axis-aligned bounds [minX,minY,minZ,maxX,maxY,maxZ]. */
  bounds: (p: Params) => [number, number, number, number, number, number];
}

const mm = (key: string, label: string, def: number, min: number, max: number, step = 1): ParamSpec => ({
  key,
  label,
  def,
  min,
  max,
  step,
  unit: 'mm',
});

export const SHAPE_MODULES: ShapeModule[] = [
  {
    key: 'sphere',
    name: 'Sphere',
    params: [mm('r', 'Radius', 40, 0.5, 500)],
    sdf: (x, y, z, p) => sdSphere(x, y, z, num(p, 'r', 40)),
    bounds: (p) => {
      const r = num(p, 'r', 40);
      return [-r, -r, -r, r, r, r];
    },
  },
  {
    key: 'roundBox',
    name: 'Rounded box',
    params: [
      mm('sx', 'Size X', 80, 1, 700),
      mm('sy', 'Size Y', 80, 1, 700),
      mm('sz', 'Size Z', 80, 1, 700),
      mm('r', 'Corner radius', 12, 0, 200, 0.5),
    ],
    sdf: (x, y, z, p) => {
      const bx = num(p, 'sx', 80) / 2;
      const by = num(p, 'sy', 80) / 2;
      const bz = num(p, 'sz', 80) / 2;
      const r = Math.min(num(p, 'r', 12), Math.min(bx, Math.min(by, bz)));
      return sdRoundBox(x, y, z, bx, by, bz, r);
    },
    bounds: (p) => {
      const bx = num(p, 'sx', 80) / 2;
      const by = num(p, 'sy', 80) / 2;
      const bz = num(p, 'sz', 80) / 2;
      return [-bx, -by, -bz, bx, by, bz];
    },
  },
  {
    key: 'capsule',
    name: 'Capsule',
    params: [mm('h', 'Length', 80, 0, 700), mm('r', 'Radius', 25, 0.5, 400)],
    sdf: (x, y, z, p) => sdCapsuleZ(x, y, z, num(p, 'h', 80), num(p, 'r', 25)),
    bounds: (p) => {
      const h = num(p, 'h', 80) / 2;
      const r = num(p, 'r', 25);
      return [-r, -r, -h - r, r, r, h + r];
    },
  },
  {
    key: 'torus',
    name: 'Torus',
    params: [mm('R', 'Major radius', 50, 1, 500), mm('r', 'Tube radius', 15, 0.5, 300)],
    sdf: (x, y, z, p) => sdTorusZ(x, y, z, num(p, 'R', 50), num(p, 'r', 15)),
    bounds: (p) => {
      const R = num(p, 'R', 50);
      const r = num(p, 'r', 15);
      return [-R - r, -R - r, -r, R + r, R + r, r];
    },
  },
  {
    key: 'ellipsoid',
    name: 'Ellipsoid',
    params: [
      mm('rx', 'Radius X', 50, 0.5, 500),
      mm('ry', 'Radius Y', 35, 0.5, 500),
      mm('rz', 'Radius Z', 60, 0.5, 500),
    ],
    sdf: (x, y, z, p) =>
      sdEllipsoid(x, y, z, num(p, 'rx', 50), num(p, 'ry', 35), num(p, 'rz', 60)),
    bounds: (p) => {
      const rx = num(p, 'rx', 50);
      const ry = num(p, 'ry', 35);
      const rz = num(p, 'rz', 60);
      return [-rx, -ry, -rz, rx, ry, rz];
    },
  },
  {
    key: 'superellipsoid',
    name: 'Superellipsoid',
    params: [
      mm('rx', 'Radius X', 50, 0.5, 500),
      mm('ry', 'Radius Y', 50, 0.5, 500),
      mm('rz', 'Radius Z', 50, 0.5, 500),
      // Default below 2 on purpose. At 4 a superellipsoid is a rounded box and
      // adds nothing the rounded box module does not already do; the shapes
      // worth having are the pinched ones under 2.
      { key: 'e', label: 'Exponent', def: 1.4, min: 0.3, max: 12, step: 0.1 },
    ],
    sdf: (x, y, z, p) =>
      sdSuperellipsoid(
        x,
        y,
        z,
        num(p, 'rx', 50),
        num(p, 'ry', 50),
        num(p, 'rz', 50),
        num(p, 'e', 1.4),
      ),
    bounds: (p) => {
      const rx = num(p, 'rx', 50);
      const ry = num(p, 'ry', 50);
      const rz = num(p, 'rz', 50);
      return [-rx, -ry, -rz, rx, ry, rz];
    },
  },
];

export function findModule(key: string): ShapeModule | undefined {
  return SHAPE_MODULES.find((m) => m.key === key);
}

/* ------------------------------------------------------------------ *
 * Modifiers
 *
 * A modifier is not a solid. It takes the distance the tree has produced so
 * far and returns a new one, so it changes the whole form rather than adding
 * to it. Shell is the first; more will follow at the CARVE stage.
 * ------------------------------------------------------------------ */

export interface ModifierModule {
  key: string;
  name: string;
  params: ParamSpec[];
  /** `d` is the accumulated distance at the world point x, y, z. */
  apply: (d: number, x: number, y: number, z: number, p: Params) => number;
}

/**
 * Hollow the solid, leaving a wall.
 *
 * Written as `max(d, -inner)` with `inner = d + thickness`, not as the usual
 * `abs(d) - thickness/2`. The difference matters: the abs form moves the outer
 * surface inward by half the wall, quietly shrinking the shape you designed.
 * This form leaves the outer surface exactly where it was and takes the wall
 * off the inside, which is what a lamp wants — the silhouette is the design.
 *
 * The cavity can be stopped at a height at each end, which leaves a solid cap
 * or a solid foot. That is a proper intersection against a half-space rather
 * than a switch on z, so the field stays continuous and slices through the
 * transition come out clean.
 */
export const shellModifier: ModifierModule = {
  key: 'shell',
  name: 'Shell',
  params: [
    mm('t', 'Wall', 6, 0.2, 100, 0.1),
    mm('capTopZ', 'Solid above', 0, -400, 400),
    mm('capBottomZ', 'Solid below', 0, -400, 400),
  ],
  apply: (d, _x, _y, z, p) => {
    const thickness = Math.max(num(p, 't', 6), 0.01);
    let inner = d + thickness;

    // The cavity exists only between the two caps, when they are switched on.
    if (num(p, 'capTop', 0) > 0) inner = Math.max(inner, z - num(p, 'capTopZ', 0));
    if (num(p, 'capBottom', 0) > 0) inner = Math.max(inner, num(p, 'capBottomZ', 0) - z);

    return Math.max(d, -inner);
  },
};

export const MODIFIER_MODULES: ModifierModule[] = [shellModifier];

export function findModifier(key: string): ModifierModule | undefined {
  return MODIFIER_MODULES.find((m) => m.key === key);
}

/** Default parameters for a newly added modifier. */
export function defaultModifierParams(mod: ModifierModule): Params {
  const p: Params = {};
  for (const spec of mod.params) p[spec.key] = spec.def;
  if (mod.key === 'shell') {
    p.capTop = 0;
    p.capBottom = 0;
  }
  return p;
}

/**
 * Transform parameters every shape feature carries, on top of its own.
 *
 * There is no scale parameter on purpose: non-uniform scaling breaks the
 * distance property of the field, which would quietly corrupt blends and
 * kerf offsets. Primitives are dimensioned in mm instead.
 */
export const TRANSFORM_PARAMS: ParamSpec[] = [
  mm('px', 'Position X', 0, -400, 400),
  mm('py', 'Position Y', 0, -400, 400),
  mm('pz', 'Position Z', 0, -400, 400),
  { key: 'rx', label: 'Rotate X', def: 0, min: -180, max: 180, step: 1, unit: '°' },
  { key: 'ry', label: 'Rotate Y', def: 0, min: -180, max: 180, step: 1, unit: '°' },
  { key: 'rz', label: 'Rotate Z', def: 0, min: -180, max: 180, step: 1, unit: '°' },
];

export const BLEND_PARAM: ParamSpec = {
  key: 'k',
  label: 'Blend',
  def: 10,
  min: 0,
  max: 120,
  step: 0.5,
  unit: 'mm',
};

/** Default parameter set for a newly added feature of the given module. */
export function defaultParams(mod: ShapeModule): Params {
  const p: Params = { op: 'smoothUnion', k: BLEND_PARAM.def };
  for (const spec of TRANSFORM_PARAMS) p[spec.key] = spec.def;
  for (const spec of mod.params) p[spec.key] = spec.def;
  return p;
}

/* ------------------------------------------------------------------ *
 * Sculpt strokes
 *
 * A stroke is a polyline with a radius: the swept capsule chain the brush
 * traced. Distance to it is the distance to the polyline minus the radius,
 * which is exact.
 *
 * The handoff planned to bake strokes onto the voxel grid, and warned that
 * replaying them at a different grid resolution would give different geometry,
 * so the resolution had to be recorded in the feature. Evaluating them
 * analytically removes the problem rather than managing it: there is no grid in
 * the definition, so the same stroke gives the same surface whether the preview
 * samples at 32 or the slicer at 300. What it costs is speed — every sample
 * would walk every stroke — and that is what the index below is for.
 * ------------------------------------------------------------------ */

export interface SculptStroke {
  op: string;
  /** Brush radius in mm. */
  radius: number;
  /** Blend radius for the smooth ops, mm. */
  k: number;
  /** Flat x, y, z triples along the stroke. */
  points: number[];
}

interface PreparedStroke {
  op: Op;
  radius: number;
  k: number;
  /** Flat x1,y1,z1,x2,y2,z2 per segment. */
  segments: number[];
  min: [number, number, number];
  max: [number, number, number];
  /**
   * How far this stroke can still affect the field. Past it the answer cannot
   * change any union, subtraction or blend, so the stroke is skipped entirely.
   */
  reach: number;
}

/**
 * Broad phase over strokes, not over segments.
 *
 * The first version indexed each stroke's segments on their own grid, and it
 * cost five seconds for a hundred and twenty strokes: walking rings of cells in
 * three dimensions is hundreds of map lookups per sample, per stroke. One grid
 * over whole strokes turns that into a single lookup, after which the handful of
 * nearby strokes are scanned segment by segment — a stroke is a few dozen
 * segments, and a linear scan of those is far cheaper than one ring walk.
 *
 * Skipping distant strokes is safe whatever their operation: unioning or
 * subtracting something far away leaves the field exactly as it was, so the
 * order of the strokes that do matter is preserved.
 */
interface StrokeBroadPhase {
  cell: number;
  buckets: Map<string, number[]>;
}

function segmentPointDistance(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const vz = bz - az;
  const lengthSquared = vx * vx + vy * vy + vz * vz;
  if (lengthSquared === 0) return len3(px - ax, py - ay, pz - az);
  let t = ((px - ax) * vx + (py - ay) * vy + (pz - az) * vz) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return len3(px - (ax + t * vx), py - (ay + t * vy), pz - (az + t * vz));
}

function prepareStroke(stroke: SculptStroke): PreparedStroke {
  const count = Math.floor(stroke.points.length / 3);
  const segments: number[] = [];

  if (count === 1) {
    // A tap rather than a drag: a zero-length segment is a sphere.
    const [x, y, z] = [stroke.points[0], stroke.points[1], stroke.points[2]];
    segments.push(x, y, z, x, y, z);
  } else {
    for (let i = 0; i < count - 1; i++) {
      segments.push(
        stroke.points[i * 3],
        stroke.points[i * 3 + 1],
        stroke.points[i * 3 + 2],
        stroke.points[(i + 1) * 3],
        stroke.points[(i + 1) * 3 + 1],
        stroke.points[(i + 1) * 3 + 2],
      );
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < segments.length; i += 3) {
    minX = Math.min(minX, segments[i]);
    maxX = Math.max(maxX, segments[i]);
    minY = Math.min(minY, segments[i + 1]);
    maxY = Math.max(maxY, segments[i + 1]);
    minZ = Math.min(minZ, segments[i + 2]);
    maxZ = Math.max(maxZ, segments[i + 2]);
  }

  const op = (OPS as readonly string[]).includes(stroke.op) ? (stroke.op as Op) : 'union';
  const k = Math.max(stroke.k, 0);

  return {
    op,
    radius: stroke.radius,
    k,
    segments,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    reach: stroke.radius + k + 1,
  };
}

function buildBroadPhase(strokes: PreparedStroke[]): StrokeBroadPhase {
  let widest = 8;
  for (const stroke of strokes) widest = Math.max(widest, stroke.reach * 2);

  const cell = widest;
  const buckets = new Map<string, number[]>();

  strokes.forEach((stroke, id) => {
    const lo = [
      stroke.min[0] - stroke.reach,
      stroke.min[1] - stroke.reach,
      stroke.min[2] - stroke.reach,
    ];
    const hi = [
      stroke.max[0] + stroke.reach,
      stroke.max[1] + stroke.reach,
      stroke.max[2] + stroke.reach,
    ];

    for (let cx = Math.floor(lo[0] / cell); cx <= Math.floor(hi[0] / cell); cx++) {
      for (let cy = Math.floor(lo[1] / cell); cy <= Math.floor(hi[1] / cell); cy++) {
        for (let cz = Math.floor(lo[2] / cell); cz <= Math.floor(hi[2] / cell); cz++) {
          const key = `${cx}:${cy}:${cz}`;
          const bucket = buckets.get(key);
          if (bucket) bucket.push(id);
          else buckets.set(key, [id]);
        }
      }
    }
  });

  return { cell, buckets };
}

/** Distance to a stroke's surface, positive outside, bounded by its reach. */
function strokeDistance(stroke: PreparedStroke, x: number, y: number, z: number): number {
  const far = stroke.reach;

  const dx = Math.max(stroke.min[0] - x, x - stroke.max[0], 0);
  const dy = Math.max(stroke.min[1] - y, y - stroke.max[1], 0);
  const dz = Math.max(stroke.min[2] - z, z - stroke.max[2], 0);
  const outside = dx * dx + dy * dy + dz * dz;
  const limit = far + stroke.radius;
  if (outside > limit * limit) return far;

  let best = limit;
  const segments = stroke.segments;
  for (let s = 0; s < segments.length; s += 6) {
    const d = segmentPointDistance(
      x,
      y,
      z,
      segments[s],
      segments[s + 1],
      segments[s + 2],
      segments[s + 3],
      segments[s + 4],
      segments[s + 5],
    );
    if (d < best) best = d;
  }

  const surface = best - stroke.radius;
  return surface > far ? far : surface;
}

/**
 * The frame a sculpt feature's strokes are recorded in.
 *
 * `attachTo` names a feature in the same tree. When it is missing, disabled or
 * unresolvable the strokes fall back to world coordinates, which is what a
 * sculpt made before attachment existed will do.
 */
export function sculptFrame(features: EvalFeature[], sculpt: EvalFeature): Frame {
  const target = text(sculpt.params, 'attachTo', '');
  if (target === '') return IDENTITY_FRAME;
  const parent = features.find((f) => f.id === target);
  if (!parent) return IDENTITY_FRAME;
  return frameOf(parent.params);
}

/** World bounds of a stroke's swept volume. */
export function strokeBounds(
  stroke: SculptStroke,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const count = Math.floor(stroke.points.length / 3);
  if (count === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, stroke.points[i * 3]);
    maxX = Math.max(maxX, stroke.points[i * 3]);
    minY = Math.min(minY, stroke.points[i * 3 + 1]);
    maxY = Math.max(maxY, stroke.points[i * 3 + 1]);
    minZ = Math.min(minZ, stroke.points[i * 3 + 2]);
    maxZ = Math.max(maxZ, stroke.points[i * 3 + 2]);
  }

  const r = stroke.radius;
  return {
    min: [minX - r, minY - r, minZ - r],
    max: [maxX + r, maxY + r, maxZ + r],
  };
}

/* ------------------------------------------------------------------ *
 * Transforms
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/**
 * Rotation matrix for intrinsic X, then Y, then Z (R = Rz·Ry·Rx),
 * row-major [m00..m22]. Angles in degrees.
 */
export function rotationMatrix(rxDeg: number, ryDeg: number, rzDeg: number): number[] {
  const cx = Math.cos(rxDeg * DEG);
  const sx = Math.sin(rxDeg * DEG);
  const cy = Math.cos(ryDeg * DEG);
  const sy = Math.sin(ryDeg * DEG);
  const cz = Math.cos(rzDeg * DEG);
  const sz = Math.sin(rzDeg * DEG);

  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}

/* ------------------------------------------------------------------ *
 * Frames
 *
 * A rigid frame taken from a feature's transform parameters, used to express
 * one feature's geometry in another's coordinates. Distances survive a rigid
 * transform unchanged, so a field evaluated in a local frame is the same field.
 * ------------------------------------------------------------------ */

export interface Frame {
  tx: number;
  ty: number;
  tz: number;
  /** World to local: the transpose of the rotation. */
  inv: number[];
  identity: boolean;
}

export const IDENTITY_FRAME: Frame = {
  tx: 0,
  ty: 0,
  tz: 0,
  inv: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  identity: true,
};

export function frameOf(params: Params): Frame {
  const rx = num(params, 'rx', 0);
  const ry = num(params, 'ry', 0);
  const rz = num(params, 'rz', 0);
  const tx = num(params, 'px', 0);
  const ty = num(params, 'py', 0);
  const tz = num(params, 'pz', 0);

  const m = rotationMatrix(rx, ry, rz);
  return {
    tx,
    ty,
    tz,
    inv: [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]],
    identity: rx === 0 && ry === 0 && rz === 0 && tx === 0 && ty === 0 && tz === 0,
  };
}

export function frameToLocal(
  frame: Frame,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const wx = x - frame.tx;
  const wy = y - frame.ty;
  const wz = z - frame.tz;
  if (frame.identity) return [wx, wy, wz];
  const m = frame.inv;
  return [
    m[0] * wx + m[1] * wy + m[2] * wz,
    m[3] * wx + m[4] * wy + m[5] * wz,
    m[6] * wx + m[7] * wy + m[8] * wz,
  ];
}

export function frameToWorld(
  frame: Frame,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (frame.identity) return [x + frame.tx, y + frame.ty, z + frame.tz];
  // inv is the transpose of R, so reading it column-wise applies R.
  const m = frame.inv;
  return [
    m[0] * x + m[3] * y + m[6] * z + frame.tx,
    m[1] * x + m[4] * y + m[7] * z + frame.ty,
    m[2] * x + m[5] * y + m[8] * z + frame.tz,
  ];
}

/* ------------------------------------------------------------------ *
 * Grid evaluation
 * ------------------------------------------------------------------ */

export interface SdfGrid {
  data: Float32Array;
  /** Sample counts per axis. */
  dims: [number, number, number];
  /** World position of sample (0,0,0). */
  min: [number, number, number];
  /** Sample spacing in mm, uniform on all axes. */
  step: number;
}

/** The minimum a feature needs to expose to be evaluated. */
export interface EvalFeature {
  /** Needed so a sculpt feature can name the shape it is attached to. */
  id?: string;
  kind: string;
  enabled: boolean;
  params: Params;
  /** Sculpt features carry their strokes here rather than in params. */
  strokes?: SculptStroke[];
}

/** One evaluation step: either a solid to combine, or a modifier to apply. */
export type PreparedStep =
  | ({ type: 'shape' } & Prepared)
  | { type: 'modifier'; index: number; mod: ModifierModule; params: Params }
  | {
      type: 'sculpt';
      index: number;
      strokes: PreparedStroke[];
      broad: StrokeBroadPhase;
      /**
       * The frame the strokes are stored in — the shape they are attached to.
       * Moving or turning that shape carries the sculpting with it, which is
       * the whole reason strokes are not kept in world coordinates.
       */
      frame: Frame;
    };

export interface Prepared {
  /** Index into the feature array this was prepared from. */
  index: number;
  mod: ShapeModule;
  params: Params;
  op: Op;
  k: number;
  tx: number;
  ty: number;
  tz: number;
  /** Transpose of the rotation matrix, i.e. world -> local. */
  inv: number[];
  identity: boolean;
}

/**
 * Resolve features into an evaluation-ready form: module looked up, rotation
 * inverted once, disabled and unknown rows dropped.
 */
export function prepareFeatures(features: EvalFeature[]): PreparedStep[] {
  const out: PreparedStep[] = [];
  for (let index = 0; index < features.length; index++) {
    const f = features[index];
    if (!f.enabled) continue;

    if (f.kind === 'sculpt') {
      const strokes: PreparedStroke[] = [];
      for (const stroke of f.strokes ?? []) {
        if (stroke.points.length < 3 || stroke.radius <= 0) continue;
        strokes.push(prepareStroke(stroke));
      }
      if (strokes.length > 0) {
        out.push({
          type: 'sculpt',
          index,
          strokes,
          broad: buildBroadPhase(strokes),
          frame: sculptFrame(features, f),
        });
      }
      continue;
    }

    const modifier = findModifier(f.kind);
    if (modifier) {
      out.push({ type: 'modifier', index, mod: modifier, params: f.params });
      continue;
    }

    const mod = findModule(f.kind);
    if (!mod) continue;

    const rx = num(f.params, 'rx', 0);
    const ry = num(f.params, 'ry', 0);
    const rz = num(f.params, 'rz', 0);
    const m = rotationMatrix(rx, ry, rz);

    out.push({
      type: 'shape',
      index,
      mod,
      params: f.params,
      op: text(f.params, 'op', 'smoothUnion') as Op,
      k: num(f.params, 'k', 0),
      tx: num(f.params, 'px', 0),
      ty: num(f.params, 'py', 0),
      tz: num(f.params, 'pz', 0),
      // Transpose: inverse of a rotation.
      inv: [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]],
      identity: rx === 0 && ry === 0 && rz === 0,
    });
  }
  return out;
}

/** Transform a world point into one prepared feature's local space. */
export function toLocal(f: Prepared, x: number, y: number, z: number): [number, number, number] {
  const wx = x - f.tx;
  const wy = y - f.ty;
  const wz = z - f.tz;
  if (f.identity) return [wx, wy, wz];
  const m = f.inv;
  return [
    m[0] * wx + m[1] * wy + m[2] * wz,
    m[3] * wx + m[4] * wy + m[5] * wz,
    m[6] * wx + m[7] * wy + m[8] * wz,
  ];
}

/** Distance of the whole tree at one world point. */
export function evaluatePoint(prepared: PreparedStep[], x: number, y: number, z: number): number {
  let d = EMPTY;
  for (let i = 0; i < prepared.length; i++) {
    const step = prepared[i];

    if (step.type === 'sculpt') {
      // Into the attached shape's frame, where the strokes were recorded.
      const [lx, ly, lz] = step.frame.identity
        ? [x - step.frame.tx, y - step.frame.ty, z - step.frame.tz]
        : frameToLocal(step.frame, x, y, z);

      const cell = step.broad.cell;
      const nearby = step.broad.buckets.get(
        `${Math.floor(lx / cell)}:${Math.floor(ly / cell)}:${Math.floor(lz / cell)}`,
      );
      if (nearby) {
        // Already in stroke order: the bucket was filled by ascending id.
        for (const id of nearby) {
          const stroke = step.strokes[id];
          d = opApply(stroke.op, d, strokeDistance(stroke, lx, ly, lz), stroke.k);
        }
      }
      continue;
    }

    if (step.type === 'modifier') {
      // Nothing to hollow yet: a shell above an empty tree must not invent a
      // wall out of the sentinel distance.
      if (d < EMPTY) d = step.mod.apply(d, x, y, z, step.params);
      continue;
    }

    const f = step;
    const wx = x - f.tx;
    const wy = y - f.ty;
    const wz = z - f.tz;
    let lx = wx;
    let ly = wy;
    let lz = wz;
    if (!f.identity) {
      const m = f.inv;
      lx = m[0] * wx + m[1] * wy + m[2] * wz;
      ly = m[3] * wx + m[4] * wy + m[5] * wz;
      lz = m[6] * wx + m[7] * wy + m[8] * wz;
    }
    d = opApply(f.op, d, f.mod.sdf(lx, ly, lz, f.params), f.k);
  }
  return d;
}

/** World bounds of the additive features, or null when there is nothing solid. */
export function modelBounds(
  features: EvalFeature[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  const prepared = prepareFeatures(features);
  let found = false;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const grow = (lo: [number, number, number], hi: [number, number, number]) => {
    found = true;
    minX = Math.min(minX, lo[0]);
    minY = Math.min(minY, lo[1]);
    minZ = Math.min(minZ, lo[2]);
    maxX = Math.max(maxX, hi[0]);
    maxY = Math.max(maxY, hi[1]);
    maxZ = Math.max(maxZ, hi[2]);
  };

  // Sculpt strokes that add material set bounds like any other solid: without
  // this, a stroke pulled out past the base shape would be cut off by the grid.
  for (const feature of features) {
    if (feature.kind !== 'sculpt' || !feature.enabled) continue;
    const frame = sculptFrame(features, feature);
    for (const stroke of feature.strokes ?? []) {
      if (!opIsAdditive(stroke.op as Op)) continue;
      const box = strokeBounds(stroke);
      if (!box) continue;

      // Local bounds, so all eight corners go through the frame before they
      // can be trusted as world bounds.
      for (let c = 0; c < 8; c++) {
        const corner = frameToWorld(
          frame,
          c & 1 ? box.max[0] : box.min[0],
          c & 2 ? box.max[1] : box.min[1],
          c & 4 ? box.max[2] : box.min[2],
        );
        grow(corner, corner);
      }
    }
  }

  for (const f of prepared) {
    // Modifiers add no material, so they set no bounds.
    if (f.type !== 'shape') continue;
    if (!opIsAdditive(f.op)) continue;
    found = true;
    const b = f.mod.bounds(f.params);
    // Rotate the eight corners of the local box into world space.
    const m = f.inv;
    for (let c = 0; c < 8; c++) {
      const lx = c & 1 ? b[3] : b[0];
      const ly = c & 2 ? b[4] : b[1];
      const lz = c & 4 ? b[5] : b[2];
      // inv is the transpose of R, so R = transpose(inv): reuse it column-wise.
      const wx = m[0] * lx + m[3] * ly + m[6] * lz + f.tx;
      const wy = m[1] * lx + m[4] * ly + m[7] * lz + f.ty;
      const wz = m[2] * lx + m[5] * ly + m[8] * lz + f.tz;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
  }

  if (!found) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Sample the whole feature tree onto a uniform voxel grid.
 *
 * `res` is the sample count along the longest axis; the other axes get
 * whatever that spacing gives them, so voxels stay cubic.
 */
/**
 * Sample any field onto a grid over given bounds.
 *
 * Split out from `evaluateGrid` so callers that compose extra volumes on top of
 * the tree — windows, for one — preview exactly the field they will slice,
 * rather than a tree that no longer describes the model.
 */
export function evaluateGridSampled(
  sample: (x: number, y: number, z: number) => number,
  bounds: { min: [number, number, number]; max: [number, number, number] } | null,
  res: number,
  blendPad = 0,
): SdfGrid {
  if (!bounds) {
    return {
      data: new Float32Array([EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]),
      dims: [2, 2, 2],
      min: [0, 0, 0],
      step: 1,
    };
  }

  const resolution = Math.max(8, Math.round(res));
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const longest = Math.max(sizeX, sizeY, sizeZ, 1);
  const step = longest / resolution;
  const pad = 3 * step + blendPad;

  const minX = bounds.min[0] - pad;
  const minY = bounds.min[1] - pad;
  const minZ = bounds.min[2] - pad;
  const nx = Math.ceil((sizeX + 2 * pad) / step) + 1;
  const ny = Math.ceil((sizeY + 2 * pad) / step) + 1;
  const nz = Math.ceil((sizeZ + 2 * pad) / step) + 1;

  const data = new Float32Array(nx * ny * nz);
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const z = minZ + k * step;
    for (let j = 0; j < ny; j++) {
      const y = minY + j * step;
      for (let i = 0; i < nx; i++) {
        data[idx++] = sample(minX + i * step, y, z);
      }
    }
  }

  return { data, dims: [nx, ny, nz], min: [minX, minY, minZ], step };
}

export function evaluateGrid(features: EvalFeature[], res: number): SdfGrid {
  const prepared = prepareFeatures(features);
  const bounds = modelBounds(features);

  if (!bounds || prepared.length === 0) {
    return {
      data: new Float32Array([EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]),
      dims: [2, 2, 2],
      min: [0, 0, 0],
      step: 1,
    };
  }

  const resolution = Math.max(8, Math.round(res));
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const longest = Math.max(sizeX, Math.max(sizeY, sizeZ), 1);
  const step = longest / resolution;

  // Blends push the surface outside the union of the primitives. For the
  // polynomial smooth min the bulge is bounded by k/4, so padding by the full
  // blend radius would inflate the grid roughly fourfold in volume for no
  // gain. BLEND_PAD_FACTOR keeps a margin over the theoretical bound; the
  // validator asserts no sample on the grid boundary ends up inside.
  const BLEND_PAD_FACTOR = 0.35;
  let maxBlend = 0;
  for (const f of prepared) {
    if (f.type === 'shape' && opUsesBlend(f.op) && f.k > maxBlend) maxBlend = f.k;
    if (f.type === 'sculpt') {
      for (const stroke of f.strokes) {
        if (opUsesBlend(stroke.op) && stroke.k > maxBlend) maxBlend = stroke.k;
      }
    }
  }
  const pad = 3 * step + maxBlend * BLEND_PAD_FACTOR;

  const minX = bounds.min[0] - pad;
  const minY = bounds.min[1] - pad;
  const minZ = bounds.min[2] - pad;
  const nx = Math.ceil((sizeX + 2 * pad) / step) + 1;
  const ny = Math.ceil((sizeY + 2 * pad) / step) + 1;
  const nz = Math.ceil((sizeZ + 2 * pad) / step) + 1;

  const data = new Float32Array(nx * ny * nz);
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const z = minZ + k * step;
    for (let j = 0; j < ny; j++) {
      const y = minY + j * step;
      for (let i = 0; i < nx; i++) {
        data[idx++] = evaluatePoint(prepared, minX + i * step, y, z);
      }
    }
  }

  return { data, dims: [nx, ny, nz], min: [minX, minY, minZ], step };
}

/**
 * Which feature owns the surface at a world point.
 *
 * Clicking the preview mesh cannot say which feature was hit: the tree
 * evaluates to one merged surface, so two blended spheres are a single mesh.
 * Instead, evaluate each feature's own field at the hit point and take the
 * one whose surface is closest. That picks the subtracted shape when the
 * click lands inside a carved cavity, which is what someone pointing at a
 * hole means.
 *
 * Returns an index into `features`, or -1 when nothing is eligible.
 */
export function nearestFeatureIndex(
  features: EvalFeature[],
  x: number,
  y: number,
  z: number,
): number {
  const prepared = prepareFeatures(features);
  let best = -1;
  let bestDistance = Infinity;

  for (const f of prepared) {
    // A modifier has no surface of its own, so nothing can point at it.
    if (f.type !== 'shape') continue;
    const [lx, ly, lz] = toLocal(f, x, y, z);
    const d = Math.abs(f.mod.sdf(lx, ly, lz, f.params));
    if (d < bestDistance) {
      bestDistance = d;
      best = f.index;
    }
  }

  return best;
}
