#!/usr/bin/env node
/** Hole punches through the real pipeline, including layer ownership and kerf. */
import assert from 'node:assert/strict';
import { runSliceJob, placePunch, paintPlaneIndex } from '../src/core/pipeline.ts';
import { circleFitsInPart, groupContours, signedArea } from '../src/core/slice.ts';

const feature = (id, kind, stage, params) => ({ id, kind, stage, name: id, enabled: true, params });
const body = feature('body', 'roundBox', 'SHAPE', { op: 'union', sx: 80, sy: 80, sz: 30, pz: 15, r: 0 });
const job = { features: [body], thickness: 3, spacerHeight: 6, kerf: 0.2,
  resolution: 80, tolerance: 0.05, smoothing: 1, minFeature: 1, seed: 7 };
const run = (features, options = {}) => runSliceJob({ ...job, features, ...options }, new Map());
const base = run([body]);
const chosen = base.set.slices[1];
const punch = feature('punch', 'holePunch', 'SLICE', { px: 10, py: -8, pz: chosen.z, diameter: 6 });
const output = run([body, punch]);
assert.deepEqual(output.punchResults.punch, { status: 'placed', layer: chosen.index });
for (const [i, slice] of output.set.slices.entries()) {
  assert.deepEqual(slice.contours, base.set.slices[i].contours, 'punches never change the part outline');
  if (slice.index !== chosen.index) assert.deepEqual(slice, base.set.slices[i], 'every other layer is unchanged');
}
const cut = output.set.slices[1].circles[0];
assert.equal(cut.owner, punch.id);
assert.equal(cut.x, punch.params.px);
assert.equal(cut.y, punch.params.py);
assert.equal(cut.r * 2 + job.kerf, punch.params.diameter, 'beam width restores the requested finished diameter');
assert.deepEqual(run([body, { ...punch, enabled: false }]).set, base.set, 'disabling a punch restores the original cuts');
const turned = run([body, punch], { twistPerLayer: 37 });
assert.deepEqual(turned.set.slices[1].circles, output.set.slices[1].circles, 'sheet-local punches are not counter-rotated');
const changed = run([body, punch], { thickness: 4, spacerHeight: 3 });
const owningPlane = paintPlaneIndex(changed.set.planes, punch.params.pz);
const owningZ = changed.set.planes.find((p) => p.index === owningPlane).z;
assert.equal(changed.set.slices.filter((s) => s.circles.some((c) => c.owner === punch.id)).length, 1);
assert.equal(changed.set.slices.find((s) => s.circles.some((c) => c.owner === punch.id)).z, owningZ,
  'a changed plan resolves the saved height through the shared nearest-plane rule');
const outside = { ...punch, params: { ...punch.params, pz: 1000 } };
assert.equal(run([body, outside]).punchResults.punch.status, 'outside-stack');
const lower = { ...body, params: { ...body.params, sz: 3, pz: 1.5 } };
const upper = { ...body, id: 'upper', params: { ...body.params, sz: 3, pz: 28.5 } };
assert.equal(run([lower, upper, punch]).punchResults.punch.status, 'empty-layer', 'an empty plane must not retarget a different sheet');
const copy = { ...punch, id: 'second' };
assert.equal(run([body, punch, copy]).punchResults.second.status, 'overlap', 'tree order deterministically resolves overlapping punches');
const pattern = feature('pattern', 'hex', 'PATTERN', { radius: 1.5, pitch: 9, density: 1, minBridge: 1 });
const patterned = run([body, pattern, punch]);
const holeLayer = patterned.set.slices.find((s) => s.index === chosen.index);
assert.equal(patterned.punchResults.punch.status, 'placed');
assert.ok(patterned.patternCounts.pattern > 0);
for (const hole of holeLayer.circles.filter((c) => c.owner === 'pattern')) {
  assert.ok(Math.hypot(hole.x - cut.x, hole.y - cut.y) > hole.r + cut.r, 'perforation keeps clear of the punched hole');
}
console.log('  ok    one sheet, kerf, disabling, twist, changed plans, empty planes, overlapping punches and perforation');

const ring = (points) => ({ points, area: signedArea(points), isHole: signedArea(points) < 0 });
const square = ring([-40, -40, 40, -40, 40, 40, -40, 40]);
const sparse = { index: 1, z: chosen.z, contours: [square], circles: [] };
assert.equal(circleFitsInPart(groupContours([square])[0], { x: 39, y: 0, r: 3 }), false,
  'a circle crossing the middle of a long edge does not fit');
assert.equal(placePunch(sparse, 39, 0, 6, 0).status, 'no-material');
assert.equal(placePunch(sparse, 37, 0, 6, 0).status, 'no-material', 'tangent circles are not full holes');
assert.equal(placePunch(sparse, 0, 0, job.kerf, job.kerf).status, 'too-small');
assert.equal(placePunch(sparse, NaN, 0, 6, job.kerf).status, 'invalid');
const bored = { ...sparse, contours: [square, ring([-5, -5, -5, 5, 5, 5, 5, -5])] };
assert.equal(placePunch(bored, 0, 0, 6, 0).status, 'no-material', 'the middle of a cavity is not material');
assert.equal(placePunch(bored, 7, 0, 6, 0).status, 'no-material', 'crossing an existing hole edge is refused');
assert.equal(placePunch({ ...sparse, circles: [cut] }, cut.x, cut.y, 6, job.kerf).status, 'overlap');
const narrow = { ...punch, params: { ...punch.params, px: 36.5, py: 0 } };
const warned = run([body, narrow]);
assert.equal(warned.punchResults.punch.status, 'placed');
assert.ok(warned.reports[chosen.index - 1].tooThin, 'an accepted narrow bridge still reaches the existing manufacturability warning');
console.log('  ok    long edges, tangency, existing cavities, invalid input and narrow-bridge warnings');
console.log('OK    hole punches');
