#!/usr/bin/env node
/**
 * validate-pattern.mjs
 *
 * Checks the pattern generators against the real SDF core, on a real shelled
 * form. The point of interest is the bridge width: a pattern that leaves a
 * 0.3 mm strip of cardboard is a pattern that falls apart on the bed, so the
 * limit is measured on the output rather than trusted from the code that
 * placed it.
 *
 *   node tools/validate-pattern.mjs
 */

import {
  PATTERN_KINDS,
  PATTERN_LABELS,
  generatePattern,
  holeFits,
  patternCutRadius,
  measuredBridge,
} from '../src/core/pattern.ts';

import {
  prepareFeatures,
  evaluatePoint,
  modelBounds,
  defaultParams,
  defaultModifierParams,
  findModule,
  shellModifier,
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

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A hollow cylinder, radius 60, wall 10, from z = 0 to 90. */
function tube(wall = 10) {
  const capsule = findModule('capsule');
  const tree = [
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(capsule), op: 'union', h: 90, r: 60, pz: 45 },
    },
    { kind: 'shell', enabled: true, params: { ...defaultModifierParams(shellModifier), t: wall } },
  ];
  const prepared = prepareFeatures(tree);
  return {
    sample: (x, y, z) => evaluatePoint(prepared, x, y, z),
    bounds: modelBounds(tree),
  };
}

function inputFor(model, layer = 5, existing = []) {
  return {
    z: 45,
    bounds: {
      minX: model.bounds.min[0],
      minY: model.bounds.min[1],
      maxX: model.bounds.max[0],
      maxY: model.bounds.max[1],
    },
    existing,
    sample: model.sample,
    layer,
  };
}

const baseOptions = {
  kind: 'hex',
  radius: 2,
  pitch: 8,
  minBridge: 1.5,
  density: 1,
  kerf: 0.2,
  seed: 7,
  rotatePerLayer: false,
};

console.log('pattern: kerf compensation');
{
  check('the cut path is half a kerf smaller', near(patternCutRadius(2, 0.2), 1.9, 1e-12));
  check('zero kerf leaves the radius alone', near(patternCutRadius(2, 0), 2, 1e-12));
  check('an absurd kerf clamps rather than inverting', patternCutRadius(0.5, 5) > 0);
}

console.log('pattern: acceptance test');
{
  const model = tube();
  const input = inputFor(model);

  // Mid-wall on a 10 mm wall: 5 mm of material each way.
  check('a small hole fits mid-wall', holeFits(55, 0, input, baseOptions, []));
  check(
    'a hole too big for the wall does not',
    !holeFits(55, 0, input, { ...baseOptions, radius: 4.5 }, []),
  );
  check('a hole in the central void does not fit', !holeFits(0, 0, input, baseOptions, []));
  check('nor does one outside the form', !holeFits(90, 0, input, baseOptions, []));
  check(
    'a hole right at the wall face does not fit',
    !holeFits(59.9, 0, input, baseOptions, []),
  );

  const crowded = [{ x: 55, y: 0, r: 1.9 }];
  check(
    'a hole too close to an existing one does not fit',
    !holeFits(58, 0, input, baseOptions, crowded),
  );
  check(
    'but one far enough away does',
    holeFits(55, 8, input, baseOptions, crowded),
  );
}

console.log('pattern: every generator');
{
  const model = tube();
  const input = inputFor(model);

  check('four kinds are registered', PATTERN_KINDS.length === 4);
  check('each has a label', PATTERN_KINDS.every((k) => typeof PATTERN_LABELS[k] === 'string'));

  for (const kind of PATTERN_KINDS) {
    const circles = generatePattern(input, { ...baseOptions, kind });
    check(`${kind}: places holes`, circles.length > 10, `${circles.length} holes`);

    const bridge = measuredBridge(circles, input, baseOptions.kerf);
    check(
      `${kind}: respects the bridge width`,
      bridge >= baseOptions.minBridge - 1e-9,
      `narrowest bridge ${bridge.toFixed(3)} mm, limit ${baseOptions.minBridge}`,
    );

    const inWall = circles.every((c) => {
      const r = Math.hypot(c.x, c.y);
      return r > 50 - 1e-6 && r < 60 + 1e-6;
    });
    check(`${kind}: every hole lands in the wall band`, inWall);

    check(
      `${kind}: every cut radius is compensated`,
      circles.every((c) => near(c.r, 1.9, 1e-12)),
    );
  }
}

