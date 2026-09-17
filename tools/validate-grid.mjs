#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { runSliceJob } from '../src/core/pipeline.ts';
import { gridFeatures, gridMember, gridMembers, gridPosition, GRID_LIMITS, gridPlannedParts } from '../src/core/grid.ts';
import { sheetLocal } from '../src/core/assembly.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';

const bounds = { min: [-60, -60, -60], max: [60, 60, 60] };
const source = { id: 'f1', kind: 'roundBox', stage: 'SHAPE', name: 'Grid source', enabled: true, params: { op: 'union', sx: 120, sy: 120, sz: 120, r: 2 } };
const options = { thickness: 3, kerf: .15, materialName: 'Test stock', spacerHeight: 6, resolution: 120, tolerance: .04, smoothing: 0, minFeature: 1, seed: 1 };
const created = gridFeatures(2, bounds);
for (const axis of ['x', 'y']) created.features.push(gridMember(created.features[0], axis, created.features, created.next++));
Object.assign(created.features[0].params, { spacingX: 33.6, spacingY: 33.6, spacingZ: 33.6 });
const original = [source, ...created.features];
const run = (features = original, extra = {}) => runSliceJob({ ...options, features, ...extra }, new Map()).set;
const errors = set => set.assembly.issues.filter(i => i.severity === 'error');
const good = set => assert.equal(set.assembly.cuttable, true, JSON.stringify(errors(set)));
const distance = contours => {
  const index = indexProfile({ rings: contours.map(c => c.points), fill: 'holes' }, 1, .02, 8);
  return (x, y) => indexedDistance(index, x, y);
};
const box = contours => {
  const values = axis => contours.flatMap(c => c.points.filter((_, i) => i % 2 === axis));
  return [0, 1].map(axis => [Math.min(...values(axis)), Math.max(...values(axis))]);
};
const set = run(); good(set);
assert.equal(set.slices.filter(s => s.part.gridAxis === 'z').length, 3 * 4 * 4);
assert.equal(set.slices.filter(s => s.part.gridAxis !== 'z').length, 6);
assert.ok(set.slices.every(s => s.nominalContours.filter(c => !c.isHole).length === 1));
assert.equal(new Set(set.slices.map(s => s.part.id)).size, set.slices.length);
assert.ok(set.assembly.issues.some(i => i.message.includes('assembly order')));
const fields = new Map(set.slices.map(s => [s.part.id, distance(s.nominalContours)]));
// Independent world-space occupancy checks against the FINISHED outlines,
// across both physical slabs, rather than replaying the slot construction.
for (let i = 0; i < set.slices.length; i++) for (let j = i + 1; j < set.slices.length; j++) {
  const a = set.slices[i].part, b = set.slices[j].part;
  const aa = 'xyz'.indexOf(a.gridAxis), bb = 'xyz'.indexOf(b.gridAxis);
  if (aa === bb) continue;
  const line = [0, 1, 2].find(k => k !== aa && k !== bb);
  for (const da of [-.49, 0, .49]) for (const db of [-.49, 0, .49]) for (let q = -60; q <= 60; q += .6) {
    const point = [0, 0, 0]; point[aa] = a.origin[aa] + da * a.thickness; point[bb] = b.origin[bb] + db * b.thickness; point[line] = q;
    const pa = sheetLocal(a, point), pb = sheetLocal(b, point);
    assert.ok(!(fields.get(a.id)(pa[0], pa[1]) < -.06 && fields.get(b.id)(pb[0], pb[1]) < -.06), `finished slabs intersect: ${a.label} / ${b.label} at ${point}`);
  }
}
for (const tile of set.slices.filter(s => s.part.gridAxis === 'z')) {
  const joint = set.assembly.joints.find(j => j.parts.includes(tile.part.id)); assert.ok(joint);
  const wall = set.slices.find(s => s.part.id === joint.parts.find(id => id !== tile.part.id)); assert.ok(wall);
  // A real tab must occupy the receiver slab, and the complete slot must be empty.
  const ax = wall.part.gridAxis === 'x' ? 0 : 1, other = 1 - ax;
  let material = 0;
  for (let u = -60; u <= 60; u += .4) {
    const p = [0, 0, tile.z]; p[ax] = wall.part.origin[ax]; p[other] = u;
    if (fields.get(tile.part.id)(p[0], p[1]) < -.1) {
      material++;
      for (const dz of [-.49, 0, .49]) { const local = sheetLocal(wall.part, [p[0], p[1], tile.z + dz * options.thickness]); assert.ok(fields.get(wall.part.id)(local[0], local[1]) > .02); }
    }
  }
  assert.ok(material > 10, `missing tab in ${tile.part.label}`);
  // Stage by translating away from the receiving wall. Insertion travel
  // must clear every other upright slab; the path then stays within the cell.
  const sign = joint.instruction.includes(`slide -${wall.part.gridAxis.toUpperCase()}`) ? 1 : -1;
  const travel = options.thickness + Number(created.features[0].params.jointClearance) + set.step;
  const tb = box(tile.nominalContours);
  for (const otherWall of set.slices.filter(s => s.part.gridAxis !== 'z')) {
    const oa = otherWall.part.gridAxis === 'x' ? 0 : 1, tangent = 1 - oa;
    for (const fraction of [0, .25, .5, .75, 1]) for (const dz of [-.49, 0, .49]) for (let u = tb[tangent][0]; u <= tb[tangent][1]; u += .5) {
      const p = [0, 0, tile.z + dz * options.thickness]; p[oa] = otherWall.part.origin[oa]; p[tangent] = u;
      const localTile = [...p]; localTile[ax] -= sign * travel * fraction;
      const localWall = sheetLocal(otherWall.part, p);
      assert.ok(!(fields.get(tile.part.id)(localTile[0], localTile[1]) < -.06 && fields.get(otherWall.part.id)(localWall[0], localWall[1]) < -.06), `${tile.part.label} insertion hits ${otherWall.part.label}`);
    }
  }
}
console.log('  ok    XYZ profiles, connected parts, full-stock collision checks, every tab/socket and insertion travel');

