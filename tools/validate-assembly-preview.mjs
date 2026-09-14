#!/usr/bin/env node
/** Fast placement agrees with real cut frames; the real bridge skips stale work. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { assemblyFeatures } from '../src/core/assemblyFeatures.ts';
import { ribAnglePreview } from '../src/core/assembly.ts';
import { runSliceJob } from '../src/core/pipeline.ts';
import { createLatestQueue } from '../src/ui/latestJob.ts';

const options = { thickness: 3, kerf: .15, spacerHeight: 6, resolution: 200, tolerance: .025, smoothing: 1, minFeature: 1, seed: 7 };
const bounds = { min: [-60, -60, -60], max: [60, 60, 60] };
const base = { id: 'f1', kind: 'sphere', stage: 'SHAPE', name: 'Body', enabled: true, params: { op: 'union', r: 60 } };
const patch = (features, id, params) => features.map(f => f.id === id ? { ...f, params: { ...f.params, ...params } } : f);
const run = features => runSliceJob({ ...options, features }, new Map());
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
let finalFeatures, finalOutput;
for (const kind of ['linear', 'radial']) {
  const factory = assemblyFeatures(kind, 2, bounds);
  const before = [base, ...factory.features];
  const layout = before.find(f => f.kind === 'assembly:layout');
  layout.params.angle = 27; layout.params.px = 14; layout.params.py = -9;
  const ribs = before.filter(f => f.kind === 'assembly:rib');
  const original = run(before), copy = structuredClone(original);
  let after = patch(before, layout.id, { ribAngle: 2, oddAngle: 4, evenAngle: -3, fanAngle: 12 });
  after = patch(after, ribs[1].id, { angle: 3 });
  const preview = ribAnglePreview(original.set, before, after), complete = run(after);
  assert.ok(preview);
  for (const slice of complete.set.slices.filter(s => s.part.kind === 'rib')) {
    const frame = preview.get(slice.part.id);
    for (const key of ['origin', 'u', 'v', 'n']) frame[key].forEach((v, i) => near(v, slice.part[key][i]));
  }
  assert.deepEqual(original, copy, 'preview never mutates the retained cuts or manufacturing report');
  assert.equal(preview.size, ribs.length, 'only rib frames are previewed, never wall/ring cut geometry');
  // Repeated edits always start from the known result, including a return to 0.
  for (const fanAngle of [40, -17, 0, 12]) {
    const current = patch(after, layout.id, { fanAngle });
    const direct = ribAnglePreview(original.set, before, current);
    const rebased = ribAnglePreview(complete.set, after, current);
    for (const [id, frame] of direct) for (const key of ['origin', 'u', 'v', 'n']) frame[key].forEach((v, i) => near(v, rebased.get(id)[key][i]));
  }
  for (const [id, params] of [[base.id, { r: 61 }], [layout.id, { spacing: 13 }], [layout.id, { angle: 31 }], [ribs[0].id, { sourceX: 5 }], [ribs[0].id, { px: 8 }], [ribs[0].id, { thickness: 4 }]]) {
    assert.equal(ribAnglePreview(original.set, before, patch(after, id, params)), null, `non-angle edit ${id}: ${JSON.stringify(params)}`);
  }
  assert.equal(ribAnglePreview(original.set, null, after), null, 'no cross-project/import/settings preview');
  assert.equal(ribAnglePreview(null, before, after), null);
  assert.equal(ribAnglePreview(original.set, before, after.slice(0, -1)), null, 'deleting a member invalidates the snapshot');
  assert.equal(ribAnglePreview(original.set, before, after.map(f => f.id === ribs[0].id ? { ...f, enabled: false } : f)), null);
  assert.equal(ribAnglePreview(original.set, before, [...after].reverse()), null, 'tree changes cannot borrow unrelated cut geometry');
  const started = performance.now();
  for (let i = 0; i < 1000; i++) ribAnglePreview(original.set, before, patch(after, layout.id, { fanAngle: i % 60 }));
  console.log(`  ok    ${kind}: live frames match cuts; 1000 placement updates ${(performance.now() - started).toFixed(1)} ms, complete rebuild ${complete.ms} ms`);
  if (kind === 'linear') { finalFeatures = after; finalOutput = complete; }
}

// Scheduler cancellation and failure are transport behaviour, not geometry mocks.
const queue = createLatestQueue(), controller = new AbortController();
let release;
const held = queue.enqueue('slice', () => new Promise(resolve => { release = resolve; }), controller.signal);
const superseded = queue.enqueue('slice', () => assert.fail('superseded job ran'));
const newest = queue.enqueue('slice', () => 42);
assert.equal(await superseded, undefined);
controller.abort(); assert.equal(await held, undefined);
release(1); assert.equal(await newest, 42);
await assert.rejects(queue.enqueue('preview', () => { throw Error('expected failure'); }), /expected failure/);
assert.equal(await queue.enqueue('slice', () => 43), 43, 'failure releases the execution slot');
const aborted = new AbortController(); aborted.abort();
assert.equal(await queue.enqueue('slice', () => assert.fail('aborted job ran'), aborted.signal), undefined);

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
const oldWorker = globalThis.Worker, oldSelf = globalThis.self;
try {
  // Delay delivery only. The real worker handler computes all replies through
  // the real pipeline, so this catches an unwired scheduler in workerBridge.
  let transport;
  globalThis.Worker = class {
    work = []; imports = 0;
    constructor() { transport = this; }
    postMessage(message) {
      if (message.kind === 'imports') { this.imports++; globalThis.self.onmessage({ data: message }); }
      else this.work.push(message);
    }
  };
  globalThis.self = { postMessage(message, transfer = []) { transport.onmessage({ data: structuredClone(message, { transfer }) }); } };
  await server.ssrLoadModule('/src/ui/kerros.worker.ts');
  const bridge = await server.ssrLoadModule('/src/ui/workerBridge.ts');
  const empty = { ...options, features: [] };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const deliver = async () => {
    const work = transport.work.shift(); assert.ok(work, 'expected one dispatched job');
    globalThis.self.onmessage({ data: work }); await tick(); return work;
  };
  const runningAbort = new AbortController();
  const first = bridge.requestSlice(empty, 0, runningAbort.signal);
  const skipped = Array.from({ length: 8 }, () => bridge.requestSlice(empty, 0));
  const latest = bridge.requestSlice({ ...options, features: finalFeatures }, 0);
  assert.equal(transport.work.length, 1, 'the worker receives no backlog');
  assert.ok((await Promise.all(skipped)).every(v => v === undefined));
  runningAbort.abort(); assert.equal(await first, undefined);
  await deliver();
  assert.equal(transport.work.length, 1, 'only the latest replacement follows the active job');
  await deliver(); assert.deepEqual((await latest).set, finalOutput.set, 'latest reply is full manufacturing geometry');
  assert.equal(transport.imports, 1, 'shared import cache is preserved');

  const active = bridge.requestSlice(empty, 0);
  const queuedAbort = new AbortController();
  const removed = bridge.requestSlice(empty, 0, queuedAbort.signal);
  const preview = bridge.requestPreview({ ...empty, resolution: 32 }, 1);
  const nest = bridge.requestNest({ parts: [], options: { sheetWidth: 730, sheetHeight: 410, gap: 4, labelHeight: 3 } });
  queuedAbort.abort(); assert.equal(await removed, undefined);
  assert.equal(transport.work.length, 1);
  assert.equal((await deliver()).kind, 'slice'); await active;
  assert.equal((await deliver()).kind, 'preview'); assert.equal((await preview).triangles, 0);
  assert.equal((await deliver()).kind, 'nest'); assert.deepEqual((await nest).unplacedIds, []);
  assert.equal(transport.work.length, 0);
  assert.equal(transport.imports, 2, 'changed revisions still resync imports before execution');
  // A failed calculation must reject, not masquerade as a successful empty
  // model. The same queue must run the next edited or retried job afterward.
  const failedSlice = bridge.requestSlice(empty, 1);
  const rejected = assert.rejects(failedSlice, /deliberate worker failure/);
  const failedRequest = transport.work.shift();
  transport.onmessage({ data: { kind: 'failed', token: failedRequest.token, message: 'deliberate worker failure' } });
  await rejected; await tick();
  const recovered = bridge.requestSlice(empty, 1);
  await deliver(); assert.equal((await recovered).set, null, 'a real empty model remains a valid successful calculation');
  const fallbackFailure = bridge.requestSlice(empty, 1);
  const stopped = assert.rejects(fallbackFailure, /worker stopped/);
  transport.onerror(); await stopped; await tick();
  assert.equal((await bridge.requestSlice(empty, 1)).set, null, 'a stopped worker recovers through the real inline pipeline');
  console.log('  ok    worker failures reject, retries drain correctly and a stopped worker recovers without false empty success');
  console.log('  ok    actual bridge/worker: one active job, newest slice, cancellation, mixed job kinds, imports and complete final cuts');
} finally {
  if (oldWorker === undefined) delete globalThis.Worker; else globalThis.Worker = oldWorker;
  if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf;
  await server.close();
}
console.log('OK    assembly angle preview and latest-job scheduling');
