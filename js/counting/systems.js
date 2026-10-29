/**
 * Card-counting systems are data, not code. Each system assigns a value to a
 * rank bucket (2..10, where 10 means any ten-value card, and 11 means ace).
 * Adding a system here is enough for the trainer and the count displays; the
 * betting and index lab currently uses the selected system's running count.
 *
 * `balanced` systems have a full-deck sum of zero, so running count divided by
 * decks remaining is a true count. Unbalanced systems (KO) use the running
 * count directly and expose a key count instead.
 */
export const COUNT_SYSTEMS = Object.freeze([
  Object.freeze({
    id: 'hi-lo',
    name: 'Hi-Lo',
    short: 'Hi-Lo',
    balanced: true,
    description: '+1 for 2–6, 0 for 7–9, −1 for 10–A. The default and the system used by the index lab.',
    values: Object.freeze({ 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0, 9: 0, 10: -1, 11: -1 }),
  }),
  Object.freeze({
    id: 'ko',
    name: 'KO (Knock-Out)',
    short: 'KO',
    balanced: false,
    description: '+1 for 2–7, 0 for 8–9, −1 for 10–A. Unbalanced; use the running count and the key count.',
    values: Object.freeze({ 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 0, 9: 0, 10: -1, 11: -1 }),
    keyCount: 2,
  }),
  Object.freeze({
    id: 'omega-ii',
    name: 'Omega II',
    short: 'Omega II',
    balanced: true,
    description: '+2 for 4–6, +1 for 2–3 and 7, 0 for 8 and A, −1 for 9, −2 for 10. A level-2 system.',
    values: Object.freeze({ 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1, 8: 0, 9: -1, 10: -2, 11: 0 }),
  }),
]);

export const DEFAULT_SYSTEM_ID = 'hi-lo';

/** @param {string} id */
export function systemById(id) {
  return COUNT_SYSTEMS.find((s) => s.id === id) ?? COUNT_SYSTEMS[0];
}

/** @param {ReturnType<typeof systemById>} system @param {number} bucket */
export function countValue(system, bucket) {
  return system.values[bucket] ?? 0;
}

/**
 * Running count of a complete composition. The counts array uses the engine
 * bucket order: 2,3,4,5,6,7,8,9,10,A.
 *
 * @param {ReturnType<typeof systemById>} system
 * @param {number[]} counts
 */
export function runningCountFromCounts(system, counts) {
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    const bucket = i === 9 ? 11 : i + 2;
    total += countValue(system, bucket) * counts[i];
  }
  return total;
}

/** Cards represented by a counts array. */
export function cardsInCounts(counts) {
  return counts.reduce((sum, n) => sum + n, 0);
}

/** Decks remaining, to one decimal place when displayed. */
export function decksRemaining(counts) {
  return cardsInCounts(counts) / 52;
}

/**
 * True count for a balanced system. Unbalanced systems return null; their
 * running count is the useful number. A shoe with fewer than half a deck left
 * still uses half a deck as the divisor to avoid an exploding estimate.
 *
 * @param {ReturnType<typeof systemById>} system
 * @param {number} runningCount
 * @param {number} cardsLeft
 */
export function trueCountFor(system, runningCount, cardsLeft) {
  if (!system.balanced) return null;
  const decks = Math.max(0.5, cardsLeft / 52);
  return runningCount / decks;
}

/** A short display label for the count that matters for this system. */
export function primaryCount(system, runningCount, cardsLeft) {
  if (system.balanced) {
    const tc = trueCountFor(system, runningCount, cardsLeft);
    return { label: 'True count', value: tc, runningCount, decks: cardsLeft / 52 };
  }
  return {
    label: 'Running count',
    value: runningCount,
    keyCount: system.keyCount,
    decks: cardsLeft / 52,
  };
}
