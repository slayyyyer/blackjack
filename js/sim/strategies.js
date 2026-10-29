import { doubleAllowedByTotal } from '../engine/rules.js';

export const UPCARDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const ACTIONS = Object.freeze(['S', 'H', 'D', 'P', 'R']);

export const STRATEGIES = Object.freeze([
  {
    id: 'optimal',
    name: 'Optimal chart',
    short: 'Optimal',
    description: 'The EV-maximizing total-dependent chart from the exact solver.',
  },
  {
    id: 'deviations',
    name: 'Optimal + count deviations',
    short: 'With indices',
    description: 'Basic strategy with Hi-Lo index plays when a true count is available.',
  },
  {
    id: 'mimic',
    name: 'Mimic the dealer',
    short: 'Mimic dealer',
    description: 'Hit below 17, stand on 17+ using the dealer rule. No doubles or splits.',
  },
  {
    id: 'neverBust',
    name: 'Never bust',
    short: 'Never bust',
    description: 'Stand on 12 or more, hit below 12. No doubles, splits or surrender.',
  },
  {
    id: 'alwaysStand',
    name: 'Always stand',
    short: 'Always stand',
    description: 'Never draw a card. A deliberately terrible baseline.',
  },
  {
    id: 'random',
    name: 'Random legal action',
    short: 'Random',
    description: 'Choose uniformly among legal actions. Doubles and splits add wagers.',
  },
]);

