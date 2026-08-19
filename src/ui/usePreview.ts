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
  const seed = useKerros((s) => s.seed);
  const importRevision = useKerros((s) => s.importRevision);

  const [result, setResult] = useState<PreviewResult>(IDLE);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(IDLE);
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));

    const timer = window.setTimeout(() => {
      const mine = ++generation.current;
      const job: PreviewJob = {
        features,
        resolution,
        kerf,
        seed,
        thickness,
        spacerHeight,
      };

      void requestPreview(job, importRevision).then((output) => {
        if (mine !== generation.current) return;
        setResult({ ...output, pending: false });
      });
    }, PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [enabled, features, resolution, kerf, thickness, spacerHeight, seed, importRevision]);

  return result;
}
