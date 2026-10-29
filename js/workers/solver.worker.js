import { rulesKey } from '../engine/rules.js';
import { buildStrategyChart } from '../solver/chart.js';
import { solveHandFinite } from '../solver/finite.js';
import { tryComputeFixedHouseEdge } from '../solver/fixed.js';

/**
 * Solver worker protocol. Every request has an `id`; every response echoes it.
 *
 *   { type: 'chart', rules }                    -> chart
 *   { type: 'edge', rules }                     -> fresh-shoe fixed edge
 *   { type: 'solveHand', rules, counts, state } -> finite action EVs
 *
 * Long tasks post `progress` messages with a 0..1 value. Chart results are
 * cached by the full rule key, because the chart task and the edge task
 * usually run back-to-back for the same rules.
 */

const chartCache = new Map();

function getChart(rules) {
  const key = rulesKey(rules);
  let chart = chartCache.get(key);
  if (!chart) {
    chart = buildStrategyChart(rules);
    chartCache.set(key, chart);
    // Keep the cache bounded when the user flips through many rule sets.
    if (chartCache.size > 8) {
      chartCache.delete(chartCache.keys().next().value);
    }
  }
  return chart;
}

function fail(id, error) {
  self.postMessage({
    id,
    type: 'error',
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
    },
  });
}

self.onmessage = (event) => {
  const { id, type, rules, counts, state } = event.data ?? {};

  try {
    if (type === 'chart') {
      self.postMessage({ id, type: 'progress', phase: 'Solving the exact chart', value: 0.1 });
      const chart = getChart(rules);
      self.postMessage({ id, type: 'chart', chart });
      return;
    }

    if (type === 'edge') {
      if (rules.decks === 'infinite') {
        const chart = getChart(rules);
        self.postMessage({
          id,
          type: 'edge',
          edge: {
            houseEdge: chart.houseEdge,
            exact: true,
            model: 'infinite',
            approximation: null,
            ms: 0,
            incomplete: false,
          },
        });
        return;
      }

      const chart = getChart(rules);
      self.postMessage({
        id,
        type: 'progress',
        phase: 'Solving the fresh-shoe reference edge',
        value: 0.02,
      });
      const result = tryComputeFixedHouseEdge(rules, chart, {
        budget: 4_000_000,
        dealerBudget: 4_000_000,
        onProgress: (progress) => {
          self.postMessage({
            id,
            type: 'progress',
            phase: progress.phase,
            value: 0.02 + progress.value * 0.96,
          });
        },
      });
      self.postMessage({
        id,
        type: 'edge',
        edge: {
          houseEdge: result.houseEdge,
          exact: false,
          model: 'fresh-finite',
          approximation: result.approximation
            ?? 'split EV uses the infinite-deck model; hole-card composition is unconditioned',
          ms: result.ms,
          nodes: result.nodes,
          incomplete: result.incomplete,
          error: result.error,
        },
      });
      return;
    }

    if (type === 'solveHand') {
      const result = solveHandFinite(rules, counts, state, {
        budget: 350_000,
        dealerBudget: 2_000_000,
      });
      self.postMessage({ id, type: 'solveHand', result });
      return;
    }

    fail(id, new Error(`Unknown solver task: ${type}`));
  } catch (error) {
    fail(id, error);
  }
};
