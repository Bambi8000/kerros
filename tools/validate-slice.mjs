#!/usr/bin/env node
/**
 * validate-slice.mjs
 *
 * Imports the REAL src/core/slice.ts. Because the slicer takes a sampler
 * rather than an SDF tree, it can be checked against fields whose contours are
 * known exactly — a circle's area and perimeter, an annulus's two rings, a
 * square's corner count — and then against the real SDF core.
 *
 *   node tools/validate-slice.mjs
 */

import { layerPitch } from '../src/core/types.ts';
import {
  signedArea,
  perimeter,
  pointInRing,
  simplifyRing,
  smoothRing,
  contoursFromField,
  groupContours,
  planeZs,
  planLayers,
  ringsForGap,
  sliceModel,
} from '../src/core/slice.ts';

import {
  prepareFeatures,
  evaluatePoint,
  modelBounds,
  defaultParams,
  findModule,
} from '../src/core/sdf.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function ring(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

/** Sample a 2D field into the layout contoursFromField expects. */
function makeField(fn, halfX, halfY, step) {
  const nx = Math.round((2 * halfX) / step) + 1;
  const ny = Math.round((2 * halfY) / step) + 1;
  const field = new Float64Array(nx * ny);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      field[k++] = fn(-halfX + i * step, -halfY + j * step);
    }
  }
  return { field, nx, ny, originX: -halfX, originY: -halfY, step };
}

console.log('slice: polygon helpers');
{
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  check('counter-clockwise square has positive area', near(signedArea(square), 100, 1e-9));
  check(
    'reversed square has negative area',
    near(signedArea([0, 0, 0, 10, 10, 10, 10, 0]), -100, 1e-9),
  );
  check('square perimeter', near(perimeter(square), 40, 1e-9));
  check('centre is inside', pointInRing(square, 5, 5));
  check('outside is outside', !pointInRing(square, 15, 5));
  check('a circle ring has the right area', near(signedArea(ring(0, 0, 20, 512)), Math.PI * 400, 0.1));
}

console.log('slice: simplify and smooth');
{
  // A straight run of collinear points must collapse to its endpoints.
  const line = [0, 0, 1, 0, 2, 0, 3, 0, 3, 3, 0, 3];
  const simplified = simplifyRing(line, 0.01);
  check(
    'collinear points are dropped',
    simplified.length / 2 < line.length / 2,
    `${line.length / 2} -> ${simplified.length / 2}`,
  );
  check('simplified ring keeps its area', near(signedArea(simplified), signedArea(line), 1e-9));

  const circle = ring(0, 0, 30, 400);
  const coarse = simplifyRing(circle, 0.05);
  check(
    'a circle simplifies substantially',
    coarse.length / 2 < 200,
    `${coarse.length / 2} points left`,
  );
  check(
    'simplified circle keeps its area within 0.5%',
    Math.abs(signedArea(coarse) - Math.PI * 900) / (Math.PI * 900) < 0.005,
  );

  const square = [0, 0, 20, 0, 20, 20, 0, 20];
  const smoothed = smoothRing(square, 2);
  check('smoothing multiplies point count by four over two passes', smoothed.length / 2 === 16);
  check('smoothing keeps orientation', signedArea(smoothed) > 0);
  // Two passes on a 20 mm square cut 50 then 12.5 mm2 off the corners. This
  // is exactly why smoothing runs before simplification, never after: on a
  // dense marching-squares ring the cut is a fraction of a cell, but on an
  // RDP-reduced ring it would eat whole corners.
  check(
    'two passes on a 20 mm square remove exactly the corner triangles',
    near(signedArea(smoothed), 337.5, 1e-9),
    `area ${signedArea(smoothed).toFixed(2)}`,
  );
  check('zero passes leaves the ring untouched', smoothRing(square, 0).length === square.length);
}

console.log('slice: marching squares on a disc');
{
  const R = 40;
  const g = makeField((x, y) => Math.hypot(x, y) - R, 60, 60, 0.5);
  const rings = contoursFromField(g.field, g.nx, g.ny, g.originX, g.originY, g.step);

  check('one contour', rings.length === 1, `got ${rings.length}`);
  const area = signedArea(rings[0]);
  check('the contour is counter-clockwise', area > 0, `area ${area.toFixed(1)}`);
  check(
    'area matches the analytic disc within 0.2%',
    Math.abs(area - Math.PI * R * R) / (Math.PI * R * R) < 0.002,
    `got ${area.toFixed(1)}, expected ${(Math.PI * R * R).toFixed(1)}`,
  );
  check(
    'perimeter matches the analytic circle within 0.5%',
    Math.abs(perimeter(rings[0]) - 2 * Math.PI * R) / (2 * Math.PI * R) < 0.005,
  );

  let maxError = 0;
  for (let i = 0; i < rings[0].length; i += 2) {
    maxError = Math.max(maxError, Math.abs(Math.hypot(rings[0][i], rings[0][i + 1]) - R));
  }
  check('every vertex sits on the circle within a cell', maxError < g.step, `max ${maxError.toFixed(4)} mm`);
}