const uncompensated = run(original, { kerf: 0 }); good(uncompensated);
const tile = set.slices.find(s => s.part.gridAxis === 'z'), plain = uncompensated.slices.find(s => s.part.id === tile.part.id);
for (let axis = 0; axis < 2; axis++) {
  const a = box(tile.contours)[axis], b = box(plain.contours)[axis];
  assert.ok(Math.abs((a[1] - a[0]) - (b[1] - b[0]) - options.kerf) < .045, 'one in-plane kerf compensation');
}
const transformed = structuredClone(original); Object.assign(transformed[1].params, { angle: 37, px: 11, py: -7, pz: 9 });
const moved = run(transformed); good(moved); assert.deepEqual(moved.slices.map(s => s.contours), set.slices.map(s => s.contours));
assert.notDeepEqual(moved.slices.map(s => s.part.origin), set.slices.map(s => s.part.origin));
const sphere = structuredClone(original); Object.assign(sphere[0], { kind: 'sphere', params: { op: 'union', r: 60 } });
const curved = run(sphere); good(curved); assert.notDeepEqual(curved.slices.map(s => s.contours), set.slices.map(s => s.contours));
const smallDefault = gridFeatures(2, { min: [-40, -40, -40], max: [40, 40, 40] });
good(run([{ ...sphere[0], params: { op: 'union', r: 40 } }, ...smallDefault.features]));
assert.ok(curved.assembly.issues.some(i => /[1-9]\d* cells contain no source/.test(i.message)));
const cavity = structuredClone(original).filter(f => !(f.kind === 'assembly:grid' && f.params.axis !== 'z' && f.params.ordinal === 1));
cavity[1].params.spacingX = cavity[1].params.spacingY = 60;
cavity.splice(1, 0, { id: 'f99', kind: 'sphere', stage: 'SHAPE', name: 'Light cavity', enabled: true, params: { op: 'subtract', r: 18 } });
const hollow = run(cavity); good(hollow);
assert.ok(hollow.slices.some(s => s.part.gridAxis === 'z' && s.nominalContours.some(c => c.isHole)), 'the actual cavity remains open');
const changed = structuredClone(original); changed[0].params.sx = 130;
assert.notDeepEqual(run(changed).slices.map(s => s.contours), set.slices.map(s => s.contours), 'source edits regenerate grid cuts');
console.log('  ok    one kerf shift, rigid whole-grid transforms, curved source, preserved light cavity and live source edits');

