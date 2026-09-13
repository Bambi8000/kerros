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
  console.log('OK  project state: imported meshes and cache revisions belong to the opened project');
} finally {
  await server.close();
}
