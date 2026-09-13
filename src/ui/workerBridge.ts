/**
 * The one worker, shared.
 *
 * Slicing and the preview surface both need the field, and the field cannot be
 * sent anywhere — so both send the feature tree instead, and both want the same
 * imported grids on the far side. One worker, one import cache, one place that
 * knows how to fall back when there is no worker at all.
 */

import { importGrids } from '../core/store';
import {
  EMPTY_NEST,
  EMPTY_OUTPUT,
  EMPTY_PREVIEW,
  runNestJob,
  runPreviewJob,
  runSliceJob,
} from '../core/pipeline';
import type {
  ImportPayload,
  MeshVolume,
  NestJob,
  NestOutput,
  PreviewJob,
  PreviewOutput,
  SliceJob,
  SliceOutput,
} from '../core/pipeline';
import { sampleMeshGrid } from '../core/voxelise';
import type { WorkerReply, WorkerRequest } from './kerros.worker';
import { createLatestQueue } from './latestJob';

const jobs = createLatestQueue();

let worker: Worker | null = null;
let broken = false;
/** Import revision the worker has been told about. */
let sentRevision = -1;
let nextToken = 1;

/** Callers waiting on a reply, by token. */
const pending = new Map<number, (reply: WorkerReply) => void>();

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;

  try {
    const made = new Worker(new URL('./kerros.worker.ts', import.meta.url), {
      type: 'module',
    });

    made.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.kind === 'imports') return;
      const settle = pending.get(reply.token);
      if (!settle) return;
      pending.delete(reply.token);
      settle(reply);
    };

    made.onerror = () => {
      // A worker that cannot run is a reason to be slower, not to stop working.
      broken = true;
      worker = null;
      for (const settle of pending.values()) {
        settle({ kind: 'failed', token: -1, message: 'the worker stopped' });
      }
      pending.clear();
    };

    worker = made;
    return made;
  } catch {
    broken = true;
    return null;
  }
}

/** Send the baked grids across, once per bake rather than once per job. */
function syncImports(target: Worker, revision: number) {
  if (revision === sentRevision) return;

  const payloads: ImportPayload[] = importGrids().map(({ id, grid }) => ({
    id,
    // Copied, not transferred: the main thread still needs its grids for
    // clicking on an import and for the selection outline.
    data: grid.data.slice(),
    dims: grid.dims,
    min: grid.min,
    step: grid.step,
    reach: grid.reach,
  }));

  const request: WorkerRequest = { kind: 'imports', payloads };
  target.postMessage(
    request,
    payloads.map((p) => p.data.buffer),
  );
  sentRevision = revision;
}

/** The main thread's own volumes, for the fallback path. */
function localVolumes(): Map<string, MeshVolume> {
  const out = new Map<string, MeshVolume>();
  for (const { id, grid } of importGrids()) {
    out.set(id, {
      sample: (x, y, z) => sampleMeshGrid(grid, x, y, z),
      min: grid.min,
      max: [
        grid.min[0] + (grid.dims[0] - 1) * grid.step,
        grid.min[1] + (grid.dims[1] - 1) * grid.step,
        grid.min[2] + (grid.dims[2] - 1) * grid.step,
      ],
    });
  }
  return out;
}

export function workerAvailable(): boolean {
  return ensureWorker() !== null;
}

export function requestSlice(job: SliceJob, revision: number, signal?: AbortSignal): Promise<SliceOutput | undefined> {
  return jobs.enqueue('slice', () => executeSlice(job, revision), signal);
}
async function executeSlice(job: SliceJob, revision: number): Promise<SliceOutput> {
  const active = ensureWorker();
  if (!active) return runSliceJob(job, localVolumes());

  syncImports(active, revision);
  const token = nextToken++;

  const reply = await new Promise<WorkerReply>((resolve) => {
    pending.set(token, resolve);
    const request: WorkerRequest = { kind: 'slice', token, job };
    active.postMessage(request);
  });

  if (reply.kind === 'sliced') return reply.output;
  console.error('[Kerros] slicing failed in the worker:', reply.kind === 'failed' ? reply.message : '');
  return EMPTY_OUTPUT;
}

export function requestPreview(job: PreviewJob, revision: number, signal?: AbortSignal): Promise<PreviewOutput | undefined> {
  return jobs.enqueue('preview', () => executePreview(job, revision), signal);
}
async function executePreview(
  job: PreviewJob,
  revision: number,
): Promise<PreviewOutput> {
  const active = ensureWorker();
  if (!active) return runPreviewJob(job, localVolumes());

  syncImports(active, revision);
  const token = nextToken++;

  const reply = await new Promise<WorkerReply>((resolve) => {
    pending.set(token, resolve);
    const request: WorkerRequest = { kind: 'preview', token, job };
    active.postMessage(request);
  });

  if (reply.kind === 'previewed') return reply.output;
  console.error('[Kerros] preview failed in the worker:', reply.kind === 'failed' ? reply.message : '');
  return EMPTY_PREVIEW;
}

/**
 * Pack parts onto sheets, off the main thread.
 *
 * No `syncImports` here, and that is not an oversight: nesting is handed
 * finished parts and never asks the field anything, so the megabytes of
 * Float32 an import carries are of no use to it.
 */
export function requestNest(job: NestJob, signal?: AbortSignal): Promise<NestOutput | undefined> {
  return jobs.enqueue('nest', () => executeNest(job), signal);
}
async function executeNest(job: NestJob): Promise<NestOutput> {
  const active = ensureWorker();
  if (!active) return runNestJob(job);

  const token = nextToken++;

  const reply = await new Promise<WorkerReply>((resolve) => {
    pending.set(token, resolve);
    const request: WorkerRequest = { kind: 'nest', token, job };
    active.postMessage(request);
  });

  if (reply.kind === 'nested') return reply.output;
  console.error('[Kerros] nesting failed in the worker:', reply.kind === 'failed' ? reply.message : '');
  return EMPTY_NEST;
}
