import {
  BUCKETS,
  INFINITE_DRAW_PROBS,
  bucketValue,
  countsTotal,
} from '../engine/cards.js';
import {
  addValue,
  baseForSplitCard,
  pairBucketOf,
  stateFromBuckets,
} from '../engine/hand.js';
import { doubleAllowedByTotal } from '../engine/rules.js';
import { dealerDistributionInfinite } from './dealer.js';

export const ACTION = Object.freeze({
  STAND: 'S',
  HIT: 'H',
  DOUBLE: 'D',
  SPLIT: 'P',
  SURRENDER: 'R',
});

/** Display/label metadata shared by the UI and tests. */
export const ACTION_LABELS = Object.freeze({
  S: 'Stand',
  H: 'Hit',
  D: 'Double',
  P: 'Split',
  R: 'Surrender',
});

const ACTION_ORDER = Object.freeze(['S', 'H', 'D', 'P', 'R']);

/**
 * Create the memo tables for one rule set. Results are deterministic, so the
 * same context can be reused for every cell in a chart.
 */
export function createInfiniteContext(rules) {
  return {
    rules,
    dealer: new Map(),
    rawDealer: new Map(),
    memo: new Map(),
    splitMemo: new Map(),
    nodes: 0,
  };
}

function getRawDealer(ctx, upcard) {
  let d = ctx.rawDealer.get(upcard);
  if (!d) {
    d = dealerDistributionInfinite(upcard, ctx.rules.dealerHitsSoft17);
    ctx.rawDealer.set(upcard, d);
  }
  return d.raw;
}

function getPlayDealer(ctx, upcard) {
  let d = ctx.dealer.get(upcard);
  if (!d) {
    const result = dealerDistributionInfinite(upcard, ctx.rules.dealerHitsSoft17);
    d = ctx.rules.peek ? result.noBJ : result.raw;
    ctx.dealer.set(upcard, d);
  }
  return d;
}

/**
 * Expected net result per one-unit bet of standing on `total`.
 * A dealer natural loses; a push is zero; a dealer bust wins.
 */
export function standEV(total, dealer) {
  if (total > 21) return -1;
  let ev = dealer.bust - dealer.bj;
  for (let t = 17; t <= 21; t++) {
    const p = dealer[t] || 0;
    if (p === 0) continue;
    if (t < total) ev += p;
    else if (t > total) ev -= p;
  }
  return ev;
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
    // The epsilon makes ties choose the earlier action in ACTION_ORDER.
    if (value > ev + 1e-12) {
      ev = value;
      best = action;
    }
  }
  return { best, ev };
}

/**
 * Exact EV of every legal action for one player hand in the infinite-deck
 * model.
 *
 * State:
 * - total/soft: the current hand.
 * - pairBucket: only set for a two-card pair that can still be split.
 * - splitHands: total hands currently on the table (1 before any split).
 * - canDouble: true only for a two-card hand where doubling is structurally
 *   legal (the 9-11 rule is checked separately).
 * - canSurrender: true only for the initial two-card hand.
 *
 * Memoization is valid because the dealer's distribution depends only on the
 * upcard and rules, and the player's continuation depends only on this state.
 */
