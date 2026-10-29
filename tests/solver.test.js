import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRules } from '../js/engine/rules.js';
import { buildStrategyChart, diffCharts } from '../js/solver/chart.js';
import { computeHouseEdgeInfinite } from '../js/solver/ev.js';

const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function cell(chart, section, value, upcard) {
  const row = chart[section].find((r) => r.value === value);
  assert.ok(row, `missing ${section} row ${value}`);
  return row.cells[UPCARDS.indexOf(upcard)];
}

function close(actual, expected, tolerance = 2e-3, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual}`,
  );
}

test('exact infinite-deck EVs match the published Wizard of Odds table', () => {
  const chart = buildStrategyChart(makeRules());

  // Hard 9 vs 2: hit is better than double. These values are exact published
  // infinite-deck S17/DAS figures.
  let c = cell(chart, 'hard', 9, 2);
  close(c.actions.S, -0.292784, 1e-5, 'hard 9 vs 2 stand');
  close(c.actions.H, 0.074446, 1e-5, 'hard 9 vs 2 hit');
  close(c.actions.D, 0.061119, 1e-5, 'hard 9 vs 2 double');
  assert.equal(c.best, 'H');

  // Hard 16 vs 10 is the classic close call.
  c = cell(chart, 'hard', 16, 10);
  close(c.actions.S, -0.540430, 1e-5, 'hard 16 vs 10 stand');
  close(c.actions.H, -0.539826, 1e-5, 'hard 16 vs 10 hit');
  assert.equal(c.best, 'H');

  // Soft 18 vs 2: standing beats doubling by a small margin in S17.
  c = cell(chart, 'soft', 18, 2);
  close(c.actions.S, 0.121742, 1e-5, 'soft 18 vs 2 stand');
  close(c.actions.H, 0.062905, 1e-5, 'soft 18 vs 2 hit');
  close(c.actions.D, 0.119750, 1e-5, 'soft 18 vs 2 double');
  assert.equal(c.best, 'S');

  // Splits that are actually used in basic strategy should match closely.
  c = cell(chart, 'pairs', 8, 10);
  close(c.actions.P, -0.480686, 2e-4, '8,8 vs 10 split');
  assert.equal(c.best, 'P');

  c = cell(chart, 'pairs', 11, 5);
  close(c.actions.P, 0.614699, 1e-5, 'A,A vs 5 split');
  assert.equal(c.best, 'P');

  c = cell(chart, 'pairs', 9, 6);
  close(c.actions.P, 0.471339, 1e-3, '9,9 vs 6 split');
  assert.equal(c.best, 'P');
});

test('standard S17/DAS basic strategy cells are reproduced', () => {
  const chart = buildStrategyChart(makeRules());
  const cases = [
    ['hard', 16, 10, 'H'],
    ['hard', 12, 4, 'S'],
    ['hard', 11, 6, 'D'],
    ['hard', 10, 9, 'D'],
    ['hard', 9, 2, 'H'],
    ['hard', 9, 3, 'D'],
    ['hard', 13, 2, 'S'],
    ['soft', 18, 2, 'S'],
    ['soft', 18, 3, 'D'],
    ['soft', 13, 5, 'H'],
    ['soft', 15, 4, 'H'],
    ['soft', 19, 6, 'S'],
    ['pairs', 8, 10, 'P'],
    ['pairs', 11, 5, 'P'],
    ['pairs', 10, 6, 'S'],
    ['pairs', 9, 7, 'S'],
    ['pairs', 9, 8, 'P'],
    ['pairs', 5, 6, 'D'],
    ['pairs', 4, 4, 'H'],
    ['pairs', 4, 5, 'P'],
    ['pairs', 6, 2, 'P'],
    ['pairs', 7, 7, 'P'],
  ];
  for (const [section, value, upcard, expected] of cases) {
    const c = cell(chart, section, value, upcard);
    assert.equal(c.best, expected, `${section} ${value} vs ${upcard}`);
  }
});

test('house edge matches the published infinite-deck S17/DAS value', () => {
  const result = computeHouseEdgeInfinite(makeRules());
  close(result.probability, 1, 1e-12, 'initial deal probability');
  close(result.houseEdge, 0.511734, 2e-3, 'house edge');
  assert.ok(result.houseEdge > 0.4 && result.houseEdge < 0.6);
});

test('rule changes move the house edge in the expected direction', () => {
  const base = computeHouseEdgeInfinite(makeRules()).houseEdge;
  const h17 = computeHouseEdgeInfinite(makeRules({ dealerHitsSoft17: true })).houseEdge;
  const noDas = computeHouseEdgeInfinite(makeRules({ doubleAfterSplit: false })).houseEdge;
  const noPeek = computeHouseEdgeInfinite(makeRules({ peek: false })).houseEdge;
  const sixFive = computeHouseEdgeInfinite(makeRules({ blackjackPayout: 1.2 })).houseEdge;
  const surrender = computeHouseEdgeInfinite(makeRules({ surrender: 'late' })).houseEdge;
  const double911 = computeHouseEdgeInfinite(makeRules({ doubleAnyTwo: false })).houseEdge;

  assert.ok(h17 - base > 0.18 && h17 - base < 0.25, `H17 delta ${h17 - base}`);
  assert.ok(noDas - base > 0.12 && noDas - base < 0.16, `no DAS delta ${noDas - base}`);
  assert.ok(noPeek - base > 0.09 && noPeek - base < 0.13, `no peek delta ${noPeek - base}`);
  assert.ok(sixFive - base > 1.3 && sixFive - base < 1.4, `6:5 delta ${sixFive - base}`);
  assert.ok(base - surrender > 0.07 && base - surrender < 0.10, `surrender delta ${base - surrender}`);
  assert.ok(double911 - base > 0.08 && double911 - base < 0.10, `9-11 delta ${double911 - base}`);
});

test('rule diff highlights the known H17 strategy flips', () => {
  const before = buildStrategyChart(makeRules());
  const after = buildStrategyChart(makeRules({ dealerHitsSoft17: true }));
  const diff = diffCharts(before, after);
  assert.equal(diff.flips.length, 4);
  const labels = diff.flips.map((f) => `${f.section}:${f.rowLabel}:${f.upcardLabel}:${f.from}->${f.to}`);
  assert.ok(labels.includes('hard:11:A:H->D'));
  assert.ok(labels.includes('soft:A,4:4:H->D'));
  assert.ok(labels.includes('soft:A,7:2:S->D'));
  assert.ok(labels.includes('soft:A,8:6:S->D'));
  assert.ok(diff.houseEdgeDelta > 0.2);
});
