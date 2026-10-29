import { cardValue } from './cards.js';

/**
 * The canonical solver state is (total, soft). `soft` means exactly one ace is
 * currently counted as 11. Two aces as 11 would exceed 21, so at most one soft
 * ace can exist. This invariant makes adding a card a small, exact operation.
 *
 * @typedef {Object} HandState
 * @property {number} total 4..21+ (busts can exceed 21)
 * @property {boolean} soft
 * @property {boolean} bust
 */

/**
 * Evaluate a physical hand.
 * @param {import('./cards.js').Card[]} cards
 */
export function stateFromCards(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const value = cardValue(card);
    if (value === 11) {
      aces++;
      total += 1; // count every ace low first
    } else {
      total += value;
    }
  }
  let soft = false;
  if (aces > 0 && total + 10 <= 21) {
    total += 10; // promote exactly one ace
    soft = true;
  }
  return {
    total,
    soft,
    bust: total > 21,
    blackjack: cards.length === 2 && total === 21,
  };
}

/**
 * Evaluate buckets directly (used by tests and the chart).
 * @param {number[]} buckets
 */
export function stateFromBuckets(buckets) {
  let total = 0;
  let aces = 0;
  for (const bucket of buckets) {
    if (bucket === 11) {
      aces++;
      total += 1;
    } else {
      total += bucket;
    }
  }
  let soft = false;
  if (aces > 0 && total + 10 <= 21) {
    total += 10;
    soft = true;
  }
  return {
    total,
    soft,
    bust: total > 21,
    blackjack: buckets.length === 2 && total === 21,
  };
}

/**
 * Add one card to a hand state. `value` is 2..10 or 11 for an ace.
 *
 * Why this is correct with one `soft` flag:
 * - If the added card is not an ace and the total busts, the existing soft ace
 *   is demoted once (subtract 10), which necessarily leaves a hard total.
 * - If the added card is an ace, it is normally counted as 1. It can be counted
 *   as 11 only when no ace is currently soft and doing so does not bust. When
 *   the current hand is soft and adding a low ace would bust, the old soft ace
 *   is demoted instead.
 *
 * @param {number} total
 * @param {boolean} soft
 * @param {number} value
 * @returns {HandState}
 */
export function addValue(total, soft, value) {
  if (total > 21) return { total, soft, bust: true };

  if (value === 11) {
    if (!soft && total + 11 <= 21) {
      return { total: total + 11, soft: true, bust: false };
    }
    let next = total + 1;
    let nextSoft = soft;
    if (nextSoft && next > 21) {
      next -= 10;
      nextSoft = false;
    }
    return { total: next, soft: nextSoft, bust: next > 21 };
  }

  let next = total + value;
  let nextSoft = soft;
  if (next > 21 && nextSoft) {
    next -= 10;
    nextSoft = false;
  }
  return { total: next, soft: nextSoft, bust: next > 21 };
}

/** Combine two initial buckets into a hand state. */
export function stateFromPairBuckets(a, b) {
  return stateFromBuckets([a, b]);
}

/**
 * A pair exists when the two cards have the same bucket. All ten-value cards
 * are interchangeable for pair splitting.
 * @param {number} a
 * @param {number} b
 */
export function pairBucketOf(a, b) {
  return a === b ? a : null;
}

/** Total of the unsplit pair, used for chart rows. */
export function pairTotal(bucket) {
  return bucket === 11 ? 12 : bucket * 2;
}

/** A single split card starts with an ace counted as 11, or the card's value. */
export function baseForSplitCard(bucket) {
  return bucket === 11
    ? { total: 11, soft: true, bust: false }
    : { total: bucket, soft: false, bust: false };
}

/** @param {number} total @param {boolean} soft */
export function handLabel(total, soft) {
  if (total > 21) return `Bust (${total})`;
  if (total === 21 && !soft) return '21';
  return soft ? `Soft ${total}` : `${total}`;
}

/** @param {number} total @param {boolean} soft */
export function handShortLabel(total, soft) {
  if (total > 21) return `${total}`;
  return soft ? `S${total}` : `${total}`;
}

/**
 * Classify a chart row. Hard 5-17 and soft 13-20 are the conventional rows.
 * @param {number} total
 * @param {boolean} soft
 */
export function chartRowKind(total, soft) {
  if (soft) return 'soft';
  return 'hard';
}
