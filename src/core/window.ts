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

/**
 * One sheet's plane. Structurally identical to `LayerPlane` in `slice.ts`,
 * which builds it — duplicated deliberately, as `WindowFrame` and `PlaneFrame`
 * are, because neither module may import the other.
 */
export interface LayerPlane {
  /**
   * Ordinal from the bottom of the model, from 0, counting planes examined
   * rather than planes that produced geometry.
   *
   * Per-layer window rolls are seeded from this, so it is not free to change:
   * renumbering would reroll every window in every saved project.
   */
  index: number;
  z0: number;
  /** Mid-plane, the height the slice is taken at. */
  z: number;
  thickness: number;
  /** Gap to the sheet above, mm. */
  gapAbove: number;
}

/** Where the layers are, so per-layer windows can land on them exactly. */
export type LayerPlan = LayerPlane[];

/** Pitch of the plane at `i`: its own thickness plus the gap above it. */
function pitchOf(plan: LayerPlan, i: number): number {
  return Math.max(plan[i].thickness + plan[i].gapAbove, 1e-6);
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

/**
 * Widest a single window may be, half-angle — 100 degrees across.
 *
 * This was 89 degrees, which is where the two-half-plane form of the wedge
 * stops being exact. The real ceiling turned out to be lower and to come from
 * the bench rather than the mathematics: a window is only a plexi plug if you
 * cut one, and left as an opening a wide one makes the stack awkward to glue —
 * there is not enough ring left to hold while it sets. Measured on a cut lamp,
 * not reasoned about.
 */
const MAX_HALF_ANGLE = 50 * DEG;

/**
 * Most windows a **rolled** layer may get.
 *
 * Same bench, different force: two openings in a ring leave two arcs to hold
 * while the glue sets, and three leave three of nothing much.
 *
 * It clamps the per-layer roll and **not** `band` mode, and that asymmetry is
 * deliberate. The limit only bites when the wedges are left as openings; cut
 * the plexi plugs and put them back and a ring with five windows in it is whole
 * again. The program cannot know which you will do — a plug is a part on a
 * sheet, not a setting — so it holds the line where it invents the number
 * itself and leaves the one you typed alone. Band mode warns instead.
 */
export const MAX_WINDOWS_PER_LAYER = 2;

/* ------------------------------------------------------------------ *
 * Attachment
 * ------------------------------------------------------------------ */

/**
 * The part of a parent's transform a window can follow.
 *
 * Translation and rotation **about Z only**, deliberately. A window is a
 * vertical wedge tied to the stack's axis, and per-layer mode picks its layers
 * from world Z. Inheriting a parent's X or Y rotation would tip the wedge out
 * of the stack and leave the layer planes cutting across it at an angle —
 * geometrically meaningless for something that gets sliced horizontally.
 * Rotation about Z leaves every horizontal plane exactly where it was, so it is
 * the part worth carrying.
 */
export interface WindowFrame {
  x: number;
  y: number;
  z: number;
  /** Rotation about Z, degrees. */
  rz: number;
}

export const WINDOW_WORLD: WindowFrame = { x: 0, y: 0, z: 0, rz: 0 };

/** Where the axis, band and aim sit. */
export interface WindowPlacement {
  x: number;
  y: number;
  z: number;
  angle: number;
}

export function windowToWorld(local: WindowPlacement, frame: WindowFrame): WindowPlacement {
  const a = (frame.rz * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: frame.x + local.x * cos - local.y * sin,
    y: frame.y + local.x * sin + local.y * cos,
    z: frame.z + local.z,
    angle: local.angle + frame.rz,
  };
}

export function windowToLocal(world: WindowPlacement, frame: WindowFrame): WindowPlacement {
  const a = (-frame.rz * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = world.x - frame.x;
  const dy = world.y - frame.y;
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
    z: world.z - frame.z,
    angle: world.angle - frame.rz,
  };
}

/**
 * A spec with its placement resolved into world terms.
 *
 * Resolving at prepare time rather than transforming the query point keeps
 * `sectorDistance` untouched and, more importantly, keeps layer indexing in
 * world Z where it belongs.
 */
export function resolveWindow(spec: WindowSpec, frame: WindowFrame): WindowSpec {
  if (frame.x === 0 && frame.y === 0 && frame.z === 0 && frame.rz === 0) return spec;
  const placed = windowToWorld({ x: spec.x, y: spec.y, z: spec.z, angle: spec.angle }, frame);
  return { ...spec, ...placed };
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

/** A small stable number from a string, so a feature's id can seed with it. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Which layer a height belongs to, by nearest mid-plane.
 *
 * No thickness argument: a plane carries its own, which is the point of the
 * plan being a list. Leaving the parameter in place would have been a lie the
 * moment sheets could differ.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * **Ties go up.** The old arithmetic was `Math.round`, which rounds a half
 * toward +infinity, so a height exactly between two mid-planes belongs to the
 * upper one. Get this backwards and every window sitting on a boundary moves a
 * layer.
 *
 * **It extrapolates rather than clamping.** The sampling grid pads well beyond
 * the stack, so heights below the bottom sheet legitimately produce negative
 * indices and heights above the top produce indices past the end. Clamping them
 * would change the field outside the stack, and the stock field is a `max`
 * against the sector, so a changed value there is not always harmless.
 */
export function layerIndexAt(plan: LayerPlan, z: number): number {
  const n = plan.length;
  if (n === 0) return 0;

  const first = plan[0];
  if (z <= first.z) return first.index + Math.round((z - first.z) / pitchOf(plan, 0));

  const last = plan[n - 1];
  if (z >= last.z) return last.index + Math.round((z - last.z) / pitchOf(plan, n - 1));

  // Inside the stack: the first plane whose upper boundary is past z. The
  // boundary is the midpoint between neighbouring mid-planes, and `<` rather
  // than `<=` is what sends a tie upward.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (z < (plan[mid].z + plan[mid + 1].z) / 2) hi = mid;
    else lo = mid + 1;
  }
  return plan[lo].index;
}

/** Mid-plane of a layer, extrapolated past the ends the same way. */
export function layerMidZ(plan: LayerPlan, index: number): number {
  const n = plan.length;
  if (n === 0) return 0;
  const first = plan[0];
  if (index <= first.index) return first.z + (index - first.index) * pitchOf(plan, 0);
  const last = plan[n - 1];
  if (index >= last.index) return last.z + (index - last.index) * pitchOf(plan, n - 1);
  const at = plan[index - first.index];
  return at && at.index === index ? at.z : first.z + (index - first.index) * pitchOf(plan, 0);
}

/** Half the distance to the neighbouring mid-planes, i.e. this sheet's own slab. */
function halfSlabAt(plan: LayerPlan, index: number): number {
  const n = plan.length;
  if (n === 0) return 0.5;
  const first = plan[0].index;
  const at = index - first;
  if (at < 0) return pitchOf(plan, 0) / 2;
  if (at >= n) return pitchOf(plan, n - 1) / 2;
  return pitchOf(plan, at) / 2;
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

  const lo = Math.min(
    Math.max(Math.round(Math.min(spec.minCount, spec.maxCount)), 1),
    MAX_WINDOWS_PER_LAYER,
  );
  const hi = Math.min(
    Math.max(Math.round(Math.max(spec.minCount, spec.maxCount)), lo),
    MAX_WINDOWS_PER_LAYER,
  );
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
): number {
  const halfLength = Math.max(spec.length, 0.01) / 2;
  const band = Math.max(z - (spec.z + halfLength), spec.z - halfLength - z);

  const layer = layerIndexAt(plan, z);
  const wedges = wedgesForLayer(spec, layer);
  if (wedges.length === 0) return Math.abs(band) + 1e3;

  const mid = layerMidZ(plan, layer);
  const halfPitch = halfSlabAt(plan, layer);
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
): number {
  // Everything below works in the wedge's own frame, so the axis can stand
  // wherever the form does.
  const x = worldX - (spec.x ?? 0);
  const y = worldY - (spec.y ?? 0);

  if (spec.mode === 'perLayer') {
    if (!plan) return 1e3;
    return perLayerDistance(x, y, z, spec, plan);
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
): (x: number, y: number, z: number) => number {
  const inset = Math.max(spec.fit, 0) / 2;
  return (x, y, z) =>
    Math.max(solid(x, y, z), sectorDistance(x, y, z, spec, plan)) + inset;
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
): (x: number, y: number, z: number) => number {
  if (windows.length === 0) return solid;
  return (x, y, z) => {
    let d = solid(x, y, z);
    for (const spec of windows) {
      d = Math.max(d, -sectorDistance(x, y, z, spec, plan));
    }
    return d;
  };
}

/** Layers inside the band that rolled at least one window, for reporting. */
export function windowedLayers(
  spec: WindowSpec,
  plan: LayerPlan,
  layerCount: number,
): number[] {
  const out: number[] = [];
  const halfLength = Math.max(spec.length, 0) / 2;
  for (let k = 0; k < layerCount; k++) {
    const z = layerMidZ(plan, k);
    if (z < spec.z - halfLength || z > spec.z + halfLength) continue;
    if (spec.mode === 'band' || wedgesForLayer(spec, k).length > 0) out.push(k);
  }
  return out;
}
