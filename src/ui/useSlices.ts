import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKerros } from '../core/store';
import { EMPTY_OUTPUT } from '../core/pipeline';
import type { SliceJob, SliceOutput } from '../core/pipeline';
import type { Feature } from '../core/types';
import { requestSlice } from './workerBridge';

/** Editing settles before a re-slice, which is far heavier than a preview. */
const SLICE_DEBOUNCE_MS = 250;

export interface SliceResult extends SliceOutput {
  /** True while a job is queued or running. */
  pending: boolean;
  /** Calculation failures are not successful empty jobs. */
  error: string | null;
  completedAt: number | null;
  recalculate: () => void;
  /** The output belongs to the current project and slice inputs. */
  fresh: boolean;
  /** Source tree of the retained output; never crosses a project/import change. */
  sourceFeatures: Feature[] | null;
}

const IDLE = { ...EMPTY_OUTPUT, fresh: false, sourceFeatures: null, completedAt: null };

/**
 * Slice the current feature tree, off the main thread.
 *
 * Only runs while `enabled`, so nobody pays for slicing while modelling. Each job
 * is tagged with a generation, and anything that comes back stale is dropped:
 * the shared queue keeps only the newest waiting job. An obsolete active job
 * may finish, but cannot become current or reach export.
 */
export function useSlices(enabled: boolean): SliceResult {
  const features = useKerros((s) => s.features);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const materialName = useKerros((s) => s.material.name);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  // The whole stack, not just the bottom gap: per-layer windows key on which
  // sheet a height falls in, so the field needs the plan and not a spacing.
  const spacerHeightTop = useKerros((s) => s.stack.spacerHeightTop);
  const spacerThickness = useKerros((s) => s.stack.spacerThickness);
  const spacerHeightMid = useKerros((s) => s.stack.spacerHeightMid);
  const twistPerLayer = useKerros((s) => s.stack.twistPerLayer);
  const twistOverrides = useKerros((s) => s.stack.twistOverrides);
  const resolution = useKerros((s) => s.sliceRes);
  const tolerance = useKerros((s) => s.sliceTolerance);
  const smoothing = useKerros((s) => s.sliceSmoothing);
  const minFeature = useKerros((s) => s.minFeature);
  const seed = useKerros((s) => s.seed);
  const importRevision = useKerros((s) => s.importRevision);
  const projectRevision = useKerros((s) => s.projectRevision);

  const job = useMemo<SliceJob>(() => ({
    features, thickness, kerf, materialName, spacerHeight, spacerHeightTop, spacerThickness,
    spacerHeightMid, twistPerLayer, twistOverrides, resolution, tolerance,
    smoothing, minFeature, seed,
  }), [features, thickness, kerf, materialName, spacerHeight, spacerHeightTop, spacerThickness,
    spacerHeightMid, twistPerLayer, twistOverrides, resolution, tolerance,
    smoothing, minFeature, seed]);
  const [attempt, setAttempt] = useState(0);
  const recalculate = useCallback(() => setAttempt(value => value + 1), []);
  const [failed, setFailed] = useState<{
    message: string; job: SliceJob; importRevision: number; projectRevision: number; attempt: number;
  } | null>(null);
  const [done, setDone] = useState<{
    output: SliceOutput; job: SliceJob; importRevision: number; projectRevision: number; attempt: number; completedAt: number;
  } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    if (!enabled) return;
    setFailed(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void requestSlice(job, importRevision, controller.signal).then((output) => {
        if (!output || mine !== generation.current) return;
        setDone({ output, job, importRevision, projectRevision, attempt, completedAt: Date.now() });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || mine !== generation.current) return;
        setFailed({ message: (error instanceof Error ? error.message : String(error)).trim() || 'The slice calculation failed.', job, importRevision, projectRevision, attempt });
      });
    }, SLICE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      // Invalidate immediately, including the next job's debounce interval.
      generation.current++;
    };
  }, [enabled, job, importRevision, projectRevision, attempt]);

  // Retain this project's last slice for Model-mode fixture ghosts. Ownership
  // and freshness are checked during render, before effects can dispatch work.
  const error = failed?.job === job && failed.importRevision === importRevision && failed.projectRevision === projectRevision && failed.attempt === attempt ? failed.message : null;
  if (!done || done.projectRevision !== projectRevision) return { ...IDLE, pending: enabled && !error, error, recalculate };
  const fresh = done.job === job && done.importRevision === importRevision && done.attempt === attempt && !error;
  const sameSettings = (Object.keys(job) as (keyof SliceJob)[]).every((key) => key === 'features' || done.job[key] === job[key]);
  return { ...done.output, fresh, pending: enabled && !fresh && !error, error, recalculate, completedAt: fresh ? done.completedAt : null,
    sourceFeatures: !error && sameSettings && done.importRevision === importRevision ? done.job.features : null };
}
