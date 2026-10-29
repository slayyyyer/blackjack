import {
  BUCKETS,
  bucketFromIndex,
  bucketIndex,
  bucketValue,
  countsKey,
  countsTotal,
  emptyCounts,
} from '../engine/cards.js';
import {
  addValue,
  baseForSplitCard,
  pairBucketOf,
  stateFromBuckets,
} from '../engine/hand.js';
import { doubleAllowedByTotal, isInfinite } from '../engine/rules.js';
import {
  dealerDistributionFinite,
  makeDealerCache,
} from './dealer.js';
import { createInfiniteContext, splitEV, standEV } from './ev.js';

/**
 * Finite-shoe solver.
 *
 * Exactness boundary:
 * - Dealer distributions are exact for the supplied remaining composition.
 * - Hit, stand, double and surrender are exact for that composition.
 * - Splits use the standard independent-hand approximation: after the two
 *   split cards are dealt, each resulting hand is evaluated with the same
 *   remaining composition. This ignores depletion caused by the sibling hand's
 *   later draws and the interaction between two hands competing for the
 *   resplit limit. It is exact for an infinite shoe and very close for a shoe
 *   with several decks. The UI labels this as the split approximation.
 * - In a peek game, player draw probabilities treat the dealer's unknown hole
 *   card as still in the shoe; only the dealer's final distribution is
 *   conditioned on no blackjack. This is a small composition bias, documented
 *   in the README.
 *
 * All counts arrays are ten buckets: 2,3,...,9,10,A, with index 0 = 2 and
 * index 9 = A. A count is the number of cards remaining.
 */

const ACTION_ORDER = Object.freeze(['S', 'H', 'D', 'P', 'R']);

export class FiniteBudgetError extends Error {
  constructor(message = 'Finite solve exceeded the node budget') {
    super(message);
    this.name = 'FiniteBudgetError';
    this.code = 'BUDGET';
  }
}

export function freshCounts(decks) {
  const counts = emptyCounts();
  for (let i = 0; i < 8; i++) counts[i] = 4 * decks;
  counts[8] = 16 * decks; // T/J/Q/K
  counts[9] = 4 * decks; // ace
  return counts;
}

export function createFiniteContext(rules, options = {}) {
  return {
    rules,
    dealerCache: makeDealerCache(options.dealerBudget ?? 2_000_000),
    memo: new Map(),
    splitMemo: new Map(),
    nodes: 0,
    budget: options.budget ?? 1_000_000,
    usedSplit: false,
    usedInfiniteSplit: false,
    usedIndependentSplit: false,
    splitMode: options.splitMode ?? 'exact',
    infiniteCtx: createInfiniteContext(rules),
  };
}

function dealerForPlay(ctx, counts, upcard) {
  const result = dealerDistributionFinite(
    upcard,
    counts,
    ctx.rules.dealerHitsSoft17,
    ctx.dealerCache,
  );
  return ctx.rules.peek ? result.noBJ : result.raw;
}

function dealerRaw(ctx, counts, upcard) {
  return dealerDistributionFinite(
    upcard,
    counts,
    ctx.rules.dealerHitsSoft17,
    ctx.dealerCache,
  ).raw;
}

function canSplitPair(ctx, pairBucket, splitHands) {
  const { rules } = ctx;
  if (pairBucket == null) return false;
  if (splitHands + 1 > rules.resplitLimit) return false;
  if (pairBucket === 11 && splitHands > 1 && !rules.resplitAces) return false;
  return true;
}

function bestOf(actions) {
  let best = null;
  let ev = -Infinity;
  for (const action of ACTION_ORDER) {
    const value = actions[action];
    if (value == null) continue;
    if (value > ev + 1e-12) {
      ev = value;
      best = action;
    }
  }
  return { best, ev };
}

/**
 * Exact EV of every legal action for a hand at a known composition.
 *
 * @param {ReturnType<typeof createFiniteContext>} ctx
 * @param {number[]} counts remaining shoe, excluding the player's cards and the
 *   dealer upcard, including the unknown dealer hole card
 * @param {{
 *   total: number, soft: boolean, pairBucket: number|null, upcard: number,
 *   canDouble?: boolean, canSurrender?: boolean, splitHands?: number
 * }} state
 */
