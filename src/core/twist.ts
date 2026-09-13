/**
 * Kerros layer twist.
 *
 * The angle each sheet is turned by **when the stack goes together**, not when
 * it is cut. A spiral offset turns each layer a little further than the one
 * below, and any single layer can be overridden by hand.
 *
 * WHY THIS IS ABOUT HOLES. A sheet turned at assembly cuts exactly the same
 * outline it always did — so the DXF, the nesting and the part count are all
 * untouched. What cannot stay where it was is anything that has to line up
 * *through* the stack: a rod is straight, so its clearance hole must be drilled
 * turned back by the same angle, or the sheet cannot go on.
 *
 * So the rule is one line, and it is worth stating in one line because it is the
 * whole feature: **the outline is cut as designed, the holes are drilled at
 * −twist, and the sheet is turned by +twist when it is assembled.**
 *
 * WHAT IT IS FOR. Corrugated board has flutes running one way inside it and a
 * cut edge shows them, so a stack cut all at one angle has twelve identical
 * edges. Turning each layer is what makes the stack look alive — and the angle
 * a flute ends up at in the finished lamp is the part's rotation on the sheet
 * *plus* this. Both are needed to draw the grain honestly.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

const DEG = Math.PI / 180;

export interface TwistSpec {
  /** Degrees added per layer going up. 0 is a stack with no spiral. */
  perLayer: number;
  /**
   * Layers turned by hand, as `layer:degrees` pairs in one string.
   *
   * A handful of short entries is not bulk data, so it needs no array of its own
   * and no change to the project format — and `7:15 12:-20` is something a
   * person can read in the file and edit out if it ever goes wrong. The same
   * shape the hand-removed pins already use, and the same fragility: the keys
   * are layer numbers, so changing the material thickness points them at
   * different sheets.
   */
  overrides: string;
}

export const NO_TWIST: TwistSpec = { perLayer: 0, overrides: '' };

/** `7:15 12:-20` as a lookup. Anything unreadable is skipped, not guessed at. */
export function parseTwistOverrides(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const entry of String(text ?? '').split(/\s+/)) {
    if (entry === '') continue;
    const [left, right] = entry.split(':');
    const layer = Number(left);
    const degrees = Number(right);
    if (!Number.isFinite(layer) || !Number.isFinite(degrees)) continue;
    out.set(Math.round(layer), degrees);
  }
  return out;
}

/** The same map written back out, in layer order so a diff is readable. */
export function writeTwistOverrides(overrides: Map<number, number>): string {
  return [...overrides.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, degrees]) => `${layer}:${degrees}`)
    .join(' ');
}

/**
 * How far layer `index` is turned, degrees.
 *
 * Layers are numbered as the slice inspector numbers them, from 1 at the bottom,
 * and **the bottom layer is never turned**: the spiral is measured from it, so a
 * stack with one sheet has no twist however large the offset is. An override
 * replaces the spiral for that layer rather than adding to it — "this one at
 * 40 degrees" is the thing people mean, and a value that quietly compounded
 * with the spiral would be impossible to aim.
 */
export function twistAt(spec: TwistSpec, index: number, overrides?: Map<number, number>): number {
  const table = overrides ?? parseTwistOverrides(spec.overrides);
  const own = table.get(index);
  if (own !== undefined) return own;
  return (index - 1) * spec.perLayer;
}

/**
 * A hole's position on the sheet, given where it has to end up in the stack.
 *
 * Turned **back** by the twist: the sheet is turned forward when it is
 * assembled, so a hole drilled at −twist lands on the axis it belongs to. Get
 * the sign backwards and every hole is out by twice the angle, which on a
 * 2 degree spiral over 18 layers is most of a rod's clearance.
 */
export function untwistPoint(
  x: number,
  y: number,
  degrees: number,
  /** The stack's axis, which the sheets turn about. */
  cx = 0,
  cy = 0,
): [number, number] {
  if (degrees === 0) return [x, y];
  const a = -degrees * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** The forward turn, for drawing the assembled stack and the flute direction. */
export function twistPoint(
  x: number,
  y: number,
  degrees: number,
  cx = 0,
  cy = 0,
): [number, number] {
  return untwistPoint(x, y, -degrees, cx, cy);
}

export const MAX_REPEAT_STEPS = 3600;

/**
 * First repeated orientation within 3600 increments, to 1e-7 degrees.
 * Zero means no repeat found within that horizon, not "never". A pin ring
 * uses its angular spacing as the cycle; a sheet uses a full 360-degree turn.
 */
export function twistPeriod(perLayer: number, cycle = 360): number {
  if (!Number.isFinite(perLayer) || !Number.isFinite(cycle) || cycle <= 0) return 0;
  const turn = ((perLayer % cycle) + cycle) % cycle;
  for (let steps = 1; steps <= MAX_REPEAT_STEPS; steps++) {
    const angle = steps * turn;
    if (Math.abs(angle - Math.round(angle / cycle) * cycle) < 1e-7) return steps;
  }
  return 0;
}
