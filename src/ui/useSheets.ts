import { useMemo } from 'react';
import { rodsFromFeatures, useKerros } from '../core/store';
import { spacerHeightAchieved, spacerPlans } from '../core/rig';
import type { SpacerPlan } from '../core/rig';
import { buildParts } from '../core/job';
import { analyseSheet, applyPlacements, nestParts } from '../core/nest';
import type { NestResult, SheetReport } from '../core/nest';
import type { SliceSet } from '../core/slice';

export interface SheetResult extends NestResult {
  spacers: SpacerPlan[];
  /** Gap the generated rings actually produce, mm. */
  spacerAchieved: number;
  partCount: number;
  /** True-shape collision and clearance report, per sheet index. */
  reports: Record<number, SheetReport>;
  pinnedCount: number;
}

const EMPTY: SheetResult = {
  sheets: [],
  unplaced: [],
  spacers: [],
  spacerAchieved: 0,
  partCount: 0,
  reports: {},
  pinnedCount: 0,
};

/**
 * Nest the current job onto sheets.
 *
 * Cheap compared with slicing — it only moves bounding boxes around — so it
 * runs synchronously off a memo rather than a debounce, and re-runs whenever
 * the slices or the bed change.
 */
export function useSheets(slices: SliceSet | null): SheetResult {
  const features = useKerros((s) => s.features);
  const machine = useKerros((s) => s.machine);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  const partGap = useKerros((s) => s.partGap);
  const labelHeight = useKerros((s) => s.labelHeight);
  const ringWidth = useKerros((s) => s.ringWidth);
  const makeSpacers = useKerros((s) => s.makeSpacers);
  const partPlacements = useKerros((s) => s.partPlacements);

  return useMemo(() => {
    if (!slices || slices.slices.length === 0) return EMPTY;

    const spacerOptions = { thickness, spacerHeight, kerf, ringWidth };
    const spacers = makeSpacers
      ? spacerPlans(rodsFromFeatures(features), slices.slices, spacerOptions)
      : [];

    const parts = buildParts(slices, spacers);
    const nested = nestParts(parts, {
      sheetWidth: Math.max(machine.bedWidth - machine.margin * 2, 1),
      sheetHeight: Math.max(machine.bedHeight - machine.margin * 2, 1),
      gap: partGap,
      labelHeight,
    });

    // Manual placements go on last, so re-nesting rearranges everything except
    // what a person deliberately put somewhere.
    const placed = applyPlacements(nested, partPlacements);

    // The real check: do the outlines actually meet, and is there enough room
    // between them. Bounding boxes cannot tell you either — a part nested into
    // another's concavity shares a box and cuts perfectly.
    const reports: Record<number, SheetReport> = {};
    let pinnedCount = 0;
    for (const sheet of placed.sheets) {
      reports[sheet.index] = analyseSheet(sheet, partGap);
      for (const part of sheet.parts) if (part.pinned) pinnedCount++;
    }

    return {
      ...placed,
      spacers,
      spacerAchieved: spacerHeightAchieved(spacerOptions),
      partCount: parts.length,
      reports,
      pinnedCount,
    };
  }, [
    slices,
    features,
    machine.bedWidth,
    machine.bedHeight,
    machine.margin,
    thickness,
    kerf,
    spacerHeight,
    partGap,
    labelHeight,
    ringWidth,
    makeSpacers,
    partPlacements,
  ]);
}
