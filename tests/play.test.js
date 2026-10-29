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

test('insurance selection ignores the hidden hole card at the threshold', () => {
  const game = new PlayGame({
    rules: makeRules({ decks: 1, insurance: true }),
    seed: 1,
    bankroll: 100_000,
    bet: 10,
  });

  // Deal until a real ace-up hand sits on the insurance threshold, with a ten
  // in the hole. The old counts[8] / cardsLeftUnseen() estimate puts this hand
  // below 1/3 and declines insurance; the visible-card estimate puts it above
  // 1/3 and takes it. This is the selection bug, not just a density difference.
  let found = false;
  for (let attempt = 0; attempt < 2_000 && !found; attempt++) {
    if (game.phase === 'settled') game.nextHand();
    assert.equal(game.phase, 'bet');
    game.setBet(10);
    assert.equal(game.startRound(), true);

    if (game.phase === 'insurance') {
      const unseen = game.cardsLeftUnseen();
      const postHoleDensity = game.counts[8] / unseen;
      if (postHoleDensity < 1 / 3 && game.tenDensity() >= 1 / 3) {
        found = true;
        break;
      }
      game.declineInsurance();
    }

    while (game.phase === 'player') game.act('stand');
    if (game.phase === 'dealer') game.dealerPlay();
  }
  assert.ok(found, 'expected a seed where the two density estimates straddle 1/3');

  const hole = game.round.dealer.hole.bucket;
  assert.equal(hole, 10, 'the threshold flip must come from a hidden ten');
  const unseen = game.cardsLeftUnseen();
  const unseenTens = game.counts[8] + 1; // the hidden hole card is a ten
  assert.equal(unseen, game.remaining + game.unrevealed);
  assert.equal(game.tenDensity(), unseenTens / unseen);

  // Under the old estimate moving the ten from the hole to the counts would
  // change the decision even though the player has seen the same cards.
  assert.ok(game.counts[8] / unseen < 1 / 3);
  const decision = game.insuranceDecision(true);
  assert.equal(decision.correct, true);
  assert.ok(decision.insuranceEV > 0);
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

  // Simulate a late, ten-rich shoe: 30 non-ten cards have been seen, leaving
  // 6 non-tens and 16 tens among 22 unseen cards (the hidden hole included).
  game.seenCards = 30;
  game.seenTens = 0;
  game.counts = [1, 1, 1, 1, 1, 1, 0, 0, 15, 0];
  game.remaining = 21;
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
