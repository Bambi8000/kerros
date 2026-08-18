#!/usr/bin/env node
/**
 * validate-sculpt.mjs
 *
 * Sculpt strokes are evaluated analytically rather than baked onto a grid, so
 * the thing worth proving is exactly the thing the handoff warned would be
 * fragile: the same stroke gives the same surface at any sampling resolution.
 *
 *   node tools/validate-sculpt.mjs
 */

import {
  prepareFeatures,
  evaluatePoint,
  modelBounds,
  evaluateGrid,
  defaultParams,
  defaultModifierParams,
  findModule,
  shellModifier,
  strokeBounds,
  sculptFrame,
  frameOf,
  frameToLocal,
  frameToWorld,
} from '../src/core/sdf.ts';

import { surfaceNets } from '../src/core/surfaceNets.ts';

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

function line(from, to, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    );
  }
  return pts;
}

function sculpt(strokes) {
  return { kind: 'sculpt', enabled: true, params: {}, strokes };
}

const sphere = findModule('sphere');
const base = {
  kind: 'sphere',
  enabled: true,
  params: { ...defaultParams(sphere), op: 'union', r: 40 },
};

console.log('sculpt: a stroke is a capsule chain');
{
  const stroke = { op: 'union', radius: 8, k: 0, points: line([-30, 0, 0], [30, 0, 0], 12) };
  const prepared = prepareFeatures([sculpt([stroke])]);
  const at = (x, y, z) => evaluatePoint(prepared, x, y, z);

  check('the axis is one radius inside', near(at(0, 0, 0), -8, 1e-9));
  check('the surface is at the radius', near(at(0, 8, 0), 0, 1e-9));
  check('outside is the exact distance, up to the cap', near(at(0, 12, 0), 4, 1e-9));
  check('the end cap is round', near(at(38, 0, 0), 0, 1e-9));
  check('past the end it is outside', at(45, 0, 0) > 0);
  check('off to the side too', at(0, 40, 0) > 0);

  // Exact along the whole length, which is what makes it a capsule chain and
  // not a row of beads.
  let worst = 0;
  for (let x = -30; x <= 30; x += 3) worst = Math.max(worst, Math.abs(at(x, 8, 0)));
  check('the tube has no beading along its length', worst < 1e-9, `worst ${worst.toExponential(2)}`);

  const tap = prepareFeatures([sculpt([{ op: 'union', radius: 6, k: 0, points: [10, 10, 10] }])]);
  check('a single point is a sphere', near(evaluatePoint(tap, 10, 16, 10), 0, 1e-9));
  check('and is solid at its centre', near(evaluatePoint(tap, 10, 10, 10), -6, 1e-9));
}

console.log('sculpt: strokes combine like anything else');
{
  const add = { op: 'union', radius: 10, k: 0, points: line([0, 0, 40], [0, 0, 70], 8) };
  const cut = { op: 'subtract', radius: 6, k: 0, points: line([-50, 0, 0], [50, 0, 0], 10) };

  const built = prepareFeatures([base, sculpt([add])]);
  check('an additive stroke adds material outside the base', evaluatePoint(built, 0, 0, 60) < 0);
  check('and the base is still there', evaluatePoint(built, 0, 0, 0) < 0);

  const carved = prepareFeatures([base, sculpt([cut])]);
  check('a subtract stroke cuts into the base', evaluatePoint(carved, 0, 0, 0) > 0);
  check('and leaves material beside the groove', evaluatePoint(carved, 0, 0, 20) < 0);

  const ordered = prepareFeatures([base, sculpt([cut, add])]);
  check(
    'strokes apply in the order they were made',
    evaluatePoint(ordered, 0, 0, 60) < 0 && evaluatePoint(ordered, 0, 0, 0) > 0,
  );

  const smooth = prepareFeatures([
    base,
    sculpt([{ op: 'smoothUnion', radius: 10, k: 15, points: line([0, 0, 40], [0, 0, 70], 8) }]),
  ]);
  const hard = prepareFeatures([
    base,
    sculpt([{ op: 'union', radius: 10, k: 0, points: line([0, 0, 40], [0, 0, 70], 8) }]),
  ]);
  check(
    'a smooth union fills the joint that a hard one leaves',
    evaluatePoint(smooth, 11, 0, 40) < evaluatePoint(hard, 11, 0, 40),
  );

  const disabled = prepareFeatures([base, { ...sculpt([cut]), enabled: false }]);
  check('a disabled sculpt feature does nothing', evaluatePoint(disabled, 0, 0, 0) < 0);

  const empty = prepareFeatures([base, sculpt([])]);
  check('a sculpt feature with no strokes does nothing', evaluatePoint(empty, 0, 0, 0) < 0);
  check(
    'a stroke with no points is ignored',
    evaluatePoint(prepareFeatures([base, sculpt([{ op: 'subtract', radius: 5, k: 0, points: [] }])]), 0, 0, 0) < 0,
  );
  check(
    'a zero radius is ignored rather than dividing by anything',
    evaluatePoint(prepareFeatures([base, sculpt([{ op: 'subtract', radius: 0, k: 0, points: [0, 0, 0] }])]), 0, 0, 0) < 0,
  );
}

