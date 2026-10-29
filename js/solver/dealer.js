import {
  BUCKETS,
  INFINITE_DRAW_PROBS,
  bucketIndex,
  bucketValue,
  countsKey,
  countsTotal,
  bucketFromIndex,
} from '../engine/cards.js';
import { addValue } from '../engine/hand.js';

/**
 * Dealer outcome distribution.
 * Keys 17..21 are final totals. `21` excludes a natural blackjack; `bj` is
 * tracked separately so peek conditioning is explicit. The probabilities sum
 * to 1 including `bj`.
 *
 * @typedef {Object} DealerDistribution
 * @property {number} 17
 * @property {number} 18
 * @property {number} 19
 * @property {number} 20
 * @property {number} 21
 * @property {number} bust
 * @property {number} bj
 */

const OUTCOME_KEYS = Object.freeze([17, 18, 19, 20, 21, 'bust']);

/** @returns {DealerDistribution} */
export function makeDistribution() {
  return { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0, bj: 0 };
}

/** @param {DealerDistribution} target @param {DealerDistribution} source @param {number} p */
function addDistribution(target, source, p = 1) {
  target[17] += source[17] * p;
  target[18] += source[18] * p;
  target[19] += source[19] * p;
  target[20] += source[20] * p;
  target[21] += source[21] * p;
  target.bust += source.bust * p;
  target.bj += (source.bj || 0) * p;
}

function freezeDistribution(d) {
  return Object.freeze({ ...d });
}

/**
 * Condition a raw distribution on the dealer not having blackjack.
 * The non-BJ branches were already generated from non-BJ hole cards, so
 * renormalizing their unconditional probabilities is exact.
 * @param {DealerDistribution} raw
 * @returns {DealerDistribution}
 */
export function conditionOnNoBlackjack(raw) {
  if (!raw.bj) return raw;
  const p = 1 - raw.bj;
  return freezeDistribution({
    17: raw[17] / p,
    18: raw[18] / p,
    19: raw[19] / p,
    20: raw[20] / p,
    21: raw[21] / p,
    bust: raw.bust / p,
    bj: 0,
  });
}

/**
 * The dealer's decision rule. This is the standard rule: hit below 17, and on
 * soft 17 only when H17 is enabled. A hard or soft 21 always stands.
 */
function dealerShouldStand(total, soft, hitsSoft17) {
  if (total >= 21) return true;
  if (total > 17) return true;
  if (total === 17) return !(soft && hitsSoft17);
  return false;
}

const infiniteMemo = new Map();

/**
 * Distribution from an already-dealt dealer hand state, drawing with
 * replacement. Memoized on (total, soft, H17) because the infinite deck has no
 * composition state.
 *
 * @param {number} total
 * @param {boolean} soft
 * @param {boolean} hitsSoft17
 * @returns {DealerDistribution}
 */
