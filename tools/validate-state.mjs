#!/usr/bin/env node
/** Exercise the actual store; Vite resolves the browser graph without a port. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
try {
  const { useKerros, importEntry, importGrids } = await server.ssrLoadModule('/src/core/store.ts');
  const bytes = new TextEncoder().encode([
    'v 0 0 0', 'v 10 0 0', 'v 0 10 0', 'v 0 0 10',
    'f 1 3 2', 'f 1 2 4', 'f 1 4 3', 'f 2 3 4',
  ].join('\n'));
  const id = useKerros.getState().loadImport(null, 'first.obj', bytes);
  assert.ok(importEntry(id));
  assert.equal(importGrids().length, 1);
  const before = useKerros.getState();
  const project = before.projectData();
  project.features[0].params.path = 'different.obj';
  before.applyProject(project, 2);
  assert.equal(useKerros.getState().features[0].id, id);
  assert.equal(importEntry(id), undefined, 'a reused feature id must not reuse another project mesh');
  assert.deepEqual(importGrids(), [], 'the next worker sync must clear its mesh cache too');
  assert.ok(useKerros.getState().importRevision > before.importRevision);
  assert.ok(useKerros.getState().projectRevision > before.projectRevision);
  useKerros.getState().loadImport(id, 'different.obj', bytes);
  assert.ok(importEntry(id), 'locating the new project mesh must work');
  const reloaded = useKerros.getState();
  reloaded.applyProject(reloaded.projectData(), 2);
  assert.equal(importEntry(id), undefined, 'opening even the same project starts with no baked meshes');

  // Follow a user-created punch through saving, reopening, part construction
  // and the actual DXF export path, rather than rebuilding its geometry here.
  const { serializeProject, parseProject } = await server.ssrLoadModule('/src/core/project.ts');
  const { runSliceJob } = await server.ssrLoadModule('/src/core/pipeline.ts');
  const { buildParts, sheetToDxf } = await server.ssrLoadModule('/src/core/job.ts');
  const { nestParts } = await server.ssrLoadModule('/src/core/nest.ts');
  const { writeDxfR12 } = await server.ssrLoadModule('/src/core/dxf.ts');
  const lamp = useKerros.getState().projectData();
  lamp.features = [{ id: 'f1', kind: 'roundBox', stage: 'SHAPE', name: 'Body', enabled: true,
    params: { op: 'union', sx: 80, sy: 80, sz: 30, pz: 15, r: 0 } }];
  useKerros.getState().applyProject(lamp, 2);
  useKerros.getState().addHolePunch(10, -8, 10.5, 6);
  const created = useKerros.getState().features.at(-1);
  assert.equal(created.kind, 'holePunch');
  assert.equal(useKerros.getState().selectedId, created.id);
  assert.equal(useKerros.getState().panel, 'inspector');
  const reopened = parseProject(serializeProject(useKerros.getState().projectData(), '0.28.0', '2026-09-13T00:00:00Z'));
  assert.ok(reopened.data);
  assert.deepEqual(reopened.data.features.at(-1), created);
  useKerros.getState().applyProject(reopened.data, reopened.nextFeatureNumber);
  useKerros.getState().moveOriginWorldBy(created.id, 2, 3);
  const moved = useKerros.getState().features.at(-1);
  assert.equal(moved.params.pz, created.params.pz, 'dragging a punch keeps its layer height');
  assert.equal(moved.params.px, 12);
  assert.equal(moved.params.py, -5);
  const cuts = runSliceJob({ features: useKerros.getState().features, thickness: 3, spacerHeight: 6,
    kerf: 0.2, resolution: 80, tolerance: 0.05, smoothing: 1, minFeature: 1, seed: 7 }, new Map());
  const parts = buildParts(cuts.set, []);
  assert.equal(parts.flatMap((p) => p.circles).length, 1);
  assert.equal(parts.find((p) => p.circles.length).layer, 2);
  const packed = nestParts(parts, { sheetWidth: 720, sheetHeight: 400, gap: 4, labelHeight: 3 });
  assert.equal(packed.unplaced.length, 0);
  const documents = packed.sheets.map(sheetToDxf);
  assert.equal(documents.flatMap((d) => d.circles).length, 1);
  assert.equal(documents.flatMap((d) => d.circles)[0].r, (6 - 0.2) / 2);
  assert.ok(documents.some((d) => writeDxfR12(d).includes('CIRCLE')));
  assert.ok(documents.every((d) => !/NaN|Infinity/.test(writeDxfR12(d))), 'export contains only finite coordinates');
  useKerros.getState().removeFeature(created.id);
  assert.equal(useKerros.getState().features.some((f) => f.id === created.id), false);
  console.log('  ok    hole punch creation, save/open, drag, part building, nesting, DXF and deletion');

  // Run the real worker message handler with the platform's structured-clone
  // transport, including buffer detachment. No geometry or algorithm is mocked.
  const previousSelf = globalThis.self;
  const replies = [];
  globalThis.self = {
    postMessage(message, transfer = []) {
      replies.push(structuredClone(message, { transfer }));
    },
  };
  try {
    await server.ssrLoadModule('/src/ui/kerros.worker.ts');
    const empty = { features: [], resolution: 32, thickness: 3, kerf: 0.2, spacerHeight: 6, seed: 7 };
    for (let token = 1; token <= 3; token++) {
      globalThis.self.onmessage({ data: { kind: 'preview', token, job: empty } });
      const reply = replies.at(-1);
      assert.equal(reply.kind, 'previewed', `empty preview ${token}: ${reply.message ?? ''}`);
      assert.equal(reply.output.triangles, 0);
      assert.equal(reply.token, token);
    }
    globalThis.self.onmessage({ data: { kind: 'preview', token: 4, job: {
      ...empty, features: [{ id: 'body', kind: 'sphere', stage: 'SHAPE', enabled: true, params: { r: 10, op: 'union' } }],
    } } });
    assert.equal(replies.at(-1).kind, 'previewed');
    assert.ok(replies.at(-1).output.triangles > 0, 'normal mesh buffers still transfer');
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
  console.log('OK  project state: project-owned mesh caches and repeatable worker preview transfers');
} finally {
  await server.close();
}
