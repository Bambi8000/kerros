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

import {
  runSliceJob,
  runPreviewJob,
  runNestJob,
  rehydrateNest,
  attachFrameFor,
  fixturesFromFeatures,
  EMPTY_OUTPUT,
  EMPTY_PREVIEW,
  EMPTY_NEST,
  volumeFromPayload,
} from '../src/core/pipeline.ts';
import { nestByMaterial } from '../src/core/nest.ts';
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

/** Structural comparison, so a test cannot fail merely on key order. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
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
  check('a fixture that does not fit is counted', typeof output.holeMisses.fx === 'number');

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

console.log('pipeline: the preview surface');
{
  const job = {
    features: [body, shell],
    resolution: 48,
    kerf: 0.2,
    seed: 7,
    thickness: 3,
    spacerHeight: 6,
  };

  const preview = runPreviewJob(job, new Map());
  check('a surface comes out', preview.triangles > 500, `${preview.triangles} triangles`);
  check('with positions and indices', preview.positions.length > 0 && preview.indices.length > 0);
  check('three indices per triangle', preview.indices.length === preview.triangles * 3);
  check('the grid is reported', preview.dims.every((n) => n > 8) && preview.step > 0);

  const empty = runPreviewJob({ ...job, features: [] }, new Map());
  check('an empty tree gives an empty surface', empty.triangles === 0);
  check('and matches the idle shape', empty.dims.join() === EMPTY_PREVIEW.dims.join());

  const finer = runPreviewJob({ ...job, resolution: 72 }, new Map());
  check('a finer resolution gives more triangles', finer.triangles > preview.triangles);
  check('and a smaller step', finer.step < preview.step);

  // The preview and the slicer must read the same field, or the shape on screen
  // is not the shape that gets cut.
  const sliced = runSliceJob(baseJob([body, shell]), new Map());
  const previewTop = preview.positions.reduce((m, v, i) => (i % 3 === 2 ? Math.max(m, v) : m), -Infinity);
  const sliceTop = sliced.set.slices[sliced.set.slices.length - 1].z;
  check(
    'the preview and the slices agree on where the top is',
    Math.abs(previewTop - sliceTop) < 8,
    `preview ${previewTop.toFixed(1)}, top slice ${sliceTop.toFixed(1)}`,
  );
}

console.log('pipeline: fixtures follow the shape they are attached to');
{
  const host = feature('host', 'sphere', 'SHAPE', { ...defaultParams(sphere), op: 'union', r: 60, pz: 65 });

  const socket = (attachTo) =>
    feature('fx', 'fixture:socket', 'RIG', {
      fixture: 'socket',
      attachTo,
      px: 10,
      py: 0,
      pz: 5,
      length: 8,
      rot: 0,
      preset: 'nipple',
      diameter: 10.5,
      screws: 3,
      boltCircle: 30,
      screwDiameter: 3.2,
      shape: 'round',
      slotLength: 24,
      width: 32,
      depth: 22,
      corner: 3,
    });

  const detached = fixturesFromFeatures([host, socket('')], 0.2)[0];
  check('detached, the stored numbers are the world numbers', detached.x === 10 && detached.z === 5);

  const moved = { ...host, params: { ...host.params, px: 100, pz: 20 } };
  const attached = fixturesFromFeatures([moved, socket('host')], 0.2)[0];
  check('attached, it moves with the shape', attached.x === 110 && attached.z === 25,
    `at ${attached.x}, ${attached.z}`);

  const turned = { ...host, params: { ...host.params, rz: 90 } };
  const spun = fixturesFromFeatures([turned, socket('host')], 0.2)[0];
  check('a Z rotation swings the offset round', Math.abs(spun.x) < 1e-9 && Math.abs(spun.y - 10) < 1e-9,
    `at ${spun.x.toFixed(2)}, ${spun.y.toFixed(2)}`);
  check('and turns the bolt circle with it', Math.abs(spun.rot - 90) < 1e-9);

  const tipped = { ...host, params: { ...host.params, rx: 45, ry: 30, rz: 0 } };
  const flat = fixturesFromFeatures([tipped, socket('host')], 0.2)[0];
  check(
    'X and Y rotation are NOT inherited, a hole belonging to one flat sheet',
    flat.x === 10 && flat.y === 0 && flat.rot === 0,
  );

  const gone = fixturesFromFeatures([host, socket('nobody')], 0.2)[0];
  check('an attachment that no longer exists falls back to world', gone.x === 10 && gone.z === 5);

  check('the frame helper is shared with windows', attachFrameFor([moved], socket('host')).x === 100);

  // And it must actually reach the layer it is aimed at once attached.
  const output = runSliceJob(baseJob([moved, shell, socket('host')]), new Map());
  check('an attached fixture still slices', output.set !== null);
  check('and is accounted for', typeof output.holeMisses.fx === 'number');
}

console.log('pipeline: one way to say which layers');
{
  /*
   * A solid body, not the shelled one used elsewhere.
   *
   * A socket hole in the middle of a shelled sphere lands in the cavity, does
   * not fit the ring it is asked to sit in, and is counted as a miss rather
   * than cut — which is correct behaviour and exactly the "a socket mount needs
   * a solid layer" note in the handoff. The first version of this block used
   * the shell and measured zero holes everywhere, which said nothing about
   * selectors at all.
   */
  const plain = runSliceJob(baseJob([body]), new Map());
  const zs = plain.set.slices.map((slice) => slice.z);
  const numbers = plain.set.slices.map((slice) => slice.index);
  check('the test body slices into enough layers to choose between', numbers.length >= 8, `${numbers.length}`);

  const socket = (extra) =>
    feature('fx', 'fixture:socket', 'RIG', {
      fixture: 'socket',
      px: 0,
      py: 0,
      // Aimed at a real mid-plane rather than a guessed height: a band between
      // two sheets reaches neither, which is right and makes a poor test.
      pz: zs[2],
      length: 1,
      rot: 0,
      preset: 'nipple',
      diameter: 10.5,
      screws: 0,
      boltCircle: 30,
      screwDiameter: 3.2,
      ...extra,
    });

  const drilledLayers = (out) =>
    out.set.slices.filter((slice) => slice.circles.length > 0).map((s) => s.index);

  // No selector at all: the band the fixture has always had, on the sheet it
  // has always landed on. This is the check that lets the mechanism change.
  const band = runSliceJob(baseJob([body, socket({})]), new Map());
  check(
    'a fixture with no selector still uses its band',
    JSON.stringify(drilledLayers(band)) === JSON.stringify([numbers[2]]),
    JSON.stringify(drilledLayers(band)),
  );

  const spelled = runSliceJob(baseJob([body, socket({ selKind: 'band' })]), new Map());
  check(
    'saying "band" out loud changes nothing',
    JSON.stringify(drilledLayers(spelled)) === JSON.stringify(drilledLayers(band)),
  );

  // A run of layers, chosen by number rather than aimed at a height.
  const from = numbers[1];
  const to = numbers[3];
  const ranged = runSliceJob(
    baseJob([body, socket({ selKind: 'range', selFrom: from, selTo: to })]),
    new Map(),
  );
  check(
    'a range puts the holes on exactly those sheets',
    JSON.stringify(drilledLayers(ranged)) === JSON.stringify(numbers.slice(1, 4)),
    JSON.stringify(drilledLayers(ranged)),
  );
  check(
    'which is more sheets than the band had',
    drilledLayers(ranged).length > drilledLayers(band).length,
  );

  const everyThird = runSliceJob(
    baseJob([body, socket({ selKind: 'every', selN: 3, selOffset: 0 })]),
    new Map(),
  );
  const nth = drilledLayers(everyThird);
  check('every third sheet gets one', nth.length >= 3, nth.join(','));
  check(
    'and they are three apart in the stack',
    nth.every((n, i) => i === 0 || numbers.indexOf(n) - numbers.indexOf(nth[i - 1]) === 3),
    nth.join(','),
  );
  check('starting at the bottom', nth[0] === numbers[0]);

  // Perforation had no way of saying anything and went everywhere. `all` is
  // that behaviour written down, and a range is the new thing.
  const pattern = (extra) =>
    feature('pt', 'pattern', 'PATTERN', {
      patternKind: 'grid',
      radius: 1.2,
      pitch: 6,
      minBridge: 1.2,
      density: 1,
      band: 0,
      rotatePerLayer: 0,
      ...extra,
    });

  const everywhere = runSliceJob(baseJob([body, shell, pattern({})]), new Map());
  const perforated = (out) =>
    out.set.slices.filter((slice) => slice.circles.length > 0).map((s) => s.index);
  check('perforation with no selector still goes on every layer it can', perforated(everywhere).length > 4);

  const someLayers = runSliceJob(
    baseJob([body, shell, pattern({ selKind: 'range', selFrom: 3, selTo: 5 })]),
    new Map(),
  );
  check(
    'and a range holds it to those',
    perforated(someLayers).every((n) => n >= 3 && n <= 5),
    perforated(someLayers).join(','),
  );
  check('while still placing some', perforated(someLayers).length > 0);
  check(
    'the counts follow the selection',
    everywhere.patternCounts.pt > someLayers.patternCounts.pt,
    `${everywhere.patternCounts.pt} vs ${someLayers.patternCounts.pt}`,
  );
}

