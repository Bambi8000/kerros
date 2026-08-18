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

import {
  signedArea,
  perimeter,
  pointInRing,
  simplifyRing,
  smoothRing,
  contoursFromField,
  groupContours,
  planeZs,
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
  check(
    'the cross-section keeps its area within 1% of 80x80',
    Math.abs(middle.contours[0].area - 6400) / 6400 < 0.01,
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