const disabled = structuredClone(original), off = disabled.find(f => f.kind === 'assembly:grid' && f.params.axis === 'x'); off.enabled = false;
const retained = disabled.find(f => f.kind === 'assembly:grid' && f.params.axis === 'x' && f.id !== off.id);
assert.equal(gridPosition(retained, disabled, disabled[1]), gridPosition(retained, original, original[1]), 'hidden planes retain their stations');
assert.ok(!run(disabled).slices.some(s => s.part.id === off.id));
for (const [key, value, pattern] of [['spacingX', 1, /spacing|overlap/], ['tabWidth', 200, /no connected tab/], ['jointClearance', -1, /nonnegative/]]) {
  const bad = structuredClone(original); bad[1].params[key] = value; const out = run(bad); assert.equal(out.assembly.cuttable, false); assert.ok(errors(out).some(e => pattern.test(e.message)));
}
const unsupported = [...original, { id: 'f90', kind: 'rod', stage: 'RIG', enabled: true, name: 'Rod', params: { diameter: 5, length: 120 } }];
assert.ok(errors(run(unsupported)).some(e => e.message.includes('Grid cannot combine')));
const splitShell = [...sphere, { id: 'f90', kind: 'shell', stage: 'CARVE', name: 'Shell', enabled: true, params: { thickness: 5 } }];
assert.equal(run(splitShell).assembly.cuttable, false, 'unsupported multi-band upright joints refuse instead of filling the cavity');
console.log('  ok    stable hidden stations, crowded cells, missing tabs, invalid clearance, unsupported tools and topology refusals');

