/**
 * Kerros rig features.
 *
 * A rod is a threaded rod running along Z through some span of the stack. It
 * is not a solid in the SDF sense — it removes nothing from the form. It adds
 * a clearance hole to every slice whose mid-plane falls inside its span, and
 * nothing to the slices outside it.
 *
 * DELIBERATE CONSTRAINT: no value imports. Node validators load this as the
 * real module.
 */

export const ROD_SIZES = ['M3', 'M4', 'M5', 'M6', 'M8'] as const;
export type RodSize = (typeof ROD_SIZES)[number];

/**
 * Clearance hole diameters in mm, the medium-fit column of the usual metric
 * table. Overridable per rod: a rod that has been painted, or a cheap rod with
 * a fat thread, wants its own number.
 */
export const ROD_CLEARANCE: Record<string, number> = {
  M3: 3.2,
  M4: 4.3,
  M5: 5.3,
  M6: 6.4,
  M8: 8.4,
};

export interface RodSpec {
  id: string;
  label: string;
  size: string;
  x: number;
  y: number;
  zStart: number;
  zEnd: number;
  /** Overrides the table when greater than zero. */
  diameter: number;
}

export interface CircleHole {
  x: number;
  y: number;
  r: number;
  label: string;
}

/** Finished hole diameter for a rod, table value unless overridden. */
export function rodDiameter(rod: RodSpec): number {
  if (rod.diameter > 0) return rod.diameter;
  return ROD_CLEARANCE[rod.size] ?? ROD_CLEARANCE.M5;
}

/** Span with the ends in order, so a rod dragged backwards still works. */
export function rodSpan(rod: RodSpec): [number, number] {
  return rod.zStart <= rod.zEnd ? [rod.zStart, rod.zEnd] : [rod.zEnd, rod.zStart];
}

/**
 * Does this rod pass through a layer sampled at `z`?
 *
 * The test is on the layer's mid-plane, matching how the slice itself was
 * taken. A rod that stops halfway through a sheet does not get a hole in it:
 * a half-drilled hole is not a thing a laser can cut.
 */
export function rodSpansZ(rod: RodSpec, z: number): boolean {
  const [low, high] = rodSpan(rod);
  return z >= low && z <= high;
}

/**
 * Radius of the path to cut for a finished hole of `diameter`.
 *
 * The laser removes kerf/2 outside the path and kerf/2 inside it, so a hole
 * comes out one kerf wider than the path. Cut the path smaller by kerf/2.
 */
export function rodCutRadius(diameter: number, kerf: number): number {
  return Math.max(diameter / 2 - Math.max(kerf, 0) / 2, 0.05);
}

/** Clearance holes for every rod crossing a given layer. */
export function rodHolesAt(rods: RodSpec[], z: number, kerf: number): CircleHole[] {
  const holes: CircleHole[] = [];
  for (const rod of rods) {
    if (!rodSpansZ(rod, z)) continue;
    holes.push({
      x: rod.x,
      y: rod.y,
      r: rodCutRadius(rodDiameter(rod), kerf),
      label: `${rod.size} ${rod.label}`,
    });
  }
  return holes;
}

/** Minimal shape of a slice this module needs to annotate. */
export interface SliceLike {
  z: number;
  circles: CircleHole[];
}

/**
 * Attach rod holes to every slice. Returns new slice objects; the input is
 * left alone so a re-run always starts from clean geometry rather than
 * accumulating holes.
 */
export function applyRods<T extends SliceLike>(
  slices: T[],
  rods: RodSpec[],
  kerf: number,
): T[] {
  return slices.map((slice) => ({
    ...slice,
    circles: rodHolesAt(rods, slice.z, kerf),
  }));
}

/**
 * Layers a rod actually reaches, for the assembly manifest and for warning
 * about a rod that misses the stack entirely.
 */
export function rodLayerCount(rod: RodSpec, slices: SliceLike[]): number {
  let count = 0;
  for (const slice of slices) if (rodSpansZ(rod, slice.z)) count++;
  return count;
}

/* ------------------------------------------------------------------ *
 * Spacer rings
 * ------------------------------------------------------------------ */

export interface SpacerPlan {
  rodId: string;
  label: string;
  /** Cut radius of the bore, kerf-compensated. */
  innerR: number;
  /** Cut radius of the outside, kerf-compensated. */
  outerR: number;
  /** Gaps this rod has to fill. */
  gaps: number;
  /** Rings stacked in each gap to reach the spacer height. */
  ringsPerGap: number;
  /** gaps x ringsPerGap. */
  total: number;
}

export interface SpacerOptions {
  /** Material thickness, mm — one ring is this tall. */
  thickness: number;
  /** Requested gap between sheets, mm. */
  spacerHeight: number;
  kerf: number;
  /** Radial width of the ring, mm. */
  ringWidth: number;
}

/**
 * How many rings each gap needs.
 *
 * The handoff says one ring per gap, and that is wrong the moment the spacer
 * height is not the material thickness: a 6 mm gap cut from 3 mm plexi needs
 * two rings stacked, not one. Rings can only come in whole material
 * thicknesses, so the achievable gap is `ringsPerGap x thickness` — which is
 * why `spacerHeightAchieved` exists and why the UI warns when it does not
 * match what was asked for. Getting this wrong means the stack does not go
 * together with the parts you cut.
 */
export function ringsPerGap(options: SpacerOptions): number {
  if (options.spacerHeight <= 0 || options.thickness <= 0) return 0;
  return Math.max(1, Math.round(options.spacerHeight / options.thickness));
}

/** The gap you will actually get, given rings can only be whole sheets thick. */
export function spacerHeightAchieved(options: SpacerOptions): number {
  return ringsPerGap(options) * options.thickness;
}

/**
 * Ring parts needed for every rod.
 *
 * A rod spanning n layers has n-1 gaps between them. A rod that reaches one
 * layer or none needs no spacers at all.
 */
export function spacerPlans(
  rods: RodSpec[],
  slices: SliceLike[],
  options: SpacerOptions,
): SpacerPlan[] {
  const perGap = ringsPerGap(options);
  if (perGap === 0) return [];

  const plans: SpacerPlan[] = [];
  for (const rod of rods) {
    const layers = rodLayerCount(rod, slices);
    const gaps = Math.max(layers - 1, 0);
    if (gaps === 0) continue;

    const diameter = rodDiameter(rod);
    plans.push({
      rodId: rod.id,
      label: rod.label,
      innerR: rodCutRadius(diameter, options.kerf),
      // The outside is an outer boundary, so it grows by half a kerf.
      outerR: diameter / 2 + Math.max(options.ringWidth, 0.5) + options.kerf / 2,
      gaps,
      ringsPerGap: perGap,
      total: gaps * perGap,
    });
  }
  return plans;
}

/** A circle as a closed ring, fine enough that the chord error is invisible. */
export function circlePoints(cx: number, cy: number, r: number, tolerance = 0.02): number[] {
  const safe = Math.max(r, 0.05);
  const ratio = Math.min(Math.max(1 - tolerance / safe, -1), 1);
  const segments = Math.max(24, Math.ceil(Math.PI / Math.acos(ratio)));
  const points: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(cx + safe * Math.cos(a), cy + safe * Math.sin(a));
  }
  return points;
}
