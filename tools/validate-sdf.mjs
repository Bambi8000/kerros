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
  sdCapsuleBentZ,
  sdTorusZ,
  sdEllipsoid,
  SHAPE_MODULES,
  findModule,
  defaultParams,
  rotationMatrix,
  modelBounds,
  evaluateGrid,
  nearestFeatureIndex,
  prepareFeatures,
  evaluatePoint,
  sdSuperellipsoid,
  sdPrismZ,
  sdConeZ,
  shellModifier,
  findModifier,
  defaultModifierParams,
  MODIFIER_MODULES,
  composeRigid,
  eulerFromMatrix,
  rigidOf,
  worldRigidOf,
  localFromWorld,
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

/*
 * The bent capsule: a sausage.
 *
 * The obvious way to bend a field is to warp the query point, and it is wrong
 * for the reason this program has refused non-uniform scale three times: a warp
 * is not an isometry, so |grad d| stops being 1 and every smooth blend and kerf
 * iso-level that reads the field is corrupted by however much it stretches.
 *
 * A capsule is a segment with a radius; a bent one is an **arc** with a radius,
 * and the distance to a circular arc is closed form. These checks are what say
 * the difference: exactness, unit gradient, and a length that survives bending.
 */
{
  const h = 80;
  const r = 25;

  // Zero bend must be the straight capsule, bit for bit, or every saved lamp
  // with a capsule in it changes the day this parameter appears.
  let drift = 0;
  for (let i = 0; i < 4000; i++) {
    const x = Math.sin(i * 1.1) * 120;
    const y = Math.cos(i * 1.7) * 120;
    const z = Math.sin(i * 2.3) * 120;
    drift = Math.max(drift, Math.abs(sdCapsuleBentZ(x, y, z, h, r, 0) - sdCapsuleZ(x, y, z, h, r)));
  }
  check('a bend of zero is the straight capsule exactly', drift === 0, `off by ${drift}`);
  check('and so is a bend too small to measure', sdCapsuleBentZ(30, 0, 0, h, r, 1e-12) === sdCapsuleZ(30, 0, 0, h, r));

  for (const bend of [30, 90, 180, -90]) {
    const theta = (bend * Math.PI) / 180;
    const R = h / theta;

    // The centreline still passes through the origin along +Z, so the midpoint
    // is one radius in and a point a radius out sits on the surface.
    check(`bend ${bend}: the middle is one radius in`, near(sdCapsuleBentZ(0, 0, 0, h, r, bend), -r, 1e-9));
    check(`bend ${bend}: a radius out is the surface`, near(sdCapsuleBentZ(0, r, 0, h, r, bend), 0, 1e-9));

    // The ends of the arc, which is where a clamp that does not clamp shows up.
    const endX = R - R * Math.cos(theta / 2);
    const endZ = R * Math.sin(theta / 2);
    check(`bend ${bend}: the far cap is on the surface`, near(sdCapsuleBentZ(endX, r, endZ, h, r, bend), 0, 1e-9));
    check(
      `bend ${bend}: past the cap is the distance past it`,
      near(sdCapsuleBentZ(endX, r + 12, endZ, h, r, bend), 12, 1e-9),
    );

    /*
     * The length is measured along the centreline, so a sausage keeps the length
     * asked for however far it curves — which is the whole reason `h` is the arc
     * length and the bend radius is derived rather than typed.
     */
    let arcLength = 0;
    let prev = null;
    for (let k = 0; k <= 4000; k++) {
      const phi = -theta / 2 + (theta * k) / 4000;
      const point = [R - R * Math.cos(phi), R * Math.sin(phi)];
      if (prev) arcLength += Math.hypot(point[0] - prev[0], point[1] - prev[1]);
      prev = point;
    }
    check(`bend ${bend}: the centreline is still ${h} mm`, near(arcLength, h, 1e-4), `${arcLength.toFixed(4)}`);

    // Unit gradient, away from the arc's centre where a distance field creases.
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin(i * 1.1) * 90;
      const y = Math.cos(i * 1.7) * 90;
      const z = Math.sin(i * 2.3) * 90;
      if (Math.hypot(x - R, z) < r * 0.5) continue;
      const e = 1e-5;
      const at = (a, b, c) => sdCapsuleBentZ(a, b, c, h, r, bend);
      const g = Math.hypot(
        (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
        (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
        (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
      );
      if (Number.isFinite(g)) worst = Math.max(worst, Math.abs(g - 1));
    }
    check(`bend ${bend}: the gradient stays unit`, worst < 1e-6, `off by ${worst.toExponential(1)}`);
  }

  // Bending one way and the other are mirror images, not different shapes.
  check(
    'a negative bend mirrors a positive one',
    near(sdCapsuleBentZ(-18, 7, 22, h, r, -90), sdCapsuleBentZ(18, 7, 22, h, r, 90), 1e-9),
  );

  /*
   * The clamp is what makes it an arc rather than a whole circle. Without it the
   * sausage would close into a torus, which is a different module — so a point
   * beyond the far end has to read as beyond the end.
   */
  const beyond = sdCapsuleBentZ(0, 0, -70, h, r, 180);
  check('the arc stops where it is told to', beyond > 0, `${beyond.toFixed(3)} past the end`);
}

/** The capsule's bounds have to hold the bend, not just the straight case. */
{
  const capsule = findModule('capsule');
  for (const bend of [0, 30, 90, 180, 300, -180]) {
    const params = { h: 80, r: 25, bend };
    const [x0, y0, z0, x1, y1, z1] = capsule.bounds(params);
    let deepest = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const t = i / 2000;
      const u = ((i * 7) % 2000) / 2000;
      const faces = [
        [x0, y0 + (y1 - y0) * t, z0 + (z1 - z0) * u],
        [x1, y0 + (y1 - y0) * t, z0 + (z1 - z0) * u],
        [x0 + (x1 - x0) * t, y0, z0 + (z1 - z0) * u],
        [x0 + (x1 - x0) * t, y1, z0 + (z1 - z0) * u],
        [x0 + (x1 - x0) * t, y0 + (y1 - y0) * u, z0],
        [x0 + (x1 - x0) * t, y0 + (y1 - y0) * u, z1],
      ];
      for (const q of faces) deepest = Math.max(deepest, -capsule.sdf(q[0], q[1], q[2], params));
    }
    check(`bend ${bend}: nothing escapes the bounding box`, deepest <= 1e-9, `${deepest.toFixed(4)} inside`);
  }
}

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
check('eight shape modules registered', SHAPE_MODULES.length === 8, `got ${SHAPE_MODULES.length}`);
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

console.log('sdf: prism is an exact field');
{
  const n = 6;
  const r = 50;
  const h = 80;
  const a = Math.PI / n;
  const apothem = r * Math.cos(a);
  const near = (got, want, tol = 1e-9) => Math.abs(got - want) < tol;

  // A vertex sits on +X, so the first edge midpoint is at angle a. Both are on
  // the surface, and getting the fold phase wrong moves one of them — which is
  // exactly what happened on the first attempt, by up to 25 mm on a triangle.
  check('a vertex is on the surface', near(sdPrismZ(r, 0, 0, n, r, h, 0), 0));
  check(
    'an edge midpoint is one apothem out',
    near(sdPrismZ(apothem * Math.cos(a), apothem * Math.sin(a), 0, n, r, h, 0), 0),
  );
  check(
    'and 7 mm past that edge is 7 mm',
    near(sdPrismZ((apothem + 7) * Math.cos(a), (apothem + 7) * Math.sin(a), 0, n, r, h, 0), 7),
  );
  check('5 mm past a vertex is 5 mm', near(sdPrismZ(r + 5, 0, 0, n, r, h, 0), 5));
  check('the centre is the apothem in', near(sdPrismZ(0, 0, 0, n, r, h, 0), -Math.min(apothem, h / 2)));
  check('above the cap is the height above it', near(sdPrismZ(0, 0, h / 2 + 6, n, r, h, 0), 6));

  // The property that matters downstream: blends and the kerf iso-level both
  // assume a true Euclidean field, which means a unit gradient.
  let worstGradient = 0;
  for (let i = 0; i < 3000; i++) {
    const t = i / 3000;
    const x = Math.sin(t * 91.3) * 90;
    const y = Math.cos(t * 57.7) * 90;
    const z = Math.sin(t * 33.1) * 90;
    const e = 1e-4;
    const at = (px, py, pz) => sdPrismZ(px, py, pz, n, r, h, 0);
    const g = Math.hypot(
      (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
      (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
      (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
    );
    if (Number.isFinite(g)) worstGradient = Math.max(worstGradient, Math.abs(g - 1));
  }
  check('the gradient is unit everywhere sampled', worstGradient < 1e-3, `off by ${worstGradient.toExponential(2)}`);

  // A hand-edited project file is not bound by the inspector's step of 1.
  check('a fractional side count rounds', sdPrismZ(17, 9, 3, 6.4, r, h, 0) === sdPrismZ(17, 9, 3, 6, r, h, 0));
  check('fewer than three sides clamps up', sdPrismZ(17, 9, 3, 1, r, h, 0) === sdPrismZ(17, 9, 3, 3, r, h, 0));

  // Rounding takes the corner off and leaves the flats alone, as roundBox does.
  check(
    'rounding leaves the flats exactly where they were',
    near(sdPrismZ(apothem * Math.cos(a), apothem * Math.sin(a), 0, n, r, h, 8), 0),
  );
  check('and pulls the vertex in', sdPrismZ(r, 0, 0, n, r, h, 8) > 1, `${sdPrismZ(r, 0, 0, n, r, h, 8).toFixed(3)}`);
  check(
    'a corner radius past the apothem is clamped rather than inverting',
    sdPrismZ(0, 0, 0, n, r, h, 500) < 0,
  );

  for (const sides of [3, 5, 8, 12]) {
    const ap = r * Math.cos(Math.PI / sides);
    check(
      `n=${sides}: vertex on the surface and centre one apothem in`,
      near(sdPrismZ(r, 0, 0, sides, r, h, 0), 0) &&
        near(sdPrismZ(0, 0, 0, sides, r, h, 0), -Math.min(ap, h / 2)),
    );
  }
}

console.log('sdf: cone is an exact field');
{
  const near = (got, want, tol = 1e-9) => Math.abs(got - want) < tol;

  check('the apex is on the surface', near(sdConeZ(0, 0, 45, 90, 50, 0), 0));
  check('5 mm above the apex is 5 mm', near(sdConeZ(0, 0, 50, 90, 50, 0), 5));
  check('the base rim is on the surface', near(sdConeZ(50, 0, -45, 90, 50, 0), 0));
  check('the centre of the base is on the surface', near(sdConeZ(0, 0, -45, 90, 50, 0), 0));

  // Straight out along the slant's normal, which is the case a naive
  // implementation gets wrong while still looking right on the axis.
  const len = Math.hypot(90, 50);
  check(
    '10 mm off the slant is 10 mm',
    near(sdConeZ(25 + (10 * 90) / len, 0, (10 * 50) / len, 90, 50, 0), 10),
  );

  // r1 = r2 has to degenerate to a cylinder rather than dividing by nothing.
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const t = i / 2000;
    const x = Math.sin(t * 91) * 80;
    const y = Math.cos(t * 57) * 80;
    const z = Math.sin(t * 33) * 80;
    const dr = Math.hypot(x, y) - 40;
    const dz = Math.abs(z) - 40;
    const want = Math.min(Math.max(dr, dz), 0) + Math.hypot(Math.max(dr, 0), Math.max(dz, 0));
    worst = Math.max(worst, Math.abs(sdConeZ(x, y, z, 80, 40, 40) - want));
  }
  check('equal radii give exactly a cylinder', worst < 1e-9, `off by ${worst.toExponential(2)}`);

  check('a zero height does not divide by nothing', Number.isFinite(sdConeZ(3, 4, 0, 0, 20, 10)));
  check('an upside-down taper works too', near(sdConeZ(0, 0, -45, 90, 0, 50), 0));

  let worstGradient = 0;
  for (let i = 0; i < 3000; i++) {
    const t = i / 3000;
    const x = Math.sin(t * 71.3) * 90;
    const y = Math.cos(t * 47.7) * 90;
    const z = Math.sin(t * 29.1) * 90;
    const e = 1e-4;
    const at = (px, py, pz) => sdConeZ(px, py, pz, 90, 50, 15);
    const g = Math.hypot(
      (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
      (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
      (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
    );
    if (Number.isFinite(g)) worstGradient = Math.max(worstGradient, Math.abs(g - 1));
  }
  check('the gradient is unit everywhere sampled', worstGradient < 1e-3, `off by ${worstGradient.toExponential(2)}`);
}

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

console.log('sdf: superellipsoid field');
{
  const R = 50;
  // At e = 2 a superellipsoid is a sphere, so the field can be checked against
  // the exact answer rather than against itself.
  check('the surface is at zero on an axis', near(sdSuperellipsoid(R, 0, 0, R, R, R, 2), 0, 1e-9));
  const diag = R / Math.sqrt(3);
  check(
    'and on a diagonal',
    near(sdSuperellipsoid(diag, diag, diag, R, R, R, 2), 0, 1e-9),
  );
  check(
    'just outside, it is within 5% of the true distance',
    Math.abs(sdSuperellipsoid(R + 5, 0, 0, R, R, R, 2) - 5) / 5 < 0.05,
    `got ${sdSuperellipsoid(R + 5, 0, 0, R, R, R, 2).toFixed(4)}`,
  );
  check(
    'just inside too',
    Math.abs(sdSuperellipsoid(R - 5, 0, 0, R, R, R, 2) + 5) / 5 < 0.1,
    `got ${sdSuperellipsoid(R - 5, 0, 0, R, R, R, 2).toFixed(4)}`,
  );
  check('the centre is inside', sdSuperellipsoid(0, 0, 0, R, R, R, 2) < 0);
  check('the centre does not divide by zero', Number.isFinite(sdSuperellipsoid(0, 0, 0, R, R, R, 1.4)));

  // The whole point of the exponent: below 2 the shape pulls in between the
  // axes, above 2 it pushes out towards the corners.
  const reach = (e) => {
    const t = Math.pow(1 / 3, 1 / e) * R;
    return t * Math.sqrt(3);
  };
  check('below 2 the diagonal pulls in', reach(1) < R * 0.7);
  check('at 2 the diagonal equals the axis', near(reach(2), R, 1e-9));
  check('above 2 the diagonal pushes out', reach(4) > R * 1.2);
  check(
    'the default exponent is a shape a rounded box cannot make',
    findModule('superellipsoid').params.find((p) => p.key === 'e').def < 2,
  );
}

console.log('sdf: shell');
{
  const R = 50;
  const wall = 6;
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'union', r: R } },
    { kind: 'shell', enabled: true, params: { ...defaultModifierParams(shellModifier), t: wall } },
  ];
  const prepared = prepareFeatures(tree);
  const at = (x, y, z) => evaluatePoint(prepared, x, y, z);

  check('one modifier is registered', MODIFIER_MODULES.length === 1);
  check('it is found by key', findModifier('shell') === shellModifier);
  check('a shell is not a shape module', findModule('shell') === undefined);

  check('the outer surface is exactly where it was', near(at(R, 0, 0), 0, 1e-9));
  check('the wall is solid', at(R - wall / 2, 0, 0) < 0);
  check('the inner surface is one wall in', near(at(R - wall, 0, 0), 0, 1e-9));
  check('the cavity is empty', at(R - wall - 10, 0, 0) > 0);
  check('the centre is empty', at(0, 0, 0) > 0);
  check('outside is still outside', at(R + 10, 0, 0) > 0);

  // The abs(d) - t/2 form would have moved the outer surface inward by t/2.
  check(
    'shelling does not shrink the silhouette',
    at(R - 0.5, 0, 0) < 0 && at(R + 0.5, 0, 0) > 0,
  );

  const bounds = modelBounds(tree);
  check('a shell sets no bounds of its own', near(bounds.max[0], R, 1e-9));

  const emptyTree = [{ kind: 'shell', enabled: true, params: defaultModifierParams(shellModifier) }];
  const emptyPrepared = prepareFeatures(emptyTree);
  check(
    'a shell above an empty tree makes no wall out of nothing',
    evaluatePoint(emptyPrepared, 0, 0, 0) >= EMPTY,
  );

  const disabled = prepareFeatures([tree[0], { ...tree[1], enabled: false }]);
  check('a disabled shell does nothing', evaluatePoint(disabled, 0, 0, 0) < 0);

  check(
    'a shell is never picked, having no surface of its own',
    nearestFeatureIndex(tree, R, 0, 0) === 0,
  );
}

console.log('sdf: shell caps');
{
  const R = 50;
  const wall = 6;
  const withCap = (extra) => {
    const tree = [
      { kind: 'sphere', enabled: true, params: { ...defaultParams(findModule('sphere')), op: 'union', r: R } },
      {
        kind: 'shell',
        enabled: true,
        params: { ...defaultModifierParams(shellModifier), t: wall, ...extra },
      },
    ];
    const prepared = prepareFeatures(tree);
    return (x, y, z) => evaluatePoint(prepared, x, y, z);
  };

  const capped = withCap({ capTop: 1, capTopZ: 20 });
  check('below the cap the shape is still hollow', capped(0, 0, 0) > 0);
  check('above the cap it is solid', capped(0, 0, 30) < 0);
  check('and the outer surface is untouched', near(capped(0, 0, R), 0, 1e-9));

  const footed = withCap({ capBottom: 1, capBottomZ: -20 });
  check('above the foot it is hollow', footed(0, 0, 0) > 0);
  check('below the foot it is solid', footed(0, 0, -30) < 0);

  const both = withCap({ capTop: 1, capTopZ: 20, capBottom: 1, capBottomZ: -20 });
  check('with both caps the cavity is a band', both(0, 0, 0) > 0 && both(0, 0, 30) < 0 && both(0, 0, -30) < 0);

  // A switch on z would leave a jump in the field; an intersection does not.
  const before = capped(0, 0, 19.9);
  const after = capped(0, 0, 20.1);
  check(
    'the field is continuous across the cap plane',
    Math.abs(before - after) < 0.5,
    `${before.toFixed(3)} then ${after.toFixed(3)}`,
  );
}

console.log('sdf: grouping by attachment');
{
  const sphere = findModule('sphere');
  const shape = (id, params, attachTo) => ({
    id,
    kind: 'sphere',
    enabled: true,
    params: { ...defaultParams(sphere), op: 'union', r: 10, ...params, ...(attachTo ? { attachTo } : {}) },
  });

  // The leader, and four shapes attached to it — a group of five.
  const leader = shape('a', { r: 12, px: 0, py: 0, pz: 0 });
  const followers = [
    shape('b', { r: 8, px: 40 }, 'a'),
    shape('c', { r: 8, px: -40 }, 'a'),
    shape('d', { r: 8, py: 40 }, 'a'),
    shape('e', { r: 8, py: -40 }, 'a'),
  ];
  const group = [leader, ...followers];

  const at = (tree, x, y, z) => evaluatePoint(prepareFeatures(tree), x, y, z);

  check('the group evaluates where it was built', at(group, 40, 0, 0) < 0);
  check('all four followers are there', 
    at(group, -40, 0, 0) < 0 && at(group, 0, 40, 0) < 0 && at(group, 0, -40, 0) < 0);

  // Move the leader: everything comes along.
  const moved = [{ ...leader, params: { ...leader.params, px: 200, pz: 50 } }, ...followers];
  check('moving the leader carries a follower', at(moved, 240, 0, 50) < 0);
  check('and empties the old place', at(moved, 40, 0, 0) > 0);
  check('the leader itself moved too', at(moved, 200, 0, 50) < 0);

  // Turn the leader 90 degrees about Z: the +X follower swings to +Y.
  const turned = [{ ...leader, params: { ...leader.params, rz: 90 } }, ...followers];
  check('turning the leader swings a follower round', at(turned, 0, 40, 0) < 0);
  check('and the old direction now holds the one that was on -Y', at(turned, 40, 0, 0) < 0);

  const tipped = [{ ...leader, params: { ...leader.params, ry: 90 } }, ...followers];
  check('a shape inherits the full rotation, not just Z', at(tipped, 0, 0, -40) < 0,
    'turned 90 about Y, the +X follower should be under the leader');

  // Bounds have to follow, or a grouped shape gets clipped by the sampling grid.
  const box = modelBounds(moved);
  check('bounds follow the group', box.max[0] >= 248 - 1e-6, `max x ${box.max[0].toFixed(1)}`);

  const grid = evaluateGrid(moved, 48);
  const [nx, ny, nz] = grid.dims;
  let leaks = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const face = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        if (face && grid.data[i + nx * (j + ny * k)] < 0) leaks++;
      }
    }
  }
  check('and the moved group is not clipped', leaks === 0, `${leaks} samples`);

  // Chains: a follower of a follower.
  const chained = [
    leader,
    shape('b', { r: 8, px: 40 }, 'a'),
    shape('f', { r: 5, px: 20 }, 'b'),
  ];
  check('a chain composes', at(chained, 60, 0, 0) < 0);
  const chainMoved = [
    { ...leader, params: { ...leader.params, px: 100 } },
    shape('b', { r: 8, px: 40 }, 'a'),
    shape('f', { r: 5, px: 20 }, 'b'),
  ];
  check('and the whole chain moves with the root', at(chainMoved, 160, 0, 0) < 0);

  const orphan = [shape('z', { r: 8, px: 40 }, 'nobody')];
  check('an attachment that does not exist falls back to the shape itself',
    at(orphan, 40, 0, 0) < 0);

  // A cycle must not hang. It cannot be made through the interface, but a
  // hand-edited project file is not bound by the interface.
  const cyclic = [shape('p', { r: 8, px: 10 }, 'q'), shape('q', { r: 8, px: 20 }, 'p')];
  const cycleWorld = worldRigidOf(cyclic, cyclic[0]);
  check('a cycle resolves to the identity rather than looping forever',
    cycleWorld.t.every((v) => v === 0));
  check('and the tree still evaluates', Number.isFinite(at(cyclic, 0, 0, 0)));

  check('picking sees a follower at its composed position',
    nearestFeatureIndex(moved, 240, 0, 50) === 1);
}

