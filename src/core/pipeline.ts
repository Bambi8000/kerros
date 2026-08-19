/**
 * The slicing pipeline as one pure function.
 *
 * Everything from a feature tree to sliced, drilled, perforated layers, with no
 * React, no store subscription and no closures crossing a boundary. That is what
 * makes it runnable in a Web Worker — and, just as usefully, what makes it
 * runnable in Node, so the whole pipeline can be validated end to end rather than
 * one module at a time.
 *
 * The field itself cannot be sent to a worker: `composeField` returns a chain of
 * closures. So the worker is not given a field, it is given the **tree** and
 * builds the field itself. A tree is plain JSON; a closure is not.
 *
 * The one thing that is not plain JSON is an imported mesh's grid, which is
 * megabytes of Float32. Those are sent once after baking and cached on both
 * sides, keyed by feature id — never re-sent with each job.
 */

import type { Feature } from './types.ts';
import {
  ROD_CLEARANCE,
  applyRods,
} from './rig.ts';
import type { RodSpec } from './rig.ts';
import { PLANE_WORLD, fixtureHolesAt, resolveFixture } from './fixture.ts';
import type { FixtureKind, FixtureSpec, PlaneFrame } from './fixture.ts';
import {
  WINDOW_WORLD,
  resolveWindow,
  stockField,
  windowField,
} from './window.ts';
import type { LayerPlan, WindowFrame, WindowSpec } from './window.ts';
import {
  evaluateGridSampled,
  evaluatePoint,
  modelBounds,
  prepareFeatures,
} from './sdf.ts';
import { surfaceNets } from './surfaceNets.ts';
import { sampleMeshGrid } from './voxelise.ts';
import type { MeshGrid } from './voxelise.ts';
import { generatePattern } from './pattern.ts';
import {
  circleFitsInPart,
  groupContours,
  minFeatureGap,
  polygonFitsInPart,
  signedArea,
  sliceModel,
} from './slice.ts';
import type { GapReport, SliceSet } from './slice.ts';

/**
 * Every import here names its file with a `.ts` extension.
 *
 * That is what lets Node load this module, and therefore validate the whole
 * slicing path in one call rather than one algorithm at a time. Everything it
 * pulls in has no imports of its own, so the graph terminates immediately.
 * `store.ts` is deliberately not among them: it imports zustand, and Node cannot
 * resolve that.
 */

/** An imported mesh's grid, as it travels between threads. */
export interface ImportPayload {
  id: string;
  data: Float32Array;
  dims: [number, number, number];
  min: [number, number, number];
  step: number;
  reach: number;
}

export interface SliceJob {
  features: Feature[];
  thickness: number;
  kerf: number;
  spacerHeight: number;
  resolution: number;
  tolerance: number;
  smoothing: number;
  minFeature: number;
  seed: number;
}

export interface SliceOutput {
  set: SliceSet | null;
  windows: { label: string; set: SliceSet }[];
  reports: GapReport[];
  patternCounts: Record<string, number>;
  fixtureMisses: Record<string, number>;
  ms: number;
}

export const EMPTY_OUTPUT: SliceOutput = {
  set: null,
  windows: [],
  reports: [],
  patternCounts: {},
  fixtureMisses: {},
  ms: 0,
};

/** Turn a payload back into something the field can sample. */
export function volumeFromPayload(payload: ImportPayload) {
  const grid: MeshGrid = {
    data: payload.data,
    dims: payload.dims,
    min: payload.min,
    step: payload.step,
    reach: payload.reach,
  };
  const max: [number, number, number] = [
    grid.min[0] + (grid.dims[0] - 1) * grid.step,
    grid.min[1] + (grid.dims[1] - 1) * grid.step,
    grid.min[2] + (grid.dims[2] - 1) * grid.step,
  ];
  return {
    sample: (x: number, y: number, z: number) => sampleMeshGrid(grid, x, y, z),
    min: grid.min,
    max,
  };
}

export interface MeshVolume {
  sample: (x: number, y: number, z: number) => number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface PreviewJob {
  features: Feature[];
  resolution: number;
  kerf: number;
  seed: number;
  thickness: number;
  spacerHeight: number;
}

export interface PreviewOutput {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
  /** Grid the surface came from, for the readout. */
  dims: [number, number, number];
  step: number;
  ms: number;
}

export const EMPTY_PREVIEW: PreviewOutput = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
  dims: [0, 0, 0],
  step: 0,
  ms: 0,
};

/**
 * Build the preview surface.
 *
 * The same field the slicer reads, sampled coarsely and meshed. Kept here beside
 * the slice job for one reason: both have to be runnable off the main thread, and
 * both need the field, which cannot be sent anywhere.
 */
