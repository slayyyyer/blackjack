/**
 * Counting-lab worker client. A new task terminates the previous worker, so a
 * stale multi-second solve can never overwrite a fresh result.
 */
export class CountingClient {
  constructor() {
    this.worker = null;
    this.job = 0;
    this.nextId = 1;
  }

  cancel() {
    this.job++;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  task(type, payload, handlers = {}) {
    this.cancel();
    const job = this.job;
    const id = this.nextId++;
    this.worker = new Worker(new URL('./counting.worker.js', import.meta.url), {
      type: 'module',
      name: `blackjack-counting-${type}`,
    });
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        if (job !== this.job) return;
        const data = event.data ?? {};
        if (data.type === 'progress') {
          handlers.onProgress?.(data);
          return;
        }
        if (data.type === 'error') {
          const error = new Error(data.error?.message ?? 'Counting task failed');
          handlers.onError?.(error);
          reject(error);
          return;
        }
        if (data.id === id) {
          handlers.onResult?.(data);
          resolve(data.result);
        }
      };
      worker.onerror = (event) => {
        if (job !== this.job) return;
        const error = new Error(event.message || 'Counting worker crashed');
        handlers.onError?.(error);
        reject(error);
      };
      worker.postMessage({ id, type, ...payload });
    });
  }

  edgeCurve(rules, options = {}, handlers = {}) {
    return this.task('edgeCurve', { rules, ...options }, handlers);
  }

  indices(rules, handlers = {}) {
    return this.task('indices', { rules }, handlers);
  }

  ramp(options, handlers = {}) {
    return this.task('ramp', options, handlers);
  }

  scatter(rules, options = {}, handlers = {}) {
    return this.task('scatter', { rules, ...options }, handlers);
  }

  dispose() {
    this.cancel();
  }
}
