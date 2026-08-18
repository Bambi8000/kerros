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
  /** Default gap between slices in mm. 0 means tight stacking. */
  spacerHeight: number;
}

/** Layer pitch is thickness plus spacer — the one number the whole stack hangs on. */
export function layerPitch(material: MaterialProfile, stack: StackSettings): number {
  return material.thickness + stack.spacerHeight;
}