export function runPreviewJob(job: PreviewJob, volumes: Map<string, MeshVolume>): PreviewOutput {
  const field = composeField(
    job.features,
    job.kerf,
    job.seed,
    job.thickness,
    job.thickness + job.spacerHeight,
    volumes,
  );
  if (!field.bounds) return EMPTY_PREVIEW;

  const started = Date.now();
  const grid = evaluateGridSampled(field.sample, field.bounds, job.resolution);
  const mesh = surfaceNets(grid);

  return {
    positions: mesh.positions,
    indices: mesh.indices,
    triangles: mesh.triangleCount,
    dims: grid.dims,
    step: grid.step,
    ms: Date.now() - started,
  };
}

/**
 * Slice a job.
 *
 * The order is not arbitrary and each step depends on the one before it:
 *
 *   1. the field, with windows subtracted
 *   2. layers, at the kerf-compensated iso-level
 *   3. rods, so their clearance holes exist
 *   4. fixtures, which must find room among what is already there
 *   5. perforation, which keeps its bridge clear of all of it
 *   6. window plugs, cut from the form *before* any window was taken out
 *   7. the thin-feature check, on the finished result
 */
export function runSliceJob(job: SliceJob, volumes: Map<string, MeshVolume>): SliceOutput {
  const { features, thickness, kerf, spacerHeight, resolution, tolerance, smoothing } = job;

  const field = composeField(
    features,
    kerf,
    job.seed,
    thickness,
    thickness + spacerHeight,
    volumes,
  );
  const bounds = field.bounds;
  if (!bounds) return EMPTY_OUTPUT;

  const started = Date.now();
  const layerOptions = { thickness, spacerHeight, resolution, tolerance, smoothing };

  const sliced = sliceModel(field.sample, bounds, { ...layerOptions, kerf });

  // Window plugs come off the form as it was before any window was taken out of
  // it, on the same layer planes, so a plug and its hole are the same curve
  // offset only by the fit clearance. Their own kerf, being another material.
  const windows = field.windows.map((spec) => ({
    label: spec.label,
    set: sliceModel(windowField(field.solid, spec, field.plan, field.thickness), bounds, {
      ...layerOptions,
      kerf: spec.kerf,
    }),
  }));

  const drilled = applyRods(sliced.slices, rodsFromFeatures(features), kerf);

  /* --- fixtures --- */

  const fixtures = fixturesFromFeatures(features, kerf);
  const fixtureMisses: Record<string, number> = {};
  for (const spec of fixtures) fixtureMisses[spec.id] = 0;

  const fitted =
    fixtures.length === 0
      ? drilled
      : drilled.map((slice) => {
          const circles = slice.circles.slice();
          const contours = slice.contours.slice();

          for (const spec of fixtures) {
            const holes = fixtureHolesAt(spec, slice.z);
            if (holes.circles.length === 0 && holes.polygons.length === 0) continue;

            const groups = groupContours(contours);

            for (const circle of holes.circles) {
              if (groups.some((g) => circleFitsInPart(g, circle))) circles.push(circle);
              else fixtureMisses[spec.id] += 1;
            }

            for (const polygon of holes.polygons) {
              if (groups.some((g) => polygonFitsInPart(g, polygon))) {
                const area = signedArea(polygon);
                contours.push({ points: polygon, area, isHole: area < 0 });
              } else {
                fixtureMisses[spec.id] += 1;
              }
            }
          }

          return { ...slice, circles, contours };
        });

  /* --- perforation --- */

  const patterns = features.filter((f) => f.stage === 'PATTERN' && f.enabled);
  const patternCounts: Record<string, number> = {};
  for (const feature of patterns) patternCounts[feature.id] = 0;

  const perforated =
    patterns.length === 0
      ? fitted
      : fitted.map((slice) => {
          const circles = slice.circles.slice();
          for (const feature of patterns) {
            const holes = generatePattern(
              {
                z: slice.z,
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
              patternOptionsOf(feature, kerf, job.seed),
            );
            patternCounts[feature.id] += holes.length;
            circles.push(...holes);
          }
          return { ...slice, circles };
        });

  const set: SliceSet = { ...sliced, slices: perforated };

  // Whichever is larger: what the maker asked for, or two kerfs, below which the
  // material burns through however good the geometry is.
  const threshold = Math.max(job.minFeature, kerf * 2);
  const reports = set.slices.map((slice) => minFeatureGap(slice, threshold));

  return {
    set,
    windows,
    reports,
    patternCounts,
    fixtureMisses,
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * Feature tree to field
 *
 * Moved here from the store so that the slicing path has no dependency on
 * zustand and can be run — and checked — outside a browser.
 * ------------------------------------------------------------------ */

/**
 * Features that take part in the distance field.
 *
 * SHAPE contributes solids, CARVE modifies the result. RIG does neither: rods
 * are drilled after slicing and never touch the field.
 */
export function isFieldFeature(feature: Feature): boolean {
  return feature.stage === 'SHAPE' || feature.stage === 'CARVE';
}

/**
 * A rod's span, from centre and length.
 *
 * Rods used to be stored as two ends. Both forms are read here so a tree built
 * before the change still resolves, but centre-and-length is the one written.
 */
export function rodSpanOf(params: Feature['params']): [number, number] {
  const length = Number(params.length) || 0;
  if (length > 0) {
    const centre = Number(params.pz) || 0;
    return [centre - length / 2, centre + length / 2];
  }
  const start = Number(params.zStart) || 0;
  const end = Number(params.zEnd) || 0;
  return start <= end ? [start, end] : [end, start];
}

/** Turn the RIG features of a tree into rod specs the rig module understands. */
export function rodsFromFeatures(features: Feature[]): RodSpec[] {
  const rods: RodSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'rod' || !f.enabled) continue;
    const size = typeof f.params.size === 'string' ? f.params.size : 'M5';
    const [zStart, zEnd] = rodSpanOf(f.params);
    rods.push({
      id: f.id,
      label: f.name,
      size: ROD_CLEARANCE[size] ? size : 'M5',
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      zStart,
      zEnd,
      diameter: Number(f.params.diameter) || 0,
    });
  }
  return rods;
}

/**
 * The frame a window follows: translation and Z rotation only.
 *
 * A window is a vertical wedge and its layers come from world Z, so inheriting
 * a parent's X or Y rotation would tip it out of the stack. See `WindowFrame`.
 */
export function windowFrameFor(features: Feature[], window: Feature): WindowFrame {
  const target = typeof window.params.attachTo === 'string' ? window.params.attachTo : '';
  if (target === '') return WINDOW_WORLD;
  const parent = features.find((f) => f.id === target);
  if (!parent) return WINDOW_WORLD;
  return {
    x: Number(parent.params.px) || 0,
    y: Number(parent.params.py) || 0,
    z: Number(parent.params.pz) || 0,
    rz: Number(parent.params.rz) || 0,
  };
}

/** Window features of a tree, as the window module wants them. */
export function windowsFromFeatures(
  features: Feature[],
  fallbackKerf: number,
  seed: number,
): WindowSpec[] {
  const out: WindowSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'window' || !f.enabled) continue;
    const mode = f.params.mode === 'band' ? 'band' : 'perLayer';
    out.push({
      id: f.id,
      label: f.name,
      mode,
      chance: Math.min(Math.max(Number(f.params.chance) ?? 0.3, 0), 1),
      minCount: Math.max(Math.round(Number(f.params.minCount) || 1), 1),
      maxCount: Math.max(Math.round(Number(f.params.maxCount) || 1), 1),
      minWidth: Math.max(Number(f.params.minWidth) || 0, 0),
      maxWidth: Math.max(Number(f.params.maxWidth) || 0, 0),
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      seed,
      count: Math.max(Math.round(Number(f.params.count) || 1), 1),
      width: Number(f.params.width) || 0,
      angle: Number(f.params.angle) || 0,
      twist: Number(f.params.twist) || 0,
      z: Number(f.params.pz) || 0,
      length: Math.max(Number(f.params.length) || 0, 0),
      fit: Math.max(Number(f.params.fit) || 0, 0),
      kerf: Math.max(Number(f.params.windowKerf) ?? fallbackKerf, 0),
    });
  }
  // Placements are stored in the parent's frame; resolve them into world terms
  // here so the sector and the layer planes are measured in the same space.
  return out.map((spec) => {
    const feature = features.find((f) => f.id === spec.id);
    return feature ? resolveWindow(spec, windowFrameFor(features, feature)) : spec;
  });
}