console.log('pipeline: splayed legs are cut from the field');
{
  /*
   * A flat plate, not the sphere the rest of this file uses.
   *
   * A leg's spread is measured at the bottom of the model and the leg leans in
   * as it rises, so aiming one at a sheet halfway up is nonsense — over 60 mm
   * of height at 30 degrees it has moved 35 mm inwards, past the axis and out
   * the other side. The first version of this block did exactly that and
   * measured legs that had crossed over. Legs belong on the bottom sheets,
   * which is what the feature is for, and a plate has room down there.
   */
  const plate = feature('pl', 'roundBox', 'SHAPE', {
    ...defaultParams(findModule('roundBox')),
    op: 'union',
    sx: 120,
    sy: 120,
    sz: 60,
    r: 0,
    pz: 30,
  });

  const bare = runSliceJob(baseJob([plate]), new Map());
  const numbers = bare.set.slices.map((slice) => slice.index);
  check('the plate slices into sheets to choose between', numbers.length >= 4, `${numbers.length}`);

  const legDiameter = 12;
  const legs = (extra) =>
    feature('lg', 'legs', 'RIG', {
      legCount: 3,
      tilt: 30,
      diameter: legDiameter,
      radius: 40,
      angle: 0,
      px: 0,
      py: 0,
      selKind: 'range',
      selFrom: numbers[0],
      selTo: numbers[1],
      ...extra,
    });

  const holesOn = (result, index) => {
    const slice = result.set.slices.find((s2) => s2.index === index);
    return slice.contours.filter((c) => c.isHole).length;
  };

  const out = runSliceJob(baseJob([plate, legs({})]), new Map());
  check('the bare plate has no holes', holesOn(bare, numbers[0]) === 0);
  check('the first chosen sheet gains three', holesOn(out, numbers[0]) === 3, `${holesOn(out, numbers[0])}`);
  check('and so does the second', holesOn(out, numbers[1]) === 3);
  check(
    'while the sheets nobody chose are untouched',
    out.set.slices.every(
      (slice) =>
        slice.index === numbers[0] || slice.index === numbers[1] || holesOn(out, slice.index) === 0,
    ),
  );

  // The sweep, measured off the real output: longer along the tilt than across
  // it, by the sheet thickness times the tangent.
  const legOnX = (() => {
    const slice = out.set.slices.find((s2) => s2.index === numbers[0]);
    let best = null;
    let bestD = Infinity;
    for (const ring of slice.contours.filter((c) => c.isHole)) {
      const xs = ring.points.filter((_, i) => i % 2 === 0);
      const ys = ring.points.filter((_, i) => i % 2 === 1);
      const mx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const my = (Math.max(...ys) + Math.min(...ys)) / 2;
      const d = Math.hypot(mx - 40, my);
      if (d < bestD) {
        bestD = d;
        best = { xs, ys, mx };
      }
    }
    return best;
  })();

  const along = Math.max(...legOnX.xs) - Math.min(...legOnX.xs);
  const across = Math.max(...legOnX.ys) - Math.min(...legOnX.ys);
  const tilt = (30 * Math.PI) / 180;
  const kerf = 0.2;

  check('the leg on +X is where the spread put it', Math.abs(legOnX.mx - 40) < 2, `${legOnX.mx.toFixed(2)}`);
  // Kerf is the iso-level now, so the cut path is a kerf under the finished hole.
  check(
    'across the tilt, the leg width less a kerf',
    Math.abs(across - (legDiameter - kerf)) < 0.5,
    `${across.toFixed(2)} against ${(legDiameter - kerf).toFixed(2)}`,
  );
  check(
    'along it, one ellipse plus the sweep',
    Math.abs(along - (legDiameter / Math.cos(tilt) + 3 * Math.tan(tilt) - kerf)) < 0.6,
    `${along.toFixed(2)} against ${(legDiameter / Math.cos(tilt) + 3 * Math.tan(tilt) - kerf).toFixed(2)}`,
  );
  check('so the hole is longer than it is wide', along > across + 1);

  /*
   * The reason for moving into the field: a leg over the rim takes a bite out
   * of it rather than being refused. The sheet keeps its outer ring, and that
   * ring loses area and gains perimeter — a notch is longer round than the
   * straight edge it replaced.
   */
  const rim = (result, index) => {
    const slice = result.set.slices.find((s2) => s2.index === index);
    const ring = slice.contours.find((c) => !c.isHole);
    let sum = 0;
    for (let i = 0; i < ring.points.length; i += 2) {
      const j = (i + 2) % ring.points.length;
      sum += Math.hypot(ring.points[j] - ring.points[i], ring.points[j + 1] - ring.points[i + 1]);
    }
    return { area: Math.abs(ring.area), perimeter: sum };
  };

  const overhang = runSliceJob(baseJob([plate, legs({ radius: 60 })]), new Map());
  check('a leg on the rim still leaves a sheet', overhang.set.slices.some((s2) => s2.index === numbers[0]));
  check(
    'and takes material out of the outline',
    rim(overhang, numbers[0]).area < rim(bare, numbers[0]).area - 10,
    `${rim(overhang, numbers[0]).area.toFixed(0)} against ${rim(bare, numbers[0]).area.toFixed(0)} mm2`,
  );
  check(
    'by notching it rather than punching through',
    rim(overhang, numbers[0]).perimeter > rim(bare, numbers[0]).perimeter,
  );

  // Entirely off the sheet: nothing at all, and no complaint either.
  const away = runSliceJob(baseJob([plate, legs({ radius: 500 })]), new Map());
  check(
    'a leg nowhere near the sheet does nothing',
    away.set.slices.every((slice) => holesOn(away, slice.index) === 0),
  );
  check(
    'and the outline is untouched',
    Math.abs(rim(away, numbers[0]).area - rim(bare, numbers[0]).area) < 1e-6,
  );
  check('with nothing reported, because nothing was refused', (away.legGaps.lg ?? 0) === 0);

  const upright = runSliceJob(baseJob([plate, legs({ tilt: 0 })]), new Map());
  const round = (() => {
    const slice = upright.set.slices.find((s2) => s2.index === numbers[0]);
    const ring = slice.contours.filter((c) => c.isHole)[0];
    const xs = ring.points.filter((_, i) => i % 2 === 0);
    const ys = ring.points.filter((_, i) => i % 2 === 1);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  })();
  check(
    'a vertical leg leaves a round hole',
    Math.abs(round[0] - round[1]) < 0.3,
    round.map((v) => v.toFixed(2)).join(' x '),
  );
}

