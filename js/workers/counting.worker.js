import { rulesKey } from '../engine/rules.js';
import { buildStrategyChart } from '../solver/chart.js';
import { computeEdgeCurve } from '../counting/edge.js';
import { deriveIndices } from '../counting/indices.js';
import { simulateRampComparison } from '../counting/ramp.js';
import { sampleHiLoScatter } from '../counting/scatter.js';

/**
 * Counting-lab worker. Each request is independent and returns a plain data
 * object. The client cancels by terminating the worker, so long solves never
 * block the UI and a rule change cannot leave stale results on screen.
 */

const chartCache = new Map();

function chartFor(rules) {
  const key = rulesKey(rules);
  let chart = chartCache.get(key);
  if (!chart) {
    chart = buildStrategyChart(rules);
    chartCache.set(key, chart);
    if (chartCache.size > 4) chartCache.delete(chartCache.keys().next().value);
  }
  return chart;
}

function progress(id, data) {
  self.postMessage({
    id,
    type: 'progress',
    phase: data.phase,
    value: data.value,
    done: data.done,
    total: data.total,
    targetTrueCount: data.targetTrueCount,
  });
}

self.onmessage = (event) => {
  const { id, type } = event.data ?? {};
  try {
    if (type === 'edgeCurve') {
      const rules = event.data.rules;
      if (rules.decks === 'infinite') throw new Error('The edge-vs-count curve needs a finite shoe.');
      const chart = chartFor(rules);
      const result = computeEdgeCurve(rules, chart, {
        trueCounts: event.data.trueCounts,
        penetration: event.data.penetration,
        budget: event.data.budget ?? 3_000_000,
        onProgress: (p) => progress(id, p),
      });
      self.postMessage({ id, type: 'edgeCurve', result });
      return;
    }

    if (type === 'indices') {
      const rules = event.data.rules;
      if (rules.decks === 'infinite') throw new Error('Index derivation needs a finite shoe.');
      const result = deriveIndices(rules, {
        candidates: event.data.candidates,
        onProgress: (p) => progress(id, p),
      });
      self.postMessage({ id, type: 'indices', result });
      return;
    }

    if (type === 'ramp') {
      const result = simulateRampComparison({
        ...event.data,
        onProgress: (p) => progress(id, p),
      });
      self.postMessage({ id, type: 'ramp', result });
      return;
    }

    if (type === 'scatter') {
      const rules = event.data.rules;
      if (rules.decks === 'infinite') throw new Error('The Hi-Lo scatter needs a finite shoe.');
      const result = sampleHiLoScatter(rules, {
        samples: event.data.samples,
        seed: event.data.seed,
        onProgress: (p) => progress(id, p),
      });
      self.postMessage({ id, type: 'scatter', result });
      return;
    }

    self.postMessage({ id, type: 'error', error: { message: `Unknown counting task: ${type}` } });
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
      },
    });
  }
};