console.log('sculpt: bounds follow added material');
{
  const far = { op: 'union', radius: 8, k: 0, points: line([0, 0, 40], [0, 0, 120], 10) };
  const bounds = modelBounds([base, sculpt([far])]);
  check(
    'an additive stroke past the base extends the bounds',
    bounds.max[2] >= 128 - 1e-9,
    `top at ${bounds.max[2].toFixed(1)}`,
  );

  const cutOnly = modelBounds([
    base,
    sculpt([{ op: 'subtract', radius: 8, k: 0, points: line([0, 0, 40], [0, 0, 200], 10) }]),
  ]);
  check(
    'a subtractive stroke does not, having added nothing',
    near(cutOnly.max[2], 40, 1e-9),
    `top at ${cutOnly.max[2].toFixed(1)}`,
  );

  const box = strokeBounds({ op: 'union', radius: 5, k: 0, points: [0, 0, 0, 10, 0, 0] });
  check('stroke bounds include the radius', near(box.min[0], -5, 1e-9) && near(box.max[0], 15, 1e-9));
  check('an empty stroke has no bounds', strokeBounds({ op: 'union', radius: 5, k: 0, points: [] }) === null);

  // The grid has to actually contain the sculpted surface.
  const grid = evaluateGrid([base, sculpt([far])], 48);
  const [nx, ny, nz] = grid.dims;
  let boundaryInside = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const onFace = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        if (onFace && grid.data[i + nx * (j + ny * k)] < 0) boundaryInside++;
      }
    }
  }
  check('the sculpted surface fits inside the grid', boundaryInside === 0, `${boundaryInside} samples`);
}

console.log('sculpt: the same stroke at any resolution');
{
  // This is the whole reason for evaluating strokes rather than baking them.
  // The handoff expected to have to store the grid resolution in the feature to
  // keep replays stable; with no grid in the definition there is nothing to
  // store and nothing to drift.
  const tree = [
    base,
    sculpt([
      { op: 'smoothUnion', radius: 9, k: 12, points: line([-30, -10, 10], [30, 20, 35], 14) },
      { op: 'subtract', radius: 7, k: 0, points: line([0, -40, 20], [0, 40, 20], 10) },
    ]),
  ];
  const prepared = prepareFeatures(tree);

  const probes = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    probes.push([45 * Math.cos(a), 45 * Math.sin(a), 10 + (i % 40)]);
  }

  const first = probes.map(([x, y, z]) => evaluatePoint(prepared, x, y, z));
  const again = prepareFeatures(tree).map ? null : null;
  const rebuilt = prepareFeatures(tree);
  const second = probes.map(([x, y, z]) => evaluatePoint(rebuilt, x, y, z));
  check('the field is bit-identical when rebuilt', first.every((v, i) => v === second[i]));

  // And the same surface comes out of coarse and fine grids: not identical
  // meshes, but the same shape, so the volume must agree closely.
  const volumeAt = (res) => {
    const grid = evaluateGrid(tree, res);
    const mesh = surfaceNets(grid);
    let vol = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] * 3;
      const b = mesh.indices[t + 1] * 3;
      const c = mesh.indices[t + 2] * 3;
      const p = mesh.positions;
      vol +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    return vol;
  };

  const coarse = volumeAt(40);
  const fine = volumeAt(90);
  check(
    'coarse and fine sampling agree on the volume within 2%',
    Math.abs(coarse - fine) / fine < 0.02,
    `${coarse.toFixed(0)} vs ${fine.toFixed(0)} mm3`,
  );
  check('both are solid, not inside out', coarse > 0 && fine > 0);
}

console.log('sculpt: sculpt then shell');
{
  const tree = [
    base,
    sculpt([{ op: 'union', radius: 12, k: 10, points: line([0, 0, 30], [0, 0, 60], 8) }]),
    { kind: 'shell', enabled: true, params: { ...defaultModifierParams(shellModifier), t: 5 } },
  ];
  const prepared = prepareFeatures(tree);

  check('the sculpted spout is hollow too', evaluatePoint(prepared, 0, 0, 55) > 0);
  check('and its wall is solid', evaluatePoint(prepared, 9, 0, 55) < 0);
  check('the shell followed the stroke without being told about it', evaluatePoint(prepared, 0, 0, 0) > 0);
}