function dealerRecInfinite(total, soft, hitsSoft17, memo) {
  if (total > 21) return freezeDistribution({ ...makeDistribution(), bust: 1 });
  if (dealerShouldStand(total, soft, hitsSoft17)) {
    return freezeDistribution({ ...makeDistribution(), [total]: 1 });
  }

  const key = `${total}|${soft ? 1 : 0}|${hitsSoft17 ? 1 : 0}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const out = makeDistribution();
  for (let i = 0; i < BUCKETS.length; i++) {
    const p = INFINITE_DRAW_PROBS[i];
    if (p === 0) continue;
    const next = addValue(total, soft, bucketValue(BUCKETS[i]));
    const sub = dealerRecInfinite(next.total, next.soft, hitsSoft17, memo);
    addDistribution(out, sub, p);
  }
  const frozen = freezeDistribution(out);
  memo.set(key, frozen);
  return frozen;
}

/**
 * Exact infinite-deck dealer distribution for an upcard bucket.
 * The result contains both the raw distribution and the no-blackjack
 * conditional distribution used for US peek games.
 *
 * @param {number} upcard 2..10 or 11 for ace
 * @param {boolean} hitsSoft17
 * @returns {{raw: DealerDistribution, noBJ: DealerDistribution}}
 */
export function dealerDistributionInfinite(upcard, hitsSoft17) {
  const key = `${upcard}|${hitsSoft17 ? 1 : 0}`;
  const cached = infiniteMemo.get(key);
  if (cached) return cached;

  const raw = makeDistribution();

  for (let i = 0; i < BUCKETS.length; i++) {
    const hole = BUCKETS[i];
    const p = INFINITE_DRAW_PROBS[i];
    if (p === 0) continue;

    // Natural blackjack: the upcard and hole card are an ace and a ten.
    if ((upcard === 11 && hole === 10) || (upcard === 10 && hole === 11)) {
      raw.bj += p;
      continue;
    }

    const base = upcard === 11
      ? addValue(11, true, bucketValue(hole))
      : addValue(upcard, false, bucketValue(hole));

    if (base.bust) {
      raw.bust += p;
      continue;
    }
    const sub = dealerRecInfinite(base.total, base.soft, hitsSoft17, infiniteMemo);
    addDistribution(raw, sub, p);
  }

  const result = Object.freeze({
    raw: freezeDistribution(raw),
    noBJ: conditionOnNoBlackjack(raw),
  });
  infiniteMemo.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Composition-dependent dealer distribution (finite shoe)             */
/* ------------------------------------------------------------------ */

/**
 * A cache for finite dealer recursion. The node budget lets the caller abort a
 * pathological solve and fall back to a documented approximation instead of
 * freezing the UI.
 */
export function makeDealerCache(budget = 2_000_000) {
  return { memo: new Map(), nodes: 0, budget };
}

function dealerRecFinite(total, soft, counts, hitsSoft17, cache) {
  if (total > 21) return freezeDistribution({ ...makeDistribution(), bust: 1 });
  if (dealerShouldStand(total, soft, hitsSoft17)) {
    return freezeDistribution({ ...makeDistribution(), [total]: 1 });
  }

  const key = `${total}|${soft ? 1 : 0}|${hitsSoft17 ? 1 : 0}|${countsKey(counts)}`;
  const cached = cache.memo.get(key);
  if (cached) return cached;

  cache.nodes++;
  if (cache.nodes > cache.budget) {
    const err = new Error('Dealer solve exceeded the node budget');
    err.code = 'BUDGET';
    throw err;
  }

  const n = countsTotal(counts);
  if (n <= 0) {
    const err = new Error('Shoe is empty while the dealer is drawing');
    err.code = 'EMPTY_SHOE';
    throw err;
  }

  const out = makeDistribution();
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    if (count <= 0) continue;
    const p = count / n;
    const bucket = bucketFromIndex(i);
    const next = addValue(total, soft, bucketValue(bucket));
    counts[i]--;
    try {
      const sub = dealerRecFinite(next.total, next.soft, counts, hitsSoft17, cache);
      addDistribution(out, sub, p);
    } finally {
      counts[i]++;
    }
  }

  const frozen = freezeDistribution(out);
  cache.memo.set(key, frozen);
  return frozen;
}

/**
 * Exact dealer distribution from a finite composition. `counts` must include
 * the dealer's unknown hole card and all undealt cards, but must not include
 * the dealer upcard or the player's cards.
 *
 * @param {number} upcard
 * @param {number[]} counts
 * @param {boolean} hitsSoft17
 * @param {ReturnType<typeof makeDealerCache>} cache
 * @returns {{raw: DealerDistribution, noBJ: DealerDistribution}}
 */
export function dealerDistributionFinite(upcard, counts, hitsSoft17, cache) {
  const key = `D|${upcard}|${hitsSoft17 ? 1 : 0}|${countsKey(counts)}`;
  const cached = cache.memo.get(key);
  if (cached) return cached;

  const n = countsTotal(counts);
  if (n <= 0) {
    const err = new Error('Shoe is empty while dealing the dealer hole card');
    err.code = 'EMPTY_SHOE';
    throw err;
  }

  const raw = makeDistribution();
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    if (count <= 0) continue;
    const hole = bucketFromIndex(i);
    const p = count / n;

    if ((upcard === 11 && hole === 10) || (upcard === 10 && hole === 11)) {
      raw.bj += p;
      continue;
    }

    const base = upcard === 11
      ? addValue(11, true, bucketValue(hole))
      : addValue(upcard, false, bucketValue(hole));

    if (base.bust) {
      raw.bust += p;
      continue;
    }

    counts[i]--;
    try {
      const sub = dealerRecFinite(base.total, base.soft, counts, hitsSoft17, cache);
      addDistribution(raw, sub, p);
    } finally {
      counts[i]++;
    }
  }

  const result = Object.freeze({
    raw: freezeDistribution(raw),
    noBJ: conditionOnNoBlackjack(raw),
  });
  cache.memo.set(key, result);
  return result;
}

/** Sum of all outcome probabilities, for invariant checks. */
export function distributionMass(d) {
  return d[17] + d[18] + d[19] + d[20] + d[21] + d.bust + d.bj;
}

/** A quick human-readable dump used by tests and debugging. */
export function distributionToString(d) {
  return OUTCOME_KEYS.map((k) => `${k}:${(d[k] * 100).toFixed(3)}%`).join('  ')
    + `  bj:${(d.bj * 100).toFixed(3)}%`;
}
