import { useEffect, useState } from 'react';
import { composeField, patternOptionsOf, rodsFromFeatures, useKerros } from '../core/store';
import { windowField } from '../core/window';
import { minFeatureGap, sliceModel } from '../core/slice';
import type { GapReport, SliceSet } from '../core/slice';
import { applyRods } from '../core/rig';
import { generatePattern } from '../core/pattern';

/** Editing settles before a re-slice, which is far heavier than a preview. */
const SLICE_DEBOUNCE_MS = 250;

export interface SliceResult {
  set: SliceSet | null;
  /** One sliced set of plugs per window feature. */
  windows: { label: string; set: SliceSet }[];
  /** Holes each pattern feature actually placed, keyed by feature id. */
  patternCounts: Record<string, number>;
  /** One report per slice, aligned by index. */
  reports: GapReport[];
  ms: number;
  pending: boolean;
}

const IDLE: SliceResult = {
  set: null,
  windows: [],
  patternCounts: {},
  reports: [],
  ms: 0,
  pending: false,
};

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
  const seed = useKerros((s) => s.seed);

  const [result, setResult] = useState<SliceResult>(IDLE);

  useEffect(() => {
    if (!enabled) {
      setResult(IDLE);
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));

    const timer = window.setTimeout(() => {
      const field = composeField(features, kerf);
      const bounds = field.bounds;

      if (!bounds) {
        setResult(IDLE);
        return;
      }

      const started = performance.now();
      const layerOptions = { thickness, spacerHeight, resolution, tolerance, smoothing };

      const sliced = sliceModel(field.sample, bounds, { ...layerOptions, kerf });

      // Each window's plugs are cut from the form BEFORE any window was taken
      // out of it, on the same layer planes, so a plug and its hole are the
      // same curve offset only by the fit clearance. Their own kerf, because
      // they are cut from their own material.
      const windows = field.windows.map((spec) => ({
        label: spec.label,
        set: sliceModel(windowField(field.solid, spec), bounds, {
          ...layerOptions,
          kerf: spec.kerf,
        }),
      }));

      // Rods drill after slicing: they take no part in the field, they only
      // add holes to the layers their span reaches.
      const drilled = applyRods(sliced.slices, rodsFromFeatures(features), kerf);

      // Patterns perforate after the rods, so a pattern hole never crowds a
      // rod hole. Each pattern sees the ones before it for the same reason.
      const patterns = features.filter((f) => f.stage === 'PATTERN' && f.enabled);
      // Counted as they are placed: a pattern that fits nowhere must say so
      // rather than leave the maker looking for holes that were never made.
      const patternCounts: Record<string, number> = {};
      for (const feature of patterns) patternCounts[feature.id] = 0;

      const perforated =
        patterns.length === 0
          ? drilled
          : drilled.map((slice) => {
              const circles = slice.circles.slice();
              for (const feature of patterns) {
                const holes = generatePattern(
                  {
                    z: slice.z,
                    // Clearance is measured against the slice's own rings, in
                    // plane. The field only supplies the inside/outside sign.
                    contours: slice.contours.map((c) => ({ points: c.points })),
                    bounds: {
                      minX: bounds.min[0],
                      minY: bounds.min[1],
                      maxX: bounds.max[0],
                      maxY: bounds.max[1],
                    },
                    existing: circles,
                    sample: field.sample,
                    layer: slice.index,
                  },
                  patternOptionsOf(feature, kerf, seed),
                );
                patternCounts[feature.id] += holes.length;
                circles.push(...holes);
              }
              return { ...slice, circles };
            });

      const set: SliceSet = { ...sliced, slices: perforated };

      // The check threshold is whichever is larger: what the maker asked for,
      // or two kerfs, below which the material burns through regardless.
      const threshold = Math.max(minFeature, kerf * 2);
      const reports = set.slices.map((slice) => minFeatureGap(slice, threshold));

      setResult({
        set,
        windows,
        patternCounts,
        reports,
        ms: performance.now() - started,
        pending: false,
      });
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
    seed,
  ]);

  return result;
}
