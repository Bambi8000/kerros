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
  /**
   * The feature that put it there.
   *
   * Stamped when the hole is made, not worked out afterwards. A hole cut per
   * slice was made by exactly one feature, so remembering which is both cheaper
   * and more honest than reconstructing it from geometry the way the model view
   * has to.
   */
  owner?: string;
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
      owner: rod.id,
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
  /**
   * Rings in the thinnest and the thickest gap this rod spans.
   *
   * There used to be one `ringsPerGap` here, which is only a number while every
   * gap is the same. On a graded stack the two differ and the range is what a
   * person needs to know before counting rings out onto the bench.
   */
  ringsMin: number;
  ringsMax: number;
  /** Rings this rod needs in total. */
  total: number;
}

export interface SpacerOptions {
  /** Sheet thickness of the stock, mm. */
  thickness: number;
  /** Requested gap between sheets, mm. */
  spacerHeight: number;
  kerf: number;
  /** Radial width of the ring, mm. */
  ringWidth: number;
  /**
   * Thickness of one ring, mm. Defaults to the stock thickness.
   *
   * Its own material, because tying it to the stock makes thin sheet unusable:
   * a 200 mm lamp in 0.5 mm steel needs 372 rings per rod from 0.5 mm rings and
   * 62 from 3 mm ones.
   */
  spacerThickness?: number;
}

/** Thickness of one ring: its own material, falling back to the stock's. */
export function ringThickness(options: SpacerOptions): number {
  const own = options.spacerThickness;
  return own !== undefined && own > 0 ? own : options.thickness;
}

/**
 * How many rings each gap needs.
 *
 * The handoff says one ring per gap, and that is wrong the moment the spacer
 * height is not the ring thickness: a 6 mm gap from 3 mm rings needs two
 * stacked, not one. Rings come only in whole thicknesses of **their own**
 * material, which is not the stock's — that separation is what makes 0.5 mm
 * sheet usable, since 0.5 mm rings would want 372 of them on a rod where 3 mm
 * rings want 62. The achievable gap is therefore `ringsPerGap x
 * ringThickness`, which is what `spacerHeightAchieved` reports and what the
 * plan is built on. Getting it wrong means the stack does not go together with
 * the parts you cut.
 *
 * This is the requested gap quantised. `spacerPlans` does not use it: rings
 * there are counted from the gaps the sheets actually leave, which is the same
 * number on a uniform stack and the right one on a graded one.
 */
export function ringsPerGap(options: SpacerOptions): number {
  const ringT = ringThickness(options);
  if (options.spacerHeight <= 0 || ringT <= 0) return 0;
  return Math.max(1, Math.round(options.spacerHeight / ringT));
}

/** The gap you will actually get, given rings can only be whole sheets thick. */
export function spacerHeightAchieved(options: SpacerOptions): number {
  return ringsPerGap(options) * ringThickness(options);
}

/**
 * Rings needed to fill a measured gap.
 *
 * Rounds rather than flooring, so a gap between two sheets is filled as closely
 * as whole rings allow. Zero for a gap that is not there.
 */
export function ringsInGap(gap: number, ringT: number): number {
  if (!(ringT > 0) || gap <= ringT / 2) return 0;
  return Math.max(1, Math.round(gap / ringT));
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
  const ringT = ringThickness(options);
  if (!(ringT > 0)) return [];

  const plans: SpacerPlan[] = [];
  for (const rod of rods) {
    /*
     * Rings are counted from the gaps that are actually there, sheet to sheet,
     * rather than from the requested spacer height multiplied by the gap count.
     *
     * On a uniform stack the two agree. On a graded one they cannot, and the
     * measured gap is the one that has to be filled — a rod does not care what
     * was asked for, only how far apart the sheets it passes through are. It
     * also gets a void along Z right for free: two sheets three pitches apart
     * need three pitches of rings, not one gap's worth.
     */
    const reached = slices.filter((slice) => rodSpansZ(rod, slice.z));
    if (reached.length < 2) continue;

    let total = 0;
    let ringsMin = Infinity;
    let ringsMax = 0;
    let gaps = 0;

    for (let i = 0; i + 1 < reached.length; i++) {
      const gap = reached[i + 1].z - reached[i].z - options.thickness;
      const rings = ringsInGap(gap, ringT);
      gaps++;
      total += rings;
      if (rings < ringsMin) ringsMin = rings;
      if (rings > ringsMax) ringsMax = rings;
    }

    if (total === 0) continue;

    const diameter = rodDiameter(rod);
    plans.push({
      rodId: rod.id,
      label: rod.label,
      innerR: rodCutRadius(diameter, options.kerf),
      // The outside is an outer boundary, so it grows by half a kerf.
      outerR: diameter / 2 + Math.max(options.ringWidth, 0.5) + options.kerf / 2,
      gaps,
      ringsMin: ringsMin === Infinity ? 0 : ringsMin,
      ringsMax,
      total,
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
