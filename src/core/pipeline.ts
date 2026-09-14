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

import type { Feature, ProfileKey } from './types.ts';
import {
  rodFromFeature, rodPose, rodDiameter, rodIsVertical,
  applyRods,
  loosePins,
  pinGaps,
} from './rig.ts';
import type { CircleHole, PinSpec, RodSpec } from './rig.ts';
import { PLANE_WORLD, fixtureHolesAt, resolveFixture } from './fixture.ts';
import type { FixtureKind, FixtureSpec, PlaneFrame } from './fixture.ts';
import {
  layerIndexAt,
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
import { resolveLayerSet, resolveLayers, selectorFromParams } from './layers.ts';
import { legSections, sectionsDistance } from './legs.ts';
import { bossField } from './boss.ts';
import { extrudeMorph, extrudeProfile, indexProfile, indexedDistance, profileBounds } from './profile2d.ts';
import { activeAssembly, buildAssembly, channelAngles, prismOpening } from './assembly.ts';
import type { MorphEasing, MorphEntry } from './profile2d.ts';
import { parseTwistOverrides, twistAt, untwistPoint } from './twist.ts';
import { paintDistance, strokesBounds, strokesByPlane } from './paint.ts';
import type { PaintStroke } from './paint.ts';
import type { FillRule } from './profile2d.ts';
import type { BossSpec } from './boss.ts';
import type { LegSection, LegSpec } from './legs.ts';
import type { LayerSelector } from './layers.ts';
import { nestByMaterial } from './nest.ts';
import type {
  BBox,
  NestOptions,
  NestResult,
  PartGeometry,
  PlacedPart,
  Sheet,
} from './nest.ts';
import {
  circleFitsInPart,
  groupContours,
  minFeatureGap,
  planLayers,
  polygonFitsInPart,
  signedArea,
  sliceModel,
  traceSheet,
} from './slice.ts';
import type { GapReport, Slice, SliceSet } from './slice.ts';
import { buildVerticalSupports } from './verticalSupports.ts';

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
  materialName?: string;
  spacerHeight: number;
  /** Gap at the top of the stack, mm. Omitted means uniform. */
  spacerHeightTop?: number;
  /** Gap in the middle of the stack, mm. Omitted is a straight run. */
  spacerHeightMid?: number;
  /** Thickness of one spacer ring, mm. Omitted means the stock's. */
  spacerThickness?: number;
  /** Degrees each sheet is turned from the one below at assembly. */
  twistPerLayer?: number;
  /** Layers turned by hand, as `layer:degrees` pairs. */
  twistOverrides?: string;
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
  holeMisses: Record<string, number>;
  punchResults: Record<string, PunchResult>;
  /**
   * Layers a legs feature was aimed at that produced no sheet, by feature.
   *
   * The field cuts legs before the sheets exist, so it counts planes rather
   * than sheets — the two differ only where a model has a void along Z, and
   * when they do the difference has to be said rather than discovered.
   */
  legGaps: Record<string, number>;
  /**
   * Sheets a pins feature left held on one side only, by feature.
   *
   * A pattern of holes is not a structure. If a gap's pins do not fit, the two
   * sheets either side of it are not fastened together, and a stack that comes
   * apart in the middle is worse than one that was never pinned.
   */
  pinLoose: Record<string, number[]>;
  ms: number;
}