export function evaluateHand(ctx, state) {
  const {
    total,
    soft,
    pairBucket = null,
    upcard,
    canDouble = false,
    canSurrender = false,
    splitHands = 1,
  } = state;

  const key = `${total}|${soft ? 1 : 0}|${pairBucket ?? '-'}|${upcard}|${canDouble ? 1 : 0}|${canSurrender ? 1 : 0}|${splitHands}`;
  const cached = ctx.memo.get(key);
  if (cached) return cached;

  ctx.nodes++;
  const dealer = getPlayDealer(ctx, upcard);
  const actions = { S: null, H: null, D: null, P: null, R: null };

  // Stand is always legal.
  actions.S = standEV(total, dealer);

  // Hit is only meaningful below 21. Hitting 21 can only reduce EV.
  if (total < 21) {
    let hit = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      const p = INFINITE_DRAW_PROBS[i];
      if (p === 0) continue;
      const next = addValue(total, soft, bucketValue(BUCKETS[i]));
      if (next.bust) {
        hit -= p;
      } else {
        const sub = evaluateHand(ctx, {
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
    }
    actions.H = hit;
  }

  // Double: one card, then stand. Extra wager doubles both win and loss.
  if (canDouble && doubleAllowedByTotal(ctx.rules, total, soft)) {
    let double = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      const p = INFINITE_DRAW_PROBS[i];
      if (p === 0) continue;
      const next = addValue(total, soft, bucketValue(BUCKETS[i]));
      if (next.bust) {
        double -= 2 * p;
      } else {
        double += p * 2 * standEV(next.total, dealer);
      }
    }
    actions.D = double;
  }

  // Split. The split EV is the expected net of all hands created from this
  // pair, including the extra wagers. See splitEV for the accounting.
  if (canSplitPair(ctx, pairBucket, splitHands)) {
    actions.P = splitEV(ctx, pairBucket, upcard, splitHands + 1);
  }

  // Late surrender is only offered in a peek game. It gives up half the bet.
  if (canSurrender && ctx.rules.surrender === 'late') {
    actions.R = -0.5;
  }

  const choice = bestOf(actions);
  const result = Object.freeze({ actions: Object.freeze(actions), best: choice.best, ev: choice.ev });
  ctx.memo.set(key, result);
  return result;
}

/**
 * EV of splitting a pair. `totalHands` is the number of hands after this
 * split. Each of the two new hands is evaluated independently, which is exact
 * for an infinite deck and a documented approximation for a finite shoe.
 */
export function splitEV(ctx, pairBucket, upcard, totalHands) {
  const key = `${pairBucket}|${upcard}|${totalHands}`;
  const cached = ctx.splitMemo.get(key);
  if (cached != null) return cached;

  if (totalHands > ctx.rules.resplitLimit) return -Infinity;

  const one = splitHandEV(ctx, pairBucket, upcard, totalHands);
  // Two independent post-split hands, each with its own one-unit wager.
  const ev = 2 * one;
  ctx.splitMemo.set(key, ev);
  return ev;
}

/**
 * EV of one post-split hand. The pair card is already in hand; one new card is
 * drawn. Splitting aces gets exactly one card unless resplit aces is enabled.
 */
function splitHandEV(ctx, pairBucket, upcard, totalHands) {
  const dealer = getPlayDealer(ctx, upcard);
  const base = baseForSplitCard(pairBucket);
  let ev = 0;

  for (let i = 0; i < BUCKETS.length; i++) {
    const p = INFINITE_DRAW_PROBS[i];
    if (p === 0) continue;
    const draw = BUCKETS[i];
    const next = addValue(base.total, base.soft, bucketValue(draw));

    if (pairBucket === 11 && ctx.rules.splitAcesOneCard) {
      // Aces get one card. If another ace appears, resplitting may still be
      // legal; otherwise the hand stands on 12 or better.
      let handEV = standEV(next.total, dealer);
      if (
        draw === 11
        && ctx.rules.resplitAces
        && totalHands + 1 <= ctx.rules.resplitLimit
      ) {
        const resplit = splitEV(ctx, 11, upcard, totalHands + 1);
        if (resplit > handEV) handEV = resplit;
      }
      ev += p * handEV;
      continue;
    }

    const childPair = draw === pairBucket ? pairBucket : null;
    const sub = evaluateHand(ctx, {
      total: next.total,
      soft: next.soft,
      pairBucket: childPair,
      upcard,
      canDouble: ctx.rules.doubleAfterSplit,
      canSurrender: false,
      splitHands: totalHands,
    });
    ev += p * sub.ev;
  }

  return ev;
}

/**
 * Evaluate one initial two-card hand. For peek games, the returned EV includes
 * the unconditional loss when the dealer has a natural; the action EV itself
 * is computed against the no-blackjack conditional distribution.
 *
 * @param {ReturnType<typeof createInfiniteContext>} ctx
 * @param {number} c1 bucket
 * @param {number} c2 bucket
 * @param {number} upcard bucket
 */
export function initialHandEV(ctx, c1, c2, upcard) {
  const hand = stateFromBuckets([c1, c2]);
  const pairBucket = pairBucketOf(c1, c2);
  const raw = getRawDealer(ctx, upcard);
  const pBJ = raw.bj || 0;

  if (hand.blackjack) {
    // A natural pushes against a dealer natural; otherwise it pays the table
    // payout. This formula is the same for peek and ENHC.
    return (1 - pBJ) * ctx.rules.blackjackPayout;
  }

  const actionEV = evaluateHand(ctx, {
    total: hand.total,
    soft: hand.soft,
    pairBucket,
    upcard,
    canDouble: true,
    canSurrender: ctx.rules.surrender === 'late' && ctx.rules.peek,
    splitHands: 1,
  }).ev;

  if (ctx.rules.peek) {
    // If the dealer has blackjack, the round ends before the player acts, so
    // only the original bet is lost. Otherwise play the conditional game.
    return -pBJ + (1 - pBJ) * actionEV;
  }

  // ENHC: the dealer natural is included in the action distribution, so
  // doubles and splits lose their extra wagers too.
  return actionEV;
}

/**
 * Evaluate a chart cell.
 * @param {ReturnType<typeof createInfiniteContext>} ctx
 * @param {'hard'|'soft'|'pair'} kind
 * @param {number} value total for hard/soft, pair bucket for pairs
 * @param {number} upcard
 */
export function evaluateChartCell(ctx, kind, value, upcard) {
  let total;
  let soft;
  let pairBucket = null;

  if (kind === 'pair') {
    pairBucket = value;
    const pair = stateFromBuckets([value, value]);
    total = pair.total;
    soft = pair.soft;
  } else {
    total = value;
    soft = kind === 'soft';
  }

  const result = evaluateHand(ctx, {
    total,
    soft,
    pairBucket,
    upcard,
    canDouble: true,
    canSurrender: ctx.rules.surrender === 'late' && ctx.rules.peek,
    splitHands: 1,
  });
  return { ...result, total, soft, pairBucket, upcard, kind };
}

/**
 * Exact house edge for the infinite-deck model. The player uses the
 * EV-maximizing action in every cell. Initial hands are weighted by their
 * actual draw probabilities, and the dealer natural is settled before play in
 * peek games.
 *
 * House edge is returned as a percentage of the initial bet. Insurance is not
 * included because basic strategy never takes it in this model; its EV is
 * exposed separately by the UI.
 *
 * @param {import('../engine/rules.js').Rules} rules
 */
export function computeHouseEdgeInfinite(rules) {
  const ctx = createInfiniteContext(rules);
  const upProb = INFINITE_DRAW_PROBS;
  let totalEV = 0;
  let probability = 0;

  for (let u = 0; u < BUCKETS.length; u++) {
    const upcard = BUCKETS[u];
    const pu = upProb[u];
    if (pu === 0) continue;
    for (let i = 0; i < BUCKETS.length; i++) {
      const c1 = BUCKETS[i];
      const p1 = INFINITE_DRAW_PROBS[i];
      if (p1 === 0) continue;
      for (let j = 0; j < BUCKETS.length; j++) {
        const c2 = BUCKETS[j];
        const p2 = INFINITE_DRAW_PROBS[j];
        if (p2 === 0) continue;
        const p = pu * p1 * p2;
        probability += p;
        totalEV += p * initialHandEV(ctx, c1, c2, upcard);
      }
    }
  }

  const houseEdge = -totalEV * 100;
  return {
    rules,
    totalEV,
    houseEdge,
    probability,
    nodes: ctx.nodes,
    ctx,
  };
}

/** A compact EV string for tests and logs. */
export function evString(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

/** Probability mass sanity check for a distribution. */
export function distributionMass(d) {
  return d[17] + d[18] + d[19] + d[20] + d[21] + d.bust + d.bj;
}

/** Exposed for tests: number of reachable infinite states explored. */
export function solverNodeCount(ctx) {
  return ctx.nodes;
}

/** Count cards in a finite composition; exported for UI convenience. */
export function compositionSize(counts) {
  return countsTotal(counts);
}
