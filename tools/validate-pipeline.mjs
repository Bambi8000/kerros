#!/usr/bin/env node
/**
 * validate-pipeline.mjs
 *
 * The whole slicing pipeline in one call, which is the thing the worker runs. A
 * worker cannot be tested from a script, so the pipeline is pure and the worker
 * is a shell around it — and this checks the pipeline.
 *
 *   node tools/validate-pipeline.mjs
 */

import { runSliceJob, EMPTY_OUTPUT, volumeFromPayload } from '../src/core/pipeline.ts';
import { defaultParams, defaultModifierParams, findModule, shellModifier } from '../src/core/sdf.ts';
import { groupContours } from '../src/core/slice.ts';
import { importMesh } from '../src/core/meshImport.ts';
import { voxelise } from '../src/core/voxelise.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sphere = findModule('sphere');
const capsule = findModule('capsule');

function baseJob(features) {
  return {
    features,
    thickness: 3,
    kerf: 0.2,
    spacerHeight: 6,
    resolution: 180,
    tolerance: 0.05,
    smoothing: 1,
    minFeature: 1,
    seed: 7,
  };
}

function feature(id, kind, stage, params, extra = {}) {
  return { id, kind, stage, name: id, enabled: true, params, ...extra };
}

const shell = feature('sh', 'shell', 'CARVE', { ...defaultModifierParams(shellModifier), t: 10 });
const body = feature('b', 'sphere', 'SHAPE', { ...defaultParams(sphere), op: 'union', r: 60, pz: 65 });

console.log('pipeline: an empty tree');
{
  const output = runSliceJob(baseJob([]), new Map());
  check('produces nothing rather than throwing', output.set === null);
  check('and matches the idle shape', JSON.stringify(output) === JSON.stringify(EMPTY_OUTPUT));
}

console.log('pipeline: a shelled body');
{
  const output = runSliceJob(baseJob([body, shell]), new Map());
  check('slices', output.set !== null && output.set.slices.length > 8, `${output.set?.slices.length} layers`);
  check('reports a time', output.ms >= 0);
  check('every layer is a ring or a cap', output.set.slices.every((s) => s.contours.length >= 1));
  check('a report per layer', output.reports.length === output.set.slices.length);
  check('no windows', output.windows.length === 0);
  check('nothing flagged on a clean form', output.reports.every((r) => !r.tooThin));
}

console.log('pipeline: rods, fixtures and perforation compose in order');
{
  const rods = [0, 1, 2, 3].map((i) =>
    feature(`r${i}`, 'rod', 'RIG', {
      size: 'M5',
      px: Math.round(54 * Math.cos((i * Math.PI) / 2)),
      py: Math.round(54 * Math.sin((i * Math.PI) / 2)),
      pz: 65,
      length: 130,
      diameter: 0,
    }),
  );

  const pattern = feature('p1', 'pattern', 'PATTERN', {
    patternKind: 'hex',
    radius: 1.4,
    pitch: 6,
    minBridge: 1.2,
    density: 1,
    band: 0,
    rotatePerLayer: 1,
  });

  const socket = feature('fx', 'fixture:socket', 'RIG', {
    fixture: 'socket',
    px: 0,
    py: 0,
    pz: 6.5,
    length: 8,
    rot: 0,
    preset: 'nipple',
    diameter: 10.5,
    screws: 0,
    boltCircle: 30,
    screwDiameter: 3.2,
    shape: 'round',
    slotLength: 24,
    width: 32,
    depth: 22,
    corner: 3,
  });

  const output = runSliceJob(baseJob([body, shell, ...rods, socket, pattern]), new Map());

  const mid = output.set.slices[Math.floor(output.set.slices.length / 2)];
  check('rod holes are drilled', mid.circles.some((c) => c.label.includes('M5')));
  check('perforation is placed', output.patternCounts.p1 > 50, `${output.patternCounts.p1} holes`);
  check('and counted per feature', Object.keys(output.patternCounts).join() === 'p1');

  // The socket sits at the very bottom, where a shelled sphere has almost no
  // material, so it is expected to be reported rather than cut.
  check('a fixture that does not fit is counted', typeof output.fixtureMisses.fx === 'number');

  const bridge = Math.min(...output.reports.map((r) => r.minGap));
  check('the bridge check ran on the finished layers', Number.isFinite(bridge));

  // Perforation must respect the rods it was given, which only works because it
  // runs after them.
  const holes = mid.circles.filter((c) => c.label === 'pattern');
  const rodHoles = mid.circles.filter((c) => c.label !== 'pattern');
  const crowded = holes.some((h) =>
    rodHoles.some((r) => Math.hypot(h.x - r.x, h.y - r.y) < h.r + r.r + 1),
  );
  check('no perforation crowds a rod hole', !crowded);
}