export function evaluateHandFinite(ctx, counts, state, options = {}) {
  const {
    total,
    soft,
    pairBucket = null,
    upcard,
    canDouble = false,
    canSurrender = false,
    splitHands = 1,
  } = state;
  const splitMode = options.splitMode ?? ctx.splitMode;

  const key = `${countsKey(counts)}|${total}|${soft ? 1 : 0}|${pairBucket ?? '-'}|${upcard}|${canDouble ? 1 : 0}|${canSurrender ? 1 : 0}|${splitHands}`;
  const cached = ctx.memo.get(key);
  if (cached) return cached;

  ctx.nodes++;
  if (ctx.nodes > ctx.budget) throw new FiniteBudgetError();

  const dealer = dealerForPlay(ctx, counts, upcard);
  const n = countsTotal(counts);
  const actions = { S: null, H: null, D: null, P: null, R: null };

  actions.S = standEV(total, dealer);

  if (total < 21 && n > 0) {
    let hit = 0;
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (count <= 0) continue;
      const p = count / n;
      const bucket = bucketFromIndex(i);
      const next = addValue(total, soft, bucketValue(bucket));
      counts[i]--;
      try {
        if (next.bust) hit -= p;
        else {
          const sub = evaluateHandFinite(ctx, counts, {
            total: next.total,
            soft: next.soft,
            pairBucket: null,
            upcard,
            canDouble: false,
            canSurrender: false,
            splitHands,
          });
          hit += p * sub.ev;
        }
      } finally {
        counts[i]++;
      }
    }
    actions.H = hit;
  }

  if (canDouble && doubleAllowedByTotal(ctx.rules, total, soft) && n > 0) {
    let double = 0;
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (count <= 0) continue;
      const p = count / n;
      const bucket = bucketFromIndex(i);
      const next = addValue(total, soft, bucketValue(bucket));
      counts[i]--;
      try {
        if (next.bust) double -= 2 * p;
        else double += 2 * p * standEV(next.total, dealerForPlay(ctx, counts, upcard));
      } finally {
        counts[i]++;
      }
    }
    actions.D = double;
  }

  if (canSplitPair(ctx, pairBucket, splitHands)) {
    if (splitMode === 'infinite') {
      // The documented fast approximation: composition-exact hit/double/stand,
      // but each split hand is evaluated as an independent infinite-deck hand.
      ctx.usedInfiniteSplit = true;
      actions.P = splitEV(ctx.infiniteCtx, pairBucket, upcard, splitHands + 1);
    } else if (splitMode === 'independent') {
      ctx.usedIndependentSplit = true;
      actions.P = splitEVIndependent(ctx, counts, pairBucket, upcard, splitHands + 1);
    } else {
      actions.P = splitEVFinite(ctx, counts, pairBucket, upcard, splitHands + 1);
    }
  }

  if (canSurrender && ctx.rules.surrender === 'late' && ctx.rules.peek) {
    actions.R = -0.5;
  }

  const choice = bestOf(actions);
  const result = Object.freeze({
    actions: Object.freeze(actions),
    best: choice.best,
    ev: choice.ev,
    nodes: ctx.nodes,
    approximateSplit: ctx.usedSplit || ctx.usedInfiniteSplit || ctx.usedIndependentSplit,
  });
  ctx.memo.set(key, result);
  return result;
}

/**
 * Expected net of one split, in units of the original bet. `totalHands` is the
 * total number of hands after this split.
 *
 * We draw the two initial post-split cards as an unordered pair; the sum of
 * the two child EVs is symmetric under swapping the draw order.
 */
export function splitEVFinite(ctx, counts, pairBucket, upcard, totalHands) {
  if (totalHands > ctx.rules.resplitLimit) return -Infinity;
  const key = `${countsKey(counts)}|${pairBucket}|${upcard}|${totalHands}`;
  const cached = ctx.splitMemo.get(key);
  if (cached != null) return cached;

  ctx.usedSplit = true;
  const n = countsTotal(counts);
  if (n < 2) {
    ctx.splitMemo.set(key, -1);
    return -1;
  }

  let ev = 0;
  for (let a = 0; a < counts.length; a++) {
    if (counts[a] <= 0) continue;
    for (let b = a; b < counts.length; b++) {
      if (counts[b] <= 0) continue;
      if (a === b && counts[a] < 2) continue;

      let p;
      if (a === b) {
        p = (counts[a] / n) * ((counts[a] - 1) / (n - 1));
      } else {
        p = (2 * counts[a] * counts[b]) / (n * (n - 1));
      }

      counts[a]--;
      counts[b]--;
      let left;
      let right;
      try {
        left = postSplitChildEV(ctx, counts, pairBucket, bucketFromIndex(a), upcard, totalHands);
        right = postSplitChildEV(ctx, counts, pairBucket, bucketFromIndex(b), upcard, totalHands);
      } finally {
        counts[a]++;
        counts[b]++;
      }
      ev += p * (left + right);
    }
  }

  ctx.splitMemo.set(key, ev);
  return ev;
}

/**
 * A composition-aware split approximation that is fast enough for the index
 * lab. It draws one card for a post-split hand, weights the child EV by the
 * real probability of that draw, and doubles the result for the two hands.
 * Sibling-hand depletion is ignored, and a child pair uses the infinite-deck
 * resplit model. This is the middle ground between the exact finite split
 * recursion and the composition-blind infinite split.
 */