console.log('slice: annulus produces a hole');
{
  const outerR = 50;
  const innerR = 20;
  const g = makeField(
    (x, y) => Math.max(Math.hypot(x, y) - outerR, innerR - Math.hypot(x, y)),
    70,
    70,
    0.4,
  );
  const rings = contoursFromField(g.field, g.nx, g.ny, g.originX, g.originY, g.step);
  check('two contours', rings.length === 2, `got ${rings.length}`);

  const areas = rings.map(signedArea).sort((a, b) => a - b);
  check('one ring is clockwise and one counter-clockwise', areas[0] < 0 && areas[1] > 0);
  check(
    'outer area is right',
    Math.abs(areas[1] - Math.PI * outerR * outerR) / (Math.PI * outerR * outerR) < 0.002,
  );
  check(
    'hole area is right',
    Math.abs(Math.abs(areas[0]) - Math.PI * innerR * innerR) / (Math.PI * innerR * innerR) < 0.005,
  );

  const contours = rings.map((points) => {
    const area = signedArea(points);
    return { points, area, isHole: area < 0 };
  });
  const groups = groupContours(contours);
  check('grouping gives one part', groups.length === 1);
  check('the hole is assigned to it', groups[0].holes.length === 1);
}

console.log('slice: two separate discs');
{
  const g = makeField(
    (x, y) => Math.min(Math.hypot(x - 40, y) - 20, Math.hypot(x + 40, y) - 20),
    80,
    40,
    0.4,
  );
  const rings = contoursFromField(g.field, g.nx, g.ny, g.originX, g.originY, g.step);
  check('two separate contours', rings.length === 2, `got ${rings.length}`);
  check('both counter-clockwise', rings.every((r) => signedArea(r) > 0));
  const groups = groupContours(
    rings.map((points) => {
      const area = signedArea(points);
      return { points, area, isHole: area < 0 };
    }),
  );
  check('grouping gives two parts with no holes', groups.length === 2 && groups.every((g2) => g2.holes.length === 0));
}

console.log('slice: saddle cell resolution');
{
  // Two discs that nearly touch force saddle cells along the pinch.
  const g = makeField(
    (x, y) => Math.min(Math.hypot(x - 10.05, y) - 10, Math.hypot(x + 10.05, y) - 10),
    30,
    20,
    0.5,
  );
  const rings = contoursFromField(g.field, g.nx, g.ny, g.originX, g.originY, g.step);
  check('a near-touching pair stays closed', rings.length >= 1);
  check('all rings closed and oriented', rings.every((r) => Math.abs(signedArea(r)) > 1));
}

console.log('slice: layer planning');
{
  const bounds = { min: [-50, -50, 0], max: [50, 50, 100] };
  const zs = planeZs(bounds, { thickness: 3, spacerHeight: 6, resolution: 64, tolerance: 0.05, smoothing: 1 });
  check('pitch 9 over 100 mm gives 12 planes', zs.length === 12, `got ${zs.length}`);
  check('first plane sits at the bottom', near(zs[0], 0, 1e-9));
  check('planes are one pitch apart', near(zs[1] - zs[0], 9, 1e-9));

  const tight = planeZs(bounds, { thickness: 3, spacerHeight: 0, resolution: 64, tolerance: 0.05, smoothing: 1 });
  check('tight stacking gives 34 planes', tight.length === 34, `got ${tight.length}`);

  const capped = planeZs(bounds, {
    thickness: 0.1,
    spacerHeight: 0,
    resolution: 64,
    tolerance: 0.05,
    smoothing: 1,
    maxLayers: 50,
  });
  check('the layer cap holds', capped.length === 50);

  const degenerate = planeZs(bounds, { thickness: 0, spacerHeight: 0, resolution: 64, tolerance: 0.05, smoothing: 1 });
  check('zero pitch yields no planes rather than hanging', degenerate.length === 0);
}

