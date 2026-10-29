import { bucketIndex, countsTotal } from '../engine/cards.js';
import { stateFromBuckets, pairBucketOf } from '../engine/hand.js';
import { createFiniteContext, evaluateHandFinite } from '../solver/finite.js';
import { STANDARD_INDEX_PLAYS } from '../sim/strategies.js';
import { compositionAtTrueCount } from './edge.js';

/**
 * Candidate borderline decisions for the index lab. Each entry names the two
 * actions being compared and a representative two-card holding. The solver
 * scans true counts, builds a realistic composition at each count, and finds
 * where the preferred action changes.
 *
 * The pair entries deliberately use the pair state; the others use a concrete
 * composition because index thresholds depend on the cards in the hand, not
 * just the total. The holding is shown in the UI so the result is reproducible.
 */
export const INDEX_CANDIDATES = Object.freeze([
  { id: '16v10', label: '16 vs 10', cards: [10, 6], upcard: 10, lowAction: 'H', highAction: 'S', standardIndex: 0 },
  { id: '15v10', label: '15 vs 10', cards: [10, 5], upcard: 10, lowAction: 'H', highAction: 'S', standardIndex: 4 },
  { id: '16v9', label: '16 vs 9', cards: [10, 6], upcard: 9, lowAction: 'H', highAction: 'S', standardIndex: 5 },
  { id: '12v3', label: '12 vs 3', cards: [10, 2], upcard: 3, lowAction: 'H', highAction: 'S', standardIndex: 2 },
  { id: '12v2', label: '12 vs 2', cards: [10, 2], upcard: 2, lowAction: 'H', highAction: 'S', standardIndex: 3 },
  { id: '12v4', label: '12 vs 4', cards: [10, 2], upcard: 4, lowAction: 'H', highAction: 'S', standardIndex: -2 },
  { id: '13v2', label: '13 vs 2', cards: [10, 3], upcard: 2, lowAction: 'H', highAction: 'S', standardIndex: -1 },
  { id: '11vA', label: '11 vs A', cards: [5, 6], upcard: 11, lowAction: 'H', highAction: 'D', standardIndex: 1 },
  { id: '10v10', label: '10 vs 10', cards: [6, 4], upcard: 10, lowAction: 'H', highAction: 'D', standardIndex: 4 },
  { id: '10vA', label: '10 vs A', cards: [6, 4], upcard: 11, lowAction: 'H', highAction: 'D', standardIndex: 4 },
  { id: '9v2', label: '9 vs 2', cards: [5, 4], upcard: 2, lowAction: 'H', highAction: 'D', standardIndex: 1 },
  { id: '9v7', label: '9 vs 7', cards: [5, 4], upcard: 7, lowAction: 'H', highAction: 'D', standardIndex: 3 },
  { id: '8v6', label: '8 vs 6', cards: [5, 3], upcard: 6, lowAction: 'H', highAction: 'D', standardIndex: 2 },
  { id: 'A8v5', label: 'A,8 vs 5', cards: [11, 8], upcard: 5, lowAction: 'S', highAction: 'D', standardIndex: 1 },
  { id: 'A8v6', label: 'A,8 vs 6', cards: [11, 8], upcard: 6, lowAction: 'S', highAction: 'D', standardIndex: 1 },
  { id: 'TTv5', label: '10,10 vs 5', cards: [10, 10], upcard: 5, lowAction: 'S', highAction: 'P', standardIndex: 5 },
  { id: 'TTv6', label: '10,10 vs 6', cards: [10, 10], upcard: 6, lowAction: 'S', highAction: 'P', standardIndex: 4 },
  { id: '99v7', label: '9,9 vs 7', cards: [9, 9], upcard: 7, lowAction: 'S', highAction: 'P', standardIndex: 3 },
]);

const SAMPLE_COUNTS = Object.freeze([-4, 0, 4, 8]);
const SCAN_COUNTS = Object.freeze([-4, -2, 0, 2, 4, 6, 8]);

function countsWithoutHand(compCounts, c1, c2, upcard) {
  const counts = compCounts.slice();
  const indices = [bucketIndex(c1), bucketIndex(c2), bucketIndex(upcard)];
  for (const i of indices) {
    if (counts[i] <= 0) return null;
    counts[i]--;
  }
  return counts;
}