export function splitEVIndependent(ctx, counts, pairBucket, upcard, totalHands) {
  if (totalHands > ctx.rules.resplitLimit) return -Infinity;
  const n = countsTotal(counts);
  if (n <= 0) return -1;
  let oneHand = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    if (count <= 0) continue;
    const p = count / n;
    const draw = bucketFromIndex(i);
    counts[i]--;
    try {
      oneHand += p * postSplitChildEVApprox(ctx, counts, pairBucket, draw, upcard, totalHands);
    } finally {
      counts[i]++;
    }
  }
  return 2 * oneHand;
}

function postSplitChildEVApprox(ctx, counts, pairBucket, draw, upcard, totalHands) {
  const base = baseForSplitCard(pairBucket);
  const next = addValue(base.total, base.soft, bucketValue(draw));

  if (pairBucket === 11 && ctx.rules.splitAcesOneCard) {
    const stand = standEV(next.total, dealerForPlay(ctx, counts, upcard));
    if (draw === 11 && ctx.rules.resplitAces && totalHands + 1 <= ctx.rules.resplitLimit) {
      const resplit = splitEV(ctx.infiniteCtx, 11, upcard, totalHands + 1);
      return Math.max(stand, resplit);
    }
    return stand;
  }

  const childPair = draw === pairBucket ? pairBucket : null;
  return evaluateHandFinite(ctx, counts, {
    total: next.total,
    soft: next.soft,
    pairBucket: childPair,
    upcard,
    canDouble: ctx.rules.doubleAfterSplit,
    canSurrender: false,
    splitHands: totalHands,
  }, { splitMode: 'infinite' }).ev;
}

function postSplitChildEV(ctx, counts, pairBucket, draw, upcard, totalHands) {
  const base = baseForSplitCard(pairBucket);
  const next = addValue(base.total, base.soft, bucketValue(draw));

  if (pairBucket === 11 && ctx.rules.splitAcesOneCard) {
    const stand = standEV(next.total, dealerForPlay(ctx, counts, upcard));
    if (draw === 11 && ctx.rules.resplitAces && totalHands + 1 <= ctx.rules.resplitLimit) {
      const resplit = splitEVFinite(ctx, counts, 11, upcard, totalHands + 1);
      return Math.max(stand, resplit);
    }
    return stand;
  }

  const childPair = draw === pairBucket ? pairBucket : null;
  return evaluateHandFinite(ctx, counts, {
    total: next.total,
    soft: next.soft,
    pairBucket: childPair,
    upcard,
    canDouble: ctx.rules.doubleAfterSplit,
    canSurrender: false,
    splitHands: totalHands,
  }).ev;
}

/**
 * Solve one already-dealt hand. `counts` must exclude the player's visible
 * cards and the dealer upcard, but include the unknown hole card.
 */
export function solveHandFinite(rules, counts, state, options = {}) {
  if (isInfinite(rules)) {
    throw new Error('solveHandFinite requires a finite shoe');
  }
  const started = performance.now();
  const ctx = createFiniteContext(rules, options);
  try {
    const result = evaluateHandFinite(ctx, counts, state);
    return {
      ...result,
      nodes: ctx.nodes,
      usedSplit: ctx.usedSplit,
      ms: performance.now() - started,
      incomplete: false,
    };
  } catch (error) {
    if (!(error instanceof FiniteBudgetError)) throw error;
    return {
      actions: null,
      best: null,
      ev: null,
      nodes: ctx.nodes,
      usedSplit: ctx.usedSplit,
      ms: performance.now() - started,
      incomplete: true,
      error: error.message,
    };
  }
}

/**
 * EV of one initial hand from the **remaining** composition. The upcard and
 * the two player cards must already be removed. This includes the natural
 * blackjack and peek/ENHC settlement exactly the same way as the infinite
 * solver.
 *
 * @param {ReturnType<typeof createFiniteContext>} ctx
 * @param {number[]} counts remaining shoe after the upcard and player cards
 * @param {number} c1 bucket
 * @param {number} c2 bucket
 * @param {number} upcard bucket
 */
export function initialHandEVFromRemaining(ctx, counts, c1, c2, upcard) {
  const hand = stateFromBuckets([c1, c2]);
  const raw = dealerRaw(ctx, counts, upcard);
  const pBJ = raw.bj || 0;

  if (hand.blackjack) {
    return (1 - pBJ) * ctx.rules.blackjackPayout;
  }

  const action = evaluateHandFinite(ctx, counts, {
    total: hand.total,
    soft: hand.soft,
    pairBucket: pairBucketOf(c1, c2),
    upcard,
    canDouble: true,
    canSurrender: ctx.rules.surrender === 'late' && ctx.rules.peek,
    splitHands: 1,
  }).ev;

  if (ctx.rules.peek) return -pBJ + (1 - pBJ) * action;
  return action;
}