export const EMPTY_OUTPUT: SliceOutput = {
  set: null,
  windows: [],
  reports: [],
  patternCounts: {},
  holeMisses: {},
  punchResults: {},
  legGaps: {},
  pinLoose: {},
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
  spacerHeightTop?: number;
  spacerThickness?: number;
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
    {
      spacerHeight: job.spacerHeight,
      spacerHeightTop: job.spacerHeightTop,
      spacerThickness: job.spacerThickness,
    },
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
  if (activeAssembly(job.features)) {
    const started = Date.now();
    const field = composeField(job.features.filter(isFieldFeature), job.kerf, job.seed, job.thickness, { spacerHeight: 0 }, volumes);
    const layout = activeAssembly(job.features)!;
    const centre = ['X', 'Y', 'Z'].map((axis) => Number(layout.params[`sourceCentre${axis}`] || 0));
    const half = [Number(layout.params.radius) || 80, Number(layout.params.radius) || 80, (Number(layout.params.height) || 160) / 2];
    // Independent plates survive removal of the source shape. Linked ribs
    // still sample the actual (now empty) source and report their missing cuts.
    const bounds = field.bounds ?? { min: centre.map((v, i) => v - half[i]) as [number, number, number], max: centre.map((v, i) => v + half[i]) as [number, number, number] };
    // Rods stay in world coordinates. Convert only the worker input to the
    // shared finite-cylinder route representation, never the saved feature.
    const angle = Number(layout.params.angle || 0), a = -angle * Math.PI / 180;
    const origin = bounds.min.map((v, i) => (v + bounds.max[i]) / 2 + Number(layout.params[['px', 'py', 'pz'][i]] || 0));
    const assemblyFeatures = job.features.map((f): Feature => {
      if (f.kind !== 'rod') return f;
      const rod = rodFromFeature(f), pose = rodPose(rod), d = pose.centre.map((v, i) => v - origin[i]);
      return { ...f, kind: 'assembly:channel', params: { groupId: layout.id, rod: true, shape: 'tube',
        px: d[0] * Math.cos(a) - d[1] * Math.sin(a), py: d[0] * Math.sin(a) + d[1] * Math.cos(a), pz: d[2],
        ...channelAngles(pose.u, pose.v, angle), length: pose.length, diameter: rodDiameter(rod), clearance: 0,
        through: false, ribTarget: true, supportTarget: true, backplateTarget: true, plateTarget: true } };
    });
    const set = buildAssembly(assemblyFeatures, field.solid, bounds, job, {
      trace: traceSheet,
      distance: (contours, reach) => {
        const index = indexProfile({ rings: contours.map((c) => c.points), fill: 'holes' }, 1, 0.02, Math.min(reach, Math.max(8, job.minFeature * 3, job.kerf * 2)));
        return (x, y) => indexedDistance(index, x, y);
      },
      thin: (slice, threshold) => minFeatureGap(slice, threshold).tooThin,
    });
    return { ...EMPTY_OUTPUT, set, ms: Date.now() - started };
  }
  const {
    features,
    thickness,
    kerf,
    spacerHeight,
    spacerHeightTop,
    spacerHeightMid,
    spacerThickness,
    twistPerLayer,
    twistOverrides,
    resolution,
    tolerance,
    smoothing,
  } = job;

  const field = composeField(
    features,
    kerf,
    job.seed,
    thickness,
    {
      spacerHeight,
      spacerHeightTop,
      spacerHeightMid,
      spacerThickness,
      twistPerLayer,
      twistOverrides,
    },
    volumes,
  );
  const bounds = field.bounds;
  if (!bounds) return EMPTY_OUTPUT;

  const started = Date.now();
  /*
   * Everything the layer plan is built from, in one place.
   *
   * Listed by name rather than spread, which is what let the middle gap reach
   * the field and not the slicer: `composeField` takes the whole stack object,
   * so it saw the new number the day it existed, while this list had to be
   * edited by hand and was not. The stack came out uniform while the panel
   * described a gradient.
   */
  const layerOptions = {
    thickness,
    spacerHeight,
    spacerHeightMid,
    spacerHeightTop,
    spacerThickness,
    resolution,
    tolerance,
    smoothing,
  };

  const rawSlices = sliceModel(field.sample, bounds, { ...layerOptions, kerf });
  const supportTwist = { perLayer: Number(twistPerLayer) || 0, overrides: twistOverrides ?? '' };
  const supportTwistTable = parseTwistOverrides(supportTwist.overrides);
  const supportFeature = features.find(f => f.enabled && f.kind === 'verticalSupports');
  const supportLayerIndices = resolveLayers(selectorFromParams({ selKind: 'range',
    selFrom: supportFeature?.params.firstLayer ?? 1,
    selTo: Number(supportFeature?.params.lastLayer) || rawSlices.slices.length }), rawSlices.slices);
  const sliced = supportFeature
    ? buildVerticalSupports(rawSlices, sliceModel(field.sample, bounds, { ...layerOptions, kerf: 0 }), features,
      { ...job, layerIndices: supportLayerIndices }, slice => twistAt(supportTwist, slice.index, supportTwistTable), {
        trace: traceSheet,
        distance: (contours, reach) => {
          const index = indexProfile({ rings: contours.map(c => c.points), fill: 'holes' }, 1, 0.02, reach);
          return (x, y) => indexedDistance(index, x, y);
        },
        thin: (slice, threshold) => minFeatureGap(slice, threshold).tooThin,
      }) : rawSlices;

  // Window plugs come off the form as it was before any window was taken out of
  // it, on the same layer planes, so a plug and its hole are the same curve
  // offset only by the fit clearance. Their own kerf, being another material.
  const windows = field.windows.map((spec) => ({
    label: spec.label,
    set: sliceModel(windowField(field.solid, spec, field.plan), bounds, {
      ...layerOptions,
      kerf: spec.kerf,
    }),
  }));

  const drilled = applyRods(sliced.slices, rodsFromFeatures(features), kerf);

  /* --- fixtures --- */

  const fixtures = fixturesFromFeatures(features, kerf);
  /**
   * Holes that would not have fitted the sheet they landed on, by feature.
   *
   * Named for what it holds rather than for who first needed it: legs report
   * here too, and `fixtureMisses` would have been a lie the moment they did.
   */
  const holeMisses: Record<string, number> = {};
  for (const spec of fixtures) holeMisses[spec.id] = 0;

  /*
   * Which layers each fixture reaches, decided once rather than per slice.
   *
   * A band's z is the fixture's **resolved** z — after its attachment frame —
   * which is why this is built here and not in `fixture.ts`: that module has no
   * imports and no idea where a parent has moved to. Defaulting to a band of
   * the fixture's own length is exactly what `fixtureSpansZ` did, so a project
   * that has never heard of selectors lands on the same sheets.
   */
  const fixtureLayers = new Map<string, Set<number>>();
  for (const spec of fixtures) {
    const feature = features.find((f) => f.id === spec.id);
    const selector = selectorForFixture(feature?.params, spec.z, spec.length);
    fixtureLayers.set(spec.id, resolveLayerSet(selector, sliced.slices));
  }

  const fitted =
    fixtures.length === 0
      ? drilled
      : drilled.map((slice) => {
          const circles = slice.circles.slice();
          const contours = slice.contours.slice();

          for (const spec of fixtures) {
            if (!fixtureLayers.get(spec.id)?.has(slice.index)) continue;
            const holes = fixtureHolesAt(spec);
            if (holes.circles.length === 0 && holes.polygons.length === 0) continue;

            const groups = groupContours(contours);

            for (const circle of holes.circles) {
              // Stamped with the feature that made it, so the slice view can
              // point back at it. A hole cut per slice has exactly one author.
              if (groups.some((g) => circleFitsInPart(g, circle))) {
                circles.push({ ...circle, owner: spec.id });
              } else {
                holeMisses[spec.id] += 1;
              }
            }

            for (const polygon of holes.polygons) {
              if (groups.some((g) => polygonFitsInPart(g, polygon))) {
                const area = signedArea(polygon);
                contours.push({ points: polygon, area, isHole: area < 0, owner: spec.id });
              } else {
                holeMisses[spec.id] += 1;
              }
            }
          }

          return { ...slice, circles, contours };
        });

  /* --- interleaved pins --- */

  const pins = pinsFromFeatures(features, kerf);
  const pinLoose: Record<string, number[]> = {};
  const pinsByLayer = new Map<number, CircleHole[]>();

  for (const spec of pins) {
    holeMisses[spec.id] = holeMisses[spec.id] ?? 0;
    const feature = features.find((f) => f.id === spec.id);
    const chosen = resolveLayers(selectorFromParams(feature?.params), fitted);
    const gaps = pinGaps(spec, chosen);

    /*
     * Pins taken out by hand.
     *
     * Stored on the feature as a plain string of keys so the project file stays
     * readable, and read here rather than in `rig.ts`: the generator's job is to
     * say where pins go, not to remember which ones somebody did not want.
     *
     * A removed pin is not a miss. It never had to fit, so counting it as one
     * would put a warning next to a deliberate act. It does still count as
     * absent for the structural check, which is the point — empty a gap by hand
     * and the two sheets either side are genuinely unfastened, and saying so is
     * the whole reason that check exists.
     */
    const removed = new Set(
      String(feature?.params.removed ?? '')
        .split(' ')
        .filter(Boolean),
    );

    /*
     * A pin has to fit **both** sheets it passes through, not one.
     *
     * Half a pin is not a joint, so a hole that lands on material in the sheet
     * below and off the edge of the one above is refused in both — otherwise
     * the stack would carry a hole that fastens nothing and reads as if it did.
     */
    const placed: number[] = [];
    for (const gap of gaps) {
      const below = fitted.find((slice) => slice.index === gap.below);
      const above = fitted.find((slice) => slice.index === gap.above);
      if (!below || !above) {
        placed.push(0);
        continue;
      }
      const groupsBelow = groupContours(below.contours);
      const groupsAbove = groupContours(above.contours);

      let landed = 0;
      for (const hole of gap.holes) {
        if (hole.pinKey && removed.has(hole.pinKey)) continue;
        const fits =
          groupsBelow.some((g) => circleFitsInPart(g, hole)) &&
          groupsAbove.some((g) => circleFitsInPart(g, hole));
        if (!fits) {
          holeMisses[spec.id] += 1;
          continue;
        }
        landed += 1;
        // The same hole in both sheets, each stamped with the other one: which
        // of the pair you are looking at is what says whether the pin carries
        // on up from here or down.
        for (const [index, other] of [
          [gap.below, gap.above],
          [gap.above, gap.below],
        ]) {
          const list = pinsByLayer.get(index) ?? [];
          list.push({ ...hole, pinTo: other });
          pinsByLayer.set(index, list);
        }
      }
      placed.push(landed);
    }

    pinLoose[spec.id] = loosePins(gaps, placed);
  }

  const pinned =
    pinsByLayer.size === 0
      ? fitted
      : fitted.map((slice) => {
          const extra = pinsByLayer.get(slice.index);
          return extra ? { ...slice, circles: [...slice.circles, ...extra] } : slice;
        });

  /*
   * Legs are not applied here.
   *
   * They are cut from the field, in `composeField`, which is what lets a leg
   * over the rim take a bite out of it rather than being refused — and what
   * makes kerf free, since the slicer's iso-level shrinks a hole on its own.
   * What is left for this stage is the one thing the field cannot see: whether
   * a layer somebody chose produced a sheet at all.
   */
  const legs = legsFromFeatures(features, kerf, sliced.planes.length > 0 ? sliced.planes[0].z0 : 0);
  const legGaps: Record<string, number> = {};
  for (const spec of legs) {
    const feature = features.find((f) => f.id === spec.id);
    const chosen = resolveLayers(
      selectorForLegs(feature?.params),
      sliced.planes.map((plane) => ({ index: plane.index + 1, z: plane.z })),
    );
    let missing = 0;
    for (const ordinal of chosen) {
      const plane = sliced.planes[ordinal - 1];
      if (!plane) continue;
      if (!sliced.slices.some((slice) => Math.abs(slice.z - plane.z) < 1e-9)) missing += 1;
    }
    legGaps[spec.id] = missing;
  }

  /* --- layer twist --- */

  /*
   * A turned sheet cuts the same outline; what moves is everything that has to
   * line up *through* the stack. So this runs after the holes are made and
   * before the perforation: rods, fixtures and pins are drilled turned back by
   * the layer's angle, so that turning the sheet forward at assembly puts them
   * on the axes they belong to.
   *
   * Perforation is deliberately left out. It belongs to the sheet rather than to
   * the stack — nothing lines up with it — so turning it would only rotate a
   * pattern against its own part.
   *
   * Legs are left out here too, and handled in the field where their sections
   * are built: a leg is cut from the field rather than drilled per slice, so its
   * hole is part of the outline and cannot be moved afterwards.
   */
  const twistSpec = {
    perLayer: Number(twistPerLayer) || 0,
    overrides: typeof twistOverrides === 'string' ? twistOverrides : '',
  };
  const twistTable = parseTwistOverrides(twistSpec.overrides);
  const twistedOwners = new Set(
    features
      .filter((f) => f.kind === 'rod' || f.kind === 'pins' || f.kind.startsWith('fixture:'))
      .map((f) => f.id),
  );

  const anyTwist =
    twistSpec.perLayer !== 0 || twistTable.size > 0;

  const twisted =
    !anyTwist || twistedOwners.size === 0
      ? pinned
      : pinned.map((slice) => {
          const angle = twistAt(twistSpec, slice.index, twistTable);
          if (angle === 0) return slice;

          return {
            ...slice,
            circles: slice.circles.map((circle) => {
              if (!circle.owner || !twistedOwners.has(circle.owner)) return circle;
              const [x, y] = untwistPoint(circle.x, circle.y, angle);
              return { ...circle, x, y };
            }),
            contours: slice.contours.map((contour) => {
              if (!contour.owner || !twistedOwners.has(contour.owner)) return contour;
              const points = new Array<number>(contour.points.length);
              for (let i = 0; i < contour.points.length; i += 2) {
                const [x, y] = untwistPoint(contour.points[i], contour.points[i + 1], angle);
                points[i] = x;
                points[i + 1] = y;
              }
              return { ...contour, points };
            }),
          };
        });

  // Oblique openings are placed after twist so their world axes are transformed
  // back into each sheet's cutting coordinates before containment is checked.
  const inclined = cutInclinedRods(twisted, rodsFromFeatures(features), job, (slice) => twistAt(twistSpec, slice.index, twistTable));
  for (const boss of features.filter((f) => f.enabled && f.kind === 'boss')) {
    const rod = features.find((f) => f.enabled && f.kind === 'rod' && f.id === boss.params.attachTo);
    if (rod && !rodIsVertical(rodFromFeature(rod))) inclined.issues.push({ id: boss.id, severity: 'error', message: `${boss.name}: vertical bosses cannot follow a tilted rod. Disable the boss or return the rod to vertical.` });
  }

  /* --- hole punches: sheet coordinates, after structural hole rotation --- */

  const punches = features.filter((f) => f.kind === 'holePunch' && f.enabled);
  const punchResults: Record<string, PunchResult> = {};
  // Work on copies: earlier cuts, and earlier punches in tree order, take
  // precedence. Perforation comes next and keeps clear of accepted punches.
  const punched = punches.length === 0 ? inclined.slices : inclined.slices.map((slice) => ({ ...slice, circles: slice.circles.slice() }));
  for (const feature of punches) {
    const p = feature.params;
    const z = Number(p.pz);
    const planeIndex = Number.isFinite(z) ? paintPlaneIndex(field.plan, z) : null;
    const plane = field.plan.find((p) => p.index === planeIndex);
    if (!plane) {
      punchResults[feature.id] = { status: 'outside-stack' };
      continue;
    }
    const slice = punched.find((s) => Math.abs(s.z - plane.z) < 1e-6);
    if (!slice) {
      punchResults[feature.id] = { status: 'empty-layer' };
      continue;
    }
    const result = placePunch(slice, Number(p.px), Number(p.py), Number(p.diameter), kerf);
    punchResults[feature.id] = { status: result.status, layer: slice.index };
    if (result.circle) slice.circles.push({ ...result.circle, owner: feature.id });
  }

  /* --- perforation --- */

  const patterns = features.filter((f) => f.stage === 'PATTERN' && f.enabled);
  const patternCounts: Record<string, number> = {};
  for (const feature of patterns) patternCounts[feature.id] = 0;

  // Perforation had no way of saying which layers at all, so it went on every
  // one. `all` is still the default, which is that behaviour written down.
  const patternLayers = new Map<string, Set<number>>();
  for (const feature of patterns) {
    patternLayers.set(
      feature.id,
      resolveLayerSet(selectorFromParams(feature.params), sliced.slices),
    );
  }

  const perforated =
    patterns.length === 0
      ? punched
      : punched.map((slice) => {
          const circles = slice.circles.slice();
          for (const feature of patterns) {
            if (!patternLayers.get(feature.id)?.has(slice.index)) continue;
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
            for (const hole of holes) circles.push({ ...hole, owner: feature.id });
          }
          return { ...slice, circles };
        });

  const set: SliceSet = { ...sliced, slices: perforated, ...(inclined.routes.length || inclined.issues.length ? { rods: { routes: inclined.routes, issues: inclined.issues } } : {}) };

  // Whichever is larger: what the maker asked for, or two kerfs, below which the
  // material burns through however good the geometry is.
  const threshold = Math.max(job.minFeature, kerf * 2);
  const reports = set.slices.map((slice) => minFeatureGap(slice, threshold));
  if (set.verticalSupports) {
    for (let i = 0; i < reports.length; i++) {
      if (reports[i].tooThin) set.verticalSupports.issues.push({ severity: 'error', message: `Layer ${set.slices[i].index}: a finished bridge is below ${threshold.toFixed(2)} mm. Resolve it before cutting the supported stack.` });
    }
    for (const plate of set.verticalSupports.parts) for (const rod of rodsFromFeatures(features)) {
      const pose = rodPose(rod), r = rodDiameter(rod) / 2 + threshold;
      const section = Array.from({ length: 96 }, (_, i) => {
        const a = i * Math.PI * 2 / 96, radius = r / Math.cos(Math.PI / 96);
        return [radius * Math.cos(a), radius * Math.sin(a)];
      }).flat();
      const polygon = prismOpening(plate.part!, pose.start, pose.end, pose.u, pose.v, section);
      if (polygon.length < 6) continue;
      const opening = indexProfile({ rings: [polygon], fill: 'holes' }, 1, 0.02, 12);
      const material = indexProfile({ rings: plate.nominalContours!.map(c => c.points), fill: 'holes' }, 1, 0.02, 12);
      const edgeHits = (points: number[], test: (x: number, y: number) => number) => {
        for (let i = 0; i < points.length; i += 2) {
          const j = (i + 2) % points.length, dx = points[j] - points[i], dy = points[j + 1] - points[i + 1];
          const steps = Math.ceil(Math.hypot(dx, dy) / 0.25);
          for (let k = 0; k <= steps; k++) if (test(points[i] + dx * k / Math.max(steps, 1), points[i + 1] + dy * k / Math.max(steps, 1)) < 0) return true;
        }
        return false;
      };
      if (edgeHits(polygon, (x, y) => indexedDistance(material, x, y)) || plate.nominalContours!.some(c => edgeHits(c.points, (x, y) => indexedDistance(opening, x, y))))
        set.verticalSupports.issues.push({ severity: 'error', message: `${plate.part!.label} intersects or crowds ${rod.label}. Move the rod or rotate the supports; rods do not drill vertical support plates.` });
    }
  }

  return {
    set,
    windows,
    reports,
    patternCounts,
    holeMisses,
    punchResults,
    legGaps,
    pinLoose,
    ms: Date.now() - started,
  };
}