console.log('sculpt: strokes are welded to the shape they are attached to');
{
  // The stroke is recorded in the shape's coordinates, so moving the shape has
  // to move the sculpting. Getting this wrong is what left windows behind
  // earlier, and it was reported again for sculpt.
  const stroke = { op: 'union', radius: 8, k: 0, points: line([0, 0, 40], [0, 0, 70], 8) };

  const here = [
    { id: 'a', kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 40 } },
    { id: 'b', kind: 'sculpt', enabled: true, params: { attachTo: 'a' }, strokes: [stroke] },
  ];
  const moved = [
    { ...here[0], params: { ...here[0].params, px: 200, pz: 30 } },
    here[1],
  ];

  const atHere = prepareFeatures(here);
  const atMoved = prepareFeatures(moved);

  check('the stroke is solid where it was made', evaluatePoint(atHere, 0, 0, 60) < 0);
  check(
    'and moves with the shape',
    evaluatePoint(atMoved, 200, 0, 90) < 0,
    'the sculpting should have travelled 200 mm across and 30 up',
  );
  check('leaving nothing behind', evaluatePoint(atMoved, 0, 0, 60) > 0);
  check(
    'the field is the same shape, only relocated',
    Math.abs(evaluatePoint(atHere, 5, 0, 55) - evaluatePoint(atMoved, 205, 0, 85)) < 1e-9,
  );

  const turned = [
    { ...here[0], params: { ...here[0].params, ry: 90 } },
    here[1],
  ];
  const atTurned = prepareFeatures(turned);
  check(
    'a rotation carries it too',
    evaluatePoint(atTurned, 60, 0, 0) < 0,
    'turned 90 about Y, the stroke should point along +X',
  );
  check('and the old direction is empty', evaluatePoint(atTurned, 0, 0, 60) > 0);

  const detached = [here[0], { ...here[1], params: { attachTo: '' } }];
  const worldFrame = prepareFeatures(detached);
  check('with no attachment the strokes stay in world coordinates', evaluatePoint(worldFrame, 0, 0, 60) < 0);

  const orphaned = [here[0], { ...here[1], params: { attachTo: 'gone' } }];
  check(
    'an attachment that no longer exists falls back to world rather than throwing',
    evaluatePoint(prepareFeatures(orphaned), 0, 0, 60) < 0,
  );

  // Bounds must follow the frame, or a stroke on a moved shape gets clipped.
  const box = modelBounds(moved);
  check('bounds follow the attached stroke', box.max[0] >= 208 - 1e-6, `max x ${box.max[0].toFixed(1)}`);

  const grid = evaluateGrid(moved, 48);
  const [nx, ny, nz] = grid.dims;
  let boundaryInside = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const onFace = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        if (onFace && grid.data[i + nx * (j + ny * k)] < 0) boundaryInside++;
      }
    }
  }
  check('and the moved sculpting is not clipped by the grid', boundaryInside === 0, `${boundaryInside} samples`);
}

console.log('sculpt: frames round trip');
{
  const frame = frameOf({ px: 30, py: -10, pz: 5, rx: 12, ry: -40, rz: 77 });
  let worst = 0;
  for (const p of [[0, 0, 0], [10, 20, 30], [-45, 5, 12]]) {
    const [lx, ly, lz] = frameToLocal(frame, p[0], p[1], p[2]);
    const back = frameToWorld(frame, lx, ly, lz);
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(back[i] - p[i]));
  }
  check('local and world are exact inverses', worst < 1e-9, `off by ${worst.toExponential(2)}`);

  const identity = frameOf({});
  check('an empty frame is the identity', identity.identity === true);
  check(
    'and leaves points alone',
    frameToLocal(identity, 7, 8, 9).every((v, i) => v === [7, 8, 9][i]),
  );

  const resolved = sculptFrame(
    [{ id: 'a', kind: 'sphere', enabled: true, params: { px: 50 } }],
    { kind: 'sculpt', enabled: true, params: { attachTo: 'a' }, strokes: [] },
  );
  check('sculptFrame finds the named shape', resolved.tx === 50);
  check(
    'and gives the identity when there is none',
    sculptFrame([], { kind: 'sculpt', enabled: true, params: {}, strokes: [] }).identity,
  );
}

console.log('sculpt: many strokes stay quick');
{
  const strokes = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    strokes.push({
      op: i % 3 === 0 ? 'subtract' : 'union',
      radius: 5,
      k: 0,
      points: line(
        [38 * Math.cos(a), 38 * Math.sin(a), 5],
        [44 * Math.cos(a), 44 * Math.sin(a), 60],
        6,
      ),
    });
  }
  const tree = [base, sculpt(strokes)];

  const started = Date.now();
  const grid = evaluateGrid(tree, 48);
  const elapsed = Date.now() - started;

  check('120 strokes still evaluate', grid.data.some((v) => v < 0));
  check(
    'and the index keeps it inside a second',
    elapsed < 1000,
    `${elapsed} ms for ${grid.data.length} samples`,
  );
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    sculpt strokes');
