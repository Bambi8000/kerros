/**
 * The slicing worker.
 *
 * Deliberately thin: it holds the imported grids, and it forwards jobs to
 * `runSliceJob`. All of the thinking is in `src/core/pipeline.ts`, which is pure
 * and therefore testable in Node — which matters, because a worker is the one
 * place in this program that cannot be validated from a script.
 *
 * Import grids arrive once, after a bake, and stay. They are megabytes of
 * Float32 and re-sending them with every job would cost more than the slicing
 * does.
 */

import { runSliceJob, volumeFromPayload } from '../core/pipeline';
import type { ImportPayload, MeshVolume, SliceJob, SliceOutput } from '../core/pipeline';

export type WorkerRequest =
  | { kind: 'imports'; payloads: ImportPayload[] }
  | { kind: 'slice'; token: number; job: SliceJob };

export type WorkerReply =
  | { kind: 'imports'; count: number }
  | { kind: 'sliced'; token: number; output: SliceOutput }
  | { kind: 'failed'; token: number; message: string };

const volumes = new Map<string, MeshVolume>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind === 'imports') {
    volumes.clear();
    for (const payload of request.payloads) {
      volumes.set(payload.id, volumeFromPayload(payload));
    }
    const reply: WorkerReply = { kind: 'imports', count: volumes.size };
    self.postMessage(reply);
    return;
  }

  try {
    const output = runSliceJob(request.job, volumes);
    const reply: WorkerReply = { kind: 'sliced', token: request.token, output };
    self.postMessage(reply);
  } catch (error) {
    // A throw in here would otherwise be silent, and the panel would sit on a
    // stale result forever wondering why nothing changed.
    const reply: WorkerReply = {
      kind: 'failed',
      token: request.token,
      message: String(error),
    };
    self.postMessage(reply);
  }
};
