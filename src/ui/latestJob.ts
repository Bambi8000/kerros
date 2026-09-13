/** One running job, at most one waiting job of each kind. Superseded work is
 * settled without running; active synchronous worker work finishes once.
 */
export function createLatestQueue() {
  type Entry = { run: () => Promise<void>; cancel: () => void };
  const waiting = new Map<string, Entry>();
  let running = false;
  const pump = () => {
    if (running || !waiting.size) return;
    const [key, entry] = waiting.entries().next().value!;
    waiting.delete(key);
    running = true;
    void entry.run().finally(() => { running = false; pump(); });
  };
  return {
    enqueue<T>(key: string, run: () => Promise<T> | T, signal?: AbortSignal): Promise<T | undefined> {
      if (signal?.aborted) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value?: T, error?: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          if (error !== undefined) reject(error); else resolve(value);
        };
        const cancel = () => {
          if (waiting.get(key) === entry) waiting.delete(key);
          finish();
        };
        const entry: Entry = {
          cancel,
          async run() {
            try { finish(await run()); } catch (error) { finish(undefined, error); }
          },
        };
        waiting.get(key)?.cancel();
        waiting.set(key, entry);
        signal?.addEventListener('abort', cancel, { once: true });
        pump();
      });
    },
  };
}
