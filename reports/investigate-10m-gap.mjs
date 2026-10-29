/**
 * Isolate the 10M report's +0.09 point gap to its fresh-shoe reference.
 *
 * The report's exact edge (0.4256%) is a fresh-shoe solve of the chart policy,
 * with no insurance. The simulation uses a 75% cut card and takes insurance
 * whenever the live ten density makes it positive. This script separates:
 *   - insurance: actual insurance net vs. main-game net
 *   - shoe depletion: 75% cut card vs. a fresh shoe every round
 *   - sampling noise: same mode across independent seeds
 *
 * Usage:
 *   node reports/investigate-10m-gap.mjs
 *   node reports/investigate-10m-gap.mjs --rounds 1000000 --seeds 1,2,3
 *   node reports/investigate-10m-gap.mjs --penetration 0.9 --insurance decline
 *   node reports/investigate-10m-gap.mjs --fresh --insurance decline
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUCKETS } from '../js/engine/cards.js';
import { freshCounts } from '../js/solver/finite.js';
import { makeRules } from '../js/engine/rules.js';
import { buildStrategyChart } from '../js/solver/chart.js';
import { buildPolicy, optimalAction } from '../js/sim/strategies.js';
import { tryComputeFixedHouseEdge } from '../js/solver/fixed.js';
import { PlayGame } from '../js/play/game.js';

const ACTION_BY_LETTER = Object.freeze({
  S: 'stand',
  H: 'hit',
  D: 'double',
  P: 'split',
  R: 'surrender',
});

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const rounds = Math.max(1, Number(arg('rounds', 10_000_000)));
const penetration = Number(arg('penetration', 0.75));
const fresh = process.argv.includes('--fresh');
const insuranceMode = arg('insurance', 'optimal');
const tenDensityMode = arg('ten-density', 'current');
const seedArg = arg('seed', '8675309');
const seeds = arg('seeds', seedArg).split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
const quiet = process.argv.includes('--quiet');

const rules = makeRules();
const chart = buildStrategyChart(rules);
const policy = buildPolicy(chart);
const exact = tryComputeFixedHouseEdge(rules, chart, {
  budget: 4_000_000,
  dealerBudget: 4_000_000,
});
if (exact.incomplete || !Number.isFinite(exact.houseEdge)) {
  throw new Error(`Fresh-shoe edge did not solve: ${exact.error ?? 'unknown error'}`);
}
const exactEdge = exact.houseEdge;

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

function runOne(seed) {
  const game = new PlayGame({
    rules,
    seed,
    bankroll: 1_000_000_000,
    bet: 1,
    penetration,
    countSystemId: 'hi-lo',
  });

  // The shipped code uses `counts`, which has already had the hole removed.
  // That makes the estimate negatively correlated with the hole at the
  // insurance threshold. `remaining` excludes the hole from both sides but
  // still conditions on the already-drawn hole. `prehole` reconstructs the
  // composition from visible cards only, which is the player's information.
  if (tenDensityMode === 'remaining') {
    game.tenDensity = function tenDensityRemaining() {
      if (this.infinite) return 4 / 13;
      if (!Number.isFinite(this.remaining) || this.remaining <= 0) return 4 / 13;
      return this.counts[8] / this.remaining;
    };
  } else if (tenDensityMode === 'prehole') {
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
    game.tenDensity = function tenDensityPreHole() {
      if (this.infinite) return 4 / 13;
      const prehole = freshCounts(Number(this.rules.decks));
      for (let k = 0; k < visible.length; k++) prehole[k] -= visible[k];
      const cards = prehole.reduce((a, b) => a + b, 0);
      if (cards <= 0) return 4 / 13;
      return prehole[8] / cards;
    };
  } else if (tenDensityMode !== 'current') {
    throw new Error(`Unknown --ten-density mode: ${tenDensityMode}`);
  }

  let sum = 0;
  let sumSq = 0;
  let mainSum = 0;
  let mainSumSq = 0;
  let insuranceNet = 0;
  let insuranceEVSum = 0;
  let insuranceTakeEVSum = 0;
  let insuranceWins = 0;
  let insuranceLosses = 0;
  let offers = 0;
  let taken = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let hands = 0;
  let roundsDone = 0;
  let shoeRounds = 0;
  let freshShoeRounds = 0;

  for (let i = 0; i < rounds; i++) {
    if (game.phase === 'settled') game.nextHand();
    if (game.phase !== 'bet') throw new Error(`Round ${i + 1}: expected bet phase, got ${game.phase}`);
    if (fresh) {
      game.newShoe();
      freshShoeRounds++;
    }
    game.setBet(1);
    if (!game.startRound()) throw new Error(`Round ${i + 1}: startRound failed`);

    if (game.phase === 'insurance') {
      offers++;
      const ev = game.insuranceEV();
      if (Number.isFinite(ev)) insuranceEVSum += ev;
      let take = false;
      if (insuranceMode === 'always') take = true;
      else if (insuranceMode === 'optimal') take = ev >= 0;
      else if (insuranceMode === 'decline') take = false;
      else throw new Error(`Unknown --insurance mode: ${insuranceMode}`);
      if (take) {
        taken++;
        insuranceTakeEVSum += ev;
        game.takeInsurance();
      } else {
        game.declineInsurance();
      }
    }

    let guard = 0;
    while (game.phase === 'player' && guard++ < 100) {
      const snapshot = game.snapshotForCoach();
      if (!snapshot) break;
      const letter = optimalAction(
        policy,
        rules,
        handLike(snapshot),
        snapshot.upcard.bucket,
        snapshot.state.splitHands,
      );
      const action = ACTION_BY_LETTER[letter];
      if (!action || !game.legalActions().includes(action)) {
        throw new Error(`Round ${i + 1}: illegal action ${letter}`);
      }
      game.act(action);
    }

    if (game.phase === 'dealer') game.dealerPlay();
    if (game.phase !== 'settled') throw new Error(`Round ${i + 1}: round did not settle (${game.phase})`);

    const round = game.history[0];
    if (!round || !Number.isFinite(round.net)) throw new Error(`Round ${i + 1}: no settled round`);
    const net = round.net;
    const ins = Number.isFinite(round.insuranceNet) ? round.insuranceNet : 0;
    const main = net - ins;
    if (round.insuranceTaken) {
      if (round.dealer.blackjack) insuranceWins++;
      else insuranceLosses++;
    }

    sum += net;
    sumSq += net * net;
    mainSum += main;
    mainSumSq += main * main;
    insuranceNet += ins;
    hands += round.hands.length;
    if (net > 0) wins++;
    else if (net < 0) losses++;
    else pushes++;
    roundsDone++;
    game.history.length = 0;

    if (!quiet && roundsDone % 1_000_000 === 0) {
      process.stderr.write(`  ${roundsDone.toLocaleString()} rounds\r`);
    }
  }

  const mean = sum / roundsDone;
  const variance = Math.max(0, (sumSq - roundsDone * mean * mean) / Math.max(1, roundsDone - 1));
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(roundsDone);
  const mainMean = mainSum / roundsDone;
  const mainVariance = Math.max(0, (mainSumSq - roundsDone * mainMean * mainMean) / Math.max(1, roundsDone - 1));
  const mainSd = Math.sqrt(mainVariance);
  const mainSe = mainSd / Math.sqrt(roundsDone);
  const edge = -mean * 100;
  const mainEdge = -mainMean * 100;
  const half = 1.96 * se * 100;
  const mainHalf = 1.96 * mainSe * 100;
  const z = (mean + exactEdge / 100) / se;
  const mainZ = (mainMean + exactEdge / 100) / mainSe;

  return {
    seed,
    rounds: roundsDone,
    hands,
    fresh,
    penetration,
    insuranceMode,
    tenDensityMode,
    net: sum,
    edge,
    ciLow: edge - half,
    ciHigh: edge + half,
    width: 2 * half,
    sd,
    se,
    z,
    mainNet: mainSum,
    mainEdge,
    mainCiLow: mainEdge - mainHalf,
    mainCiHigh: mainEdge + mainHalf,
    mainZ,
    insuranceNet,
    insuranceEdge: -(insuranceNet / roundsDone) * 100,
    insuranceEVSum,
    insuranceTakeEVSum,
    insuranceExpectedEdge: -(insuranceTakeEVSum / roundsDone) * 100,
    insuranceExpectedNet: insuranceTakeEVSum,
    insuranceWins,
    insuranceLosses,
    insuranceActualWinRate: taken ? insuranceWins / taken : null,
    insuranceOffers: offers,
    insuranceTaken: taken,
    insuranceTakeRate: offers ? taken / offers : null,
    wins,
    losses,
    pushes,
    winRate: wins / roundsDone,
    lossRate: losses / roundsDone,
    pushRate: pushes / roundsDone,
    shoeRounds,
    freshShoeRounds,
  };
}

const results = [];
for (const seed of seeds) {
  const started = Date.now();
  const result = runOne(seed);
  result.ms = Date.now() - started;
  results.push(result);
  if (!quiet) process.stderr.write('\n');
  console.log(JSON.stringify(result, null, 2));
}

const output = {
  generatedAt: new Date().toISOString(),
  exactEdge,
  exactNote: 'Fresh-shoe fixed-chart solve, no insurance, infinite-deck split approximation.',
  config: { rounds, penetration, fresh, insuranceMode, tenDensityMode, seeds },
  results,
};
const outPath = resolve('reports/blackjack-10m-gap-investigation.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote ${outPath}`);
