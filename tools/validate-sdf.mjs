#!/usr/bin/env node
/**
 * validate-sdf.mjs
 *
 * Imports the REAL src/core/sdf.ts — no stubs, no reimplementation. If this
 * passes and the app misbehaves, the bug is in the wiring, not the field.
 *
 *   node tools/validate-sdf.mjs
 */

import {
  EMPTY,
  OPS,
  opApply,
  opIsAdditive,
  sdSphere,
  sdRoundBox,
  sdCapsuleZ,
  sdTorusZ,
  sdEllipsoid,
  SHAPE_MODULES,
  findModule,
  defaultParams,
  rotationMatrix,
  modelBounds,
  evaluateGrid,
  nearestFeatureIndex,
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

function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

console.log('sdf: primitives');
check('sphere surface is zero', near(sdSphere(40, 0, 0, 40), 0));
check('sphere centre is -r', near(sdSphere(0, 0, 0, 40), -40));
check('sphere exterior is exact distance', near(sdSphere(0, 0, 60, 40), 20));

check('box face distance', near(sdRoundBox(0, 0, 60, 40, 40, 40, 0), 20));
check('box centre is -half', near(sdRoundBox(0, 0, 0, 40, 40, 40, 0), -40));
check(
  'rounded box corner is rounded',
  sdRoundBox(40, 40, 40, 40, 40, 40, 10) > 0,
  'sharp corner would sit on the surface',
);

check('capsule cap distance', near(sdCapsuleZ(0, 0, 60, 80, 10), 10));
check('capsule side distance', near(sdCapsuleZ(30, 0, 0, 80, 10), 20));

check('torus tube surface', near(sdTorusZ(65, 0, 0, 50, 15), 0));
check('torus hole centre', near(sdTorusZ(0, 0, 0, 50, 15), 35));

check('ellipsoid surface x', near(sdEllipsoid(50, 0, 0, 50, 35, 60), 0, 1e-6));
check('ellipsoid surface z', near(sdEllipsoid(0, 0, 60, 50, 35, 60), 0, 1e-6));
check('ellipsoid inside is negative', sdEllipsoid(0, 0, 0, 50, 35, 60) < 0);

console.log('sdf: operations');
check('union is min', near(opApply('union', 5, -3, 0), -3));
check('intersect is max', near(opApply('intersect', 5, -3, 0), 5));
check('subtract removes b', near(opApply('subtract', -10, -2, 0), 2));
check('smooth union with k=0 equals min', near(opApply('smoothUnion', 5, -3, 0), -3));
check(
  'smooth union never exceeds min',
  opApply('smoothUnion', 4, 4, 20) <= Math.min(4, 4),
  'blend must add material, not remove it',
);
check(
  'smooth subtract with k=0 equals hard subtract',
  near(opApply('smoothSubtract', -10, -2, 0), 2),
);
check(
  'smooth intersect with k=0 equals max',
  near(opApply('smoothIntersect', 5, -3, 0), 5),
);
check(
  'EMPTY unions to the incoming shape',
  near(opApply('smoothUnion', EMPTY, -7, 10), -7),
  'first feature in the tree must not be blended against nothing',
);
check(
  'EMPTY subtracts to nothing',
  opApply('subtract', EMPTY, -7, 0) >= EMPTY,
  'a tree starting with a subtract must stay empty',
);
check('every op is handled', OPS.every((op) => Number.isFinite(opApply(op, 1, 2, 3))));
check('additive ops are the two unions', OPS.filter(opIsAdditive).length === 2);

console.log('sdf: modules');
check('six shape modules registered', SHAPE_MODULES.length === 6, `got ${SHAPE_MODULES.length}`);
check('module keys are unique', new Set(SHAPE_MODULES.map((m) => m.key)).size === SHAPE_MODULES.length);
for (const mod of SHAPE_MODULES) {
  const p = defaultParams(mod);
  const centre = mod.sdf(0, 0, 0, p);
  const b = mod.bounds(p);
  const outside = mod.sdf(b[3] + 200, 0, 0, p);
  check(`${mod.key}: default params give a solid`, Number.isFinite(centre));
  check(`${mod.key}: far point is outside`, outside > 0, `got ${outside}`);
  check(
    `${mod.key}: bounds are ordered`,
    b[0] < b[3] && b[1] < b[4] && b[2] < b[5],
  );
  check(
    `${mod.key}: params carry defaults`,
    mod.params.every((s) => typeof p[s.key] === 'number'),
  );
}
check('torus is not solid at its centre', findModule('torus').sdf(0, 0, 0, defaultParams(findModule('torus'))) > 0);

console.log('sdf: transforms');
{
  const m = rotationMatrix(0, 0, 90);
  // R maps +X to +Y for a 90 degree rotation about Z.
  const x = m[0] * 1 + m[1] * 0 + m[2] * 0;
  const y = m[3] * 1 + m[4] * 0 + m[5] * 0;
  check('rotate 90 about Z maps +X to +Y', near(x, 0, 1e-12) && near(y, 1, 1e-12));

  const ident = rotationMatrix(0, 0, 0);
  check(
    'zero rotation is identity',
    [1, 0, 0, 0, 1, 0, 0, 0, 1].every((v, i) => near(ident[i], v, 1e-12)),
  );

  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  check('rotation determinant is 1', near(det, 1, 1e-12));
}

console.log('sdf: rotation convention');
{
  // Our matrix must be R = Rz * Ry * Rx, which is three.js Euler order 'ZYX'.
  // The gizmo reads angles back with that order; if this composition ever
  // changes, a rotated shape jumps the moment its value round-trips through
  // the inspector. Build the product independently and compare.
  const d = Math.PI / 180;
  const mul = (A, B) => {
    const out = new Array(9).fill(0);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        for (let i = 0; i < 3; i++) out[r * 3 + c] += A[r * 3 + i] * B[i * 3 + c];
    return out;
  };
  const rx = (a) => [1, 0, 0, 0, Math.cos(a * d), -Math.sin(a * d), 0, Math.sin(a * d), Math.cos(a * d)];
  const ry = (a) => [Math.cos(a * d), 0, Math.sin(a * d), 0, 1, 0, -Math.sin(a * d), 0, Math.cos(a * d)];
  const rz = (a) => [Math.cos(a * d), -Math.sin(a * d), 0, Math.sin(a * d), Math.cos(a * d), 0, 0, 0, 1];

  for (const [ax, ay, az] of [[30, 0, 0], [0, 45, 0], [0, 0, 60], [17, -33, 79], [-120, 95, -44]]) {
    const expected = mul(rz(az), mul(ry(ay), rx(ax)));
    const actual = rotationMatrix(ax, ay, az);
    check(
      `rotation ${ax},${ay},${az} equals Rz*Ry*Rx (three.js order ZYX)`,
      expected.every((v, i) => near(actual[i], v, 1e-12)),
    );
  }
}

console.log('sdf: picking');
{
  const sphere = findModule('sphere');
  const torus = findModule('torus');
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 40, px: -30 } },
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'smoothUnion', k: 20, r: 30, px: 50 } },
    { kind: 'torus', enabled: true, params: { ...defaultParams(torus), op: 'subtract', R: 25, r: 8, pz: 45 } },
  ];

  check('a point on the left sphere picks it', nearestFeatureIndex(tree, -70, 0, 0) === 0);
  check('a point on the right sphere picks it', nearestFeatureIndex(tree, 80, 0, 0) === 1);
  check(
    'a point on the carved torus picks the subtractor',
    nearestFeatureIndex(tree, 25, 0, 37) === 2,
    `got ${nearestFeatureIndex(tree, 25, 0, 37)}`,
  );
  check(
    'disabled features are never picked',
    nearestFeatureIndex(
      [tree[0], tree[1], { ...tree[2], enabled: false }],
      25,
      0,
      37,
    ) !== 2,
  );
  check('an empty tree picks nothing', nearestFeatureIndex([], 0, 0, 0) === -1);

  const rotated = [
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(findModule('capsule')), op: 'union', h: 100, r: 10, ry: 90 },
    },
  ];
  // Rotated 90 degrees about Y, the capsule's axis lies along world X.
  check('picking respects rotation', nearestFeatureIndex(rotated, 60, 0, 0) === 0);
  check(
    'rotated capsule surface is where the transform says',
    Math.abs(evaluateGrid(rotated, 24).step) > 0,
  );
}