console.log('pipeline: interleaved pins fasten each sheet to the next');
{
  const plate = feature('pl2', 'roundBox', 'SHAPE', {
    ...defaultParams(findModule('roundBox')),
    op: 'union',
    sx: 120,
    sy: 120,
    sz: 60,
    r: 0,
    pz: 30,
  });

  const bare = runSliceJob(baseJob([plate]), new Map());
  const numbers = bare.set.slices.map((slice) => slice.index);

  const pins = (extra) =>
    feature('pn', 'pins', 'RIG', {
      pinCount: 3,
      diameter: 4,
      radius: 40,
      angle: 0,
      stagger: 0,
      px: 0,
      py: 0,
      selKind: 'all',
      ...extra,
    });

  const out = runSliceJob(baseJob([plate, pins({})]), new Map());
  const holesOn = (result, index) =>
    result.set.slices.find((s2) => s2.index === index).circles.length;

  /*
   * Every sheet but the two ends carries two rings: one from the gap below and
   * one from the gap above. The ends have a gap on one side only, so they get
   * one ring — which is the arithmetic that proves the pins really are being
   * drilled into both sheets of each gap rather than one.
   */
  check('the bottom sheet gets one ring', holesOn(out, numbers[0]) === 3, `${holesOn(out, numbers[0])}`);
  check('the top sheet gets one ring', holesOn(out, numbers[numbers.length - 1]) === 3);
  check(
    'every sheet between them gets two',
    numbers.slice(1, -1).every((n) => holesOn(out, n) === 6),
    numbers.slice(1, -1).map((n) => holesOn(out, n)).join(','),
  );
  check('and nothing is loose', (out.pinLoose.pn ?? []).length === 0, JSON.stringify(out.pinLoose.pn));

  // The two rings on a shared sheet must not sit on top of each other.
  const middle = out.set.slices.find((s2) => s2.index === numbers[1]);
  let closest = Infinity;
  for (let i = 0; i < middle.circles.length; i++) {
    for (let j = i + 1; j < middle.circles.length; j++) {
      closest = Math.min(
        closest,
        Math.hypot(middle.circles[i].x - middle.circles[j].x, middle.circles[i].y - middle.circles[j].y),
      );
    }
  }
  check(
    'the two rings on a shared sheet are turned apart',
    closest > 4,
    `${closest.toFixed(2)} mm between the nearest pair`,
  );

  // A ring off the edge of the plate fastens nothing, and says so by name.
  const wide = runSliceJob(baseJob([plate, pins({ radius: 200 })]), new Map());
  check('pins off the sheet are refused', wide.holeMisses.pn > 0, `${wide.holeMisses.pn}`);
  check(
    'and every sheet is named as unfastened',
    (wide.pinLoose.pn ?? []).length === numbers.length,
    JSON.stringify(wide.pinLoose.pn),
  );
  check(
    'with no holes drilled',
    wide.set.slices.every((slice) => slice.circles.length === 0),
  );

  // A run of layers pins only that run.
  const some = runSliceJob(
    baseJob([plate, pins({ selKind: 'range', selFrom: numbers[1], selTo: numbers[3] })]),
    new Map(),
  );
  check(
    'a range pins only the sheets in it',
    some.set.slices.every(
      (slice) =>
        (slice.index >= numbers[1] && slice.index <= numbers[3]) === slice.circles.length > 0,
    ),
  );
  check('and the ends of that run get one ring each', holesOn(some, numbers[1]) === 3);
  check('with the sheet between them getting two', holesOn(some, numbers[2]) === 6);
  check('nothing loose in the run', (some.pinLoose.pn ?? []).length === 0);
}