export type PunchStatus = 'placed' | 'outside-stack' | 'empty-layer' | 'no-material' | 'overlap' | 'too-small' | 'invalid';
export interface PunchResult { status: PunchStatus; layer?: number }

/** A full circular cut, checked against the actual compensated cut geometry. */
export function placePunch(slice: Slice, x: number, y: number, diameter: number, kerf: number): {
  status: PunchStatus; circle?: CircleHole;
} {
  if (![x, y, diameter, kerf].every(Number.isFinite) || diameter <= 0 || kerf < 0) return { status: 'invalid' };
  if (diameter <= kerf) return { status: 'too-small' };
  const circle = { x, y, r: (diameter - kerf) / 2, label: 'Hole punch' };
  // Each laser path removes half a kerf on either side. A full kerf between
  // paths leaves material between the finished hole and every other cut.
  if (!groupContours(slice.contours).some((group) => circleFitsInPart(group, circle, kerf))) return { status: 'no-material' };
  if (slice.circles.some((other) => Math.hypot(x - other.x, y - other.y) <= circle.r + other.r + kerf)) return { status: 'overlap' };
  return { status: 'placed', circle };
}

/* ------------------------------------------------------------------ *
 * Nesting
 *
 * The third job that can run off the main thread, and the one with the
 * simplest boundary. Slicing and the preview both need the field, which cannot
 * cross a thread — so both are handed the tree and rebuild it. Parts are not
 * like that: they are polygons, circles and strings, which is to say plain
 * JSON, and they travel as themselves.
 *
 * What comes back is deliberately **not** parts. Neither packer touches
 * geometry — both end at `{ ...part, bbox, pivot, dx, dy, labelAt,
 * labelHeight }` — so the only thing the nester decides is where each part
 * goes. Sending the geometry back would be sending it home again, and it would
 * quietly invite a future packer to modify it in transit, which nothing
 * downstream expects. Rotation is the proof of the rule: it is baked into
 * geometry, and it happens in `applyPlacements` on the main thread, after this.
 * ------------------------------------------------------------------ */

