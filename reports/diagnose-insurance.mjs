/**
 * Log insurance decisions to see whether the ten-density signal selects the
 * hands it claims to select. Run: node reports/diagnose-insurance.mjs
 */
import { makeRules } from '../js/engine/rules.js';
import { BUCKETS } from '../js/engine/cards.js';
import { freshCounts } from '../js/solver/finite.js';
import { buildStrategyChart } from '../js/solver/chart.js';
import { buildPolicy, optimalAction } from '../js/sim/strategies.js';
import { PlayGame } from '../js/play/game.js';

const rules = makeRules();
const chart = buildStrategyChart(rules);
const policy = buildPolicy(chart);
const ACTION_BY_LETTER = { S: 'stand', H: 'hit', D: 'double', P: 'split', R: 'surrender' };

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

const game = new PlayGame({
  rules,
  seed: 8675309,
  bankroll: 1_000_000_000,
  bet: 1,
  penetration: 0.75,
  countSystemId: 'hi-lo',
});

// Track every visible card so we can reconstruct the pre-hole composition the
// player actually knows. The hole is not visible at the insurance decision.
const visible = new Array(10).fill(0);
const originalNewShoe = game.newShoe.bind(game);
game.newShoe = function newShoeTracked(...args) {
  const result = originalNewShoe(...args);
  visible.fill(0);
  return result;
};
const originalDraw = game.draw.bind(game);
game.draw = function drawTracked(isVisible = true) {
  const card = originalDraw(isVisible);
  if (isVisible) visible[BUCKETS.indexOf(card.bucket)]++;
  return card;
};
const originalRevealHole = game.revealHole.bind(game);
game.revealHole = function revealHoleTracked() {
  if (this.round?.dealer?.holeHidden) visible[BUCKETS.indexOf(this.round.dealer.hole.bucket)]++;
  return originalRevealHole();
};

// Reconstruct the pre-hole composition from visible cards only. This is what
// the player knows at the insurance decision; the hole is still unknown.
game.tenDensity = function tenDensityPreHole() {
  if (this.infinite) return 4 / 13;
  const prehole = freshCounts(Number(rules.decks));
  for (let k = 0; k < visible.length; k++) prehole[k] -= visible[k];
  const cards = prehole.reduce((a, b) => a + b, 0);
  if (cards <= 0) return 4 / 13;
  return prehole[8] / cards;
};

let offers = 0;
let taken = 0;
let takenWins = 0;
let declined = 0;
let declinedWins = 0;
let logged = 0;
const bins = new Map();

for (let i = 0; i < 200_000; i++) {
  if (game.phase === 'settled') game.nextHand();
  game.setBet(1);
  if (!game.startRound()) throw new Error(`startRound failed at ${i}`);
  if (game.phase === 'insurance') {
    offers++;
    const t = game.insuranceEV();
    const counts = game.counts.slice();
    const remaining = game.remaining;
    const unrevealed = game.unrevealed;
    const prehole = freshCounts(Number(rules.decks));
    for (let k = 0; k < visible.length; k++) prehole[k] -= visible[k];
    const preholeCards = prehole.reduce((a, b) => a + b, 0);
    const preholeT = prehole[8] / preholeCards;
    const implied = counts.slice();
    implied[BUCKETS.indexOf(game.round.dealer.hole.bucket)]++;
    if (JSON.stringify(prehole) !== JSON.stringify(implied)) {
      console.log('MISMATCH', {
        round: i,
        hole: game.round.dealer.hole.bucket,
        remaining,
        unrevealed,
        visible,
        prehole,
        counts,
        implied,
        sumPrehole: preholeCards,
      });
      throw new Error('Pre-hole reconstruction disagrees with counts + hole');
    }
    const take = t >= 0;
    if (take) taken++;
    else declined++;
    const bin = Math.floor(preholeT * 1000) / 1000;
    if (!bins.has(bin)) bins.set(bin, { n: 0, bj: 0, post: 0 });
    if (game.round.dealer.hole.bucket === 10) {
      // The hole is not revealed yet, but this is a diagnostic script; the
      // goal is to compare the signal with the actual card.
    }
    if (take) game.takeInsurance();
    else game.declineInsurance();
    const bj = Boolean(game.round.dealer.blackjack);
    if (take) {
      if (bj) takenWins++;
      if (logged < 24) {
        console.log({
          round: i,
          t: Number(t.toFixed(5)),
          tens: counts[8],
          remaining,
          unseen: remaining + unrevealed,
          hole: game.round.dealer.hole.bucket,
          dealerBJ: bj,
          take,
        });
        logged++;
      }
    } else if (bj) {
      declinedWins++;
    }
    const entry = bins.get(bin);
    entry.n++;
    entry.post += counts[8] / (remaining + 1);
    if (bj) entry.bj++;
  }

  let guard = 0;
  while (game.phase === 'player' && guard++ < 100) {
    const snapshot = game.snapshotForCoach();
    if (!snapshot) break;
    const letter = optimalAction(policy, rules, handLike(snapshot), snapshot.upcard.bucket, snapshot.state.splitHands);
    game.act(ACTION_BY_LETTER[letter]);
  }
  if (game.phase === 'dealer') game.dealerPlay();
  if (game.phase !== 'settled') throw new Error('did not settle');
  game.history.length = 0;
}

console.log('\nSummary');
console.log({
  offers,
  taken,
  takenWins,
  takenWinRate: takenWins / taken,
  declined,
  declinedWins,
  declinedWinRate: declinedWins / declined,
});
console.log('\nPre-hole ten density bin -> offers, mean post-hole estimate, actual dealer BJ rate');
for (const [bin, entry] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
  if (entry.n < 20) continue;
  console.log(`${bin.toFixed(3)}: n=${entry.n} post=${(entry.post / entry.n).toFixed(4)} bj=${entry.bj} rate=${(entry.bj / entry.n).toFixed(4)}`);
}