console.log('pipeline: a boss widens the window it is sampled in');
{
  const ball = feature('bb', 'sphere', 'SHAPE', {
    ...defaultParams(sphere),
    op: 'union',
    r: 60,
    pz: 65,
  });
  const hollow = feature('hs', 'shell', 'CARVE', {
    ...defaultModifierParams(shellModifier),
    t: 8,
  });
  const rod = feature('rd', 'rod', 'RIG', { size: 'M5', diameter: 0, px: 0, py: 0, pz: 65, length: 120 });

  const boss = (extra) =>
    feature('bs', 'boss', 'RIG', {
      attachTo: 'rd',
      radius: 10,
      spokes: 3,
      spokeWidth: 4,
      spokeLength: 30,
      angle: 0,
      blend: 2,
      selKind: 'all',
      ...extra,
    });

  const plain = runSliceJob(baseJob([ball, hollow, rod]), new Map());
  const inside = runSliceJob(baseJob([ball, hollow, rod, boss({})]), new Map());

  check('a shelled ball slices into rings', plain.set.slices.length > 4);
  check(
    'every sheet has an outer ring with positive area',
    plain.set.slices.every((s2) => s2.contours.some((c) => !c.isHole && c.area > 0)),
  );

  /*
   * The failure this exists to catch.
   *
   * A spoke reaching further than the form does used to be clipped at the
   * sampling grid: the preview drew the cut face as a flat plate and the slicer
   * found a contour running off its window, dropped it rather than guessing an
   * edge, and the whole outer ring of that layer went with it. It showed up as
   * a sheet reporting a negative area — a hole with no part around it.
   */
  const wide = runSliceJob(baseJob([ball, hollow, rod, boss({ spokeLength: 90 })]), new Map());
  check(
    'a spoke reaching past the form keeps every outer ring',
    wide.set.slices.every((s2) => s2.contours.some((c) => !c.isHole && c.area > 0)),
    `${wide.set.slices.filter((s2) => !s2.contours.some((c) => !c.isHole && c.area > 0)).length} sheets lost theirs`,
  );
  check(
    'and no sheet reports a negative area',
    wide.set.slices.every((s2) => s2.contours.reduce((sum, c) => sum + c.area, 0) > 0),
  );
  check(
    'as many sheets as without it',
    wide.set.slices.length === plain.set.slices.length,
    `${wide.set.slices.length} against ${plain.set.slices.length}`,
  );

  // The boss really does add material: a mid sheet is heavier than the bare ring.
  const areaOf = (result, index) =>
    result.set.slices.find((s2) => s2.index === index).contours.reduce((sum, c) => sum + c.area, 0);
  const mid = plain.set.slices[Math.floor(plain.set.slices.length / 2)].index;
  check('a boss adds material to the sheet', areaOf(inside, mid) > areaOf(plain, mid));
  check('and a longer spoke adds more', areaOf(wide, mid) > areaOf(inside, mid));

  /*
   * The plan must not move. The boss's own span is read from it, so growing the
   * box in Z would be circular — and it would reroll every per-layer window and
   * shift the sheets of every saved lamp.
   */
  check(
    'the layers stay exactly where they were',
    wide.set.slices.map((s2) => s2.z.toFixed(6)).join(',') ===
      plain.set.slices.map((s2) => s2.z.toFixed(6)).join(','),
  );

  // A boss whose rod is gone contributes nothing rather than jumping to the axis.
  const orphan = runSliceJob(baseJob([ball, hollow, boss({})]), new Map());
  check(
    'a boss with no rod adds nothing',
    Math.abs(areaOf(orphan, mid) - areaOf(plain, mid)) < 1e-6,
  );
}