/** Where the nester put one part. No geometry, on purpose. */
export interface Placement {
  id: string;
  dx: number;
  dy: number;
  bbox: BBox;
  pivot: [number, number];
  labelAt: [number, number] | null;
  labelHeight: number;
}

export interface NestedSheet {
  index: number;
  material: string;
  ordinal: number;
  fill: number;
  /** In packing order, which is the order the sheet view draws them. */
  placements: Placement[];
}

export interface NestJob {
  parts: PartGeometry[];
  options: NestOptions;
}

export interface NestOutput {
  sheets: NestedSheet[];
  unplacedIds: string[];
  ms: number;
}

export const EMPTY_NEST: NestOutput = { sheets: [], unplacedIds: [], ms: 0 };

/** A rehydrated layout, plus anything the placement table named and we lack. */
export interface RehydratedNest extends NestResult {
  /**
   * Ids in the table with no part to attach them to.
   *
   * Only reachable by rehydrating against a different set of parts than the one
   * that was nested, which is a caller bug rather than a user one — but it is
   * reported rather than dropped, because a part vanishing off a sheet with no
   * explanation is the exact failure this program keeps having to fix.
   */
  missing: string[];
}

/** Pack parts onto sheets. Pure, and therefore the same on either thread. */
export function runNestJob(job: NestJob): NestOutput {
  const started = Date.now();
  const nested = nestByMaterial(job.parts, job.options);

  return {
    sheets: nested.sheets.map((sheet) => ({
      index: sheet.index,
      material: sheet.material,
      ordinal: sheet.ordinal,
      fill: sheet.fill,
      placements: sheet.parts.map((part) => ({
        id: part.id,
        dx: part.dx,
        dy: part.dy,
        bbox: part.bbox,
        pivot: part.pivot,
        labelAt: part.labelAt,
        labelHeight: part.labelHeight,
      })),
    })),
    unplacedIds: nested.unplaced.map((part) => part.id),
    ms: Date.now() - started,
  };
}

/**
 * Put the geometry back under the placements.
 *
 * Must be given the parts the table was computed from. Holding those two
 * together is the caller's job and is why `useSheets` keeps the whole job
 * snapshot beside the reply rather than only the reply: a placement table read
 * against a newer set of parts is meaningless, not merely stale.
 */
