/**
 * Simulation client. Each run gets its own worker; replacing or cancelling a
 * run terminates the old worker, which is simpler and more reliable than
 * cooperative cancellation inside a tight Monte Carlo loop.
 */
export class SimClient {
  constructor() {
    this.worker = null;
    this.job = 0;
  }

  ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./sim.worker.js', import.meta.url), {
        type: 'module',
        name: 'blackjack-simulation',
      });
    }
    return this.worker;
  }

  cancel() {
    this.job++;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  run(options, handlers = {}) {
    this.cancel();
    const job = this.job;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        if (job !== this.job) return;
        const data = event.data ?? {};
        if (data.type === 'sample') {
          handlers.onSample?.(data);
          return;
        }
        if (data.type === 'result') {
          handlers.onResult?.(data);
          resolve(data);
          return;
        }
        if (data.type === 'error') {
          const error = new Error(data.error?.message ?? 'Simulation failed');
          handlers.onError?.(error);
          reject(error);
        }
      };
      worker.onerror = (event) => {
        if (job !== this.job) return;
        const error = new Error(event.message || 'Simulation worker crashed');
        handlers.onError?.(error);
        reject(error);
      };
      worker.postMessage({ type: 'run', ...options });
    });
  }

  compare(options, handlers = {}) {
    this.cancel();
    const job = this.job;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const results = [];
      worker.onmessage = (event) => {
        if (job !== this.job) return;
        const data = event.data ?? {};
        if (data.type === 'compare-progress') {
          handlers.onProgress?.(data);
          return;
        }
        if (data.type === 'compare-result') {
          results.push(data);
          handlers.onResult?.(data);
          if (results.length >= (options.strategies?.length ?? 6)) {
            resolve(results);
          }
          return;
        }
        if (data.type === 'error') {
          const error = new Error(data.error?.message ?? 'Strategy comparison failed');
          handlers.onError?.(error);
          reject(error);
        }
      };
      worker.onerror = (event) => {
        if (job !== this.job) return;
        const error = new Error(event.message || 'Simulation worker crashed');
        handlers.onError?.(error);
        reject(error);
      };
      worker.postMessage({ type: 'compare', ...options });
    });
  }

  dispose() {
    this.cancel();
  }
}
