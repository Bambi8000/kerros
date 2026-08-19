import { useEffect, useRef, useState } from 'react';
import { importGrids, useKerros } from '../core/store';
import { EMPTY_OUTPUT, runSliceJob } from '../core/pipeline';
import type { ImportPayload, MeshVolume, SliceJob, SliceOutput } from '../core/pipeline';
import { sampleMeshGrid } from '../core/voxelise';
import type { WorkerReply, WorkerRequest } from './kerros.worker';

/** Editing settles before a re-slice, which is far heavier than a preview. */
const SLICE_DEBOUNCE_MS = 250;

export interface SliceResult extends SliceOutput {
  /** True while a job is queued or running. */
  pending: boolean;
}

const IDLE: SliceResult = { ...EMPTY_OUTPUT, pending: false };

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

let worker: Worker | null = null;
let workerBroken = false;
/** Import revision the worker has been told about. */
let sentRevision = -1;

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;

  try {
    worker = new Worker(new URL('./kerros.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onerror = () => {
      // A worker that cannot start is not a reason to stop working. Slicing falls
      // back to the main thread, which is what happened before it existed.
      workerBroken = true;
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Send the baked grids across, once per bake rather than once per job. */
function syncImports(target: Worker, revision: number) {
  if (revision === sentRevision) return;

  const payloads: ImportPayload[] = importGrids().map(({ id, grid }) => ({
    id,
    // Copied, not transferred: the main thread still needs its grids for
    // clicking on an import and for the preview mesh.
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

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

/**
 * Slice the current feature tree, off the main thread.
 *
 * Only runs while `enabled`, so nobody pays for slicing while modelling. The
 * field cannot be sent to a worker — it is a chain of closures — so the worker is
 * sent the tree instead and builds the field itself.
 *
 * Replies carry the token of the job they answer. Anything stale is dropped:
 * during a drag several jobs are in flight, and the last one asked for is the
 * only one worth showing.
 */
export function useSlices(enabled: boolean): SliceResult {
  const features = useKerros((s) => s.features);
  const thickness = useKerros((s) => s.material.thickness);
  const kerf = useKerros((s) => s.material.kerf);
  const spacerHeight = useKerros((s) => s.stack.spacerHeight);
  const resolution = useKerros((s) => s.sliceRes);
  const tolerance = useKerros((s) => s.sliceTolerance);
  const smoothing = useKerros((s) => s.sliceSmoothing);
  const minFeature = useKerros((s) => s.minFeature);
  const seed = useKerros((s) => s.seed);
  const importRevision = useKerros((s) => s.importRevision);

  const [result, setResult] = useState<SliceResult>(IDLE);
  const tokenRef = useRef(0);
  const latestRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(IDLE);
      return;
    }

    setResult((prev) => ({ ...prev, pending: true }));

    const timer = window.setTimeout(() => {
      const job: SliceJob = {
        features,
        thickness,
        kerf,
        spacerHeight,
        resolution,
        tolerance,
        smoothing,
        minFeature,
        seed,
      };

      const token = ++tokenRef.current;
      latestRef.current = token;

      const active = ensureWorker();

      if (!active) {
        // No worker: do it here, exactly as the program did before.
        const output = runSliceJob(job, localVolumes());
        setResult({ ...output, pending: false });
        return;
      }

      syncImports(active, importRevision);

      const onMessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply.kind === 'imports') return;
        if (reply.token !== latestRef.current) return;

        active.removeEventListener('message', onMessage);

        if (reply.kind === 'failed') {
          console.error('[Kerros] slicing failed in the worker:', reply.message);
          setResult({ ...EMPTY_OUTPUT, pending: false });
          return;
        }

        setResult({ ...reply.output, pending: false });
      };

      active.addEventListener('message', onMessage);
      const request: WorkerRequest = { kind: 'slice', token, job };
      active.postMessage(request);
    }, SLICE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    enabled,
    features,
    thickness,
    kerf,
    spacerHeight,
    resolution,
    tolerance,
    smoothing,
    minFeature,
    seed,
    importRevision,
  ]);

  return result;
}
