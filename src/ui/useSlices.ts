import { useEffect, useRef, useState } from 'react';
import { useKerros } from '../core/store';
import { EMPTY_OUTPUT } from '../core/pipeline';
import type { SliceJob, SliceOutput } from '../core/pipeline';
import { requestSlice } from './workerBridge';

/** Editing settles before a re-slice, which is far heavier than a preview. */
const SLICE_DEBOUNCE_MS = 250;

export interface SliceResult extends SliceOutput {
  /** True while a job is queued or running. */
  pending: boolean;
}

const IDLE: SliceResult = { ...EMPTY_OUTPUT, pending: false };

/**
 * Slice the current feature tree, off the main thread.
 *
 * Only runs while `enabled`, so nobody pays for slicing while modelling. Each job
 * is tagged with a generation, and anything that comes back stale is dropped:
 * during a drag several are in flight and only the last one asked for is worth
 * showing.
 */
export function useSlices(enabled: boolean): SliceResult {
  const features = useKerros((s) => s.features);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  // The whole stack, not just the bottom gap: per-layer windows key on which
  // sheet a height falls in, so the field needs the plan and not a spacing.
  const spacerHeightTop = useKerros((s) => s.stack.spacerHeightTop);
  const spacerThickness = useKerros((s) => s.stack.spacerThickness);
  const resolution = useKerros((s) => s.sliceRes);
  const tolerance = useKerros((s) => s.sliceTolerance);
  const smoothing = useKerros((s) => s.sliceSmoothing);
  const minFeature = useKerros((s) => s.minFeature);
  const seed = useKerros((s) => s.seed);
  const importRevision = useKerros((s) => s.importRevision);

  const [result, setResult] = useState<SliceResult>(IDLE);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(IDLE);
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));

    const timer = window.setTimeout(() => {
      const mine = ++generation.current;
      const job: SliceJob = {
        features,
        thickness,
        kerf,
        spacerHeight,
        spacerHeightTop,
        spacerThickness,
        resolution,
        tolerance,
        smoothing,
        minFeature,
        seed,
      };

      void requestSlice(job, importRevision).then((output) => {
        if (mine !== generation.current) return;
        setResult({ ...output, pending: false });
      });
    }, SLICE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    enabled,
    features,
    thickness,
    kerf,
    spacerHeight,
    spacerHeightTop,
    spacerThickness,
    resolution,
    tolerance,
    smoothing,
    minFeature,
    seed,
    importRevision,
  ]);

  return result;
}