console.log('slice: a sphere through the real SDF core');
{
  const sphere = findModule('sphere');
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 50, pz: 50 } },
  ];
  const prepared = prepareFeatures(tree);
  const sample = (x, y, z) => evaluatePoint(prepared, x, y, z);
  const bounds = modelBounds(tree);

  const set = sliceModel(sample, bounds, {
    thickness: 3,
    spacerHeight: 6,
    resolution: 200,
    tolerance: 0.05,
    smoothing: 1,
  });

  check('the sphere slices into layers', set.slices.length > 5, `got ${set.slices.length}`);
  check('layers are numbered from one', set.slices[0].index === 1);
  check(
    'layer numbers are contiguous',
    set.slices.every((s, i) => s.index === i + 1),
  );
  check('pitch is thickness plus spacer', near(set.pitch, 9, 1e-9));
  check(
    'every layer sits between the sphere poles',
    set.slices.every((s) => s.z >= 0 && s.z <= 100),
  );
  check('every layer has exactly one contour', set.slices.every((s) => s.contours.length === 1));
  check('no layer is a hole', set.slices.every((s) => !s.contours[0].isHole));

  // A sphere's cross-section radius at height z is sqrt(r^2 - (z-cz)^2).
  let worst = 0;
  for (const s of set.slices) {
    const expectedR = Math.sqrt(Math.max(2500 - (s.z - 50) ** 2, 0));
    const expectedArea = Math.PI * expectedR * expectedR;
    if (expectedArea < 50) continue;
    const relative = Math.abs(s.contours[0].area - expectedArea) / expectedArea;
    worst = Math.max(worst, relative);
  }
  check('every cross-section area matches the sphere within 2%', worst < 0.02, `worst ${(worst * 100).toFixed(2)}%`);

  const again = sliceModel(sample, bounds, {
    thickness: 3,
    spacerHeight: 6,
    resolution: 200,
    tolerance: 0.05,
    smoothing: 1,
  });
  check(
    'slicing is deterministic',
    JSON.stringify(again.slices) === JSON.stringify(set.slices),
  );
}

console.log('slice: a sharp box keeps its corners');
{
  const box = findModule('roundBox');
  const tree = [
    {
      kind: 'roundBox',
      enabled: true,
      params: { ...defaultParams(box), op: 'union', sx: 80, sy: 80, sz: 60, r: 0, pz: 30 },
    },
  ];
  const prepared = prepareFeatures(tree);
  const bounds = modelBounds(tree);
  const set = sliceModel((x, y, z) => evaluatePoint(prepared, x, y, z), bounds, {
    thickness: 3,
    spacerHeight: 6,
    resolution: 200,
    tolerance: 0.05,
    smoothing: 1,
  });

  const middle = set.slices[Math.floor(set.slices.length / 2)];
  check('a box slices', set.slices.length > 3);
  // 0.1%, not the 1% this started at. The measured error at these settings is
  // 0.006%, so a hundredfold margin still leaves the check able to see the
  // ordering bug it exists for — simplify-first eats over 15% of a small
  // square, and even a fraction of that would trip this.
  check(
    'the cross-section keeps its area within 0.1% of 80x80',
    Math.abs(middle.contours[0].area - 6400) / 6400 < 0.001,
    `got ${middle.contours[0].area.toFixed(1)} mm2, expected 6400`,
  );

  // Corner rounding is what the ordering bug would show up as: measure how far
  // the contour falls short of the true corner.
  let nearestCornerGap = Infinity;
  const pts = middle.contours[0].points;
  for (let i = 0; i < pts.length; i += 2) {
    nearestCornerGap = Math.min(
      nearestCornerGap,
      Math.hypot(pts[i] - 40, pts[i + 1] - 40),
    );
  }
  check(
    'a corner vertex lands within half a sample of the true corner',
    nearestCornerGap < set.step,
    `gap ${nearestCornerGap.toFixed(3)} mm, sample ${set.step.toFixed(3)} mm`,
  );
}

console.log('slice: a carved shape produces holes');
{
  const sphere = findModule('sphere');
  const capsule = findModule('capsule');
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 50, pz: 50 } },
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(capsule), op: 'subtract', h: 200, r: 12, pz: 50 },
    },
  ];
  const prepared = prepareFeatures(tree);
  const bounds = modelBounds(tree);
  const set = sliceModel((x, y, z) => evaluatePoint(prepared, x, y, z), bounds, {
    thickness: 3,
    spacerHeight: 6,
    resolution: 200,
    tolerance: 0.05,
    smoothing: 1,
  });

  const withHoles = set.slices.filter((s) => s.contours.some((c) => c.isHole));
  check('the bored channel shows up as holes', withHoles.length > 3, `${withHoles.length} layers with holes`);
  check(
    'each holed layer groups into one part with one hole',
    withHoles.every((s) => {
      const groups = groupContours(s.contours);
      return groups.length === 1 && groups[0].holes.length === 1;
    }),
  );
  check(
    'hole area is about the capsule cross-section',
    withHoles.every((s) => {
      const hole = s.contours.find((c) => c.isHole);
      return Math.abs(Math.abs(hole.area) - Math.PI * 144) / (Math.PI * 144) < 0.05;
    }),
  );
}