const tall = gridFeatures(2, { min: [-50, -50, -268], max: [50, 50, 268] });
tall.features[0].params.spacingZ = 8;
while (gridMembers(tall.features, tall.features[0], 'z').length < GRID_LIMITS.z) tall.features.push(gridMember(tall.features[0], 'z', tall.features, tall.next++));
const tallFeatures = [{ ...source, params: { ...source.params, sx: 100, sy: 100, sz: 536 } }, ...tall.features];
const tallStart = performance.now(), tallSet = run(tallFeatures); good(tallSet);
const tallCells = tallSet.slices.filter(s => s.part.gridAxis === 'z');
assert.equal(new Set(tallCells.map(s => s.part.featureId)).size, 64, 'all requested horizontal planes produce cut cells');
assert.equal(tallSet.slices.length, gridPlannedParts(tall.features, tall.features[0]));
assert.ok(tallSet.slices.every(s => s.nominalContours.filter(c => !c.isHole).length === 1), 'finished receivers stay connected with many sockets');
assert.ok(tallCells.every(s => tallSet.assembly.joints.some(j => j.parts.includes(s.part.id))), 'every horizontal cell is attached');
assert.equal(new Set(tallSet.slices.map(s => s.part.id)).size, tallSet.slices.length);
const tooMany = [...tallFeatures, gridMember(tall.features[0], 'z', tall.features, tall.next)];
assert.ok(errors(run(tooMany)).some(e => /Z has 65 planes; the limit is 64/.test(e.message)));
const overBudget = structuredClone(tallFeatures);
let nextBudget = tall.next;
for (const axis of ['x', 'y']) for (let i = 0; i < 3; i++) overBudget.push(gridMember(overBudget[1], axis, overBudget, nextBudget++));
const refused = run(overBudget);
assert.equal(refused.slices.length, 0);
assert.ok(errors(refused).some(e => e.message.includes(`${gridPlannedParts(overBudget, overBudget[1])} cut parts`) && e.message.includes('1024-part limit')));
console.log(`  ok    64 horizontal planes, ${tallSet.slices.length} attached/connected parts in ${((performance.now() - tallStart) / 1000).toFixed(1)} s, axis limits and explicit whole-grid budget`);

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
try {
  const { useKerros } = await server.ssrLoadModule('/src/core/store.ts');
  const { parseProject, serializeProject } = await server.ssrLoadModule('/src/core/project.ts');
  const { runNestJob, rehydrateNest } = await server.ssrLoadModule('/src/core/pipeline.ts');
  const { buildParts, manifestText, sheetToDxf, assemblyDocument } = await server.ssrLoadModule('/src/core/job.ts');
  const { writeDxfR12 } = await server.ssrLoadModule('/src/core/dxf.ts');
  const { writePdf } = await server.ssrLoadModule('/src/core/pdf.ts');
  const state = () => useKerros.getState();
  state().addShape('roundBox');
  for (const [key, value] of Object.entries(source.params)) state().setParam(state().features[0].id, key, value);
  state().addAssembly('linear'); const linear = state().features.find(f => f.kind === 'assembly:layout');
  state().addAssembly('grid'); const layout = state().features.find(f => f.params.layout === 'grid');
  assert.equal(state().features.find(f => f.id === linear.id).enabled, false);
  assert.equal(state().selectedId, layout.id); assert.equal(state().mode, 'stack');
  state().setGridCount(layout.id, 'x', 3); state().setGridCount(layout.id, 'y', 3);
  for (const axis of ['X', 'Y', 'Z']) state().setParam(layout.id, `spacing${axis}`, 33.6);
  const members = gridMembers(state().features, layout, 'x'), removed = members.at(-1).id;
  state().setParam(members[0].id, 'offset', 2); state().setGridCount(layout.id, 'x', 2);
  assert.equal(state().features.find(f => f.id === members[0].id).params.offset, 2);
  const saved = parseProject(serializeProject(state().projectData(), '0.39.0', '2026-09-17T00:00:00Z'));
  state().applyProject(saved.data, saved.nextFeatureNumber); state().setGridCount(layout.id, 'x', 3);
  assert.ok(!state().features.some(f => f.id === removed), 'deleted identities are not reused');
  state().setParam(members[0].id, 'offset', 0);
  const job = { ...options, features: state().features }, out = run(job.features); good(out);
  state().addAssembly('linear'); assert.equal(state().features.find(f => f.id === layout.id).enabled, false);
  state().addAssembly('grid'); assert.equal(state().features.filter(f => f.kind === 'assembly:layout' && f.enabled).length, 1);
  const parts = buildParts(out, []);
  const nested = rehydrateNest(runNestJob({ parts, options: { bedWidth: 730, bedHeight: 410, margin: 5, gap: 3, trueShape: false, resolution: 1 } }), parts);
  assert.equal(nested.unplaced.length, 0);
  const input = { set: out, sheets: nested.sheets, spacers: [], machineName: 'Test', materialName: 'Stock', thickness: 3, kerf: .15, spacerHeight: 6, spacerAchieved: 0, ringThickness: 3, version: '0.39.0', projectName: 'XYZ Grid' };
  const manifest = manifestText(input), pdf = writePdf(assemblyDocument(input));
  for (const part of parts) assert.ok(manifest.includes(part.label));
  assert.ok(manifest.includes('bottom to top') && manifest.includes('opposite-edge gap'));
  assert.ok(pdf.startsWith('%PDF'));
  for (const sheet of nested.sheets) { const dxf = writeDxfR12(sheetToDxf(sheet)); assert.ok(dxf.includes('POLYLINE') && !/NaN|Infinity/.test(dxf)); }
  const previous = globalThis.self, replies = [];
  globalThis.self = { postMessage: message => replies.push(structuredClone(message)) };
  try { await server.ssrLoadModule('/src/ui/kerros.worker.ts'); globalThis.self.onmessage({ data: { kind: 'slice', token: 71, job } }); assert.equal(replies.at(-1).kind, 'sliced'); assert.deepEqual(replies.at(-1).output.set, out); }
  finally { globalThis.self = previous; }
  if (process.env.KERROS_VALIDATION_ARTIFACTS) {
    writeFileSync(`${process.env.KERROS_VALIDATION_ARTIFACTS}/kerros-grid.kerros.json`, serializeProject(state().projectData(), '0.39.0', '2026-09-17T00:00:00Z'));
    writeFileSync(`${process.env.KERROS_VALIDATION_ARTIFACTS}/kerros-grid.pdf`, pdf, 'binary');
  }
  const retainedZ = gridMembers(state().features, layout, 'z');
  state().setParam(retainedZ[0].id, 'offset', 2);
  state().setGridCount(layout.id, 'z', 24);
  assert.equal(gridMembers(state().features, layout, 'z').length, 24);
  assert.deepEqual(gridMembers(state().features, layout, 'z').slice(0, retainedZ.length).map(f => f.id), retainedZ.map(f => f.id));
  const largeSaved = parseProject(serializeProject(state().projectData(), '0.39.1', '2026-09-17T00:00:00Z'));
  state().applyProject(largeSaved.data, largeSaved.nextFeatureNumber);
  assert.equal(gridMembers(state().features, layout, 'z').length, 24);
  assert.equal(state().features.find(f => f.id === retainedZ[0].id).params.offset, 2);
  state().setGridCount(layout.id, 'z', 99);
  assert.equal(gridMembers(state().features, layout, 'z').length, 64);
  state().setGridCount(layout.id, 'z', 0);
  assert.equal(gridMembers(state().features, layout, 'z').length, 0);
  state().setGridCount(layout.id, 'z', 12);
  assert.ok(gridMembers(state().features, layout, 'z').every(f => !retainedZ.some(old => old.id === f.id)));
  assert.ok(readFileSync('src/ui/FeatureTree.tsx', 'utf8').includes("addAssembly('grid')"));
  assert.ok(readFileSync('src/ui/AssemblyInspector.tsx', 'utf8').includes('<GridInspector'));
  console.log('  ok    real store, layout switching, saved identities, worker, material nesting, DXF, manifest, PDF and reachable UI');
} finally { await server.close(); }
console.log('OK    orthogonal grid and split horizontal cells');
