import { buildStrategyChart } from '../solver/chart.js';
import { buildPolicy, STANDARD_INDEX_PLAYS } from '../sim/strategies.js';
import { BlackjackSimulator } from '../sim/simulator.js';

/**
 * Simulation worker protocol.
 *
 *   { type: 'run', rules, strategy, seed, hands, shoeMode, penetration,
 *     countSystemId, useIndices }
 *     -> { type: 'sample', snapshot, strategy, requested }
 *        { type: 'result', snapshot, strategy, requested }
 *
 *   { type: 'compare', rules, strategies, seed, hands, shoeMode, penetration,
 *     countSystemId }
 *     -> { type: 'compare-progress', strategy, done, total, snapshot }
 *        { type: 'compare-result', strategy, snapshot }
 *
 * The worker is terminated by the client to cancel, so the message handler can
 * run synchronously. Progress messages are posted between sample chunks.
 */

function sampleSchedule(total) {
  const points = new Set([1, 10, 100, 1000]);
  let value = 1000;
  while (value < total) {
    value = Math.min(total, Math.ceil(value * 1.16));
    points.add(value);
  }
  points.add(total);
  return [...points].filter((n) => n <= total).sort((a, b) => a - b);
}

function makeSimulator({ rules, chart, strategy, seed, hands, shoeMode, penetration, countSystemId, useIndices }) {
  return new BlackjackSimulator({
    rules,
    policy: buildPolicy(chart),
    strategy,
    seed,
    shoeMode,
    penetration,
    countSystemId,
    indexPlays: useIndices || strategy === 'deviations' ? STANDARD_INDEX_PLAYS : null,
  });
}

function runOne(id, options) {
  const chart = buildStrategyChart(options.rules);
  const sim = makeSimulator({ ...options, chart });
  const total = Math.max(1, Math.floor(options.hands));
  const schedule = sampleSchedule(total);
  let completed = 0;

  for (const point of schedule) {
    const delta = point - completed;
    if (delta > 0) sim.run(delta);
    completed = point;
    const snapshot = sim.snapshot();
    self.postMessage({
      id,
      type: point >= total ? 'result' : 'sample',
      strategy: options.strategy,
      requested: total,
      snapshot,
    });
  }
}

function runCompare(id, options) {
  const chart = buildStrategyChart(options.rules);
  const total = Math.max(1, Math.floor(options.hands));
  const strategies = options.strategies ?? ['optimal', 'deviations', 'mimic', 'neverBust', 'alwaysStand', 'random'];
  for (const strategy of strategies) {
    const sim = makeSimulator({
      ...options,
      chart,
      strategy,
      hands: total,
      useIndices: strategy === 'deviations',
    });
    sim.run(total);
    const snapshot = sim.snapshot();
    self.postMessage({
      id,
      type: 'compare-progress',
      strategy,
      done: total,
      total,
      snapshot,
    });
    self.postMessage({
      id,
      type: 'compare-result',
      strategy,
      snapshot,
    });
  }
}

self.onmessage = (event) => {
  const { id, type } = event.data ?? {};
  try {
    if (type === 'run') {
      runOne(id, event.data);
      return;
    }
    if (type === 'compare') {
      runCompare(id, event.data);
      return;
    }
    self.postMessage({ id, type: 'error', error: { message: `Unknown simulation task: ${type}` } });
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
};
