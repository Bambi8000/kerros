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

export interface WindowSpec {
  id: string;
  label: string;
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
export function sectorDistance(
  x: number,
  y: number,
  z: number,
  spec: WindowSpec,
): number {
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
): (x: number, y: number, z: number) => number {
  const inset = Math.max(spec.fit, 0) / 2;
  return (x, y, z) => Math.max(solid(x, y, z), sectorDistance(x, y, z, spec)) + inset;
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
): (x: number, y: number, z: number) => number {
  if (windows.length === 0) return solid;
  return (x, y, z) => {
    let d = solid(x, y, z);
    for (const spec of windows) {
      d = Math.max(d, -sectorDistance(x, y, z, spec));
    }
    return d;
  };
}