console.log('pipeline: windows come out as their own sets');
{
  const window = feature('w', 'window', 'CARVE', {
    attachTo: '',
    mode: 'perLayer',
    px: 0,
    py: 0,
    pz: 65,
    chance: 1,
    minCount: 1,
    maxCount: 1,
    minWidth: 40,
    maxWidth: 40,
    count: 4,
    width: 40,
    twist: 0,
    angle: 0,
    length: 90,
    fit: 0.4,
    windowKerf: 0.1,
  });

  const output = runSliceJob(baseJob([body, shell, window]), new Map());
  check('one window feature gives one set of plugs', output.windows.length === 1);
  check('the plugs have layers', output.windows[0].set.slices.length > 3, `${output.windows[0].set.slices.length}`);
  check('and each is a solid piece', output.windows[0].set.slices.every((s) => s.contours.every((c) => !c.isHole)));

  const mid = output.set.slices[Math.floor(output.set.slices.length / 2)];
  check('the stock ring is cut open', groupContours(mid.contours).length >= 1);
}

console.log('pipeline: imports arrive as payloads');
{
  const boxTris = (() => {
    const h = 40;
    const v = [
      [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
      [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
    ];
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
      [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    const out = [];
    for (const f of faces) for (const i of f) out.push(...v[i]);
    return out;
  })();

  const bytes = (() => {
    const count = boxTris.length / 9;
    const b = new Uint8Array(84 + count * 50);
    const view = new DataView(b.buffer);
    view.setUint32(80, count, true);
    for (let t = 0; t < count; t++) {
      let at = 84 + t * 50 + 12;
      for (let i = 0; i < 9; i++) {
        view.setFloat32(at, boxTris[t * 9 + i], true);
        at += 4;
      }
    }
    return b;
  })();

  const soup = importMesh(bytes, 'box.stl').soup;
  const baked = voxelise(soup, { resolution: 64 });

  // Exactly what crosses the thread boundary, rebuilt on the other side.
  const payload = {
    id: 'im',
    data: baked.grid.data,
    dims: baked.grid.dims,
    min: baked.grid.min,
    step: baked.grid.step,
    reach: baked.grid.reach,
  };
  const volumes = new Map([['im', volumeFromPayload(payload)]]);

  const imported = feature('im', 'import', 'SHAPE', { op: 'union', k: 0, scale: 1 });
  const output = runSliceJob(baseJob([imported, shell]), volumes);

  check('an import slices through the pipeline', output.set !== null && output.set.slices.length > 8,
    `${output.set?.slices.length} layers`);
  const mid = output.set.slices[Math.floor(output.set.slices.length / 2)];
  check('and the shelled box comes out as a ring', mid.contours.length === 2, `${mid.contours.length} contours`);

  const scaled = runSliceJob(
    baseJob([{ ...imported, params: { op: 'union', k: 0, scale: 2 } }, shell]),
    volumes,
  );
  check('a scaled import gives more layers', scaled.set.slices.length > output.set.slices.length);

  const missing = runSliceJob(baseJob([imported, shell]), new Map());
  check('an import with no grid contributes nothing rather than throwing', missing.set === null);
}

console.log('pipeline: determinism');
{
  const job = baseJob([body, shell]);
  const a = runSliceJob(job, new Map());
  const b = runSliceJob(job, new Map());
  check(
    'the same job gives the same layers',
    JSON.stringify(a.set.slices) === JSON.stringify(b.set.slices),
  );
  check('and the same reports', JSON.stringify(a.reports) === JSON.stringify(b.reports));
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    slicing pipeline');
