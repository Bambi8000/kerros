/**
 * Kerros windows.
 *
 * A window is a wedge taken out of the form — the "cake slice" — and the piece
 * that came out is then a part in its own right, cut from something else and
 * glued back in. Plexi in cardboard: the stack stays opaque and the windows let
 * the light through.
 *
 * The wedge is an angular sector as a distance field, which is what makes the
 * two halves of the idea fall out of one definition:
 *
 *   stock  = solid  MINUS sector
 *   window = solid  AND   sector, shrunk by the fit clearance
 *
 * Both go through the same slicer, so the window's edge and the hole it fills
 * are the same curve by construction rather than by two pieces of code
 * agreeing. Kerf then works in opposite directions on them without either
 * knowing about the other: the hole is cut smaller so it opens out to size, the
 * plug is cut larger so it closes down to size.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

const DEG = Math.PI / 180;

/**
 * How the windows are laid out along the stack.
 *
 *   band     one set of windows, the same all the way up, optionally twisting
 *   perLayer each layer independently rolls its own — a window is then a thing
 *            that happens to a sheet, not a slot down the side of the lamp
 */
export type WindowMode = 'band' | 'perLayer';

/** Where the layers are, so per-layer windows can land on them exactly. */
export interface LayerPlan {
  /** Bottom of the stack, mm. */
  z0: number;
  /** Layer pitch: material thickness plus spacer, mm. */
  pitch: number;
}

/** One wedge on one layer. */
export interface Wedge {
  /** Centre direction, degrees. */
  angle: number;
  /** Half-width, radians, already clamped. */
  half: number;
}

export interface WindowSpec {
  id: string;
  label: string;
  mode: WindowMode;
  /**
   * Where the wedge's axis stands, mm.
   *
   * A window is its own volume, not something applied to the accumulated
   * field, so unlike a shell it does not follow the form when the form moves.
   * It needs a position of its own or it stays on the world axis while the
   * shape walks away from it.
   */
  x: number;
  y: number;
  /** How many windows evenly around the axis. */
  count: number;
  /** Angular width of each, degrees. */
  width: number;
  /** Where the first one points, degrees from +X. */
  angle: number;
  /** Degrees the set turns per mm of height. */
  twist: number;
  /** Middle of the window band, mm. */
  z: number;
  /** Height of the window band, mm. */
  length: number;
  /**
   * Total clearance between the plug and its hole, mm. Half comes off each
   * face of the plug, so 0.4 leaves 0.2 all round for glue.
   */
  fit: number;
  /** Kerf of the material the window is cut from — plexi, not the stock. */
  kerf: number;

  /* perLayer only. */
  /** Chance a layer inside the band gets any windows at all, 0..1. */
  chance: number;
  /** How many windows a chosen layer gets. */
  minCount: number;
  maxCount: number;
  /** Angular width range of each, degrees. */
  minWidth: number;
  maxWidth: number;
  /** Global seed, so the whole lamp reproduces. */
  seed: number;
}

/**
 * Widest a single window may be, as a fraction of its share of the circle.
 *
 * Two reasons for the ceiling. Windows that meet would merge into one opening
 * and the ring would fall in half, and the wedge field is built from two
 * half-planes, which is exact below a right angle and not above it.
 */
const MAX_SHARE = 0.9;
const MAX_HALF_ANGLE = 89 * DEG;

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

/** A small stable number from a string, so a feature's id can seed with it. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Which layer a height belongs to, by nearest mid-plane. */
export function layerIndexAt(plan: LayerPlan, z: number, thickness: number): number {
  const pitch = Math.max(plan.pitch, 1e-6);
  return Math.round((z - plan.z0 - thickness / 2) / pitch);
}

/** Mid-plane of a layer. */
export function layerMidZ(plan: LayerPlan, index: number, thickness: number): number {
  return plan.z0 + index * plan.pitch + thickness / 2;
}