/** Fixture specs of a tree, as the fixture module wants them. */
export function fixturesFromFeatures(features: Feature[], kerf: number): FixtureSpec[] {
  const out: FixtureSpec[] = [];
  for (const f of features) {
    if (!f.kind.startsWith('fixture:') || !f.enabled) continue;
    const kind = f.kind.slice('fixture:'.length) as FixtureKind;
    out.push({
      id: f.id,
      label: f.name,
      kind,
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      z: Number(f.params.pz) || 0,
      length: Math.max(Number(f.params.length) || 0, 0),
      rot: Number(f.params.rot) || 0,
      kerf,
      preset: typeof f.params.preset === 'string' ? f.params.preset : 'custom',
      diameter: Number(f.params.diameter) || 0,
      screws: Math.max(Math.round(Number(f.params.screws) || 0), 0),
      boltCircle: Number(f.params.boltCircle) || 0,
      screwDiameter: Number(f.params.screwDiameter) || 0,
      shape: typeof f.params.shape === 'string' ? f.params.shape : 'round',
      slotLength: Number(f.params.slotLength) || 0,
      width: Number(f.params.width) || 0,
      depth: Number(f.params.depth) || 0,
      corner: Number(f.params.corner) || 0,
    });
  }

  // Stored in the parent's frame when attached, so resolve to world here — the
  // band test and the hole positions all work in world coordinates.
  return out.map((spec) => {
    const feature = features.find((f) => f.id === spec.id);
    return feature ? resolveFixture(spec, attachFrameFor(features, feature)) : spec;
  });
}