export function rehydrateNest(output: NestOutput, parts: PartGeometry[]): RehydratedNest {
  const byId = new Map<string, PartGeometry>();
  for (const part of parts) byId.set(part.id, part);

  const missing: string[] = [];
  const sheets: Sheet[] = output.sheets.map((sheet) => {
    const placed: PlacedPart[] = [];
    for (const at of sheet.placements) {
      const part = byId.get(at.id);
      if (!part) {
        missing.push(at.id);
        continue;
      }
      // Field order matches what the packers build, so a validator can compare
      // the two results directly.
      placed.push({
        ...part,
        bbox: at.bbox,
        pivot: at.pivot,
        dx: at.dx,
        dy: at.dy,
        labelAt: at.labelAt,
        labelHeight: at.labelHeight,
      });
    }
    return {
      index: sheet.index,
      material: sheet.material,
      ordinal: sheet.ordinal,
      parts: placed,
      fill: sheet.fill,
    };
  });

  const unplaced: PartGeometry[] = [];
  for (const id of output.unplacedIds) {
    const part = byId.get(id);
    if (part) unplaced.push(part);
    else missing.push(id);
  }

  return { sheets, unplaced, missing };
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

/** Full-stock projection of finite inclined rods, in each sheet's cut frame. */
function cutInclinedRods(slices: Slice[], rods: RodSpec[], job: SliceJob, angleAt: (slice: Slice) => number) {
  const routes: NonNullable<SliceSet['rods']>['routes'] = [];
  const issues: NonNullable<SliceSet['rods']>['issues'] = [];
  let result = slices;
  for (const rod of rods.filter((r) => !rodIsVertical(r))) {
    const pose = rodPose(rod), diameter = rodDiameter(rod), radius = diameter / 2 / Math.cos(Math.PI / 96);
    const section = Array.from({ length: 96 }, (_, i) => [radius * Math.cos(i * Math.PI / 48), radius * Math.sin(i * Math.PI / 48)]).flat();
    const route = { id: rod.id, label: rod.label, start: pose.start, end: pose.end, diameter, layers: [] as number[] };
    routes.push(route);
    result = result.map((slice) => {
      const a = angleAt(slice) * Math.PI / 180;
      const part: NonNullable<Slice['part']> = { id: String(slice.index), label: `Layer ${slice.index}`, kind: 'support',
        origin: [0, 0, slice.zBottom + job.thickness / 2], u: [Math.cos(a), Math.sin(a), 0], v: [-Math.sin(a), Math.cos(a), 0], n: [0, 0, 1], thickness: job.thickness, kerf: job.kerf, material: '' };
      const polygon = prismOpening(part, pose.start, pose.end, pose.u, pose.v, section);
      if (!polygon.length) return slice;
      const xs = polygon.filter((_, i) => i % 2 === 0), ys = polygon.filter((_, i) => i % 2 === 1);
      const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      const reach = Math.max(box.maxX - box.minX, box.maxY - box.minY, 10) * 2;
      const opening = indexProfile({ rings: [polygon], fill: 'holes' }, 1, 0.02, reach);
      const material = indexProfile({ rings: slice.contours.map((c) => c.points), fill: 'holes' }, 1, 0.02, reach);
      const cut = (x: number, y: number) => indexedDistance(opening, x, y);
      const solid = (x: number, y: number) => indexedDistance(material, x, y);
      // Sample entire segments; testing vertices alone misses thin crossings.
      const edgeSome = (points: number[], test: (x: number, y: number) => boolean): boolean => {
        for (let i = 0; i < points.length; i += 2) {
          const j = (i + 2) % points.length, dx = points[j] - points[i], dy = points[j + 1] - points[i + 1];
          const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.25));
          for (let k = 0; k <= steps; k++) if (test(points[i] + dx * k / steps, points[i + 1] + dy * k / steps)) return true;
        }
        return false;
      };
      if (!edgeSome(polygon, (x, y) => solid(x, y) < 0) && !slice.contours.some((c) => edgeSome(c.points, (x, y) => cut(x, y) < 0))) return slice;
      const refuse = (message: string) => { issues.push({ id: rod.id, severity: 'error', message: `${rod.label}, layer ${slice.index}: ${message}` }); return slice; };
      const extentZ = radius * Math.hypot(pose.u[2], pose.v[2]);
      if (Math.abs(pose.direction[2]) < 0.05 || Math.min(pose.start[2], pose.end[2]) + extentZ > slice.zBottom + 1e-8
        || Math.max(pose.start[2], pose.end[2]) - extentZ < slice.zBottom + job.thickness - 1e-8) {
        return refuse('the rod ends inside the sheet or runs along its face. Extend or rotate it for a complete crossing.');
      }
      const bridge = Math.max(job.minFeature, job.kerf * 2);
      // Outlines already include kerf. Reserve its half-width as well as the
      // nominal bridge, and reject an opening that encloses an existing hole.
      if (edgeSome(polygon, (x, y) => solid(x, y) > -bridge - job.kerf / 2)
        || slice.contours.some((c) => c.isHole && edgeSome(c.points, (x, y) => cut(x, y) < bridge + job.kerf / 2))
        || slice.circles.some((c) => cut(c.x, c.y) < c.r + bridge + job.kerf / 2)) {
        return refuse('the closed opening reaches an edge, another hole or an insufficient bridge. Move the rod or reduce its diameter.');
      }
      const margin = Math.max(1, job.kerf), step = Math.max(0.015, Math.min(0.12, diameter / 24), reach / 1000);
      const traced = traceSheet(cut, { minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin }, step, -job.kerf / 2, Math.min(job.tolerance, 0.02));
      if (traced.length !== 1 || traced[0].points.length < 6) return refuse('the compensated opening could not be resolved. Increase the diameter or reduce kerf.');
      const points = traced[0].points.slice();
      if (signedArea(points) > 0) {
        const pairs = Array.from({ length: points.length / 2 }, (_, i) => points.slice(i * 2, i * 2 + 2)).reverse().flat();
        points.splice(0, points.length, ...pairs);
      }
      route.layers.push(slice.index);
      return { ...slice, contours: [...slice.contours, { points, area: signedArea(points), isHole: true, owner: rod.id }] };
    });
    if (!route.layers.length && !issues.some((i) => i.id === rod.id)) issues.push({ id: rod.id, severity: 'warning', message: `${rod.label}: no holes; the rod misses material in all layers.` });
  }
  return { slices: result, routes, issues };
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
  return features.filter((f) => f.kind === 'rod' && f.enabled).map(rodFromFeature);
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
/**
 * A fixture's layer selector.
 *
 * `band` is the default and its z is not stored — it **is** the fixture's own
 * resolved z, because for a fixture the band and the position are the same
 * thing. The other kinds ignore z entirely, which is what lets a socket be put
 * on "the bottom two sheets" instead of aimed at a height and hoped for.
 */
export function selectorForFixture(
  params: Record<string, number | string | boolean> | undefined,
  z: number,
  length: number,
): LayerSelector {
  const selector = selectorFromParams(params, { kind: 'band', z, length });
  return selector.kind === 'band' ? { ...selector, z, length } : selector;
}

