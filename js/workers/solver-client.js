/**
 * Browser-side wrapper around solver.worker.js. All solver work is
 * multiplexed through one worker and a monotonically increasing id.
 */
export class SolverClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.worker = new Worker(new URL('./solver.worker.js', import.meta.url), {
      type: 'module',
      name: 'blackjack-solver',
    });

    this.worker.onmessage = (event) => {
      const { id, type } = event.data ?? {};
      const entry = this.pending.get(id);
      if (!entry) return;
      if (type === 'progress') {
        entry.onProgress?.(event.data);
        return;
      }
      this.pending.delete(id);
      if (type === 'error') {
        const error = new Error(event.data.error?.message ?? 'Solver failed');
        error.code = event.data.error?.code;
        entry.reject(error);
        return;
      }
      entry.resolve(event.data);
    };

    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Solver worker crashed');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  request(message, onProgress) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, ...message });
    });
  }

  /**
   * @param {import('../engine/rules.js').Rules} rules
   * @param {(progress: {phase: string, value: number}) => void} [onProgress]
   * @returns {Promise<any>}
   */
  async chart(rules, onProgress) {
    const data = await this.request({ type: 'chart', rules }, onProgress);
    return data.chart;
  }

  /**
   * Fresh-shoe fixed-strategy edge. For infinite rules this is the exact
   * infinite-deck edge; otherwise it is the composition-exact reference with
   * the documented split/hole approximations.
   */
  edge(rules, onProgress) {
    return this.request({ type: 'edge', rules }, onProgress);
  }

  /**
   * Solve one hand at the real remaining composition.
   * `counts` must exclude the player's cards and the dealer upcard, but
   * include the unknown dealer hole card.
   */
  solveHand(rules, counts, state, onProgress) {
    return this.request({ type: 'solveHand', rules, counts, state }, onProgress);
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}

/** A readable message for the UI when a worker cannot even be created. */
export function workerSupportMessage() {
  return 'This browser could not start the solver worker. Open the app from a static HTTP server (not file://) in a modern browser.';
}
