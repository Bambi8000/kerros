import { useEffect, useMemo, useRef, useState } from 'react';
import { rodsFromFeatures, useKerros } from '../core/store';
import { spacerHeightAchieved, spacerPlans } from '../core/rig';
import type { SpacerPlan } from '../core/rig';
import { buildParts } from '../core/job';
import { analyseSheet, applyPlacements } from '../core/nest';
import type { NestOptions, NestResult, PartGeometry, SheetReport } from '../core/nest';
import { rehydrateNest } from '../core/pipeline';
import type { NestOutput } from '../core/pipeline';
import { requestNest } from './workerBridge';
import type { SliceSet } from '../core/slice';

export interface SheetResult extends NestResult {
  spacers: SpacerPlan[];
  /** Gap the generated rings actually produce, mm. */
  spacerAchieved: number;
  partCount: number;
  /** True-shape collision and clearance report, per sheet index. */
  reports: Record<number, SheetReport>;
  pinnedCount: number;
  /** A nest is in flight and what is on screen is the previous one. */
  busy: boolean;
  /** A completed pack for the current inputs, including an all-unplaced job. */
  ready: boolean;
  /** How long the last pack took, ms. */
  ms: number;
}

const EMPTY: SheetResult = {
  sheets: [],
  unplaced: [],
  spacers: [],
  spacerAchieved: 0,
  partCount: 0,
  reports: {},
  pinnedCount: 0,
  busy: false,
  ready: false,
  ms: 0,
};

/**
 * Stable stand-in for "no window plugs".
 *
 * A `= []` default builds a fresh array on every call, which would make the
 * job memo below change identity on every render and dispatch a nest job on
 * every render with it. Cheap when the work was a memo; not cheap now that it
 * is a message to another thread.
 */
const NO_WINDOWS: { label: string; set: SliceSet }[] = [];

/**
 * Coalesce rapid changes to the bed settings.
 *
 * Shorter than the slice debounce, because the expensive wait already happened
 * upstream: by the time parts exist, slicing has settled. This one only stops a
 * dragged margin or part gap from queueing a pack per pixel.
 */
const NEST_DEBOUNCE = 120;

interface BuiltJob {
  parts: PartGeometry[];
  spacers: SpacerPlan[];
  spacerAchieved: number;
  options: NestOptions;
}

/**
 * Nest the current job onto sheets.
 *
 * Packing runs in the shared worker. True-shape costs about half a second on a
 * real lamp and the webview makes that closer to a second, which is a freeze in
 * exactly the mode where a person is judging whether to buy material.
 *
 * Two things deliberately stay on this thread:
 *
 * - **Hand placements.** `applyPlacements` and `rotatePart` are interactive and
 *   cheap, and they go on *after* the pack, so dragging a part no longer
 *   re-packs the sheet. Before this the placements were a dependency of the
 *   memo that did the packing, so every drag paid the full cost.
 * - **`analyseSheet`.** The collision reading is feedback to that dragging, so
 *   it has to be on screen when the part is in the wrong place rather than a
 *   message round trip later. It only examines pairs whose boxes overlap and
 *   thins dense outlines, so the cost is already bounded.
 */
