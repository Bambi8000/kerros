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
 * Superellipsoid (squircle family) via the p-norm, exponent e.
 * e = 2 is an ellipsoid, higher e squares it off.
 *
 * APPROXIMATE distance: the p-norm is not a true Euclidean distance, so the
 * field is compressed away from the surface. Blends against it will look
 * slightly tighter than the blend radius suggests. Good enough for shaping,
 * documented so nobody debugs it twice.
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
  const n =
    Math.pow(Math.abs(x / rx), p) +
    Math.pow(Math.abs(y / ry), p) +
    Math.pow(Math.abs(z / rz), p);
  const scale = Math.min(rx, Math.min(ry, rz));
  return (Math.pow(n, 1 / p) - 1) * scale;
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
      { key: 'e', label: 'Exponent', def: 4, min: 0.5, max: 12, step: 0.1 },
    ],
    sdf: (x, y, z, p) =>
      sdSuperellipsoid(
        x,
        y,
        z,
        num(p, 'rx', 50),
        num(p, 'ry', 50),
        num(p, 'rz', 50),
        num(p, 'e', 4),
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
  kind: string;
  enabled: boolean;
  params: Params;
}

export interface Prepared {
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

function prepare(features: EvalFeature[]): Prepared[] {
  const out: Prepared[] = [];
  for (const f of features) {
    if (!f.enabled) continue;
    const mod = findModule(f.kind);
    if (!mod) continue;

    const rx = num(f.params, 'rx', 0);
    const ry = num(f.params, 'ry', 0);
    const rz = num(f.params, 'rz', 0);
    const m = rotationMatrix(rx, ry, rz);

    out.push({
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

/** Distance of the whole tree at one world point. */
export function evaluatePoint(prepared: Prepared[], x: number, y: number, z: number): number {
  let d = EMPTY;
  for (let i = 0; i < prepared.length; i++) {
    const f = prepared[i];
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
  const prepared = prepare(features);
  let found = false;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const f of prepared) {
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
export function evaluateGrid(features: EvalFeature[], res: number): SdfGrid {
  const prepared = prepare(features);
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
    if (opUsesBlend(f.op) && f.k > maxBlend) maxBlend = f.k;
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
