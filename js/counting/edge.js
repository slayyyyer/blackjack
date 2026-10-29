import { countsTotal } from '../engine/cards.js';
import { freshCounts } from '../solver/finite.js';
import { computeFixedHouseEdgeFromCounts } from '../solver/fixed.js';

/**
 * Build a plausible shoe composition at a target Hi-Lo true count.
 *
 * We remove roughly a quarter of the shoe, then choose how many low (2–6),
 * high (10/A) and neutral (7–9) cards were removed. Removing one low card
 * raises the running count by one; removing one high card lowers it by one.
 * The running count is exactly lowRemoved - highRemoved, and the true count is
 * that running count divided by the decks left. This is a representative
 * composition, not the unique shoe with that count, which is why the chart is
 * labelled as a composition model.
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {number} targetTrueCount
 * @param {{penetration?: number}} [options]
 */
export function compositionAtTrueCount(rules, targetTrueCount, options = {}) {
  if (rules.decks === 'infinite') throw new Error('A representative composition needs a finite shoe');
  const decks = Number(rules.decks);
  const penetration = Math.min(0.9, Math.max(0.5, options.penetration ?? 0.75));
  const total = 52 * decks;
  const removedTarget = Math.max(1, Math.round(total * (1 - penetration)));
  const leftTarget = total - removedTarget;
  const decksLeft = leftTarget / 52;
  const targetRunning = targetTrueCount * decksLeft;
  const counts = freshCounts(decks);

  const lowBuckets = [0, 1, 2, 3, 4]; // 2..6
  const neutralBuckets = [5, 6, 7]; // 7..9
  const highBuckets = [8, 9]; // ten-value, ace

  // Start from a balanced removal mix, then tilt it by the target count. A
  // quarter-deck removal is roughly 38% low, 38% high and 24% neutral.
  const baseSide = removedTarget * 0.38;
  let lowRemove = Math.round(baseSide + targetRunning / 2);
  let highRemove = Math.round(baseSide - targetRunning / 2);
  lowRemove = Math.max(0, Math.min(removedTarget, lowRemove));
  highRemove = Math.max(0, Math.min(removedTarget, highRemove));
  let neutralRemove = Math.max(0, removedTarget - lowRemove - highRemove);

  // Remove cards proportionally within each group. This matters most for the
  // high group: there are four times as many tens as aces, so an even split
  // would artificially deplete aces and bias the edge.
  const takeSpread = (buckets, amount) => {
    const available = buckets.reduce((sum, i) => sum + counts[i], 0);
    const take = Math.min(amount, available);
    if (take <= 0) return 0;
    const fractions = [];
    let assigned = 0;
    for (const i of buckets) {
      const exact = (take * counts[i]) / available;
      const base = Math.floor(exact);
      counts[i] -= base;
      assigned += base;
      fractions.push({ i, fraction: exact - base });
    }
    fractions.sort((a, b) => b.fraction - a.fraction);
    let left = take - assigned;
    while (left > 0) {
      let progressed = false;
      for (const { i } of fractions) {
        if (left <= 0) break;
        if (counts[i] > 0) {
          counts[i]--;
          left--;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return take - left;
  };

  const lowGone = takeSpread(lowBuckets, lowRemove);
  const neutralGone = takeSpread(neutralBuckets, neutralRemove);
  const highGone = takeSpread(highBuckets, highRemove);

  // If a group could not supply its requested amount, make up the shortfall
  // from any remaining cards so the shoe still has the intended penetration.
  let removed = lowGone + neutralGone + highGone;
  if (removed < removedTarget) {
    removed += takeSpread([...neutralBuckets, ...lowBuckets, ...highBuckets], removedTarget - removed);
  }

  const runningCount = lowGone - highGone;
  const cardsLeft = countsTotal(counts);
  return {
    counts,
    runningCount,
    cardsLeft,
    decksRemaining: cardsLeft / 52,
    trueCount: runningCount / Math.max(0.5, cardsLeft / 52),
    targetTrueCount,
    removedTarget,
  };
}

function linearFit(points) {
  if (points.length < 2) return { slope: 0, intercept: 0, r2: 0 };
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.trueCount, 0) / n;
  const meanY = points.reduce((s, p) => s + p.houseEdge, 0) / n;
  let num = 0;
  let den = 0;
  let total = 0;
  for (const p of points) {
    num += (p.trueCount - meanX) * (p.houseEdge - meanY);
    den += (p.trueCount - meanX) ** 2;
    total += (p.houseEdge - meanY) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  let residual = 0;
  for (const p of points) {
    residual += (p.houseEdge - (intercept + slope * p.trueCount)) ** 2;
  }
  return {
    slope,
    intercept,
    r2: total > 0 ? 1 - residual / total : 0,
  };
}

export function fitEdgeCurve(points) {
  const fit = linearFit(points);
  const zeroCrossing = fit.slope !== 0 ? -fit.intercept / fit.slope : null;
  return {
    ...fit,
    zeroCrossing,
    perTrueCount: -fit.slope,
  };
}

/**
 * Solve the fixed-strategy edge at a set of representative true counts.
 * This is intentionally run in a worker: each point enumerates every initial
 * deal at a finite composition, which takes about a second for six decks.
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {ReturnType<import('../solver/chart.js').buildStrategyChart>} chart
 * @param {{trueCounts?: number[], penetration?: number, budget?: number, onProgress?: Function}} [options]
 */
export function computeEdgeCurve(rules, chart, options = {}) {
  if (rules.decks === 'infinite') throw new Error('The true-count edge curve needs a finite shoe');
  const trueCounts = options.trueCounts ?? [-4, -2, 0, 2, 4, 6, 8];
  const points = [];
  const total = trueCounts.length;
  const started = performance.now();
  for (let i = 0; i < trueCounts.length; i++) {
    const target = trueCounts[i];
    const comp = compositionAtTrueCount(rules, target, { penetration: options.penetration });
    options.onProgress?.({
      phase: 'Solving edge at true count',
      value: i / total,
      done: i,
      total,
      targetTrueCount: target,
    });
    const result = computeFixedHouseEdgeFromCounts(rules, chart, comp.counts, {
      budget: options.budget ?? 3_000_000,
      dealerBudget: options.dealerBudget ?? 3_000_000,
    });
    points.push({
      targetTrueCount: target,
      trueCount: comp.trueCount,
      runningCount: comp.runningCount,
      decksRemaining: comp.decksRemaining,
      cardsLeft: comp.cardsLeft,
      houseEdge: result.houseEdge,
      playerEdge: -result.houseEdge,
      nodes: result.nodes,
      incomplete: result.incomplete,
      approximation: result.approximation,
    });
    options.onProgress?.({
      phase: 'Solving edge at true count',
      value: (i + 1) / total,
      done: i + 1,
      total,
      targetTrueCount: target,
    });
  }
  return {
    rules,
    points,
    fit: fitEdgeCurve(points),
    ms: performance.now() - started,
    model: 'fixed-strategy edge at a representative composition',
    approximation: 'Split EV uses the infinite-deck model; player draws treat the hidden hole card as unconditioned.',
  };
}