export function useSheets(
  slices: SliceSet | null,
  windows: { label: string; set: SliceSet }[] = NO_WINDOWS,
): SheetResult {
  const features = useKerros((s) => s.features);
  const projectRevision = useKerros((s) => s.projectRevision);
  const trueShape = useKerros((s) => s.trueShapeNesting);
  const nestCell = useKerros((s) => s.nestCell);
  const machine = useKerros((s) => s.machine);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  const spacerThickness = useKerros((s) => s.stack.spacerThickness);
  const partGap = useKerros((s) => s.partGap);
  const labelHeight = useKerros((s) => s.labelHeight);
  const ringWidth = useKerros((s) => s.ringWidth);
  const makeSpacers = useKerros((s) => s.makeSpacers);
  const partPlacements = useKerros((s) => s.partPlacements);

  /** Everything the pack needs, assembled here because it is grouping, not packing. */
  const built = useMemo<BuiltJob | null>(() => {
    if (!slices || slices.slices.length === 0) return null;

    // Rings are their own material, so the ring count comes from their
    // thickness rather than the stock's — 372 rings on a rod versus 62.
    const spacerOptions = { thickness, spacerHeight, kerf, ringWidth, spacerThickness };
    const spacers = makeSpacers
      ? spacerPlans(rodsFromFeatures(features), slices.slices, spacerOptions)
      : [];

    /*
     * Rings share the stock's sheet only while they are the stock. Give them a
     * thickness of their own and they are a different material on the bed —
     * which is how they get cut in practice, separately from whatever is to
     * hand — so they nest on their own sheet with their own ordinal.
     */
    const ringT = (spacerThickness ?? 0) > 0 ? (spacerThickness as number) : thickness;
    const spacerMaterial = Math.abs(ringT - thickness) > 1e-9 ? 'spacer' : 'stock';

    return {
      parts: buildParts(slices, spacers, windows, spacerMaterial),
      spacers,
      spacerAchieved: spacerHeightAchieved(spacerOptions),
      options: {
        trueShape,
        cell: nestCell,
        sheetWidth: Math.max(machine.bedWidth - machine.margin * 2, 1),
        sheetHeight: Math.max(machine.bedHeight - machine.margin * 2, 1),
        gap: partGap,
        labelHeight,
      },
    };
  }, [
    slices,
    windows,
    trueShape,
    nestCell,
    features,
    machine.bedWidth,
    machine.bedHeight,
    machine.margin,
    thickness,
    kerf,
    spacerHeight,
    spacerThickness,
    partGap,
    labelHeight,
    ringWidth,
    makeSpacers,
  ]);

  /**
   * The reply, kept with the job it answers.
   *
   * A placement table is only meaningful against the parts it was computed
   * from, so the two travel together. That is also what lets the previous
   * layout stay on screen while a new one is packed: it stays consistent with
   * itself rather than becoming a set of positions for parts that no longer
   * exist.
   */
  const [done, setDone] = useState<{
    output: NestOutput; job: BuiltJob; projectRevision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef(0);

  useEffect(() => {
    if (!built) {
      token.current++;
      setDone(null);
      setBusy(false);
      return;
    }

    const mine = ++token.current;
    setBusy(true);

    const timer = setTimeout(() => {
      requestNest({ parts: built.parts, options: built.options })
        .then((output) => {
          // During a drag several packs are in flight and only the last one
          // asked for is worth showing.
          if (mine !== token.current) return;
          setDone({ output, job: built, projectRevision });
          setBusy(false);
        })
        .catch((error: unknown) => {
          if (mine !== token.current) return;
          console.error('[Kerros] nesting failed:', error);
          setBusy(false);
        });
    }, NEST_DEBOUNCE);

    return () => {
      clearTimeout(timer);
      token.current++;
    };
  }, [built, projectRevision]);

  return useMemo(() => {
    if (!built) return EMPTY;
    if (!done || done.projectRevision !== projectRevision) return { ...EMPTY, busy: true };

    const { output, job } = done;
    const nested = rehydrateNest(output, job.parts);
    if (nested.missing.length > 0) {
      console.error('[Kerros] placements with no part:', nested.missing.join(', '));
    }

    // Manual placements go on last, so re-nesting rearranges everything except
    // what a person deliberately put somewhere.
    const placed = applyPlacements({ sheets: nested.sheets, unplaced: nested.unplaced }, partPlacements);

    // The real check: do the outlines actually meet, and is there enough room
    // between them. Bounding boxes cannot tell you either — a part nested into
    // another's concavity shares a box and cuts perfectly.
    const reports: Record<number, SheetReport> = {};
    let pinnedCount = 0;
    for (const sheet of placed.sheets) {
      reports[sheet.index] = analyseSheet(sheet, job.options.gap);
      for (const part of sheet.parts) if (part.pinned) pinnedCount++;
    }

    return {
      ...placed,
      spacers: job.spacers,
      spacerAchieved: job.spacerAchieved,
      partCount: job.parts.length,
      reports,
      pinnedCount,
      busy: busy || done.job !== built,
      ready: done.job === built && !busy,
      ms: output.ms,
    };
  }, [done, busy, partPlacements, built, projectRevision]);
}
