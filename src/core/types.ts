/**
 * Kerros core domain types.
 *
 * The feature tree is an ordered list. Re-evaluating it top to bottom
 * always reproduces the same model. Nothing here evaluates anything yet —
 * M0 only fixes the shapes of the data so M1 can fill them in.
 */

/** Pipeline stages, in evaluation order. */
export const STAGES = [
  'SHAPE',
  'CARVE',
  'RIG',
  'SLICE',
  'PATTERN',
  'LAYOUT',
  'EXPORT',
] as const;

export type Stage = (typeof STAGES)[number];

/** Human-readable stage descriptions, shown in the empty feature tree. */
export const STAGE_NOTES: Record<Stage, string> = {
  SHAPE: 'Primitives, smooth unions, sculpt strokes, imports',
  CARVE: 'Subtracted volumes and shell thickness',
  RIG: 'Rods, spacers, socket mount, cable channel, Wago chamber',
  SLICE: 'Layer pitch, contours, kerf offset',
  PATTERN: 'Wall perforation inside the shell band',
  LAYOUT: 'Nesting onto bed-sized sheets',
  EXPORT: 'DXF R12, CUT and ENGRAVE layers',
};

/**
 * One row of the feature tree.
 *
 * `params` stays loosely typed at the core level: each feature module owns
 * its own parameter schema, and the module registry (M1) is what narrows it.
 */
/** One brush stroke: the capsule chain the brush swept. */
export interface SculptStroke {
  op: string;
  /** Brush radius, mm. */
  radius: number;
  /** Blend radius for the smooth ops, mm. */
  k: number;
  /** Flat x, y, z triples along the stroke. */
  points: number[];
}

export interface Feature {
  id: string;
  /** Module key, e.g. 'sphere', 'smoothUnion', 'rod'. */
  kind: string;
  stage: Stage;
  name: string;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  /**
   * Sculpt strokes, on sculpt features only.
   *
   * Kept out of `params` because params hold single values, and a stroke list is
   * bulk data — the project file writes it as its own array so the file stays
   * something a person can read and diff.
   */
  strokes?: SculptStroke[];
  /**
   * A profile's rings, on profile features only.
   *
   * Bulk data like strokes, but deliberately **not** written to the project
   * file: the path is, and the outline is read again from it. Small enough to
   * travel with the tree to the worker, which is what a mesh grid is not.
   */
  rings?: number[][];
}

export interface MachineProfile {
  name: string;
  /** Laser bed width in mm (X). */
  bedWidth: number;
  /** Laser bed height in mm (Y). */
  bedHeight: number;
  /** Unusable border around the sheet, mm. */
  margin: number;
}

export interface MaterialProfile {
  name: string;
  /** Sheet thickness in mm. Sets the minimum layer pitch. */
  thickness: number;
  /** Cut width in mm, measured with the kerf test figure. */
  kerf: number;
  notes: string;
}

export interface StackSettings {
  /**
   * Gap between sheets at the **bottom** of the stack, mm. 0 is tight stacking.
   *
   * Quantised in use: a gap is a whole number of spacer rings, and a ring is
   * one `spacerThickness` tall. Asking for 4 mm from 3 mm rings gets 3 mm, and
   * the model is planned on the 3 mm — a stack the program cannot build is
   * worse than one it plans honestly.
   */
  spacerHeight: number;
  /**
   * Gap at the **top**, mm. Omitted, or equal to `spacerHeight`, is uniform.
   *
   * Optional rather than required so that a profile written before gradients
   * existed is still a valid stack, and so that "uniform" has one spelling
   * rather than two.
   */
  spacerHeightTop?: number;
  /**
   * Thickness of one spacer ring, mm — its own material, not the stock's.
   *
   * Separating the two is what makes thin stock usable at all. A 200 mm lamp
   * in 0.5 mm steel with 0.5 mm rings needs 372 rings per rod; with 3 mm rings
   * it needs 62. Nobody stacks 372 washers by hand.
   */
  spacerThickness?: number;

  /**
   * Degrees each sheet is turned from the one below it, when the stack is
   * assembled. 0 is a stack with no spiral.
   *
   * A turned sheet cuts the **same outline** — the model decides the part
   * shapes and the twist decides how they are stacked, so the lamp comes out
   * turned relative to the model rather than the parts coming out different.
   * What cannot stay put is anything that lines up *through* the stack: a rod
   * is straight, so its hole is drilled turned back by the same angle.
   */
  twistPerLayer?: number;
  /** Layers turned by hand, as `layer:degrees` pairs in one string. */
  twistOverrides?: string;
}

/**
 * Pitch at the **bottom** of the stack, mm.
 *
 * Once gaps can vary there is no single pitch, so this is no longer the number
 * the whole stack hangs on — `planLayers()` in `slice.ts` builds the stack, and
 * `pitchAt()` answers "which pitch, where". This stays for the readouts that
 * want one number, and it now returns the pitch that will actually be built
 * rather than the one that was asked for: a gap is a whole number of rings, so
 * 4 mm of 3 mm rings is 3 mm.
 *
 * The ring arithmetic is duplicated from `ringsForGap()` in `slice.ts`, which
 * this file may not import — the slicer has no imports at all, deliberately, so
 * the dependency could only go the wrong way. A validator asserts the two agree.
 */
export function layerPitch(material: MaterialProfile, stack: StackSettings): number {
  const ringT =
    stack.spacerThickness !== undefined && stack.spacerThickness > 0
      ? stack.spacerThickness
      : material.thickness;
  const rings = ringT > 0 ? Math.max(Math.round(Math.max(stack.spacerHeight, 0) / ringT), 0) : 0;
  return material.thickness + rings * ringT;
}
