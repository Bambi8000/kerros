/**
 * The worker.
 *
 * Deliberately thin: it holds the imported grids and forwards jobs to the
 * pipeline. All of the thinking is in `src/core/pipeline.ts`, which is pure and
 * therefore testable in Node — which matters, because a worker is the one place
 * in this program that cannot be validated from a script.
 *
 * Import grids arrive once, after a bake, and stay. They are megabytes of
 * Float32 and re-sending them with every job would cost more than the work does.
 */

import { runNestJob, runPreviewJob, runSliceJob, volumeFromPayload } from '../core/pipeline';
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

export type WorkerRequest =
  | { kind: 'imports'; payloads: ImportPayload[] }
  | { kind: 'slice'; token: number; job: SliceJob }
  | { kind: 'preview'; token: number; job: PreviewJob }
  | { kind: 'nest'; token: number; job: NestJob };

export type WorkerReply =
  | { kind: 'imports'; count: number }
  | { kind: 'sliced'; token: number; output: SliceOutput }
  | { kind: 'previewed'; token: number; output: PreviewOutput }
  | { kind: 'nested'; token: number; output: NestOutput }
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
    if (request.kind === 'preview') {
      const output = runPreviewJob(request.job, volumes);
      const reply: WorkerReply = { kind: 'previewed', token: request.token, output };
      // The mesh buffers are handed over rather than copied: nothing here needs
      // them once they are drawn. A worker's postMessage takes the transfer list
      // as its second argument, unlike a window's.
      (self as unknown as {
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
      }).postMessage(reply, [output.positions.buffer, output.indices.buffer]);
      return;
    }

    if (request.kind === 'nest') {
      // Nesting needs no field and therefore no import grids: it is handed
      // finished parts and hands back where they go.
      const output = runNestJob(request.job);
      const reply: WorkerReply = { kind: 'nested', token: request.token, output };
      self.postMessage(reply);
      return;
    }

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