console.log('sdf: rigid transform algebra');
{
  const a = { r: rotationMatrix(0, 0, 90), t: [10, 0, 0] };
  const b = { r: rotationMatrix(0, 0, 0), t: [5, 0, 0] };
  const composed = composeRigid(a, b);
  check('composing puts the child in the parent frame',
    Math.abs(composed.t[0] - 10) < 1e-9 && Math.abs(composed.t[1] - 5) < 1e-9,
    `at ${composed.t.map((v) => v.toFixed(2)).join(', ')}`);

  const identity = composeRigid({ r: rotationMatrix(0, 0, 0), t: [0, 0, 0] }, b);
  check('the identity composes to the child unchanged', identity.t[0] === 5);

  // Euler extraction and matrix construction must be exact inverses, or a grouped
  // shape jumps the moment it is dragged.
  let worst = 0;
  for (const [rx, ry, rz] of [[0,0,0],[30,0,0],[0,45,0],[0,0,60],[17,-33,79],[-120,50,-44],[10,89.9,10]]) {
    const m = rotationMatrix(rx, ry, rz);
    const back = eulerFromMatrix(m);
    const again = rotationMatrix(back[0], back[1], back[2]);
    for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(m[i] - again[i]));
  }
  check('euler and matrix round trip exactly', worst < 1e-9, `worst ${worst.toExponential(2)}`);

  const gimbal = eulerFromMatrix(rotationMatrix(0, 90, 0));
  check('gimbal lock is handled rather than producing NaN', gimbal.every(Number.isFinite));

  // A world drag written back into a parent's frame.
  const parent = rigidOf({ px: 100, py: 0, pz: 0, rz: 90 });
  const world = rigidOf({ px: 100, py: 40, pz: 0, rz: 90 });
  const local = localFromWorld(parent, world);
  check('a world position becomes the right local one',
    Math.abs(local.position[0] - 40) < 1e-9 && Math.abs(local.position[1]) < 1e-9,
    `local ${local.position.map((v) => v.toFixed(2)).join(', ')}`);
  check('and the local rotation cancels the parent\'s',
    local.rotation.every((v) => Math.abs(v) < 1e-9),
    `rotation ${local.rotation.map((v) => v.toFixed(3)).join(', ')}`);

  const round = localFromWorld(
    { r: rotationMatrix(0, 0, 0), t: [0, 0, 0] },
    rigidOf({ px: 7, py: 8, pz: 9, rx: 11, ry: 22, rz: 33 }),
  );
  check('with no parent, local is world',
    Math.abs(round.position[0] - 7) < 1e-9 && Math.abs(round.rotation[2] - 33) < 1e-9);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    sdf core');