/**
 * The wedges one layer rolls for itself.
 *
 * Seeded from the global seed, the feature's id and the layer number, so the
 * same lamp comes out the same every time, adding a feature does not reshuffle
 * the others, and layer 7 keeps its windows when layer 3 changes.
 *
 * Returns nothing at all for most layers when `chance` is low, which is the
 * point: a window is an event that happens to a sheet.
 */
export function wedgesForLayer(spec: WindowSpec, layer: number): Wedge[] {
  const random = mulberry32(spec.seed * 2654435761 + hashId(spec.id) + layer * 40503);

  if (random() > Math.min(Math.max(spec.chance, 0), 1)) return [];

  const lo = Math.max(Math.round(Math.min(spec.minCount, spec.maxCount)), 1);
  const hi = Math.max(Math.round(Math.max(spec.minCount, spec.maxCount)), lo);
  const count = lo + Math.floor(random() * (hi - lo + 1));

  const widthLo = Math.max(Math.min(spec.minWidth, spec.maxWidth), 0);
  const widthHi = Math.max(spec.minWidth, spec.maxWidth);

  // Windows are placed in their own share of the circle and jittered within
  // it, rather than thrown down anywhere: two that landed on top of each other
  // would merge into one wide opening and the reason for the count would be
  // lost.
  const share = 360 / count;
  const wedges: Wedge[] = [];

  for (let i = 0; i < count; i++) {
    const width = widthLo + random() * (widthHi - widthLo);
    const jitter = (random() - 0.5) * share * 0.5;
    const half = Math.min(
      (width / 2) * DEG,
      ((share / 2) * MAX_SHARE) * DEG,
      MAX_HALF_ANGLE,
    );
    if (half <= 0) continue;
    wedges.push({ angle: spec.angle + i * share + jitter, half });
  }

  return wedges;
}

/** Half-angle actually used, after the ceilings. */
export function windowHalfAngle(spec: WindowSpec): number {
  const count = Math.max(Math.round(spec.count), 1);
  const share = (Math.PI * 2) / count;
  const asked = (Math.max(spec.width, 0) / 2) * DEG;
  return Math.min(asked, (share / 2) * MAX_SHARE, MAX_HALF_ANGLE);
}

/**
 * Distance to the sector volume. Negative inside it.
 *
 * The apex sits on the Z axis, which for a lamp is inside the cavity, so the
 * approximation the two-half-plane form makes at the apex falls where there is
 * no material to get wrong.
 */
/** Distance to one wedge, infinite prism about the Z axis. */
function wedgeDistance(x: number, y: number, wedge: Wedge): number {
  const radius = Math.hypot(x, y);
  if (radius < 1e-9) return -radius;
  const a = Math.atan2(y, x) - wedge.angle * DEG;
  const u = radius * Math.cos(a);
  const v = radius * Math.sin(a);
  return Math.abs(v) * Math.cos(wedge.half) - u * Math.sin(wedge.half);
}

/**
 * Distance to the sector volume in per-layer mode.
 *
 * Each layer's windows live in that layer's own band, one pitch tall and
 * centred on its mid-plane. The field is therefore continuous within a layer
 * and steps between layers, which is exactly what the physical stack does —
 * every sheet is cut on its own.
 */
function perLayerDistance(
  x: number,
  y: number,
  z: number,
  spec: WindowSpec,
  plan: LayerPlan,
  thickness: number,
): number {
  const halfLength = Math.max(spec.length, 0.01) / 2;
  const band = Math.max(z - (spec.z + halfLength), spec.z - halfLength - z);

  const layer = layerIndexAt(plan, z, thickness);
  const wedges = wedgesForLayer(spec, layer);
  if (wedges.length === 0) return Math.abs(band) + 1e3;

  const mid = layerMidZ(plan, layer, thickness);
  const halfPitch = Math.max(plan.pitch, 1e-6) / 2;
  const slab = Math.max(z - (mid + halfPitch), mid - halfPitch - z);

  let d = Infinity;
  for (const wedge of wedges) d = Math.min(d, wedgeDistance(x, y, wedge));

  return Math.max(d, slab, band);
}