/**
 * The frame a layer-bound feature follows: translation and Z rotation.
 *
 * Windows and fixtures share it. Both live in horizontal sheets, so both can
 * inherit a parent moving or turning about the stack, and neither can inherit it
 * tipping over.
 */
export function attachFrameFor(features: Feature[], feature: Feature): PlaneFrame {
  const target = typeof feature.params.attachTo === 'string' ? feature.params.attachTo : '';
  if (target === '') return PLANE_WORLD;
  const parent = features.find((f) => f.id === target);
  if (!parent) return PLANE_WORLD;
  return {
    x: Number(parent.params.px) || 0,
    y: Number(parent.params.py) || 0,
    z: Number(parent.params.pz) || 0,
    rz: Number(parent.params.rz) || 0,
  };
}

/** Pattern settings of a feature, in the shape the generator wants. */
export function patternOptionsOf(
  feature: Feature,
  kerf: number,
  seed: number,
): {
  kind: 'grid' | 'hex' | 'scatter' | 'radial';
  radius: number;
  pitch: number;
  minBridge: number;
  density: number;
  kerf: number;
  seed: number;
  rotatePerLayer: boolean;
  band: number;
} {
  const kind = typeof feature.params.patternKind === 'string' ? feature.params.patternKind : 'hex';
  return {
    kind: (['grid', 'hex', 'scatter', 'radial'].includes(kind) ? kind : 'hex') as
      | 'grid'
      | 'hex'
      | 'scatter'
      | 'radial',
    band: Math.max(Number(feature.params.band) || 0, 0),
    radius: Number(feature.params.radius) || 2,
    pitch: Number(feature.params.pitch) || 8,
    minBridge: Number(feature.params.minBridge) || 1.5,
    density: Number(feature.params.density) || 0,
    kerf,
    seed,
    rotatePerLayer: Number(feature.params.rotatePerLayer) > 0,
  };
}

/**
 * The field the rest of the program slices.
 *
 * Windows are applied here rather than inside the SDF core, which has no
 * imports and must not gain one. `solid` is the form before any window is taken
 * out of it — the plug of each window is cut from that, so it has to stay
 * available separately.
 */
export function composeField(
  features: Feature[],
  kerf: number,
  seed: number,
  thickness: number,
  pitch: number,
  /**
   * Where to find baked import grids.
   *
   * Passed in rather than reached for: the main thread has the store's cache and
   * a worker has its own, and this module must not know which it is talking to.
   */
  volumes: Map<string, MeshVolume>,
) {
  // Imports carry their baked volume through to the evaluator here, since the
  // grids live outside the store.
  const fieldFeatures = features.filter(isFieldFeature).map((f) =>
    f.kind === 'import' ? { ...f, volume: volumes.get(f.id) } : f,
  );
  const prepared = prepareFeatures(fieldFeatures);
  const windows = windowsFromFeatures(features, kerf, seed);
  const bounds = modelBounds(fieldFeatures);

  // Per-layer windows have to land on the same planes the slicer will take, so
  // the layer plan is built from the same numbers: the bottom of the model and
  // the pitch.
  const plan: LayerPlan = { z0: bounds ? bounds.min[2] : 0, pitch: Math.max(pitch, 0.01) };

  const solid = (x: number, y: number, z: number) => evaluatePoint(prepared, x, y, z);

  return {
    solid,
    sample: stockField(solid, windows, plan, thickness),
    windows,
    plan,
    thickness,
    bounds,
  };
}