console.log('slice: the layer plan is a list of planes');
{
  const bounds = { min: [-50, -50, 0], max: [50, 50, 100] };
  const options = { thickness: 3, spacerHeight: 6, resolution: 100, tolerance: 0.05, smoothing: 1 };
  const planes = planLayers(bounds, options);

  check('a plane per layer', planes.length === planeZs(bounds, options).length);
  check('bottoms agree with planeZs', planes.every((p, i) => p.z0 === planeZs(bounds, options)[i]));
  check('numbered from zero', planes[0].index === 0 && planes[planes.length - 1].index === planes.length - 1);
  check('the mid-plane is half a sheet above the bottom', planes.every((p) => Math.abs(p.z - p.z0 - 1.5) < 1e-12));
  check('every gap is the spacer height', planes.every((p) => p.gapAbove === 6));
  check('and the sheets are their own thickness', planes.every((p) => p.thickness === 3));

  // The number a per-layer window rolls against. It counts planes examined
  // from the bottom of the model, not slices produced, so a model with a void
  // along Z skips a slice without shifting anybody's layer number.
  check(
    'consecutive planes are one pitch apart',
    planes.every((p, i) => i === 0 || Math.abs(p.z - planes[i - 1].z - 9) < 1e-12),
  );

  // The real zero-pitch hazard is a mistyped thickness. A negative spacer
  // height used to reach it too, by cancelling the thickness out; gaps are
  // counted in whole rings now and a ring count cannot go below zero, so that
  // route is closed by construction rather than guarded against.
  const empty = planLayers(bounds, { ...options, thickness: 0 });
  check('a zero thickness plans nothing rather than looping', empty.length === 0);
  const tight = planLayers(bounds, { ...options, spacerHeight: -3 });
  check('a negative gap is a tight stack, not an absent one', tight.length > 0);
  check('and its sheets touch', tight.every((p) => p.gapAbove === 0));

  // Gaps are whole rings of the spacer material, which is not the stock's.
  const thin = planLayers(bounds, { ...options, spacerThickness: 1 });
  check('a 6 mm gap from 1 mm rings is still 6 mm', thin.every((p) => p.gapAbove === 6));
  const coarse = planLayers(bounds, { ...options, spacerHeight: 4, spacerThickness: 3 });
  check(
    'a 4 mm gap from 3 mm rings is planned as the 3 mm it will be',
    coarse.every((p) => p.gapAbove === 3),
  );

  const graded = planLayers(bounds, {
    ...options,
    spacerHeight: 3,
    spacerHeightTop: 9,
    spacerThickness: 3,
  });
  check('a gradient opens the stack out', graded[0].gapAbove < graded[graded.length - 1].gapAbove,
    `${graded[0].gapAbove} at the bottom, ${graded[graded.length - 1].gapAbove} at the top`);
  check('every gap is a whole number of rings', graded.every((p) => Math.abs(p.gapAbove % 3) < 1e-12));
  check('gaps never shrink going up', graded.every((p, i) => i === 0 || p.gapAbove >= graded[i - 1].gapAbove));
  check('sheets still sit on top of the gap below', graded.every((p, i) =>
    i === 0 || Math.abs(p.z0 - (graded[i - 1].z0 + graded[i - 1].thickness + graded[i - 1].gapAbove)) < 1e-9));
  check('the mid-plane is still half a sheet up', graded.every((p) => Math.abs(p.z - p.z0 - 1.5) < 1e-12));

  // Uniform is its own branch, not the gradient with equal ends, because the
  // marching form accumulates rounding the closed form does not.
  // types.ts cannot import the slicer, so it carries its own copy of the ring
  // arithmetic for the readouts. If the two ever drift, a panel reports a pitch
  // the stack does not have.
  for (const [t, gap, ringT] of [[3, 6, 3], [3, 4, 3], [3, 6, 1], [0.5, 6, 3], [3, 0, 3]]) {
    const viaTypes = layerPitch({ name: 'm', thickness: t, kerf: 0.2, notes: '' }, {
      spacerHeight: gap,
      spacerThickness: ringT,
    });
    const viaPlan = t + ringsForGap(gap, ringT) * ringT;
    check(
      `layerPitch agrees with the plan at ${t} mm stock, ${gap} mm of ${ringT} mm rings`,
      Math.abs(viaTypes - viaPlan) < 1e-12,
      `${viaTypes} vs ${viaPlan}`,
    );
  }

  const asGradient = planLayers(bounds, { ...options, spacerHeightTop: options.spacerHeight });
  check(
    'equal ends give exactly the uniform stack',
    JSON.stringify(asGradient) === JSON.stringify(planes),
  );

  const capped = planLayers(bounds, { ...options, maxLayers: 4 });
  check('the cap holds', capped.length === 4);

  const set = (() => {
    const box = findModule('roundBox');
    const tree = [
      {
        kind: 'roundBox',
        enabled: true,
        params: { ...defaultParams(box), op: 'union', sx: 60, sy: 60, sz: 60, r: 0, pz: 30 },
      },
    ];
    const prepared = prepareFeatures(tree);
    return sliceModel(
      (x, y, z) => evaluatePoint(prepared, x, y, z),
      modelBounds(tree),
      options,
    );
  })();
  check('the slice set carries its planes', Array.isArray(set.planes) && set.planes.length > 0);
  // The one number the set still reports has to be a number the stack has.
  check(
    'the reported pitch is the one at the bottom of the plan',
    Math.abs(set.pitch - (set.planes[0].thickness + set.planes[0].gapAbove)) < 1e-12,
    `${set.pitch}`,
  );
  check('and one plane per plane examined', set.planes.length === set.planesExamined);
  check(
    'every slice sits on a plane',
    set.slices.every((slice) => set.planes.some((p) => Math.abs(p.z - slice.z) < 1e-12)),
  );
}

