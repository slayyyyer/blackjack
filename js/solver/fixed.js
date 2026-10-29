import {
  BUCKETS,
  bucketFromIndex,
  bucketValue,
  countsKey,
  countsTotal,
} from '../engine/cards.js';
import {
  addValue,
  pairBucketOf,
  stateFromBuckets,
} from '../engine/hand.js';
import { doubleAllowedByTotal, isInfinite } from '../engine/rules.js';
import {
  dealerDistributionFinite,
  makeDealerCache,
} from './dealer.js';
import { createInfiniteContext, splitEV, standEV } from './ev.js';
import { FiniteBudgetError, freshCounts } from './finite.js';

const UPCARDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const ACTION_ORDER = Object.freeze(['S', 'H', 'D', 'P', 'R']);

export function createFixedContext(rules, chart, options = {}) {
  const map = {
    hard: new Map(chart.hard.map((row) => [row.value, row.cells])),
    soft: new Map(chart.soft.map((row) => [row.value, row.cells])),
    pairs: new Map(chart.pairs.map((row) => [row.value, row.cells])),
  };
  return {
    rules,
    chart,
    map,
    dealerCache: makeDealerCache(options.dealerBudget ?? 2_000_000),
    memo: new Map(),
    infiniteCtx: createInfiniteContext(rules),
    splitCache: new Map(),
    nodes: 0,
    budget: options.budget ?? 1_500_000,
    usedInfiniteSplit: false,
    usedSplitFallback: false,
  };
}

function cellFor(ctx, state) {
  const { total, soft, pairBucket, upcard } = state;
  const upIndex = UPCARDS.indexOf(upcard);
  if (pairBucket != null) {
    const cells = ctx.map.pairs.get(pairBucket);
    if (cells) return { cell: cells[upIndex], kind: 'pair' };
  }
  if (soft) {
    const cells = ctx.map.soft.get(total);
    if (cells) return { cell: cells[upIndex], kind: 'soft' };
    return { cell: null, kind: 'soft' };
  }
  const cells = ctx.map.hard.get(total);
  if (cells) return { cell: cells[upIndex], kind: 'hard' };
  return { cell: null, kind: 'hard' };
}

function canSplit(ctx, pairBucket, splitHands) {
  const { rules } = ctx;
  if (pairBucket == null) return false;
  if (splitHands + 1 > rules.resplitLimit) return false;
  if (pairBucket === 11 && splitHands > 1 && !rules.resplitAces) return false;
  return true;
}

function legal(ctx, state, action) {
  const { total, pairBucket, canDouble, canSurrender, splitHands } = state;
  switch (action) {
    case 'S': return true;
    case 'H': return total < 21;
    case 'D': return Boolean(canDouble) && doubleAllowedByTotal(ctx.rules, total, state.soft);
    case 'P': return canSplit(ctx, pairBucket, splitHands);
    case 'R': return Boolean(canSurrender) && ctx.rules.surrender === 'late' && ctx.rules.peek;
    default: return false;
  }
}

function bestLegalFromCell(ctx, state, cell) {
  if (!cell) return state.total >= 17 ? 'S' : 'H';
  let best = null;
  let ev = -Infinity;
  for (const action of ACTION_ORDER) {
    if (cell.actions[action] == null) continue;
    if (!legal(ctx, state, action)) continue;
    if (cell.actions[action] > ev) {
      ev = cell.actions[action];
      best = action;
    }
  }
  return best ?? (state.total >= 17 ? 'S' : 'H');
}

/**
 * Basic-strategy action for a hand state. The chart is total-dependent; this
 * applies its cell to the current total/soft/pair state and falls back to the
 * best legal action when the chart's first choice is unavailable (for example,
 * a double after a hit, or a split when the resplit limit is reached).
 */
export function fixedAction(ctx, state) {
  const { pairBucket, total, soft } = state;
  if (pairBucket != null && canSplit(ctx, pairBucket, state.splitHands)) {
    const { cell } = cellFor(ctx, state);
    if (cell?.best === 'P') return 'P';
  }

  const { cell } = cellFor(ctx, state);
  let action = cell?.best;
  if (!action) {
    if (soft && total >= 21) action = 'S';
    else if (!soft && total >= 17) action = 'S';
    else action = 'H';
  }

  if (action === 'P' && !legal(ctx, state, 'P')) {
    action = bestLegalFromCell(ctx, state, cell);
  } else if (action === 'D' && !legal(ctx, state, 'D')) {
    action = bestLegalFromCell(ctx, state, cell);
  } else if (action === 'R' && !legal(ctx, state, 'R')) {
    action = bestLegalFromCell(ctx, state, cell);
  } else if (action === 'H' && !legal(ctx, state, 'H')) {
    action = 'S';
  }

  if (!legal(ctx, state, action)) action = bestLegalFromCell(ctx, state, cell);
  return action;
}