function solveCandidatePoint(rules, candidate, counts) {
  const pair = candidate.cards[0] === candidate.cards[1] ? pairBucketOf(candidate.cards[0], candidate.cards[1]) : null;
  const hand = stateFromBuckets(candidate.cards);
  const ctx = createFiniteContext(rules, {
    budget: 150_000,
    dealerBudget: 2_000_000,
    splitMode: 'infinite',
  });
  try {
    const result = evaluateHandFinite(ctx, counts, {
      total: hand.total,
      soft: hand.soft,
      pairBucket: pair,
      upcard: candidate.upcard,
      canDouble: true,
      canSurrender: rules.surrender === 'late' && rules.peek,
      splitHands: 1,
    }, { splitMode: 'independent' });
    return {
      low: result.actions[candidate.lowAction],
      high: result.actions[candidate.highAction],
      best: result.best,
      incomplete: false,
      approximateSplit: result.approximateSplit,
      nodes: ctx.nodes,
    };
  } catch (error) {
    if (error?.code !== 'BUDGET') throw error;
    return {
      low: null,
      high: null,
      best: null,
      incomplete: true,
      nodes: ctx.nodes,
      error: error.message,
    };
  }
}

function preference(point) {
  if (point.low == null || point.high == null) return 0;
  return Math.sign(point.high - point.low);
}

/**
 * Derive index thresholds. This is compute-heavy, so it accepts a progress
 * callback and is designed to run in the counting worker. Candidates whose
 * split subtree exceeds the budget are reported as unresolved rather than
 * silently using a guessed threshold.
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {{onProgress?: Function, candidates?: typeof INDEX_CANDIDATES, scan?: number[]}} [options]
 */
export function deriveIndices(rules, options = {}) {
  if (rules.decks === 'infinite') throw new Error('Derived indices require a finite shoe');
  const candidates = options.candidates ?? INDEX_CANDIDATES;
  const scan = options.scan ?? SCAN_COUNTS;
  const results = [];
  const started = performance.now();
  const totalSteps = candidates.length * scan.length;
  let done = 0;

  for (const candidate of candidates) {
    const points = [];
    for (const tc of scan) {
      const comp = compositionAtTrueCount(rules, tc);
      const counts = countsWithoutHand(comp.counts, candidate.cards[0], candidate.cards[1], candidate.upcard);
      const point = counts
        ? solveCandidatePoint(rules, candidate, counts)
        : { low: null, high: null, incomplete: true, error: 'not enough cards' };
      points.push({ trueCount: comp.trueCount, targetTrueCount: tc, ...point });
      done++;
      options.onProgress?.({ phase: 'Deriving index plays', done, total: totalSteps, value: done / totalSteps });
    }

    const valid = points.filter((p) => p.low != null && p.high != null);
    let crossing = null;
    let index = null;
    let atAbove = candidate.highAction;
    let below = candidate.lowAction;
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const next = valid[i];
      const prevDiff = prev.high - prev.low;
      const nextDiff = next.high - next.low;
      if (prevDiff === 0 || nextDiff === 0) continue;
      if (Math.sign(prevDiff) !== Math.sign(nextDiff)) {
        const denominator = Math.abs(prevDiff) + Math.abs(nextDiff);
        const fraction = denominator > 0 ? Math.abs(prevDiff) / denominator : 0;
        crossing = prev.trueCount + (next.trueCount - prev.trueCount) * fraction;
        if (Math.sign(nextDiff) > 0) {
          atAbove = candidate.highAction;
          below = candidate.lowAction;
        } else {
          atAbove = candidate.lowAction;
          below = candidate.highAction;
        }
        index = Math.ceil(crossing * 2) / 2;
        break;
      }
    }

    const unresolved = !valid.length || points.some((p) => p.incomplete);
    results.push({
      id: candidate.id,
      label: candidate.label,
      cards: candidate.cards,
      upcard: candidate.upcard,
      lowAction: candidate.lowAction,
      highAction: candidate.highAction,
      below,
      atAbove,
      index,
      crossing,
      standardIndex: candidate.standardIndex,
      points,
      unresolved,
      incomplete: points.some((p) => p.incomplete),
    });
  }

  return {
    rules,
    indices: results,
    scan,
    ms: performance.now() - started,
    model: 'finite-shoe EV at representative true-count compositions',
    note: 'Thresholds use one representative holding per hand type and a 25%-dealt shoe. Index plays are estimates for study, not a promise about every shoe.',
  };
}

/** Match a derived row to the standard seed table for side-by-side display. */
export function standardIndexFor(id) {
  return STANDARD_INDEX_PLAYS.find((entry) => entry.id === id) ?? null;
}

/** Total cards left in a composition, re-exported for UI labels. */
export function compositionCards(counts) {
  return countsTotal(counts);
}