export function sectorDistance(
  worldX: number,
  worldY: number,
  z: number,
  spec: WindowSpec,
  plan?: LayerPlan,
  thickness = 3,
): number {
  // Everything below works in the wedge's own frame, so the axis can stand
  // wherever the form does.
  const x = worldX - (spec.x ?? 0);
  const y = worldY - (spec.y ?? 0);

  if (spec.mode === 'perLayer') {
    if (!plan) return 1e3;
    return perLayerDistance(x, y, z, spec, plan, thickness);
  }

  const count = Math.max(Math.round(spec.count), 1);
  const share = (Math.PI * 2) / count;
  const half = windowHalfAngle(spec);

  // The band along Z, as a slab.
  const halfLength = Math.max(spec.length, 0.01) / 2;
  const slab = Math.max(z - (spec.z + halfLength), spec.z - halfLength - z);

  // The set turns with height, so windows can spiral up the stack.
  const rotation = (spec.angle + spec.twist * (z - spec.z)) * DEG;

  const radius = Math.hypot(x, y);
  if (radius < 1e-9) return Math.max(-radius, slab);

  // Fold the angle into one window's share of the circle.
  let a = Math.atan2(y, x) - rotation;
  a = ((a + share / 2) % share + share) % share - share / 2;

  const u = radius * Math.cos(a);
  const v = radius * Math.sin(a);

  // Intersection of two half-planes through the axis.
  const wedge = Math.abs(v) * Math.cos(half) - u * Math.sin(half);

  return Math.max(wedge, slab);
}

/** Does this window reach the plane a slice was taken on? */
export function windowSpansZ(spec: WindowSpec, z: number): boolean {
  const halfLength = Math.max(spec.length, 0) / 2;
  return z >= spec.z - halfLength && z <= spec.z + halfLength;
}

/**
 * The field of the plug that fills this window.
 *
 * `solid` is the form with no windows taken out of it. Intersecting with the
 * sector gives the piece that the subtraction removed; adding half the fit
 * clearance shrinks it uniformly so it drops into the hole with room for glue.
 */
export function windowField(
  solid: (x: number, y: number, z: number) => number,
  spec: WindowSpec,
  plan?: LayerPlan,
  thickness = 3,
): (x: number, y: number, z: number) => number {
  const inset = Math.max(spec.fit, 0) / 2;
  return (x, y, z) =>
    Math.max(solid(x, y, z), sectorDistance(x, y, z, spec, plan, thickness)) + inset;
}

/**
 * The field of the stock with every window taken out.
 *
 * Subtraction, not smooth subtraction: a window is a joint, and a blended
 * corner would leave the plug and the hole meeting along a curve neither the
 * laser nor the glue can hold.
 */
export function stockField(
  solid: (x: number, y: number, z: number) => number,
  windows: WindowSpec[],
  plan?: LayerPlan,
  thickness = 3,
): (x: number, y: number, z: number) => number {
  if (windows.length === 0) return solid;
  return (x, y, z) => {
    let d = solid(x, y, z);
    for (const spec of windows) {
      d = Math.max(d, -sectorDistance(x, y, z, spec, plan, thickness));
    }
    return d;
  };
}

/** Layers inside the band that rolled at least one window, for reporting. */
export function windowedLayers(
  spec: WindowSpec,
  plan: LayerPlan,
  thickness: number,
  layerCount: number,
): number[] {
  const out: number[] = [];
  const halfLength = Math.max(spec.length, 0) / 2;
  for (let k = 0; k < layerCount; k++) {
    const z = layerMidZ(plan, k, thickness);
    if (z < spec.z - halfLength || z > spec.z + halfLength) continue;
    if (spec.mode === 'band' || wedgesForLayer(spec, k).length > 0) out.push(k);
  }
  return out;
}