console.log('pattern: the bridge limit actually bites');
{
  const model = tube();
  const input = inputFor(model);

  const loose = generatePattern(input, { ...baseOptions, minBridge: 0.5, pitch: 5 });
  const tight = generatePattern(input, { ...baseOptions, minBridge: 4, pitch: 5 });
  check(
    'a wider bridge means fewer holes',
    tight.length < loose.length,
    `${loose.length} at 0.5 mm, ${tight.length} at 4 mm`,
  );
  check(
    'and the wide setting is still honoured',
    measuredBridge(tight, input, baseOptions.kerf) >= 4 - 1e-9,
  );

  // A wall thinner than the hole cannot be perforated at all, and saying so is
  // better than emitting holes that break out of it.
  const thin = tube(2.5);
  const thinInput = inputFor(thin);
  const nothing = generatePattern(thinInput, baseOptions);
  check('a wall too thin for the hole yields nothing', nothing.length === 0, `${nothing.length} holes`);

  const smaller = generatePattern(thinInput, { ...baseOptions, radius: 0.4, minBridge: 0.6, pitch: 3 });
  check('a smaller hole fits the same thin wall', smaller.length > 0);
  check(
    'and still respects its bridge',
    measuredBridge(smaller, thinInput, baseOptions.kerf) >= 0.6 - 1e-9,
  );
}

console.log('pattern: rod holes are respected');
{
  const model = tube();
  const rods = [
    { x: 55, y: 0, r: 2.65 },
    { x: -55, y: 0, r: 2.65 },
  ];
  const input = inputFor(model, 5, rods);
  const circles = generatePattern(input, baseOptions);

  check('holes are still placed around the rods', circles.length > 10);
  const clear = circles.every((c) =>
    rods.every(
      (rod) =>
        Math.hypot(c.x - rod.x, c.y - rod.y) - (rod.r + 0.1) - baseOptions.radius >=
        baseOptions.minBridge - 1e-9,
    ),
  );
  check('and none crowds a rod hole', clear);
  check(
    'the measured bridge covers the rods too',
    measuredBridge(circles, input, baseOptions.kerf) >= baseOptions.minBridge - 1e-9,
  );
}

console.log('pattern: determinism and variation');
{
  const model = tube();
  const input = inputFor(model);

  for (const kind of PATTERN_KINDS) {
    const a = generatePattern(input, { ...baseOptions, kind, rotatePerLayer: true });
    const b = generatePattern(input, { ...baseOptions, kind, rotatePerLayer: true });
    check(`${kind}: the same seed gives the same holes`, JSON.stringify(a) === JSON.stringify(b));
  }

  const layer1 = generatePattern(inputFor(model, 1), { ...baseOptions, rotatePerLayer: true });
  const layer2 = generatePattern(inputFor(model, 2), { ...baseOptions, rotatePerLayer: true });
  check(
    'turning per layer makes consecutive layers differ',
    JSON.stringify(layer1) !== JSON.stringify(layer2),
  );

  const fixed1 = generatePattern(inputFor(model, 1), { ...baseOptions, rotatePerLayer: false });
  const fixed2 = generatePattern(inputFor(model, 2), { ...baseOptions, rotatePerLayer: false });
  check(
    'with it off, a symmetric layer repeats',
    JSON.stringify(fixed1) === JSON.stringify(fixed2),
  );

  const seedA = generatePattern(input, { ...baseOptions, kind: 'scatter', seed: 1 });
  const seedB = generatePattern(input, { ...baseOptions, kind: 'scatter', seed: 2 });
  check('a different seed gives a different scatter', JSON.stringify(seedA) !== JSON.stringify(seedB));
}

console.log('pattern: density and degenerate settings');
{
  const model = tube();
  const input = inputFor(model);

  const full = generatePattern(input, { ...baseOptions, density: 1 });
  const half = generatePattern(input, { ...baseOptions, density: 0.4 });
  check('lower density means fewer holes', half.length < full.length, `${full.length} then ${half.length}`);
  check('zero density means none', generatePattern(input, { ...baseOptions, density: 0 }).length === 0);
  check('zero radius means none', generatePattern(input, { ...baseOptions, radius: 0 }).length === 0);

  const crammed = generatePattern(input, { ...baseOptions, pitch: 0.1 });
  check(
    'a pitch below the hole size is raised rather than looping',
    crammed.length > 0 && measuredBridge(crammed, input, baseOptions.kerf) >= baseOptions.minBridge - 1e-9,
  );

  const solid = (x, y, z) => -1000;
  const openField = {
    z: 0,
    bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
    existing: [],
    sample: solid,
    layer: 1,
  };
  const filled = generatePattern(openField, baseOptions);
  check('a solid field is filled edge to edge', filled.length > 100, `${filled.length} holes`);
  check(
    'and the bridge holds there too',
    measuredBridge(filled, openField, baseOptions.kerf) >= baseOptions.minBridge - 1e-9,
  );
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    wall patterns');