console.log('pipeline: the stack reaches the field, not just the slicer');
{
  const uniform = runSliceJob(baseJob([body, shell]), new Map());

  // Same stack said two ways. Equal ends must be the uniform stack exactly,
  // because a uniform stack is planned by a closed form and a graded one by
  // marching, and the two agree to about 1e-12 rather than agreeing.
  const spelledOut = runSliceJob(
    { ...baseJob([body, shell]), spacerHeightTop: 6, spacerThickness: 3 },
    new Map(),
  );
  check(
    'spelling out an equal top gap changes nothing',
    JSON.stringify(spelledOut.set.slices) === JSON.stringify(uniform.set.slices),
  );

  const graded = runSliceJob(
    { ...baseJob([body, shell]), spacerHeight: 3, spacerHeightTop: 12, spacerThickness: 3 },
    new Map(),
  );
  check('a graded stack slices', graded.set !== null && graded.set.slices.length > 4,
    `${graded.set?.slices.length} layers`);
  const gaps = graded.set.planes.map((p) => p.gapAbove);
  check('its gaps open out going up', gaps[gaps.length - 1] > gaps[0], `${gaps[0]} to ${gaps[gaps.length - 1]}`);
  check('every gap is a whole number of rings', gaps.every((g) => Math.abs(g % 3) < 1e-12));
  check('and it is a different lamp from the uniform one', graded.set.slices.length !== uniform.set.slices.length);

  // Rings of their own material: the plan changes because the quantisation does.
  const fine = runSliceJob(
    { ...baseJob([body, shell]), spacerHeight: 4, spacerThickness: 1 },
    new Map(),
  );
  const coarse = runSliceJob(
    { ...baseJob([body, shell]), spacerHeight: 4, spacerThickness: 3 },
    new Map(),
  );
  check('a 4 mm gap is 4 mm from 1 mm rings', fine.set.planes.every((p) => Math.abs(p.gapAbove - 4) < 1e-12));
  check('and 3 mm from 3 mm rings, planned as what it will be',
    coarse.set.planes.every((p) => Math.abs(p.gapAbove - 3) < 1e-12));
}

