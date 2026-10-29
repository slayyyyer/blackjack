import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRules } from '../js/engine/rules.js';
import { buildStrategyChart } from '../js/solver/chart.js';
import { buildPolicy } from '../js/sim/strategies.js';
import { PlayGame } from '../js/play/game.js';
import { playRounds } from '../js/play/autoplay.js';

const RULES = makeRules({ decks: 6, penetration: 0.75 });
const CHART = buildStrategyChart(RULES);
const POLICY = buildPolicy(CHART);

test('playRounds is deterministic for a seed and policy', () => {
  const first = playRounds({
    rules: RULES,
    chart: CHART,
    policy: POLICY,
    seed: 424242,
    rounds: 80,
    bankroll: 10_000,
  });
  const second = playRounds({
    rules: RULES,
    chart: CHART,
    policy: POLICY,
    seed: 424242,
    rounds: 80,
    bankroll: 10_000,
  });

  assert.equal(first.roundsPlayed, 80);
  assert.equal(second.roundsPlayed, 80);
  assert.equal(first.net, second.net);
  assert.deepEqual(first.stats, second.stats);
});

test('perfect chart play records no mistakes and keeps luck out of them', () => {
  const result = playRounds({
    rules: RULES,
    chart: CHART,
    policy: POLICY,
    seed: 8675309,
    rounds: 250,
    bankroll: 10_000,
  });

  assert.ok(result.stats.expectedCount > 0);
  assert.equal(result.stats.evLost, 0, 'perfect play should lose no EV');
  assert.equal(
    result.stats.luck,
    result.stats.expectedActualNet - result.stats.expectedNet,
    'luck is actual minus expected, not a disguised mistake total',
  );
});

test('grading after settlement uses the round bet, not the next bet', () => {
  const game = new PlayGame({
    rules: makeRules({ decks: 'infinite', insurance: false }),
    seed: 7,
    bankroll: 1000,
    bet: 10,
  });
  game.setBet(10);

  for (let attempt = 0; attempt < 20 && game.phase !== 'player'; attempt++) {
    if (game.phase === 'settled') game.nextHand();
    game.setBet(10);
    game.startRound();
  }
  assert.equal(game.phase, 'player');

  const roundId = game.round.id;
  const roundBet = game.round.bet;
  game.act('stand');
  assert.equal(game.phase, 'settled');

  // The async coach can finish after the next bet has already been entered.
  game.setBet(100);
  assert.equal(game.bet, 100);
  assert.equal(game.round.bet, roundBet);

  const actionEV = 0.25;
  game.logDecision(roundId, {
    action: 'stand',
    actionLetter: 'S',
    actionName: 'Stand',
    actionEV,
    best: 'hit',
    bestName: 'Hit',
    bestEV: actionEV + 0.1,
    evLost: 0.1,
    correct: false,
    graded: true,
    mode: 'chart',
  });

  assert.equal(game.round.expectedEV, actionEV * roundBet);
  assert.equal(game.stats.expectedNet, actionEV * roundBet);
  assert.equal(game.stats.evLost, 0.1 * roundBet, 'mistake EV is weighted by the round bet');
});

test('insurance is graded and taken at a high ten density', () => {
  const game = new PlayGame({
    rules: makeRules({ decks: 1, insurance: true }),
    seed: 1,
    bankroll: 500,
    bet: 10,
  });
  game.setBet(10);
  assert.equal(game.startRound(), true);
  assert.equal(game.phase, 'insurance');

  // Make the remaining shoe ten-rich and give the counter a high true count.
  // The hole card is still unseen, so it is included in the density denominator.
  game.counts = [1, 1, 1, 1, 1, 1, 1, 1, 30, 4];
  game.remaining = 42;
  game.unrevealed = 1;
  game.runningCount = 20;
  assert.ok(game.trueCount() > 5);

  const decision = game.insuranceDecision(true);
  assert.ok(decision, 'an insurance offer should be graded');
  assert.ok(decision.insuranceEV > 0.5);
  assert.equal(decision.correct, true);
  assert.equal(decision.evLost, 0);
  assert.equal(decision.isInsurance, true);

  game.logDecision(decision.roundId, decision);
  assert.equal(game.stats.decisions, 1);
  assert.equal(game.stats.evLost, 0);
  assert.equal(game.round.expectedEV, decision.insuranceEV * game.round.bet);
  assert.equal(game.round.decisions.at(-1).action, 'insurance');

  assert.equal(game.takeInsurance(), true);
  assert.equal(game.round.insuranceTaken, true);
});
