import { useEffect, useRef, useState } from 'react';
import { useKerros } from '../core/store';
import { EMPTY_PREVIEW } from '../core/pipeline';
import type { PreviewJob, PreviewOutput } from '../core/pipeline';
import { requestPreview } from './workerBridge';

/**
 * Shorter than the slice debounce. A preview is the thing being looked at while
 * a value is dragged, so it should keep up; slicing can wait for the hand to
 * stop.
 */
const PREVIEW_DEBOUNCE_MS = 90;

export interface PreviewResult extends PreviewOutput {
  pending: boolean;
}

const IDLE: PreviewResult = { ...EMPTY_PREVIEW, pending: false };
// Viewport draws when this object's identity changes, then sets its stats.
// A fresh empty object per render would loop while a new project is pending.
const PENDING_IDLE: PreviewResult = { ...IDLE, pending: true };

/**
 * Build the preview surface off the main thread.
 *
 * This was the last heavy thing left on the main thread: a quarter of a second of
 * field sampling and meshing, on every edit, in the mode where editing happens.
 * Moving it means dragging a blend radius no longer stutters — the old surface
 * stays on screen until the new one is ready, which is also less distracting than
 * a gap.
 */
export function usePreview(enabled: boolean): PreviewResult {
  const features = useKerros((s) => s.features);
  const resolution = useKerros((s) => s.previewRes);
  const kerf = useKerros((s) => s.material.kerf);
  const thickness = useKerros((s) => s.material.thickness);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  // The whole stack, not just the bottom gap: per-layer windows key on which
  // sheet a height falls in, so the field needs the plan and not a spacing.
  const spacerHeightTop = useKerros((s) => s.stack.spacerHeightTop);
  const spacerThickness = useKerros((s) => s.stack.spacerThickness);
  const seed = useKerros((s) => s.seed);
  const importRevision = useKerros((s) => s.importRevision);
  const projectRevision = useKerros((s) => s.projectRevision);

  const [result, setResult] = useState<PreviewResult & { projectRevision: number }>({
    ...IDLE, projectRevision,
  });
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    if (!enabled) {
      setResult({ ...IDLE, projectRevision });
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));
    const controller = new AbortController();

    const timer = window.setTimeout(() => {
      const job: PreviewJob = {
        features,
        resolution,
        kerf,
        seed,
        thickness,
        spacerHeight,
        spacerHeightTop,
        spacerThickness,
      };

      void requestPreview(job, importRevision, controller.signal).then((output) => {
        if (!output || mine !== generation.current) return;
        setResult({ ...output, pending: false, projectRevision });
      });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [
    enabled,
    features,
    resolution,
    kerf,
    thickness,
    spacerHeight,
    spacerHeightTop,
    spacerThickness,
    seed,
    importRevision,
    projectRevision,
  ]);

  return result.projectRevision === projectRevision ? result : enabled ? PENDING_IDLE : IDLE;
}
