import { PlayGame } from './game.js';
import { buildStrategyChart } from '../solver/chart.js';
import { ACTION_LABELS } from '../solver/ev.js';
import { buildPolicy, optimalAction } from '../sim/strategies.js';

const UPCARDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const ACTION_BY_LETTER = Object.freeze({
  S: 'stand',
  H: 'hit',
  D: 'double',
  P: 'split',
  R: 'surrender',
});
const LETTER_BY_ACTION = Object.freeze({
  stand: 'S',
  hit: 'H',
  double: 'D',
  split: 'P',
  surrender: 'R',
});
const NEAR_TIE_EV = 0.005;

function cellFor(chart, snapshot) {
  if (!chart) return null;
  const upIndex = UPCARDS.indexOf(snapshot.upcard.bucket);
  if (upIndex < 0) return null;
  const { total, soft, pairBucket } = snapshot.state;
  if (pairBucket != null) {
    return chart.pairs.find((row) => row.value === pairBucket)?.cells[upIndex] ?? null;
  }
  if (soft) {
    return chart.soft.find((row) => row.value === total)?.cells[upIndex] ?? null;
  }
  return chart.hard.find((row) => row.value === total)?.cells[upIndex] ?? null;
}

/**
 * Grade a chosen action against the chart cell, but only consider actions that
 * are legal for this exact hand state. A chart cell can contain a split EV even
 * when the resplit limit makes splitting unavailable, for example.
 */
function gradeSnapshot(snapshot, chosenLetter, chart) {
  const cell = cellFor(chart, snapshot);
  if (!cell) return null;
  const actions = {};
  for (const action of snapshot.legalActions) {
    const letter = LETTER_BY_ACTION[action];
    if (letter && Number.isFinite(cell.actions[letter])) {
      actions[letter] = cell.actions[letter];
    }
  }
  if (!Number.isFinite(actions[chosenLetter])) return null;

  let best = null;
  let bestEV = -Infinity;
  for (const letter of ['S', 'H', 'D', 'P', 'R']) {
    if (actions[letter] > bestEV) {
      bestEV = actions[letter];
      best = letter;
    }
  }
  if (!best) return null;
  const actionEV = actions[chosenLetter];
  const evLost = Math.max(0, bestEV - actionEV);
  return {
    actionEV,
    best,
    bestName: ACTION_LABELS[best],
    bestEV,
    evLost,
    correct: chosenLetter === best || evLost < NEAR_TIE_EV,
    graded: true,
    mode: 'chart',
  };
}

function handLike(snapshot) {
  return {
    total: snapshot.state.total,
    soft: snapshot.state.soft,
    pairBucket: snapshot.state.pairBucket,
    cards: snapshot.cards.length,
    fromSplit: snapshot.fromSplit,
    canDouble: snapshot.legalActions.includes('double'),
    canSurrender: snapshot.legalActions.includes('surrender'),
  };
}

function betFor(ramp, roundIndex, game) {
  let value = 1;
  if (typeof ramp === 'function') {
    value = ramp({
      round: roundIndex,
      game,
      trueCount: game.trueCount(),
      bankroll: game.bankroll,
    });
  } else if (Array.isArray(ramp)) {
    value = ramp[roundIndex % ramp.length];
  } else if (ramp != null) {
    value = ramp;
  }
  const bet = Math.floor(Number(value));
  return Number.isFinite(bet) && bet >= 1 ? bet : 1;
}

/**
 * Drive PlayGame without a browser. This is the reusable play-mode harness for
 * tests and headless experiments: it places bets, takes or declines insurance,
 * plays every hand with the supplied policy, grades each decision against the
 * chart, and returns the session.
 *
 * `policy` is the lookup table from buildPolicy(). It may also be a function
 * receiving ({ snapshot, game, chart, rules }) and returning a letter
 * (S/H/D/P/R). When omitted, the optimal chart policy is used.
 *
 * `betRamp` may be a number, an array indexed by round, or a function
 * receiving ({ round, game, trueCount, bankroll }).
 *
 * @param {Object} options
 * @param {import('../engine/rules.js').Rules} options.rules
 * @param {number} [options.seed]
 * @param {number} [options.rounds]
 * @param {ReturnType<typeof buildPolicy>|Function} [options.policy]
 * @param {number|number[]|Function} [options.betRamp]
 * @param {ReturnType<typeof buildStrategyChart>} [options.chart]
 * @param {number} [options.bankroll]
 * @param {number} [options.penetration]
 * @param {string} [options.countSystemId]
 */
export function playRounds({
  rules,
  seed = 20261028,
  rounds = 100,
  policy = null,
  betRamp = 1,
  chart: suppliedChart = null,
  bankroll = 1_000_000,
  penetration = 0.75,
  countSystemId = 'hi-lo',
} = {}) {
  const chart = suppliedChart ?? buildStrategyChart(rules);
  const activePolicy = policy ?? buildPolicy(chart);
  const game = new PlayGame({
    rules,
    seed,
    bankroll,
    bet: 1,
    penetration,
    countSystemId,
  });
  const startingBankroll = game.bankroll;
  let played = 0;

  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    if (game.phase === 'settled') game.nextHand();
    if (game.phase !== 'bet') break;

    game.setBet(betFor(betRamp, roundIndex, game));
    if (!game.startRound()) break;
    played++;

    // Insurance is settled before any player action. The EV decision is
    // deterministic from the unseen ten density, and grading it keeps the
    // side bet out of the luck figure.
    if (game.phase === 'insurance') {
      const take = game.insuranceEV() >= 0;
      const decision = game.insuranceDecision(take);
      if (decision) game.logDecision(decision.roundId, decision);
      if (take) game.takeInsurance();
      else game.declineInsurance();
    }

    let guard = 0;
    while (game.phase === 'player' && guard++ < 100) {
      const snapshot = game.snapshotForCoach();
      if (!snapshot) break;
      const chosen = typeof activePolicy === 'function'
        ? activePolicy({ snapshot, game, chart, rules })
        : optimalAction(
          activePolicy,
          rules,
          handLike(snapshot),
          snapshot.upcard.bucket,
          snapshot.state.splitHands,
        );
      const letter = String(chosen ?? 'S').toUpperCase().slice(0, 1);
      const action = ACTION_BY_LETTER[letter];
      if (!action || !game.legalActions().includes(action)) break;

      const grade = gradeSnapshot(snapshot, letter, chart);
      game.logDecision(snapshot.roundId, {
        action,
        actionLetter: letter,
        actionName: ACTION_LABELS[letter],
        firstAction: snapshot.actionIndex === 0,
        ...(grade ?? {
          actionEV: null,
          best: null,
          bestName: null,
          bestEV: null,
          evLost: null,
          correct: false,
          graded: false,
          mode: 'ungraded',
        }),
        trueCount: snapshot.trueCount,
        runningCount: snapshot.runningCount,
        cards: snapshot.cards.map((card) => ({ rank: card.rank, suit: card.suit })),
        upcard: snapshot.upcard.rank,
        hand: snapshot.handLabel,
        timestamp: new Date().toISOString(),
      });
      game.act(action);
    }

    if (game.phase === 'dealer') game.dealerPlay();
    if (game.phase !== 'settled') break;
  }

  return {
    game,
    roundsPlayed: played,
    net: game.bankroll - startingBankroll,
    stats: game.statsView(),
  };
}
