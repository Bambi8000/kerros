#!/usr/bin/env node
/** Actual 3D plates, nominal snapshots, worker, persistence and UI wiring. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { Euler, Vector3, Quaternion } from 'three';
import { freePlateFrame, freePlateAngles, snapshotPlate, ribAnglePreview, ribAngleTargets } from '../src/core/assembly.ts';
import { assemblyFeatures, assemblyMember } from '../src/core/assemblyFeatures.ts';
import { runSliceJob } from '../src/core/pipeline.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b} (${tolerance})`);
const vectorNear = (a, b, tolerance) => a.forEach((v, i) => near(v, b[i], tolerance));
const options = { thickness: 3, kerf: .2, materialName: 'Birch', spacerHeight: 6, resolution: 120, tolerance: .025, smoothing: 0, minFeature: 1, seed: 7 };
const body = { id: 'f1', kind: 'roundBox', stage: 'SHAPE', name: 'Body', enabled: true, params: { op: 'union', sx: 140, sy: 120, sz: 200, pz: 100, r: 4 } };
const bounds = { min: [-70, -60, 0], max: [70, 60, 200] };
const run = features => runSliceJob({ ...options, features }, new Map()).set;
const errors = set => set.assembly.issues.filter(i => i.severity === 'error');
const box = points => [0, 1].map(axis => { const v = points.filter((_, i) => i % 2 === axis); return Math.max(...v) - Math.min(...v); });
for (const angles of [[0, 0, 0], [19, -37, 61], [180, 0, -200], [12, 90, 41], [-18, -90, 31], [29, 89.999, 100], [47, 130, -90]]) {
  const actual = freePlateFrame(...angles), euler = new Euler(...angles.map(v => v * Math.PI / 180), 'ZYX');
  for (const [key, axis] of [['u', [1, 0, 0]], ['v', [0, 1, 0]], ['n', [0, 0, 1]]]) vectorNear(actual[key], new Vector3(...axis).applyEuler(euler).toArray());
  for (const layoutAngle of [0, 37]) for (const delta of [new Quaternion(), new Quaternion().setFromEuler(new Euler(.4, -.8, 1.1, 'ZYX'))]) {
    const world = v => new Vector3(...v).applyAxisAngle(new Vector3(0, 0, 1), layoutAngle * Math.PI / 180).applyQuaternion(delta).toArray();
    const pose = freePlateAngles(world(actual.u), world(actual.v), layoutAngle);
    const recovered = freePlateFrame(pose.plateRx, pose.plateRy, pose.plateRz);
    for (const key of ['u', 'v', 'n']) vectorNear(new Vector3(...recovered[key]).applyAxisAngle(new Vector3(0, 0, 1), layoutAngle * Math.PI / 180).toArray(), world(actual[key]));
  }
}
console.log('  ok    arbitrary ZYX frames, all gizmo axes, gimbal poles and rotated layouts');

// The same nominal cut outline is copied from ribs, supports and wall plates.
for (const kind of ['linear', 'radial']) {
  const factory = assemblyFeatures(kind, 2, bounds), layout = factory.features[0];
  layout.params.angle = 37; layout.params.px = 12; layout.params.py = -9;
  const features = [body, ...factory.features], set = run(features);
  const kinds = kind === 'linear' ? ['rib', 'backplate'] : ['rib', 'support'];
  for (const memberKind of kinds) {
    const slice = set.slices.find(s => s.part.kind === memberKind); assert.ok(slice);
    const source = features.find(f => f.id === slice.part.id), original = structuredClone(source);
    const copy = snapshotPlate(source, slice, layout, set.assembly.origin, `f${factory.next}`, true);
    assert.deepEqual(source, original, 'snapshot does not mutate its source');
    assert.deepEqual(copy.plateOutline, slice.nominalContours.map(c => c.points));
    assert.notEqual(copy.plateOutline[0], slice.nominalContours[0].points, 'copy owns its loops');
    const alone = run([body, layout, copy]), cloned = alone.slices[0];
    assert.deepEqual(errors(alone), []);
    assert.equal(cloned.part.kind, 'plate'); assert.equal(cloned.part.stockName, slice.part.stockName);
    assert.equal(cloned.contours.filter(c => c.isHole).length, slice.contours.filter(c => c.isHole).length);
    vectorNear(box(cloned.contours.find(c => !c.isHole).points), box(slice.contours.find(c => !c.isHole).points), .08);
    for (const key of ['u', 'v', 'n']) vectorNear(cloned.part[key], slice.part[key]);
    vectorNear(cloned.part.origin, slice.part.origin.map((v, i) => v + slice.part.n[i] * (slice.part.thickness + 10)));
    const converted = snapshotPlate(source, slice, layout, set.assembly.origin, source.id, false);
    assert.equal(converted.id, source.id); assert.equal(converted.kind, source.kind);
    const free = run([body, layout, converted]).slices[0];
    for (const key of ['origin', 'u', 'v', 'n']) vectorNear(free.part[key], slice.part[key]);
  }
}
console.log('  ok    rib, support and backplate copies preserve holes, material, nominal size and orientation');

const factory = assemblyFeatures('linear', 2, bounds), layout = factory.features[0];
const plate = assemblyMember('plate', layout, [], factory.next);
Object.assign(plate.params, { plateX: 0, plateY: 0, plateZ: 0, plateRx: 37, plateRy: -28, plateRz: 61, ownMaterial: true, thickness: 6, kerf: .2 });
const frame = freePlateFrame(37, -28, 61), theta = 27 * Math.PI / 180;
const direction = frame.n.map((n, i) => n * Math.cos(theta) + frame.u[i] * Math.sin(theta));
const channel = assemblyMember('channel', layout, [], factory.next + 1);
Object.assign(channel.params, { px: 0, py: 0, pz: 0, yaw: Math.atan2(direction[1], direction[0]) * 180 / Math.PI, elevation: Math.asin(direction[2]) * 180 / Math.PI, plateTarget: true, ribTarget: false, diameter: 12, clearance: .3 });
const channelSet = run([body, layout, plate, channel]);
assert.deepEqual(errors(channelSet), []);
assert.deepEqual(channelSet.assembly.channels[0].hits, [plate.id]);
const hole = channelSet.slices[0].contours.find(c => c.isHole); assert.ok(hole);
const diameter = channel.params.diameter + channel.params.clearance * 2;
vectorNear(box(hole.points), [diameter / Math.cos(theta) + plate.params.thickness * Math.tan(theta) - plate.params.kerf, diameter - plate.params.kerf], .08);
const other = structuredClone(plate); other.id = 'f999';
Object.assign(other.params, { plateRx: -21, plateRy: 62, plateRz: -9 });
assert.ok(errors(run([body, layout, plate, other])).some(i => i.ids.includes(plate.id) && i.ids.includes(other.id) && i.message.includes('intersect')));
other.params.plateX = 200;
assert.deepEqual(errors(run([body, layout, plate, other])), []);
console.log('  ok    tilted free-plate LED opening includes full stock thickness; intersecting plates block export');
const rod = { id: 'rod', kind: 'rod', name: 'Rod', stage: 'RIG', enabled: true,
  params: { size: 'M5', px: 0, py: 0, pz: 100, rx: 37, ry: -28, rz: 61, length: 300 } };
const rodSet = run([body, layout, plate, rod]);
assert.deepEqual(errors(rodSet), []);
assert.deepEqual(rodSet.assembly.channels.find(c => c.id === rod.id).hits, [plate.id]);
console.log('  ok    world-space rods target free plates through their rotated stock');

const before = [body, layout, plate], baseline = run(before), after = before.map(f => f.id === plate.id ? { ...f, params: { ...f.params, plateX: 17, plateY: -8, plateZ: 21, plateRx: -19, plateRy: 79, plateRz: 142 } } : f);
const preview = ribAnglePreview(baseline, before, after), finished = run(after);
for (const key of ['origin', 'u', 'v', 'n']) vectorNear(preview.get(plate.id)[key], finished.slices[0].part[key]);
assert.deepEqual(finished.slices[0].contours, baseline.slices[0].contours, 'rigid moves do not reshape or rescale the cut');
const sourceRemoved = run(after.filter(f => f !== body));
assert.deepEqual(sourceRemoved.slices, finished.slices, 'free plates survive deletion of the source shape');
assert.equal(ribAnglePreview(baseline, before, after.map(f => f.id === plate.id ? { ...f, params: { ...f.params, plateWidth: 81 } } : f)), null, 'shape changes cannot borrow old geometry');
console.log('  ok    instant placement equals finished frames, unchanged cut paths and source-independent plates');

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
try {
  const { useKerros } = await server.ssrLoadModule('/src/core/store.ts');
  const { buildParts, sheetToDxf, manifestText, assemblyDocument } = await server.ssrLoadModule('/src/core/job.ts');
  const { nestByMaterial } = await server.ssrLoadModule('/src/core/nest.ts');
  const { writeDxfR12 } = await server.ssrLoadModule('/src/core/dxf.ts');
  const { writePdf } = await server.ssrLoadModule('/src/core/pdf.ts');
  const { AssemblyInspector } = await server.ssrLoadModule('/src/ui/AssemblyInspector.tsx');
  const { createElement } = await import('react'); const { renderToStaticMarkup } = await import('react-dom/server');
  const state = () => useKerros.getState();
  state().addShape('roundBox'); const source = state().features[0];
  Object.entries(body.params).forEach(([key, value]) => state().setParam(source.id, key, value));
  state().addAssembly('linear');
  const group = state().features.find(f => f.kind === 'assembly:layout'), rib = state().features.find(f => f.kind === 'assembly:rib');
  let sources = state().features, set = run(sources);
  const savedRib = structuredClone(rib), count = sources.length;
  assert.ok(state().snapshotAssemblyPlate(rib.id, set, sources, true));
  const copyId = state().selectedId; assert.notEqual(copyId, rib.id); assert.equal(state().features.length, count + 1);
  assert.equal(state().mode, 'stack'); assert.equal(state().gizmoMode, 'translate');
  assert.deepEqual(state().features.find(f => f.id === rib.id), savedRib);
  assert.equal(state().snapshotAssemblyPlate(rib.id, set, sources, true), false, 'a stale result cannot be cloned twice');
  state().setAssemblyAngleScope('all');
  let writes = 0; const unsubscribe = useKerros.subscribe(() => writes++);
  state().setFreePlatePose(copyId, { plateX: 300, plateRx: 27, plateRy: -38, plateRz: 73 });
  unsubscribe(); assert.equal(writes, 1, 'a 3D pose commits atomically');
  assert.deepEqual(state().features.find(f => f.id === rib.id), savedRib, 'All scope never makes free-plate edits change linked ribs');
  const good = state().features;
  state().setFreePlatePose(copyId, { plateRx: NaN }); assert.equal(state().features, good);
  sources = state().features; set = run(sources);
  assert.ok(state().snapshotAssemblyPlate(rib.id, set, sources, false));
  assert.equal(state().selectedId, rib.id); assert.equal(state().gizmoMode, 'rotate');
  assert.ok(!ribAngleTargets(state().features, rib.id, 'all').includes(rib.id));
  state().setParam(rib.id, 'freePlacement', false);
  const restored = state().features.find(f => f.id === rib.id);
  for (const [key, value] of Object.entries(savedRib.params)) assert.equal(restored.params[key], value);
  const project = parseProject(serializeProject(state().projectData(), '0.34.0'));
  assert.ok(project.ok); assert.deepEqual(project.warnings, []);
  state().applyProject(project.data, project.nextFeatureNumber);
  const copy = state().features.find(f => f.id === copyId);
  assert.deepEqual(copy.plateOutline, good.find(f => f.id === copyId).plateOutline);
  assert.notEqual(copy.plateOutline[0], project.data.features.find(f => f.id === copyId).plateOutline[0]);
  assert.equal(copy.params.plateRy, -38);
  const broken = JSON.parse(serializeProject(state().projectData(), '0.34.0'));
  broken.features.find(f => f.id === copyId).plateOutline.push([0, 0, 1]);
  const bad = parseProject(JSON.stringify(broken));
  assert.ok(bad.warnings.some(w => w.includes('invalid plate outline')));
  assert.ok(errors(run(bad.data.features)).some(i => i.ids.includes(copyId) && i.message.includes('saved outline')));
  sources = state().features; set = run(sources); assert.deepEqual(errors(set), []);
  const html = renderToStaticMarkup(createElement(AssemblyInspector, { feature: copy, set, sourceFeatures: sources, pending: false }));
  for (const label of ['Clone plate', 'Rotate plate', 'Position X', 'Rotation X', 'Rotation Y', 'Rotation Z']) assert.ok(html.includes(label), label);
  const waiting = renderToStaticMarkup(createElement(AssemblyInspector, { feature: copy, set, sourceFeatures: sources, pending: true }));
  assert.match(waiting, /disabled=""[^>]*>Clone plate/);
  console.log('  ok    clone selects Move, stable IDs, fresh-result guard, restore, deep save/open and reachable controls');

  const parts = buildParts(set, []), nested = nestByMaterial(parts, { sheetWidth: 720, sheetHeight: 400, gap: 4, labelHeight: 3, trueShape: false, cell: 2 });
  assert.equal(nested.unplaced.length, 0);
  assert.ok(parts.some(p => p.id.startsWith(copyId + '-') && p.label.startsWith('P')));
  for (const sheet of nested.sheets) assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  const input = { set, sheets: nested.sheets, spacers: [], machineName: 'Test', materialName: 'Birch', thickness: 3, kerf: .2, spacerHeight: 6, spacerAchieved: 0, version: '0.34.0', projectName: 'Free plates', ringThickness: 3 };
  const manifest = manifestText(input); assert.ok(manifest.includes(copyId) && manifest.includes('no generated attachments'));
  assert.ok(writePdf(assemblyDocument(input)).startsWith('%PDF'));
  const oldSelf = globalThis.self, replies = []; globalThis.self = { postMessage(m) { replies.push(structuredClone(m)); } };
  try {
    await server.ssrLoadModule('/src/ui/kerros.worker.ts');
    globalThis.self.onmessage({ data: { kind: 'slice', token: 91, job: { ...options, features: sources } } });
    assert.deepEqual(replies.at(-1).output.set, set);
  } finally { globalThis.self = oldSelf; }
  console.log('  ok    real worker, material nesting, DXF, full placement manifest and assembly PDF');
} finally { await server.close(); }
console.log('OK    free plate placement and cloning');