/** Legs select planned planes, including empty ones, starting with the first two. */
export function selectorForLegs(params: Feature['params'] | undefined): LayerSelector {
  return selectorFromParams(params, { kind: 'range', from: 1, to: 2 });
}

/** The plane that owns a paint height; extrapolated indices outside the plan are dropped. */
export function paintPlaneIndex(plan: LayerPlan, z: number): number | null {
  if (plan.length === 0) return null;
  const index = layerIndexAt(plan, z);
  const at = index - plan[0].index;
  return at >= 0 && at < plan.length ? plan[at].index : null;
}

/** Every enabled legs feature, with its spread measured at the model's bottom. */
/** Every enabled pins feature. */
/**
 * Every enabled boss, standing where its rod does.
 *
 * A boss has no position of its own: it thickens a rod, so it reads the rod's.
 * One attached to a rod that has been deleted or switched off contributes
 * nothing rather than falling back to the axis — a boss silently jumping to the
 * middle of the lamp would be worse than one that is missing, and the inspector
 * says which rod it wanted.
 */
export function bossesFromFeatures(
  features: Feature[],
  plan: LayerPlan,
  /** Far enough to leave the model from anywhere in it, for automatic spokes. */
  reachToEdge = 1e4,
): BossSpec[] {
  const out: BossSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'boss' || !f.enabled) continue;

    const rodId = typeof f.params.attachTo === 'string' ? f.params.attachTo : '';
    const rod = features.find((r) => r.id === rodId && r.kind === 'rod' && r.enabled);
    if (!rod || !rodIsVertical(rodFromFeature(rod))) continue;

    // The chosen layers become a span: bottom of the lowest, top of the highest.
    const chosen = resolveLayers(
      selectorFromParams(f.params),
      plan.map((plane) => ({ index: plane.index + 1, z: plane.z })),
    );
    const planes = chosen.map((ordinal) => plan[ordinal - 1]).filter(Boolean);
    if (planes.length === 0) continue;

    out.push({
      id: f.id,
      label: f.name,
      x: Number(rod.params.px) || 0,
      y: Number(rod.params.py) || 0,
      z0: planes[0].z0,
      z1: planes[planes.length - 1].z0 + planes[planes.length - 1].thickness,
      radius: Math.max(Number(f.params.radius) || 0, 0.05),
      spokes: Math.max(Math.round(Number(f.params.spokes) || 0), 0),
      spokeWidth: Math.max(Number(f.params.spokeWidth) || 0, 0.1),
      /*
       * Zero reaches the wall.
       *
       * A spoke has to land on material or the boss is an island, and the
       * number that does it is different on every layer of a curved form —
       * asking for it is asking somebody to guess a value that is only right
       * once. So zero means "as far as it goes", and the envelope clip stops it
       * at the wall. Reaching too far costs nothing; that is the whole point of
       * the clip.
       */
      spokeLength:
        (Number(f.params.spokeLength) || 0) > 0
          ? Number(f.params.spokeLength)
          : reachToEdge,
      angle: Number(f.params.angle) || 0,
      blend: Math.max(Number(f.params.blend) || 0, 0),
    });
  }
  return out;
}

/**
 * The keys of a profile feature that can actually morph: a finite height and a
 * located outline. A key whose SVG has not been found again after opening has
 * no rings yet, and it cannot take part.
 *
 * Exported for the inspector as much as for the pipeline: both must answer
 * "is this a morph?" through the same predicate, or the panel describes a
 * field the sampler is not building — the FixtureInspector class of gap,
 * closed here by construction rather than by care.
 */
export function usableProfileKeys(feature: Feature): ProfileKey[] {
  return (feature.keys ?? []).filter(
    (key) => Number.isFinite(key.z) && Array.isArray(key.rings) && key.rings.length > 0,
  );
}

/** Deepest enabled shell, independent of tree order; reach must cover them all. */
export function deepestShellWall(features: Feature[]): number {
  return features.reduce((deepest, f) =>
    f.kind === 'shell' && f.enabled ? Math.max(deepest, Number(f.params.t) || 0) : deepest, 0);
}

/**
 * A profile's rings as an extruded volume, or nothing when the file is gone.
 *
 * The index is built here, once per composition, rather than per sample: it is
 * what turns a 17-microsecond walk into a 1.35-microsecond lookup, and building
 * it inside the sampler would pay for it on every point.
 *
 * With two or more usable keys the profile is a **morph**: the solid runs from
 * the lowest key to the highest and each key gets its own index, under the
 * same reach contract. With fewer — a file from before keys existed, or a
 * morph whose SVGs have not been located yet — it takes the single-outline
 * path below, exactly as it always has, so no saved lamp changes the day keys
 * appear. `height` steers only that path; a morph's span is its keys.
 */
export function profileVolume(feature: Feature, needed = 0) {
  const featureFill = (
    typeof feature.params.fill === 'string' ? feature.params.fill : 'holes'
  ) as FillRule;
  const round = Math.max(Number(feature.params.round) || 0, 0);

  /*
   * The index is exact out to a reach and clamped beyond it, and the caller has
   * to say how deep this lamp needs. A shell takes its wall off the inside, so
   * where the distance is clamped the cavity lands on the clamp — which on a
   * complicated outline looks like stray lines through the middle of the shape.
   *
   * Capped, because a reach the size of the whole drawing costs four times what
   * a useful one does and buys nothing: past the widest wall anybody cuts, no
   * part of this program reads the number.
   */
  const reachFor = (span: number) =>
    Math.min(Math.max(needed, Number(feature.params.k) || 0), span * 0.6);

  const keys = usableProfileKeys(feature);
  if (keys.length >= 2) {
    const easing: MorphEasing = feature.params.easing === 'linear' ? 'linear' : 'smooth';
    const sorted = keys.slice().sort((a, b) => a.z - b.z);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const entries: MorphEntry[] = sorted.map((key) => {
      // A key names its own rule; one that does not follows the feature's.
      const fill: FillRule =
        key.fill === 'outline' || key.fill === 'holes' ? key.fill : featureFill;
      const rings = key.rings ?? [];
      const box = profileBounds({ rings, fill });
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
      return { z: key.z, index: indexProfile({ rings, fill }, 1, 0.06, reachFor(Math.max(box.w, box.h, 1))) };
    });

    return {
      reach: Math.min(...entries.map((entry) => entry.index.reach)),
      // The union of the keys' boxes bounds the mix (a convex combination
      // cannot leave it), and `round` only shrinks — so this is the outer box.
      sample: (x: number, y: number, z: number) => extrudeMorph(entries, easing, round, x, y, z),
      min: [minX, minY, sorted[0].z] as [number, number, number],
      max: [maxX, maxY, sorted[sorted.length - 1].z] as [number, number, number],
    };
  }

  const rings = feature.rings;
  if (!rings || rings.length === 0) return undefined;

  const height = Math.max(Number(feature.params.height) || 0, 0.1);
  const box = profileBounds({ rings, fill: featureFill });
  const reach = reachFor(Math.max(box.maxX - box.minX, box.maxY - box.minY, 1));

  const index = indexProfile({ rings, fill: featureFill }, 1, 0.06, reach);
  return {
    reach: index.reach,
    sample: (x: number, y: number, z: number) => extrudeProfile(index, height, round, x, y, z),
    min: [box.minX, box.minY, -height / 2] as [number, number, number],
    max: [box.maxX, box.maxY, height / 2] as [number, number, number],
  };
}