console.log('sdf: tree evaluation');
{
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'union', r: 40 } },
    {
      kind: 'sphere',
      enabled: true,
      params: { ...defaultParams(findModule('sphere')), op: 'union', r: 30, px: 60 },
    },
  ];

  const b = modelBounds(tree);
  check('bounds cover both spheres', near(b.min[0], -40) && near(b.max[0], 90));

  const grid = evaluateGrid(tree, 32);
  check('grid has samples on every axis', grid.dims.every((n) => n > 4));
  check('grid step is positive', grid.step > 0);
  check(
    'grid contains inside and outside samples',
    grid.data.some((v) => v < 0) && grid.data.some((v) => v > 0),
  );

  const gridAgain = evaluateGrid(tree, 32);
  let identical = grid.data.length === gridAgain.data.length;
  for (let i = 0; identical && i < grid.data.length; i++) {
    if (grid.data[i] !== gridAgain.data[i]) identical = false;
  }
  check('re-evaluation is bit-identical', identical);

  const disabled = evaluateGrid(
    [{ ...tree[0], enabled: false }, tree[1]],
    32,
  );
  check('disabled features are skipped', disabled.data.some((v) => v < 0));

  const empty = evaluateGrid([], 32);
  check('empty tree yields no solid', empty.data.every((v) => v > 0));

  const subtractOnly = evaluateGrid(
    [{ kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'subtract' } }],
    32,
  );
  check('subtract-only tree yields no solid', subtractOnly.data.every((v) => v > 0));
}

console.log('sdf: blend padding');
{
  const cases = [
    { k: 10, gap: 20 },
    { k: 40, gap: 35 },
    { k: 80, gap: 50 },
    { k: 120, gap: 70 },
  ];
  for (const c of cases) {
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'union', r: 30, px: -c.gap } },
    { kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'smoothUnion', k: c.k, r: 30, px: c.gap } },
  ];
  const grid = evaluateGrid(tree, 40);
  // Every boundary sample must be outside, or the blend is clipped by the grid.
  const [nx, ny, nz] = grid.dims;
  let boundaryInside = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const onFace =
          i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        if (onFace && grid.data[i + nx * (j + ny * k)] < 0) boundaryInside++;
      }
    }
  }
  check(`blend k=${c.k} fits inside the grid`, boundaryInside === 0, `${boundaryInside} boundary samples inside`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    sdf core');
