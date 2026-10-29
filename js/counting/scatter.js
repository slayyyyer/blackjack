import { bucketFromIndex, countsTotal } from '../engine/cards.js';
import { mulberry32 } from '../engine/rng.js';
import { buildStrategyChart } from '../solver/chart.js';
import { freshCounts } from '../solver/finite.js';
import { computeFixedHouseEdgeFromCounts } from '../solver/fixed.js';

/**
 * Draw cards from a finite composition according to the exact remaining rank
 * weights. Returns the bucket and mutates `counts`.
 */
function weightedDraw(counts, rng) {
  let total = 0;
  for (const n of counts) total += n;
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < counts.length; i++) {
    r -= counts[i];
    if (r < 0 && counts[i] > 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  for (let i = counts.length - 1; i >= 0; i--) {
    if (counts[i] > 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  return null;
}

function hiLoValue(bucket) {
  if (bucket >= 2 && bucket <= 6) return 1;
  if (bucket === 10 || bucket === 11) return -1;
  return 0;
}

/** Pearson correlation and least-squares fit for the scatter. */
export function regression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, r: 0, r2: 0 };
  const meanX = points.reduce((s, p) => s + p.trueCount, 0) / n;
  const meanY = points.reduce((s, p) => s + p.ev, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (const p of points) {
    const dx = p.trueCount - meanX;
    const dy = p.ev - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const slope = varX > 0 ? cov / varX : 0;
  const intercept = meanY - slope * meanX;
  const r = varX > 0 && varY > 0 ? cov / Math.sqrt(varX * varY) : 0;
  return { slope, intercept, r, r2: r * r };
}

/**
 * Sample random shoe compositions at random depths. For each composition we
 * solve the edge of the displayed basic strategy over every initial deal, then
 * plot that edge against the Hi-Lo true count that is visible at that depth.
 *
 * Solving a full composition is what makes the dots legible. A single hand has
 * too much variance: one natural or one 16-vs-10 can drown the count signal.
 * The result is still composition-dependent — dealer distributions, hit/double
 * recursion and the initial-deal weighting are exact — but split EV uses the
 * documented infinite-deck split model (the same reference used by the header
 * edge for finite shoes).
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {{samples?: number, seed?: number, budget?: number, onProgress?: Function}} [options]
 */
export function sampleHiLoScatter(rules, options = {}) {
  if (rules.decks === 'infinite') throw new Error('The Hi-Lo scatter needs a finite shoe');
  const decks = Number(rules.decks);
  const samples = Math.max(4, Math.min(60, Math.floor(options.samples ?? 12)));
  const seed = (options.seed ?? 20261028) >>> 0;
  const rng = mulberry32(seed);
  const chart = buildStrategyChart(rules);
  const points = [];
  const started = performance.now();
  let incomplete = 0;

  for (let s = 0; s < samples; s++) {
    const counts = freshCounts(decks);
    const total = countsTotal(counts);
    // Leave between roughly 35% and 90% of the shoe, so the sample includes
    // both early-shoe and late-shoe compositions.
    const leave = Math.round(total * (0.35 + rng() * 0.55));
    let remaining = total;
    let running = 0;
    while (remaining > leave) {
      const bucket = weightedDraw(counts, rng);
      if (bucket == null) break;
      remaining--;
      running += hiLoValue(bucket);
    }
    const cardsLeft = countsTotal(counts);
    const decksLeft = Math.max(0.5, cardsLeft / 52);
    const trueCount = running / decksLeft;

    try {
      const result = computeFixedHouseEdgeFromCounts(rules, chart, counts, {
        budget: options.budget ?? 2_500_000,
        dealerBudget: options.dealerBudget ?? 2_500_000,
      });
      points.push({
        trueCount,
        ev: -result.houseEdge / 100,
        houseEdge: result.houseEdge,
        runningCount: running,
        cardsLeft,
        decksLeft,
        incomplete: result.incomplete,
      });
    } catch (error) {
      if (error?.code !== 'BUDGET') throw error;
      incomplete++;
    }
    if (s % 2 === 0 || s === samples - 1) {
      options.onProgress?.({
        phase: 'Solving exact composition edges',
        done: s + 1,
        total: samples,
        value: (s + 1) / samples,
      });
    }
  }

  const fit = regression(points);
  return {
    rules,
    points,
    fit,
    samples: points.length,
    incomplete,
    seed,
    ms: performance.now() - started,
    model: {
      basePlayerEdge: -0.0043,
      edgePerTrueCount: 0.005,
      note: 'Standard Hi-Lo rule of thumb: about +0.5% player edge per true count from a roughly −0.43% base.',
    },
    approximation: 'Full composition edge; split EV uses the infinite-deck split model.',
  };
}