/** @param {string} id */
export function strategyById(id) {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

function bestNonSplit(cell) {
  let best = 'S';
  let ev = -Infinity;
  for (const action of ['S', 'H', 'D', 'R']) {
    const value = cell.actions[action];
    if (value == null) continue;
    if (value > ev) {
      ev = value;
      best = action;
    }
  }
  return best;
}

/**
 * Turn chart cells into flat lookup arrays for the hot simulation loop.
 * hard[total][upIndex], soft[total][upIndex], pairs[pairBucket][upIndex].
 */
export function buildPolicy(chart) {
  const hard = Array.from({ length: 22 }, () => new Array(10).fill('S'));
  const soft = Array.from({ length: 22 }, () => new Array(10).fill('S'));
  const pairs = Array.from({ length: 12 }, () => new Array(10).fill('S'));
  const pairFallback = Array.from({ length: 12 }, () => new Array(10).fill('S'));

  for (const row of chart.hard) {
    for (let u = 0; u < UPCARDS.length; u++) {
      hard[row.value][u] = row.cells[u].best;
    }
  }
  for (let total = 0; total <= 21; total++) {
    for (let u = 0; u < UPCARDS.length; u++) {
      if (total <= 4) hard[total][u] = 'H';
      else if (total >= 18) hard[total][u] = 'S';
      else if (hard[total][u] == null) hard[total][u] = total >= 17 ? 'S' : 'H';
    }
  }

  for (const row of chart.soft) {
    for (let u = 0; u < UPCARDS.length; u++) {
      soft[row.value][u] = row.cells[u].best;
    }
  }
  for (let total = 0; total <= 21; total++) {
    for (let u = 0; u < UPCARDS.length; u++) {
      if (total >= 21) soft[total][u] = 'S';
      else if (total < 13) soft[total][u] = 'H';
    }
  }

  for (const row of chart.pairs) {
    for (let u = 0; u < UPCARDS.length; u++) {
      const cell = row.cells[u];
      pairs[row.value][u] = cell.best;
      pairFallback[row.value][u] = bestNonSplit(cell);
    }
  }

  return { hard, soft, pairs, pairFallback };
}

/**
 * Standard Illustrious-18-style deviations. These are the seed table for the
 * simulation's "with deviations" comparison; the Index lab derives its own
 * thresholds from the finite-shoe solver and displays both.
 *
 * `at` is played when the true count is greater than or equal to `index`.
 * Entries are deliberately conservative: if the chart already prefers `at`,
 * the deviation is a no-op.
 */
export const STANDARD_INDEX_PLAYS = Object.freeze([
  { id: '16v10', total: 16, soft: false, upcard: 10, at: 'S', index: 0, note: 'Stand on 16 vs 10 at 0 or higher.' },
  { id: '15v10', total: 15, soft: false, upcard: 10, at: 'S', index: 4, note: 'Stand on 15 vs 10 at +4 or higher.' },
  { id: '12v3', total: 12, soft: false, upcard: 3, at: 'S', index: 2, note: 'Stand on 12 vs 3 at +2 or higher.' },
  { id: '12v2', total: 12, soft: false, upcard: 2, at: 'S', index: 3, note: 'Stand on 12 vs 2 at +3 or higher.' },
  { id: '11vA', total: 11, soft: false, upcard: 11, at: 'D', index: 1, note: 'Double 11 vs A at +1 or higher.' },
  { id: '10v10', total: 10, soft: false, upcard: 10, at: 'D', index: 4, note: 'Double 10 vs 10 at +4 or higher.' },
  { id: '10vA', total: 10, soft: false, upcard: 11, at: 'D', index: 4, note: 'Double 10 vs A at +4 or higher.' },
  { id: '9v2', total: 9, soft: false, upcard: 2, at: 'D', index: 1, note: 'Double 9 vs 2 at +1 or higher.' },
  { id: '9v7', total: 9, soft: false, upcard: 7, at: 'D', index: 3, note: 'Double 9 vs 7 at +3 or higher.' },
  { id: '8v6', total: 8, soft: false, upcard: 6, at: 'D', index: 2, note: 'Double 8 vs 6 at +2 or higher.' },
  { id: 'A8v5', total: 19, soft: true, upcard: 5, at: 'D', index: 1, note: 'Double soft 19 vs 5 at +1 or higher.' },
  { id: 'A8v6', total: 19, soft: true, upcard: 6, at: 'D', index: 1, note: 'Double soft 19 vs 6 at +1 or higher.' },
  { id: 'TTv5', pairBucket: 10, upcard: 5, at: 'P', index: 5, note: 'Split tens vs 5 at +5 or higher.' },
  { id: 'TTv6', pairBucket: 10, upcard: 6, at: 'P', index: 4, note: 'Split tens vs 6 at +4 or higher.' },
  { id: '99v2', pairBucket: 9, upcard: 2, at: 'P', index: 2, note: 'Split 9s vs 2 at +2 or higher.' },
  { id: '99v7', pairBucket: 9, upcard: 7, at: 'P', index: 3, note: 'Split 9s vs 7 at +3 or higher.' },
]);

function matchingIndex(indexPlays, hand, upcard) {
  if (!indexPlays) return null;
  // Pair entries take precedence over total entries for a two-card pair.
  if (hand.pairBucket != null && hand.cards === 2) {
    const pair = indexPlays.find((entry) => entry.pairBucket === hand.pairBucket && entry.upcard === upcard);
    if (pair) return pair;
  }
  return indexPlays.find(
    (entry) => entry.pairBucket == null
      && entry.upcard === upcard
      && entry.total === hand.total
      && Boolean(entry.soft) === Boolean(hand.soft),
  ) ?? null;
}

function canSplit(rules, hand, handCount) {
  if (hand.pairBucket == null || hand.cards !== 2) return false;
  if (handCount + 1 > rules.resplitLimit) return false;
  if (hand.pairBucket === 11 && hand.fromSplit && !rules.resplitAces) return false;
  return true;
}

export function legalActions(rules, hand, handCount) {
  const actions = ['S'];
  if (hand.total < 21) actions.push('H');
  if (
    hand.cards === 2
    && hand.canDouble !== false
    && (!hand.fromSplit || rules.doubleAfterSplit)
    && doubleAllowedByTotal(rules, hand.total, hand.soft)
  ) {
    actions.push('D');
  }
  if (canSplit(rules, hand, handCount)) actions.push('P');
  if (hand.canSurrender) actions.push('R');
  return actions;
}

/**
 * Basic strategy lookup with legality fallbacks. `handCount` is the total
 * number of hands currently in play, used only for the resplit limit.
 */
export function optimalAction(policy, rules, hand, upcard, handCount) {
  const u = UPCARDS.indexOf(upcard);
  const total = hand.total;
  const isPair = hand.cards === 2 && hand.pairBucket != null;
  const splitLegal = isPair && canSplit(rules, hand, handCount);

  let action;
  if (isPair) {
    action = splitLegal ? policy.pairs[hand.pairBucket][u] : policy.pairFallback[hand.pairBucket][u];
  } else if (hand.soft && total >= 13 && total <= 20) {
    action = policy.soft[total][u];
  } else if (total >= 18) {
    action = 'S';
  } else if (total <= 4) {
    action = 'H';
  } else {
    action = policy.hard[total][u] ?? (total >= 17 ? 'S' : 'H');
  }

  if (action === 'D') {
    const doubleLegal = hand.cards === 2
      && hand.canDouble !== false
      && (!hand.fromSplit || rules.doubleAfterSplit)
      && doubleAllowedByTotal(rules, total, hand.soft);
    if (!doubleLegal) action = total >= 17 ? 'S' : 'H';
  } else if (action === 'R') {
    if (!hand.canSurrender) action = total >= 17 ? 'S' : 'H';
  } else if (action === 'P') {
    if (!splitLegal) action = policy.pairFallback[hand.pairBucket]?.[u] ?? 'H';
  } else if (action === 'H' && total >= 21) {
    action = 'S';
  }

  if (!legalActions(rules, hand, handCount).includes(action)) {
    action = total >= 17 ? 'S' : 'H';
  }
  return action;
}

/**
 * Choose one action. `context` includes the live true count and optional
 * index-play table. The count-deviation strategy falls back to the chart when
 * no index matches or when the index action is not legal.
 */
export function chooseAction(strategyId, policy, rules, hand, upcard, handCount, rng, context = {}) {
  if (strategyId === 'alwaysStand') return 'S';

  if (strategyId === 'mimic') {
    if (hand.total < 17 || (hand.total === 17 && hand.soft && rules.dealerHitsSoft17)) return 'H';
    return 'S';
  }

  if (strategyId === 'neverBust') {
    return hand.total < 12 ? 'H' : 'S';
  }

  if (strategyId === 'random') {
    const actions = legalActions(rules, hand, handCount);
    return actions[Math.floor(rng() * actions.length)];
  }

  const base = optimalAction(policy, rules, hand, upcard, handCount);
  if (strategyId !== 'deviations') return base;
  if (context.trueCount == null || !Number.isFinite(context.trueCount)) return base;

  const index = matchingIndex(context.indexPlays, hand, upcard);
  if (!index || context.trueCount < index.index) return base;
  if (!legalActions(rules, hand, handCount).includes(index.at)) return base;
  return index.at;
}
