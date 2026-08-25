/**
 * Kerros legs.
 *
 * Round legs — turned wood, steel tube — splayed outwards from the stack's
 * axis and passing through some number of sheets near the bottom.
 *
 * THE SHAPE TO CUT IS NOT THE MID-PLANE ELLIPSE.
 *
 * A cylinder tilted by θ from vertical meets a horizontal plane in an ellipse:
 * semi-minor `r` across the tilt, semi-major `r / cos θ` along it. That much is
 * ordinary. What matters is that the leg does not meet one plane, it passes
 * through a sheet — and between the sheet's underside and its top face the axis
 * has moved sideways by `t · tan θ`. At 45° through 3 mm stock that is a full
 * 3 mm, most of a leg's width.
 *
 * So the hole is the **convex hull of the two end-face ellipses**, which is
 * exact rather than approximate: a cylinder is convex, a slab is convex, their
 * intersection is convex, and the sections are translates of one ellipse moving
 * linearly — so the union of them all is the hull of the two extremes.
 *
 * Cut only the mid-plane ellipse and a 45° leg does not pass through the sheet
 * at all. A validator asserts exactly that, because it is the whole reason this
 * module is not four lines long.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

const DEG = Math.PI / 180;

/**
 * Leg counts with a name, because the useful thing to choose is how many legs
 * there are and the angle between them follows.
 *
 * 3 → 120°, 4 → 90°, 5 → 72°, 6 → 60°, 7 → 51.4°, 8 → 45°.
 */
export const LEG_COUNTS = [3, 4, 5, 6, 7, 8] as const;

/** Widest tilt that still cuts a hole rather than a slot along the sheet. */
export const MAX_TILT = 60;

export interface LegSpec {
  id: string;
  label: string;
  /** How many legs, evenly around the axis. */
  count: number;
  /** Degrees from vertical. 0 is a straight leg, which is a rod. */
  tilt: number;
  /** Leg diameter, mm. */
  diameter: number;
  /** Distance from the stack axis to a leg's centre, at `zRef`. */
  radius: number;
  /** Where the first leg points, degrees from +X. */
  angle: number;
  /** The stack axis these are arranged around, mm. */
  x: number;
  y: number;
  /**
   * The height `radius` is measured at, mm.
   *
   * Filled in by the pipeline from the bottom of the model, so the number a
   * person types is the spread where the legs enter the lamp rather than at
   * some plane they cannot see.
   */
  zRef: number;
  /** Kerf of the stock, mm. The hole is cut narrow and burns out to size. */
  kerf: number;
}

/** Angle between neighbouring legs, degrees. */
export function legSpacing(count: number): number {
  return 360 / Math.max(Math.round(count), 1);
}

/** Where each leg points, degrees from +X, ascending. */
export function legAzimuths(spec: LegSpec): number[] {
  const n = Math.max(Math.round(spec.count), 1);
  const step = 360 / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(spec.angle + i * step);
  return out;
}

/**
 * Signed area of a closed ring. Positive is counter-clockwise.
 *
 * Duplicated from the slicer rather than imported: this module has none, so the
 * validators can load it as the real thing, and one shoelace loop is a cheaper
 * price than that.
 */
function signedArea(points: number[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    sum += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return sum / 2;
}

/** Convex hull by monotone chain, counter-clockwise, no repeated last point. */
export function convexHull(points: number[]): number[] {
  const n = points.length / 2;
  if (n < 3) return points.slice();

  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) =>
    points[a * 2] === points[b * 2]
      ? points[a * 2 + 1] - points[b * 2 + 1]
      : points[a * 2] - points[b * 2],
  );

  const cross = (o: number, a: number, b: number) =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);

  const build = (seq: number[]) => {
    const stack: number[] = [];
    for (const i of seq) {
      while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], i) <= 0) {
        stack.pop();
      }
      stack.push(i);
    }
    stack.pop();
    return stack;
  };

  const lower = build(order);
  const upper = build([...order].reverse());
  const out: number[] = [];
  for (const i of [...lower, ...upper]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * One leg's hole in one sheet, wound clockwise because it is a hole.
 *
 * `zBottom` is the underside of the sheet and `thickness` its full depth: the
 * hull spans the whole sheet, not the plane the slice was sampled on.
 */
export function legHole(
  spec: LegSpec,
  azimuth: number,
  zBottom: number,
  thickness: number,
  segments = 48,
): number[] {
  const tilt = Math.min(Math.max(spec.tilt, 0), MAX_TILT) * DEG;
  const cos = Math.cos(tilt);
  const inset = Math.max(spec.kerf, 0) / 2;

  // Eroding a convex shape by the kerf moves its boundary inward everywhere.
  // On an ellipse that is not exactly another ellipse, but the error is second
  // order in the inset — under a thousandth of a millimetre on any leg anyone
  // would cut — while the two axes are what a caliper measures.
  const minor = Math.max(spec.diameter / 2 - inset, 0.05);
  const major = Math.max(spec.diameter / 2 / Math.max(cos, 1e-6) - inset, minor);

  const a = azimuth * DEG;
  const ux = Math.cos(a);
  const uy = Math.sin(a);

  /*
   * Splayed: the feet are wide and the leg leans in as it rises, so a sheet
   * higher up takes its hole closer to the axis. `radius` is the spread at
   * `zRef`, which the pipeline sets to the bottom of the model — the number
   * typed in is the spread where the legs meet the lamp.
   *
   * The sign here was wrong in the first version, with a comment above it
   * saying the opposite of what the arithmetic did. The holes marched outwards
   * up the stack and the legs would have had to bend to fit.
   */
  const tan = Math.tan(tilt);
  const shift = thickness * tan;
  const atBottom = spec.radius - (zBottom - spec.zRef) * tan;
  const atTop = atBottom - shift;

  const points: number[] = [];
  for (const centre of [atBottom, atTop]) {
    const cxLeg = spec.x + ux * centre;
    const cyLeg = spec.y + uy * centre;
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const along = major * Math.cos(t);
      const across = minor * Math.sin(t);
      points.push(cxLeg + ux * along - uy * across, cyLeg + uy * along + ux * across);
    }
  }

  const hull = convexHull(points);
  return signedArea(hull) > 0 ? reverseRing(hull) : hull;
}

/** Every leg's hole in one sheet. */
export function legHoles(
  spec: LegSpec,
  zBottom: number,
  thickness: number,
  segments = 48,
): number[][] {
  return legAzimuths(spec).map((a) => legHole(spec, a, zBottom, thickness, segments));
}

function reverseRing(points: number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i], points[i + 1]);
  return out;
}
