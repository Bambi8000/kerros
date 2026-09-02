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
  /**
   * For a pin, the other sheet it also passes through.
   *
   * A pin joins two neighbouring sheets and the same hole is drilled in both,
   * so which of the two you are looking at decides whether it carries on up or
   * down from here. Worth carrying: a ring of identical holes hides the one
   * thing about interleaving that matters.
   */
  pinTo?: number;
  /**
   * For a pin, which one it is: `gap:position`.
   *
   * Stable across a re-slice so a pin taken out by hand stays out. It is keyed
   * on the layer number below the gap rather than on an ordinal, because a run
   * of layers can be re-chosen without renumbering the sheets — but it does
   * move if the sheet count itself changes, which is the same fragility hand
   * placements on the bed already carry.
   */
  pinKey?: string;
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
export function ringThickness(
  options: Pick<SpacerOptions, 'thickness' | 'spacerThickness'>,
): number {
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

/* ------------------------------------------------------------------ *
 * Interleaved pins
 *
 * Short pins joining one sheet to the next, instead of a threaded rod through
 * the whole stack. Each pin passes through **two** neighbouring sheets, so a
 * stack of n sheets has n-1 gaps and every gap needs at least one pin or the
 * two sheets either side of it are not fastened to each other.
 *
 * THE REASON THEY ARE INTERLEAVED. The pins in gap k-1 pass through sheets k-1
 * and k. The pins in gap k pass through sheets k and k+1. Both drill sheet k —
 * so if consecutive gaps used the same angle, the two pins would meet inside
 * that sheet. Turning each gap from the one below it is not decoration; it is
 * what makes the idea possible at all.
 *
 * Every sheet except the two ends therefore carries two rings of holes, one
 * from the gap below and one from the gap above.
 * ------------------------------------------------------------------ */

export interface PinSpec {
  id: string;
  label: string;
  /** Pins in each gap, evenly around the axis. */
  count: number;
  /** Finished hole diameter, mm. */
  diameter: number;
  /** Distance from the stack axis, mm. */
  radius: number;
  /** Where the first pin of the lowest gap points, degrees from +X. */
  angle: number;
  /**
   * Degrees each gap is turned from the one below it.
   *
   * Zero — or a whole turn, which is the same thing — would put every gap at
   * the same angle and the pins would meet inside the sheets they share. Either
   * falls back to half a position, which is the furthest apart consecutive gaps
   * can be.
   */
  stagger: number;
  /** The axis the ring of pins is arranged around, mm. */
  x: number;
  y: number;
  kerf: number;
}

/** Half a position: the furthest one gap can be turned from the next. */
export function defaultStagger(count: number): number {
  return 360 / Math.max(Math.round(count), 1) / 2;
}

export interface PinGap {
  /** Layer numbers of the two sheets this gap joins. */
  below: number;
  above: number;
  /** Where the pins go. The same holes are drilled in both sheets. */
  holes: CircleHole[];
}

/**
 * One gap per pair of neighbouring sheets, with the pins turned as they climb.
 *
 * `layers` is the run of sheets to pin, in order and as the slice inspector
 * numbers them. Fewer than two sheets is not a stack and gets nothing.
 */
export function pinGaps(spec: PinSpec, layers: number[]): PinGap[] {
  const count = Math.max(Math.round(spec.count), 1);
  const radius = Math.max(spec.radius, 0);
  const cut = rodCutRadius(Math.max(spec.diameter, 0.1), spec.kerf);

  // Zero would stack every gap on the same angle and the pins would collide
  // inside the sheets they share. A whole turn is the same as none.
  const turn = spec.stagger % 360 === 0 ? defaultStagger(count) : spec.stagger;

  const gaps: PinGap[] = [];
  for (let i = 0; i + 1 < layers.length; i++) {
    const base = spec.angle + turn * i;
    const holes: CircleHole[] = [];
    for (let k = 0; k < count; k++) {
      const a = ((base + (k * 360) / count) * Math.PI) / 180;
      holes.push({
        x: spec.x + Math.cos(a) * radius,
        y: spec.y + Math.sin(a) * radius,
        r: cut,
        label: `pin ${spec.label}`,
        owner: spec.id,
        pinKey: `${layers[i]}:${k}`,
      });
    }
    gaps.push({ below: layers[i], above: layers[i + 1], holes });
  }
  return gaps;
}

/**
 * Sheets held on one side only, or on neither.
 *
 * The check the generator owes its own output. A pattern of holes is not a
 * structure: if a gap's pins would not fit the sheets they pass through, those
 * two sheets are simply not fastened together, and a stack that comes apart in
 * the middle is worse than one that was never pinned.
 *
 * `placed` says how many pins actually landed in each gap, in the same order
 * `pinGaps` returned them. The two ends of the run are left out: the lowest
 * sheet has no gap below it and the highest none above, and reporting those
 * would cry wolf on every stack.
 */
export function loosePins(gaps: PinGap[], placed: number[]): number[] {
  if (gaps.length === 0) return [];

  const held = new Map<number, number>();
  const note = (layer: number, joins: number) => held.set(layer, (held.get(layer) ?? 0) + joins);

  for (const [i, gap] of gaps.entries()) {
    const joined = (placed[i] ?? 0) > 0 ? 1 : 0;
    note(gap.below, joined);
    note(gap.above, joined);
  }

  const first = gaps[0].below;
  const last = gaps[gaps.length - 1].above;

  const loose: number[] = [];
  for (const [layer, joins] of held) {
    const wanted = layer === first || layer === last ? 1 : 2;
    if (joins < wanted) loose.push(layer);
  }
  return loose.sort((a, b) => a - b);
}
