import { BUCKETS, BUCKET_LABELS } from '../engine/cards.js';
import { computeHouseEdgeInfinite, evaluateChartCell } from './ev.js';
import { dealerDistributionInfinite } from './dealer.js';

export const DEALER_UPCARDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
export const HARD_ROWS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
export const SOFT_ROWS = Object.freeze([13, 14, 15, 16, 17, 18, 19, 20]);
export const PAIR_ROWS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function rowLabel(kind, value) {
  if (kind === 'pair') {
    return value === 11 ? 'A,A' : `${BUCKET_LABELS[BUCKETS.indexOf(value)]},${BUCKET_LABELS[BUCKETS.indexOf(value)]}`;
  }
  if (kind === 'soft') {
    return `A,${value - 11}`;
  }
  return String(value);
}

function buildRows(ctx, kind, values) {
  return values.map((value) => ({
    kind,
    value,
    label: rowLabel(kind, value),
    cells: DEALER_UPCARDS.map((upcard) => evaluateChartCell(ctx, kind, value, upcard)),
  }));
}

/**
 * Build every chart cell plus the house edge in one shared memo context.
 * The infinite-deck model is intentionally composition-independent: this is
 * the published total-dependent basic strategy, not the composition-dependent
 * live-shoe strategy.
 *
 * @param {import('../engine/rules.js').Rules} rules
 */
export function buildStrategyChart(rules) {
  const house = computeHouseEdgeInfinite(rules);
  const ctx = house.ctx;
  const hard = buildRows(ctx, 'hard', HARD_ROWS);
  const soft = buildRows(ctx, 'soft', SOFT_ROWS);
  const pairs = buildRows(ctx, 'pair', PAIR_ROWS);

  const dealer = {};
  for (const upcard of DEALER_UPCARDS) {
    dealer[upcard] = dealerDistributionInfinite(upcard, rules.dealerHitsSoft17);
  }

  return {
    rules,
    hard,
    soft,
    pairs,
    houseEdge: house.houseEdge,
    totalEV: house.totalEV,
    probability: house.probability,
    nodes: ctx.nodes,
    dealer,
  };
}

/**
 * Find chart cells whose best action changed between two charts. The UI uses
 * this to highlight flips after a rule edit and to show the edge difference.
 *
 * @param {ReturnType<typeof buildStrategyChart>} before
 * @param {ReturnType<typeof buildStrategyChart>} after
 */
export function diffCharts(before, after) {
  const flips = [];
  for (const section of ['hard', 'soft', 'pairs']) {
    const aRows = before[section];
    const bRows = after[section];
    for (let r = 0; r < aRows.length; r++) {
      const a = aRows[r];
      const b = bRows[r];
      for (let c = 0; c < a.cells.length; c++) {
        if (a.cells[c].best !== b.cells[c].best) {
          flips.push({
            section,
            kind: a.kind,
            value: a.value,
            rowLabel: a.label,
            upcard: DEALER_UPCARDS[c],
            upcardLabel: BUCKET_LABELS[c],
            from: a.cells[c].best,
            to: b.cells[c].best,
            fromEV: a.cells[c].ev,
            toEV: b.cells[c].ev,
            evGain: b.cells[c].ev - a.cells[c].ev,
          });
        }
      }
    }
  }
  return {
    flips,
    houseEdgeBefore: before.houseEdge,
    houseEdgeAfter: after.houseEdge,
    houseEdgeDelta: after.houseEdge - before.houseEdge,
  };
}

/**
 * A lookup table keyed by chart section and row value, used by the simulator
 * and coach. Cells are the same objects exposed to the UI.
 * @param {ReturnType<typeof buildStrategyChart>} chart
 */
export function chartLookup(chart) {
  const map = new Map();
  for (const section of ['hard', 'soft', 'pairs']) {
    for (const row of chart[section]) {
      map.set(`${section}:${row.value}`, row.cells);
    }
  }
  return map;
}

/** Dealer upcard index in a chart row. */
export function upcardIndex(upcard) {
  return DEALER_UPCARDS.indexOf(upcard);
}