console.log('pipeline: nesting goes through one entry point');
{
  const circle = (r, n = 64, cx = 0, cy = 0) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    return out;
  };

  const ring = (id, label, outerR, innerR) => ({
    id,
    label,
    kind: 'slice',
    material: 'stock',
    outer: circle(outerR),
    holes: [circle(innerR)],
    circles: [],
    layer: 1,
  });

  /**
   * One part that is neither round nor centred on the origin.
   *
   * Without it every part's bounding-box centre is [0, 0], the pivot is [0, 0]
   * by coincidence, and a rehydration that lost the pivot entirely would still
   * pass — which is what happened to the first version of this test.
   */
  const lopsided = {
    id: 'slice-7-0',
    label: 'L07',
    kind: 'slice',
    material: 'stock',
    outer: [10, 4, 58, 4, 58, 20, 26, 20, 26, 46, 10, 46],
    holes: [],
    circles: [{ x: 18, y: 12, r: 2.65 }],
    layer: 7,
  };

  const disc = (id, r) => ({
    id,
    label: 'SP',
    kind: 'spacer',
    material: 'stock',
    outer: circle(r),
    outerCircle: { x: 0, y: 0, r },
    holes: [],
    circles: [{ x: 0, y: 0, r: 2.65 }],
  });

  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(ring(`slice-${i + 1}-0`, `L0${i + 1}`, 45 - i * 2, 34 - i * 2));
  for (let i = 0; i < 10; i++) parts.push(disc(`spacer-r1-${i}`, 8));
  parts.push(lopsided);

  check(
    'the job has a part whose pivot is not the origin',
    Math.abs((lopsided.outer[0] + lopsided.outer[2]) / 2) > 1,
  );

  // A small bed on purpose: on a big one both packers fit everything on one
  // sheet and agree, and the checks below would have nothing to see.
  const options = { sheetWidth: 200, sheetHeight: 200, gap: 3, labelHeight: 4 };
  const shelf = { ...options, trueShape: false };
  const truth = { ...options, trueShape: true, cell: 1.5 };

  const a = runNestJob({ parts, options: shelf });
  const b = runNestJob({ parts, options: shelf });
  check(
    'the same job packs the same way',
    deepEqual({ ...a, ms: 0 }, { ...b, ms: 0 }),
  );
  check('and reports a time', a.ms >= 0);

  // The reply is positions, not parts. Neither packer touches geometry, so
  // sending it back would be sending it home again.
  check(
    'the placement table carries no geometry',
    !JSON.stringify(a).includes('"outer"') && !JSON.stringify(a).includes('"holes"'),
  );

  check('and both directions survive a thread boundary', (() => {
    try {
      structuredClone({ parts, options: shelf });
      structuredClone(a);
      return true;
    } catch {
      return false;
    }
  })());

  // The check that matters: the round trip through the job boundary must give
  // exactly what calling the nester directly gives.
  for (const [name, opts] of [['shelf packing', shelf], ['true shape', truth]]) {
    const direct = nestByMaterial(parts, opts);
    const round = rehydrateNest(runNestJob({ parts, options: opts }), parts);
    check(
      `${name}: the job boundary changes nothing`,
      deepEqual(direct, { sheets: round.sheets, unplaced: round.unplaced }),
    );
    check(`${name}: nothing goes missing`, round.missing.length === 0);
  }

  // Precondition for the pair above: if the two packers agreed on this job, a
  // dropped `trueShape` would slip through both of those checks unnoticed.
  const shelfLayout = runNestJob({ parts, options: shelf });
  const trueLayout = runNestJob({ parts, options: truth });
  check(
    'the two packers disagree on this job, so a dropped option would show',
    trueLayout.sheets[0].placements.length > shelfLayout.sheets[0].placements.length,
    `first sheet holds ${shelfLayout.sheets[0].placements.length} boxed, ` +
      `${trueLayout.sheets[0].placements.length} true-shape`,
  );

  // Materials never share a sheet, and that has to survive the boundary too.
  const mixed = [
    ring('slice-9-0', 'L09', 40, 30),
    { ...ring('window-w-9-0', 'W09', 20, 10), material: 'window' },
  ];
  const split = rehydrateNest(runNestJob({ parts: mixed, options: shelf }), mixed);
  check(
    'materials stay on their own sheets',
    split.sheets.length === 2 && split.sheets.every((s) => s.ordinal === 1),
    split.sheets.map((s) => `${s.index}:${s.material}`).join(' '),
  );

  const oversize = [ring('slice-1-0', 'L01', 45, 34), ring('huge', 'BIG', 300, 280)];
  const big = rehydrateNest(runNestJob({ parts: oversize, options: shelf }), oversize);
  check(
    'a part too large for the bed is reported, not dropped',
    big.unplaced.length === 1 && big.unplaced[0].id === 'huge',
  );
  check('and it comes back as the whole part', big.unplaced[0].outer.length > 0);

  const empty = runNestJob({ parts: [], options: shelf });
  check(
    'an empty job gives an empty layout rather than throwing',
    empty.sheets.length === 0 && empty.unplacedIds.length === 0,
  );
  check('and matches the idle shape', deepEqual({ ...empty, ms: 0 }, EMPTY_NEST));

  // Rehydrating against the wrong parts is a caller bug, but a part vanishing
  // off a sheet with no explanation is the failure this program keeps fixing.
  const wrong = rehydrateNest(a, parts.slice(0, 3));
  check('a placement with no part is reported', wrong.missing.length > 0, `${wrong.missing.length} ids`);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    slicing pipeline');