/**
 * Every enabled brush feature, split by what each stroke does.
 *
 * The operation is on the **stroke**, not the feature, because `SculptStroke`
 * already carries one — so a single brush holds what was painted on and what
 * was carved off, in the order they were made.
 */
export function paintFromFeatures(
  features: Feature[],
): { id: string; cut: boolean; strokes: PaintStroke[] }[] {
  const out: { id: string; cut: boolean; strokes: PaintStroke[] }[] = [];
  for (const f of features) {
    if (f.kind !== 'paint' || !f.enabled) continue;
    const usable = (f.strokes ?? []).filter((s) => s.points.length >= 3);
    const add = usable.filter((s) => s.op !== 'subtract');
    const cut = usable.filter((s) => s.op === 'subtract');
    if (add.length > 0) out.push({ id: f.id, cut: false, strokes: add });
    if (cut.length > 0) out.push({ id: f.id, cut: true, strokes: cut });
  }
  return out;
}

export function pinsFromFeatures(features: Feature[], kerf: number): PinSpec[] {
  const out: PinSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'pins' || !f.enabled) continue;
    out.push({
      id: f.id,
      label: f.name,
      count: Math.max(Math.round(Number(f.params.pinCount) || 3), 1),
      diameter: Math.max(Number(f.params.diameter) || 0, 0.1),
      radius: Math.max(Number(f.params.radius) || 0, 0),
      angle: Number(f.params.angle) || 0,
      stagger: Number(f.params.stagger) || 0,
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      kerf,
    });
  }
  return out;
}

