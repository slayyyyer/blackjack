/**
 * Rules are intentionally plain data. The solver, simulator and UI all share
 * this object; nothing in the engine reads from the DOM.
 *
 * @typedef {'none'|'late'} SurrenderRule
 * @typedef {1|2|4|6|8|'infinite'} DeckSetting
 *
 * @typedef {Object} Rules
 * @property {DeckSetting} decks
 * @property {boolean} dealerHitsSoft17  false = S17, true = H17
 * @property {1.5|1.2|1} blackjackPayout
 * @property {boolean} doubleAnyTwo      false = double on hard 9-11 only
 * @property {boolean} doubleAfterSplit
 * @property {boolean} splitAcesOneCard
 * @property {boolean} resplitAces
 * @property {number} resplitLimit       maximum hands after splits (2-4)
 * @property {SurrenderRule} surrender
 * @property {boolean} peek              true = US peek, false = ENHC/no-peek
 * @property {boolean} insurance
 */

/** @type {Readonly<Rules>} */
export const DEFAULT_RULES = Object.freeze({
  decks: 6,
  dealerHitsSoft17: false,
  blackjackPayout: 1.5,
  doubleAnyTwo: true,
  doubleAfterSplit: true,
  splitAcesOneCard: true,
  resplitAces: false,
  resplitLimit: 4,
  surrender: 'none',
  peek: true,
  insurance: true,
});

/** @type {ReadonlyArray<DeckSetting>} */
export const DECK_OPTIONS = Object.freeze([1, 2, 4, 6, 8, 'infinite']);
export const RESPLIT_OPTIONS = Object.freeze([2, 3, 4]);
export const PAYOUT_OPTIONS = Object.freeze([
  { value: 1.5, label: '3:2' },
  { value: 1.2, label: '6:5' },
  { value: 1, label: '1:1' },
]);

/**
 * @param {Partial<Rules>} [overrides]
 * @returns {Rules}
 */
export function makeRules(overrides = {}) {
  return normalizeRules({ ...DEFAULT_RULES, ...overrides });
}

/**
 * @param {Rules|Partial<Rules>} input
 * @returns {Rules}
 */
export function normalizeRules(input) {
  const decks = DECK_OPTIONS.includes(input.decks) ? input.decks : DEFAULT_RULES.decks;
  const payout = PAYOUT_OPTIONS.some((p) => p.value === input.blackjackPayout)
    ? input.blackjackPayout
    : DEFAULT_RULES.blackjackPayout;
  const resplitLimit = RESPLIT_OPTIONS.includes(Number(input.resplitLimit))
    ? Number(input.resplitLimit)
    : DEFAULT_RULES.resplitLimit;
  return {
    decks,
    dealerHitsSoft17: Boolean(input.dealerHitsSoft17),
    blackjackPayout: payout,
    doubleAnyTwo: Boolean(input.doubleAnyTwo),
    doubleAfterSplit: Boolean(input.doubleAfterSplit),
    splitAcesOneCard: Boolean(input.splitAcesOneCard),
    resplitAces: Boolean(input.resplitAces),
    resplitLimit,
    surrender: input.surrender === 'late' ? 'late' : 'none',
    peek: Boolean(input.peek),
    insurance: Boolean(input.insurance),
  };
}

/** @param {Rules} rules */
export function isInfinite(rules) {
  return rules.decks === 'infinite';
}

/** The physical number of decks, or 0 for the infinite-deck model. */
export function deckCount(rules) {
  return isInfinite(rules) ? 0 : Number(rules.decks);
}

/**
 * Stable key used for caching solver results.
 * @param {Rules} rules
 */
export function rulesKey(rules) {
  return [
    rules.decks,
    rules.dealerHitsSoft17 ? 'H17' : 'S17',
    rules.blackjackPayout,
    rules.doubleAnyTwo ? 'DA2' : 'D911',
    rules.doubleAfterSplit ? 'DAS' : 'NDAS',
    rules.splitAcesOneCard ? 'AS1' : 'AS+',
    rules.resplitAces ? 'RSA' : 'NRSA',
    rules.resplitLimit,
    rules.surrender,
    rules.peek ? 'PEEK' : 'ENHC',
    rules.insurance ? 'INS' : 'NOINS',
  ].join('|');
}

/**
 * Human-readable rule chips.
 * @param {Rules} rules
 * @returns {string[]}
 */
export function ruleSummary(rules) {
  const payout = PAYOUT_OPTIONS.find((p) => p.value === rules.blackjackPayout)?.label ?? '1:1';
  return [
    rules.decks === 'infinite' ? 'Infinite deck' : `${rules.decks} deck${rules.decks === 1 ? '' : 's'}`,
    rules.dealerHitsSoft17 ? 'H17' : 'S17',
    payout,
    rules.doubleAnyTwo ? 'Double any 2' : 'Double 9-11',
    rules.doubleAfterSplit ? 'DAS' : 'No DAS',
    rules.resplitLimit - 1 + ' resplits',
    rules.surrender === 'late' ? 'Late surrender' : 'No surrender',
    rules.peek ? 'US peek' : 'No peek (ENHC)',
    rules.insurance ? 'Insurance' : 'No insurance',
  ];
}

/** @param {Rules} rules */
export function doubleAllowedByTotal(rules, total, soft) {
  if (rules.doubleAnyTwo) return true;
  return !soft && total >= 9 && total <= 11;
}