/**
 * Convenience wrapper for a full shoe composition. Removes the upcard and the
 * two player cards, solves, and restores the caller's array.
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {number[]} shoeCounts composition before any cards are dealt
 * @param {number} c1
 * @param {number} c2
 * @param {number} upcard
 * @param {{budget?: number, dealerBudget?: number}} [options]
 */
export function solveInitialHandFinite(rules, shoeCounts, c1, c2, upcard, options = {}) {
  const ctx = createFiniteContext(rules, options);
  const counts = shoeCounts.slice();
  const iu = bucketIndex(upcard);
  const i1 = bucketIndex(c1);
  const i2 = bucketIndex(c2);
  const n = countsTotal(counts);
  if (counts[iu] <= 0 || n < 3) throw new Error('Shoe does not contain the initial deal');
  counts[iu]--;
  if (counts[i1] <= 0) {
    counts[iu]++;
    throw new Error('Shoe does not contain the first player card');
  }
  counts[i1]--;
  if (counts[i2] <= 0) {
    counts[i1]++;
    counts[iu]++;
    throw new Error('Shoe does not contain the second player card');
  }
  counts[i2]--;

  const started = performance.now();
  try {
    const ev = initialHandEVFromRemaining(ctx, counts, c1, c2, upcard);
    return {
      ev,
      nodes: ctx.nodes,
      usedSplit: ctx.usedSplit,
      ms: performance.now() - started,
      incomplete: false,
    };
  } catch (error) {
    if (!(error instanceof FiniteBudgetError)) throw error;
    return {
      ev: null,
      nodes: ctx.nodes,
      usedSplit: ctx.usedSplit,
      ms: performance.now() - started,
      incomplete: true,
      error: error.message,
    };
  }
}

/**
 * Composition-dependent optimal EV from a fresh shoe. This is the finite-shoe
 * counterpart of computeHouseEdgeInfinite. It can be expensive, so callers
 * should run it in a worker with progress and a budget.
 *
 * @param {import('../engine/rules.js').Rules} rules
 * @param {{budget?: number, dealerBudget?: number, onProgress?: (p: {phase:string,value:number,done:number,total:number}) => void}} [options]
 */
export function computeFiniteHouseEdge(rules, options = {}) {
  if (isInfinite(rules)) {
    throw new Error('computeFiniteHouseEdge requires a finite deck count');
  }
  const decks = Number(rules.decks);
  const ctx = createFiniteContext(rules, options);
  const counts = freshCounts(decks);
  const n = countsTotal(counts);
  const totalDeals = 10 * 10 * 10;
  let done = 0;
  let totalEV = 0;
  let probability = 0;
  const started = performance.now();

  for (let u = 0; u < BUCKETS.length; u++) {
    const upcard = BUCKETS[u];
    if (counts[u] <= 0) continue;
    const pu = counts[u] / n;
    counts[u]--;

    for (let i = 0; i < BUCKETS.length; i++) {
      const c1 = BUCKETS[i];
      if (counts[i] <= 0) {
        done += 10;
        continue;
      }
      const p1 = counts[i] / (n - 1);
      counts[i]--;

      for (let j = 0; j < BUCKETS.length; j++) {
        const c2 = BUCKETS[j];
        done++;
        if (counts[j] <= 0) continue;
        const p2 = counts[j] / (n - 2);
        const p = pu * p1 * p2;
        probability += p;
        totalEV += p * initialHandEVFromRemaining(ctx, counts, c1, c2, upcard);
        if (options.onProgress && done % 20 === 0) {
          options.onProgress({
            phase: 'Solving finite shoe',
            value: done / totalDeals,
            done,
            total: totalDeals,
          });
        }
      }

      counts[i]++;
    }
    counts[u]++;
  }

  return {
    rules,
    totalEV,
    houseEdge: -totalEV * 100,
    probability,
    nodes: ctx.nodes,
    usedSplit: ctx.usedSplit,
    ms: performance.now() - started,
    incomplete: false,
  };
}

/**
 * A safe wrapper that returns a partial result instead of throwing when a
 * budget is exceeded. The caller can then show the infinite-deck reference or
 * ask the user to retry with a larger budget.
 */
export function tryComputeFiniteHouseEdge(rules, options = {}) {
  try {
    return computeFiniteHouseEdge(rules, options);
  } catch (error) {
    if (error instanceof FiniteBudgetError) {
      return {
        rules,
        totalEV: null,
        houseEdge: null,
        probability: null,
        nodes: options.budget ?? 1_000_000,
        usedSplit: false,
        ms: 0,
        incomplete: true,
        error: error.message,
      };
    }
    throw error;
  }
}
