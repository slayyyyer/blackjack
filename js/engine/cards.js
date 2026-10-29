/**
 * The solver works with ten rank buckets: 2,3,...,9,10,A. The 10 bucket
 * represents T/J/Q/K. `11` is always the ace bucket.
 */
export const BUCKETS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
export const BUCKET_LABELS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A']);
export const BUCKET_COUNT = 10;

/**
 * Infinite-deck weights: eight non-ten ranks, four ten-value ranks, one ace.
 * Dividing by 13 gives the probability of each bucket.
 */
export const INFINITE_DRAW_WEIGHTS = Object.freeze([1, 1, 1, 1, 1, 1, 1, 1, 4, 1]);
export const INFINITE_DRAW_PROBS = Object.freeze(
  INFINITE_DRAW_WEIGHTS.map((w) => w / 13),
);

export const SUITS = Object.freeze(['spades', 'hearts', 'diamonds', 'clubs']);
export const SUIT_SYMBOLS = Object.freeze({ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' });
export const RANK_LABELS = Object.freeze({
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
});

/**
 * @typedef {Object} Card
 * @property {number} rank 2..14 (11=J, 12=Q, 13=K, 14=A)
 * @property {number} suit 0..3
 */

/** Map a physical rank to its solver bucket. */
export function bucketOfRank(rank) {
  if (rank >= 2 && rank <= 10) return rank;
  if (rank >= 11 && rank <= 13) return 10;
  if (rank === 14) return 11;
  throw new RangeError(`Invalid rank: ${rank}`);
}

/** @param {Card} card */
export function bucketOfCard(card) {
  return bucketOfRank(card.rank);
}

/** The blackjack value of a bucket: the ace is 11, tens are 10. */
export function bucketValue(bucket) {
  return bucket === 11 ? 11 : bucket;
}

/** @param {Card} card */
export function cardValue(card) {
  return bucketValue(bucketOfCard(card));
}

/** Index in count arrays: 2 -> 0, ..., 10 -> 8, A -> 9. */
export function bucketIndex(bucket) {
  return bucket === 11 ? 9 : bucket - 2;
}

/** Inverse of bucketIndex. */
export function bucketFromIndex(index) {
  if (index === 9) return 11;
  if (index >= 0 && index <= 8) return index + 2;
  throw new RangeError(`Invalid bucket index: ${index}`);
}

export function bucketName(bucket) {
  return bucket === 11 ? 'A' : String(bucket);
}

/** @param {Card} card */
export function formatCard(card) {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[SUITS[card.suit]]}`;
}

/** @param {Card} card */
export function isRedCard(card) {
  return card.suit === 1 || card.suit === 2;
}

/**
 * Build an unshuffled shoe. The order is deterministic; callers shuffle it.
 * @param {number} decks
 * @returns {Card[]}
 */
export function createShoe(decks) {
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (let suit = 0; suit < 4; suit++) {
      for (let rank = 2; rank <= 14; rank++) {
        cards.push({ rank, suit });
      }
    }
  }
  return cards;
}

/**
 * Fisher-Yates shuffle in place, using a seedable rng function.
 * @param {Card[]} cards
 * @param {() => number} rng
 */
export function shuffleInPlace(cards, rng) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
  return cards;
}

/** @returns {number[]} ten zeros */
export function emptyCounts() {
  return new Array(BUCKET_COUNT).fill(0);
}

/** @param {Card[]} cards */
export function countsFromCards(cards) {
  const counts = emptyCounts();
  for (const card of cards) {
    counts[bucketIndex(bucketOfCard(card))]++;
  }
  return counts;
}

/** @param {number[]} counts */
export function countsTotal(counts) {
  let n = 0;
  for (let i = 0; i < counts.length; i++) n += counts[i];
  return n;
}

/** @param {number[]} counts */
export function countsKey(counts) {
  return counts.join(',');
}

/** @param {number[]} counts */
export function cloneCounts(counts) {
  return counts.slice();
}

/**
 * Draw a bucket from a finite composition. Returns -1 if the shoe is empty.
 * This is for simulations/play, not for the exact solver's expectation loops.
 * @param {number[]} counts
 * @param {() => number} rng
 */
export function drawBucket(counts, rng) {
  const total = countsTotal(counts);
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < counts.length; i++) {
    r -= counts[i];
    if (r < 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  // Floating-point guard: take the last non-empty bucket.
  for (let i = counts.length - 1; i >= 0; i--) {
    if (counts[i] > 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  return -1;
}

/** Hi-Lo tag for a bucket: 2-6 +1, 7-9 0, 10/A -1. */
export function hiLoValue(bucket) {
  if (bucket >= 2 && bucket <= 6) return 1;
  if (bucket >= 7 && bucket <= 9) return 0;
  return -1; // 10 and ace
}

/** @param {Card} card */
export function hiLoValueOfCard(card) {
  return hiLoValue(bucketOfCard(card));
}

/**
 * A balanced count system is a table of tags by bucket index.
 * Hi-Lo is the default; other systems can be data entries with the same shape.
 * @typedef {Object} CountSystem
 * @property {string} id
 * @property {string} name
 * @property {number[]} tags length 10, index 0 = 2 ... index 9 = A
 * @property {number} [trueCountDivisor] optional custom divisor
 */

/** @type {CountSystem} */
export const HI_LO = Object.freeze({
  id: 'hi-lo',
  name: 'Hi-Lo',
  tags: Object.freeze([1, 1, 1, 1, 1, 0, 0, 0, -1, -1]),
});

/** @param {CountSystem} system */
export function countValueOfBucket(system, bucket) {
  return system.tags[bucketIndex(bucket)];
}