export function legsFromFeatures(features: Feature[], kerf: number, zRef: number): LegSpec[] {
  const out: LegSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'legs' || !f.enabled) continue;
    out.push({
      id: f.id,
      label: f.name,
      count: Math.max(Math.round(Number(f.params.legCount) || 3), 1),
      tilt: Number(f.params.tilt) || 0,
      diameter: Math.max(Number(f.params.diameter) || 0, 0.1),
      radius: Number(f.params.radius) || 0,
      angle: Number(f.params.angle) || 0,
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      zRef,
      kerf,
    });
  }
  return out;
}

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
  /**
   * The stack, not a pitch.
   *
   * `composeField` used to take one pitch, which is all a uniform stack needs.
   * Per-layer windows key on the layer a height falls in, so once gaps vary the
   * field has to know the whole plan rather than a single spacing.
   */
  stack: {
    spacerHeight: number;
    spacerHeightTop?: number;
    spacerHeightMid?: number;
    spacerThickness?: number;
    /** Carried so legs, which are cut from the field, can turn with their layer. */
    twistPerLayer?: number;
    twistOverrides?: string;
  },
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
  /*
   * Volumes, from two sources that look the same to the evaluator.
   *
   * A mesh's grid comes in from outside, because it is megabytes and is cached
   * on each side of the worker boundary. A profile's rings arrive on the
   * feature itself — they are kilobytes of plain numbers and travel with the
   * tree — and the extruded field is built here, so `sdf.ts` sees one shape of
   * thing and imports nothing.
   */
  /*
   * How deep any shell in the tree cuts, plus half again.
   *
   * A profile's interior only has to be exact as far as something reads it, and
   * the shell is the thing that reads deepest. Working it out here rather than
   * defaulting high means a lamp with no shell pays nothing for one.
   */
  const wallNeeded = deepestShellWall(features) * 1.6;

  const fieldFeatures = features.filter(isFieldFeature).map((f) => {
    if (f.kind === 'import') return { ...f, volume: volumes.get(f.id) };
    if (f.kind === 'profile') return { ...f, volume: profileVolume(f, wallNeeded) };
    return f;
  });
  const prepared = prepareFeatures(fieldFeatures);
  const windows = windowsFromFeatures(features, kerf, seed);
  /*
   * The box the shape tree asks for, before anything painted on widens it.
   *
   * Kept separate because the layer plan is built from *this* one: a paint
   * stroke can only reach sideways, so growing z here would move the sheets and
   * reroll every per-layer window for nothing.
   */
  const rawBounds = modelBounds(fieldFeatures);

  // Per-layer windows have to land on the same planes the slicer will take, so
  // the plan is built by the same function, from the same numbers. It is the
  // list of planes rather than a pitch, which is what lets the gaps differ
  // later without the windows losing track of which sheet they are on.
  const plan: LayerPlan = rawBounds ? planLayers(rawBounds, { thickness, ...stack }) : [];

  const solid = (x: number, y: number, z: number) => evaluatePoint(prepared, x, y, z);

  /*
   * Bosses, added to the form after the shell has hollowed it.
   *
   * The order is the whole difficulty. Everything else in RIG removes material;
   * a boss adds it, and putting it in before the shell would let the shell
   * carve the boss out again — which is the one thing it exists to prevent.
   * `solid` is already the accumulated SHAPE and CARVE tree, so unioning here
   * is after the shell and before the windows, which should still be able to
   * cut through a boss.
   *
   * A boss needs no per-layer work. A leg's hole differs on every sheet because
   * the sweep depends on the sheet's thickness; a boss is a straight column, so
   * the chosen layers collapse to a z range and the field costs one expression
   * per sample.
   */
  // Far enough that a spoke from anywhere inside the model leaves it, so an
  // automatic spoke is stopped by the envelope rather than by its own length.
  const reachToEdge = rawBounds
    ? Math.hypot(rawBounds.max[0] - rawBounds.min[0], rawBounds.max[1] - rawBounds.min[1])
    : 1e4;
  const bosses = bossesFromFeatures(features, plan, reachToEdge);

  /*
   * The form before it was hollowed, so a boss can be kept inside it.
   *
   * The shape tree without the CARVE modifiers — subtracting shapes still
   * subtract, since those are part of the outline, but the shell is left out.
   * That is the surface a boss must not cross: a spoke aimed past the wall
   * should stop at the wall rather than carry on through and hang off the
   * outside of the lamp as a fin.
   *
   * Built only when there is a boss to clip, because preparing a second tree
   * for nothing is a cost every lamp would pay.
   */
  const envelope =
    bosses.length === 0
      ? undefined
      : (() => {
          const outer = prepareFeatures(fieldFeatures.filter((f) => f.stage === 'SHAPE'));
          return (x: number, y: number, z: number) => evaluatePoint(outer, x, y, z);
        })();

  const withBoss = bossField(solid, bosses, envelope);

  /*
   * Per-layer brush strokes, after the shell for the same reason a boss is:
   * painting material on and then handing it to the shell to hollow out again
   * is not what anybody means by painting it on.
   *
   * Each stroke is anchored to the height it was drawn at and confined to that
   * sheet's own band, so it edits one layer and reaches neither neighbour. The
   * grouping is done once here rather than per sample — a lookup by plane index
   * costs nothing, and searching every stroke at every point would cost what
   * sculpt strokes had to be indexed to avoid.
   */
  const painted = paintFromFeatures(features);
  const paintByPlane = new Map<number, { cut: boolean; strokes: PaintStroke[] }[]>();

  if (plan.length > 0) {
    const planeAt = (z: number) => paintPlaneIndex(plan, z);
    for (const feature of painted) {
      for (const [planeIndex, strokes] of strokesByPlane(feature.strokes, planeAt)) {
        const list = paintByPlane.get(planeIndex) ?? [];
        list.push({ cut: feature.cut, strokes });
        paintByPlane.set(planeIndex, list);
      }
    }
  }

  const withPaint =
    paintByPlane.size === 0
      ? withBoss
      : (x: number, y: number, z: number) => {
          let d = withBoss(x, y, z);
          const index = layerIndexAt(plan, z);
          const groups = paintByPlane.get(index);
          if (!groups) return d;

          const plane = plan[index - plan[0].index];
          if (!plane) return d;
          const half = Math.max(plane.thickness + plane.gapAbove, 1e-6) / 2;

          for (const group of groups) {
            const stroke = paintDistance(group.strokes, x, y, z, plane.z, half);
            d = group.cut ? Math.max(d, -stroke) : Math.min(d, stroke);
          }
          return d;
        };

  /*
   * The rawBounds are deliberately left alone.
   *
   * The first version grew them in XY for every boss, because a spoke reaching
   * further than the form did was clipped at the grid: the preview drew the cut
   * face as a flat plate and the slicer found a contour running off its window,
   * dropped it rather than guessing an edge, and the whole outer ring of that
   * layer went with it — a sheet reporting a negative area.
   *
   * Clipping the boss to the envelope fixes that at the source and makes the
   * growth wrong rather than merely unnecessary: a bigger box at the same
   * sample count is a coarser grid everywhere, paid for reach that adds
   * nothing.
   *
   * A **paint stroke is the opposite case** and does grow them. A boss is a
   * thickening inside the form by definition; a stroke painted past the rim is
   * material somebody deliberately put outside it, and material outside the
   * grid is material the slicer never sees. Only the additive ones count — a
   * carve stroke can only remove, so it needs no room of its own.
   */
  const paintBox = strokesBounds(painted.filter((p) => !p.cut).flatMap((p) => p.strokes));
  const bounds =
    paintBox === null || rawBounds === null
      ? rawBounds
      : {
          min: [
            Math.min(rawBounds.min[0], paintBox.minX),
            Math.min(rawBounds.min[1], paintBox.minY),
            rawBounds.min[2],
          ] as [number, number, number],
          max: [
            Math.max(rawBounds.max[0], paintBox.maxX),
            Math.max(rawBounds.max[1], paintBox.maxY),
            rawBounds.max[2],
          ] as [number, number, number],
        };

  /*
   * Legs, cut from the field rather than pasted into the slices.
   *
   * The hole is the sweep of a tilted cylinder through a sheet, so it depends
   * on which sheet a height falls in — the same thing a per-layer window needs,
   * and answered the same way. Sections are built once per plane and looked up
   * per sample; a set of three legs through six sheets is eighteen of them.
   *
   * The layers are chosen against the **planes**, not the sheets. The field has
   * to exist before any sheet does, so counting sheets here would define the
   * selection in terms of its own result. The two agree unless the model has a
   * void along Z, and where they do not, `legGaps` says so.
   */
  const legTwist = {
    perLayer: Number(stack.twistPerLayer) || 0,
    overrides: typeof stack.twistOverrides === 'string' ? stack.twistOverrides : '',
  };
  const legTwistTable = parseTwistOverrides(legTwist.overrides);

  const legs = legsFromFeatures(features, kerf, plan.length > 0 ? plan[0].z0 : 0);
  const legSectionsByPlane = new Map<number, LegSection[]>();
  for (const spec of legs) {
    const feature = features.find((f) => f.id === spec.id);
    const chosen = resolveLayers(
      selectorForLegs(feature?.params),
      plan.map((plane) => ({ index: plane.index + 1, z: plane.z })),
    );
    for (const ordinal of chosen) {
      const plane = plan[ordinal - 1];
      if (!plane) continue;
      const existing = legSectionsByPlane.get(plane.index) ?? [];

      /*
       * Turned back with everything else that has to line up through the stack.
       * A leg is a straight rod, so its hole has to be drilled at −twist — but
       * it is cut from the field rather than drilled per slice, so it cannot be
       * moved after the fact the way a rod hole can. Turning the section here is
       * the same correction applied one step earlier.
       *
       * Layer numbers count sheets and planes count what was examined, so the
       * ordinal is what the twist is asked about — the same number the slice
       * inspector shows.
       */
      const angle = twistAt(legTwist, ordinal, legTwistTable);
      const sections = legSections(spec, plane.z0, plane.thickness).map((section) => {
        if (angle === 0) return section;
        const [cx, cy] = untwistPoint(section.cx, section.cy, angle);
        const a = (-angle * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        return {
          ...section,
          cx,
          cy,
          // The direction turns with the centre, or a leg would lean the way it
          // was drawn while sitting where it was moved to.
          ux: section.ux * cos - section.uy * sin,
          uy: section.ux * sin + section.uy * cos,
        };
      });

      existing.push(...sections);
      legSectionsByPlane.set(plane.index, existing);
    }
  }

  const withWindows = stockField(withPaint, windows, plan);
  const sample =
    legSectionsByPlane.size === 0
      ? withWindows
      : (x: number, y: number, z: number) => {
          const d = withWindows(x, y, z);
          const index = layerIndexAt(plan, z);
          const sections = legSectionsByPlane.get(index);
          if (!sections) return d;

          const plane = plan[index - plan[0].index];
          if (!plane) return d;

          // Confined to the sheet's own band, one pitch tall, the way a
          // per-layer window is: continuous within a layer and stepping between
          // them, which is what a stack of separately cut sheets does.
          const half = Math.max(plane.thickness + plane.gapAbove, 1e-6) / 2;
          const slab = Math.max(z - (plane.z + half), plane.z - half - z);
          const leg = Math.max(sectionsDistance(sections, x, y), slab);
          return Math.max(d, -leg);
        };

  return {
    solid,
    sample,
    windows,
    plan,
    thickness,
    // The grown box, so the grid holds whatever the bosses added. The plan above
    // was built from the original, which is what keeps the layers where they
    // were.
    bounds,
  };
}