console.log('slice: prisms and cones through the real SDF core');
{
  const sliceOf = (params, kind) => {
    const mod = findModule(kind);
    const tree = [{ kind, enabled: true, params: { ...defaultParams(mod), op: 'union', ...params } }];
    const prepared = prepareFeatures(tree);
    const bounds = modelBounds(tree);
    return sliceModel((x, y, z) => evaluatePoint(prepared, x, y, z), bounds, {
      thickness: 3,
      spacerHeight: 6,
      resolution: 200,
      tolerance: 0.05,
      smoothing: 1,
    });
  };

  // A regular polygon's area is known exactly, so this checks the field, the
  // marching squares, the smoothing and the simplification in one number.
  for (const [n, r] of [[3, 60], [5, 50], [6, 50], [8, 45]]) {
    const set = sliceOf({ n, r, h: 60, corner: 0, pz: 30 }, 'prism');
    const middle = set.slices[Math.floor(set.slices.length / 2)];
    const exact = n * 0.5 * r * r * Math.sin((2 * Math.PI) / n);
    const error = Math.abs(middle.contours[0].area - exact) / exact;
    check(
      `a ${n}-sided prism slices to its analytic area`,
      error < 0.001,
      `got ${middle.contours[0].area.toFixed(1)} mm2, expected ${exact.toFixed(1)}`,
    );
    check(
      `and comes out as a polygon, not a circle`,
      middle.contours[0].points.length / 2 < n * 6,
      `${middle.contours[0].points.length / 2} points for ${n} corners`,
    );
  }

  // Every layer of a cone is a different circle, which is the whole reason to
  // have one: it checks the taper lands on the plane the slicer takes.
  {
    const set = sliceOf({ r1: 60, r2: 10, h: 90, pz: 45 }, 'cone');
    let worst = 0;
    for (const slice of set.slices) {
      const t = slice.z / 90;
      const radius = 60 + (10 - 60) * t;
      const want = Math.PI * radius * radius;
      worst = Math.max(worst, Math.abs(slice.contours[0].area - want) / want);
    }
    check('a cone gives layers', set.slices.length > 6, `${set.slices.length} layers`);
    check(
      'and every cross-section matches the taper',
      worst < 0.005,
      `worst ${(worst * 100).toFixed(3)}%`,
    );
    check(
      'the layers shrink from bottom to top',
      set.slices[0].contours[0].area > set.slices[set.slices.length - 1].contours[0].area,
    );
  }
}

console.log('slice: empty input');
{
  const set = sliceModel(() => 1, { min: [-10, -10, 0], max: [10, 10, 10] }, {
    thickness: 3,
    spacerHeight: 0,
    resolution: 32,
    tolerance: 0.05,
    smoothing: 1,
  });
  check('a field with nothing solid yields no slices', set.slices.length === 0);
  check('but the planes examined are still reported', set.planesExamined > 0);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    slicer');
