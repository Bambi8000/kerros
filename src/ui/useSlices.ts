import { useEffect, useState } from 'react';
import { rodsFromFeatures, useKerros } from '../core/store';
import { evaluatePoint, modelBounds, prepareFeatures } from '../core/sdf';
import { minFeatureGap, sliceModel } from '../core/slice';
import type { GapReport, SliceSet } from '../core/slice';
import { applyRods } from '../core/rig';

/** Editing settles before a re-slice, which is far heavier than a preview. */
const SLICE_DEBOUNCE_MS = 250;

export interface SliceResult {
  set: SliceSet | null;
  /** One report per slice, aligned by index. */
  reports: GapReport[];
  ms: number;
  pending: boolean;
}

const IDLE: SliceResult = { set: null, reports: [], ms: 0, pending: false };

/**
 * Slice the current feature tree, drill the rods, and check the result.
 *
 * Only runs while `enabled`, so nobody pays for slicing while modelling.
 * Synchronous for now: a full lamp is a couple of hundred milliseconds, which
 * the debounce hides. It moves to a Web Worker when nesting joins it in M4 and
 * the combined cost stops fitting in a frame gap.
 */
export function useSlices(enabled: boolean): SliceResult {
  const features = useKerros((s) => s.features);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  const resolution = useKerros((s) => s.sliceRes);
  const tolerance = useKerros((s) => s.sliceTolerance);
  const smoothing = useKerros((s) => s.sliceSmoothing);
  const minFeature = useKerros((s) => s.minFeature);

  const [result, setResult] = useState<SliceResult>(IDLE);

  useEffect(() => {
    if (!enabled) {
      setResult(IDLE);
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));

    const timer = window.setTimeout(() => {
      const shapes = features.filter((f) => f.stage === 'SHAPE');
      const bounds = modelBounds(shapes);

      if (!bounds) {
        setResult(IDLE);
        return;
      }

      const prepared = prepareFeatures(shapes);
      const started = performance.now();

      const sliced = sliceModel(
        (x, y, z) => evaluatePoint(prepared, x, y, z),
        bounds,
        { thickness, spacerHeight, resolution, tolerance, smoothing, kerf },
      );

      // Rods drill after slicing: they take no part in the field, they only
      // add holes to the layers their span reaches.
      const drilled = applyRods(sliced.slices, rodsFromFeatures(features), kerf);
      const set: SliceSet = { ...sliced, slices: drilled };

      // The check threshold is whichever is larger: what the maker asked for,
      // or two kerfs, below which the material burns through regardless.
      const threshold = Math.max(minFeature, kerf * 2);
      const reports = set.slices.map((slice) => minFeatureGap(slice, threshold));

      setResult({ set, reports, ms: performance.now() - started, pending: false });
    }, SLICE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    enabled,
    features,
    thickness,
    kerf,
    spacerHeight,
    resolution,
    tolerance,
    smoothing,
    minFeature,
  ]);

  return result;
}