function infiniteSplitActionEV(ctx, pairBucket, upcard, splitHands) {
  const key = `${pairBucket}|${upcard}|${splitHands}`;
  const cached = ctx.splitCache.get(key);
  if (cached != null) return cached;
  const ev = splitEV(ctx.infiniteCtx, pairBucket, upcard, splitHands + 1);
  ctx.splitCache.set(key, ev);
  return ev;
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

/**
 * EV of following the chart's action for one hand at a known composition.
 * Splits use the infinite-deck split EV (the documented fixed-edge
 * approximation); every other action uses the finite composition exactly.
 */
export function fixedHandEVFinite(ctx, counts, state) {
  const key = `${countsKey(counts)}|${state.total}|${state.soft ? 1 : 0}|${state.pairBucket ?? '-'}|${state.upcard}|${state.canDouble ? 1 : 0}|${state.canSurrender ? 1 : 0}|${state.splitHands}`;
  const cached = ctx.memo.get(key);
  if (cached != null) return cached;

  ctx.nodes++;
  if (ctx.nodes > ctx.budget) throw new FiniteBudgetError();

  const action = fixedAction(ctx, state);
  const n = countsTotal(counts);
  let ev;

  switch (action) {
    case 'S':
      ev = standEV(state.total, dealerForPlay(ctx, counts, state.upcard));
      break;
    case 'H': {
      let hit = 0;
      for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        if (count <= 0) continue;
        const p = count / n;
        const bucket = bucketFromIndex(i);
        const next = addValue(state.total, state.soft, bucketValue(bucket));
        counts[i]--;
        try {
          if (next.bust) hit -= p;
          else {
            const sub = fixedHandEVFinite(ctx, counts, {
              total: next.total,
              soft: next.soft,
              pairBucket: null,
              upcard: state.upcard,
              canDouble: false,
              canSurrender: false,
              splitHands: state.splitHands,
            });
            hit += p * sub;
          }
        } finally {
          counts[i]++;
        }
      }
      ev = hit;
      break;
    }
    case 'D': {
      let double = 0;
      for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        if (count <= 0) continue;
        const p = count / n;
        const bucket = bucketFromIndex(i);
        const next = addValue(state.total, state.soft, bucketValue(bucket));
        counts[i]--;
        try {
          if (next.bust) double -= 2 * p;
          else double += 2 * p * standEV(next.total, dealerForPlay(ctx, counts, state.upcard));
        } finally {
          counts[i]++;
        }
      }
      ev = double;
      break;
    }
    case 'P':
      ctx.usedInfiniteSplit = true;
      ev = infiniteSplitActionEV(ctx, state.pairBucket, state.upcard, state.splitHands);
      break;
    case 'R':
      ev = -0.5;
      break;
    default:
      ev = state.total >= 17 ? standEV(state.total, dealerForPlay(ctx, counts, state.upcard)) : -1;
  }

  ctx.memo.set(key, ev);
  return ev;
}

/**
 * Fixed-strategy initial-hand EV. Counts must already exclude the upcard and
 * player cards, but include the unknown hole card.
 */
export function fixedInitialHandEV(ctx, counts, c1, c2, upcard) {
  const hand = stateFromBuckets([c1, c2]);
  const raw = dealerDistributionFinite(
    upcard,
    counts,
    ctx.rules.dealerHitsSoft17,
    ctx.dealerCache,
  ).raw;
  const pBJ = raw.bj || 0;

  if (hand.blackjack) return (1 - pBJ) * ctx.rules.blackjackPayout;

  const actionEV = fixedHandEVFinite(ctx, counts, {
    total: hand.total,
    soft: hand.soft,
    pairBucket: pairBucketOf(c1, c2),
    upcard,
    canDouble: true,
    canSurrender: ctx.rules.surrender === 'late' && ctx.rules.peek,
    splitHands: 1,
  });

  if (ctx.rules.peek) return -pBJ + (1 - pBJ) * actionEV;
  return actionEV;
}

/**
 * EV of the displayed total-dependent basic strategy from a supplied
 * composition. `startCounts` is the full shoe before the initial deal.
 *
 * Dealer and hit/double/surrender decisions are exact for the composition.
 * Split EV uses the infinite-deck split model (see fixedHandEVFinite), and
 * the hidden hole card is treated as an unconditioned member of the shoe
 * rather than conditioning player draws on the peek result. Both
 * approximations are documented in the README and surfaced in the UI.
 */
export function computeFixedHouseEdgeFromCounts(rules, chart, startCounts, options = {}) {
  if (isInfinite(rules)) throw new Error('computeFixedHouseEdgeFromCounts requires a finite deck count');
  const ctx = createFixedContext(rules, chart, options);
  const counts = startCounts.slice();
  const n = countsTotal(counts);
  if (n <= 0) throw new Error('The supplied shoe is empty');
  const totalDeals = 1000;
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
        counts[j]--;
        try {
          totalEV += p * fixedInitialHandEV(ctx, counts, c1, c2, upcard);
        } finally {
          counts[j]++;
        }
        if (options.onProgress && done % 25 === 0) {
          options.onProgress({
            phase: 'Solving fixed-strategy shoe',
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
    usedInfiniteSplit: ctx.usedInfiniteSplit,
    ms: performance.now() - started,
    incomplete: false,
    approximation: ctx.usedInfiniteSplit ? 'split EV uses the infinite-deck model' : null,
  };
}

/**
 * Fresh-shoe EV of the displayed total-dependent basic strategy. This is the
 * simulation's reference when a finite shoe is selected.
 */
export function computeFixedHouseEdge(rules, chart, options = {}) {
  if (isInfinite(rules)) throw new Error('computeFixedHouseEdge requires a finite deck count');
  return computeFixedHouseEdgeFromCounts(rules, chart, freshCounts(Number(rules.decks)), options);
}

export function tryComputeFixedHouseEdge(rules, chart, options = {}) {
  try {
    return computeFixedHouseEdge(rules, chart, options);
  } catch (error) {
    if (error instanceof FiniteBudgetError) {
      return {
        rules,
        totalEV: null,
        houseEdge: null,
        probability: null,
        nodes: options.budget ?? 1_500_000,
        usedInfiniteSplit: false,
        ms: 0,
        incomplete: true,
        error: error.message,
      };
    }
    throw error;
  }
}
