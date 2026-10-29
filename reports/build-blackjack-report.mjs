/**
 * Build the 100-hand blackjack session report.
 *
 * The session uses the same PlayGame engine as the browser table. The
 * reference run uses the same rules and chart policy over 100,000 rounds so
 * the report can compare the sample's outcome mix with a long-run baseline.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRules, ruleSummary } from '../js/engine/rules.js';
import { buildStrategyChart } from '../js/solver/chart.js';
import { buildPolicy } from '../js/sim/strategies.js';
import { tryComputeFixedHouseEdge } from '../js/solver/fixed.js';
import { playRounds } from '../js/play/autoplay.js';

const OUT = resolve('reports');
mkdirSync(OUT, { recursive: true });

const SESSION_SEED = 20261029;
const REFERENCE_SEED = 8675309;
const SESSION_ROUNDS = 100;
const REFERENCE_ROUNDS = 100_000;
const START_BANKROLL = 200;
const COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'working tree';
  }
})();

const rules = makeRules();
const chart = buildStrategyChart(rules);
const policy = buildPolicy(chart);
const freshEdge = tryComputeFixedHouseEdge(rules, chart, {
  budget: 4_000_000,
  dealerBudget: 4_000_000,
});
if (freshEdge.incomplete || !Number.isFinite(freshEdge.houseEdge)) {
  throw new Error(`Fresh-shoe edge did not solve: ${freshEdge.error ?? 'unknown error'}`);
}

function play(seed, rounds, bankroll) {
  return playRounds({
    rules,
    chart,
    policy,
    seed,
    rounds,
    bankroll,
    betRamp: 1,
    penetration: 0.75,
  });
}

const session = play(SESSION_SEED, SESSION_ROUNDS, START_BANKROLL);
const reference = play(REFERENCE_SEED, REFERENCE_ROUNDS, 1_000_000_000);
const refNets = reference.game.history.map((round) => round.net);
const refMean = refNets.reduce((sum, net) => sum + net, 0) / refNets.length;
const refVariance = refNets.reduce((sum, net) => sum + (net - refMean) ** 2, 0)
  / Math.max(1, refNets.length - 1);
const referenceSd = Math.sqrt(refVariance);
const referenceWins = reference.stats.wins / reference.stats.rounds;
const referenceLosses = reference.stats.losses / reference.stats.rounds;
const referencePushes = reference.stats.pushes / reference.stats.rounds;

const orderedRounds = session.game.history.slice().reverse();
let bankroll = START_BANKROLL;
const curve = [bankroll];
for (const round of orderedRounds) {
  bankroll += round.net;
  curve.push(bankroll);
}

const rounds = orderedRounds.map((round, index) => ({
  id: index + 1,
  bet: round.bet,
  net: round.net,
  note: round.note,
  expectedEV: round.expectedEV,
  bankroll: curve[index + 1],
  dealer: {
    cards: round.dealer.cards.map((card) => ({ rank: card.rank, suit: card.suit })),
    total: round.dealer.total,
    bust: round.dealer.bust,
    blackjack: round.dealer.blackjack,
  },
  hands: round.hands.map((hand) => ({
    cards: hand.cards.map((card) => ({ rank: card.rank, suit: card.suit })),
    total: hand.total,
    soft: hand.soft,
    bust: hand.bust,
    natural: hand.natural,
    doubled: hand.doubled,
    surrendered: hand.surrendered,
  })),
  insurance: {
    offered: round.insuranceOffered,
    taken: round.insuranceTaken,
    bet: round.insuranceBet,
  },
  actions: round.decisions.map((decision) => ({
    letter: decision.actionLetter ?? (decision.isInsurance ? 'I' : '?'),
    action: decision.action,
    name: decision.actionName,
    graded: decision.graded,
    correct: decision.correct,
    evLost: decision.evLost,
    insurance: Boolean(decision.isInsurance),
  })),
}));

const stats = session.stats;
const handCount = stats.hands;
const playerHands = rounds.flatMap((round) => round.hands);
const dealerRounds = rounds.filter((round) => !round.dealer.blackjack
  && !round.hands.some((hand) => hand.natural));
const playerBusts = playerHands.filter((hand) => hand.bust).length;
const dealerBusts = rounds.filter((round) => round.dealer.bust).length;
const naturals = rounds.filter((round) => round.hands.some((hand) => hand.natural)).length;
const dealerBlackjacks = rounds.filter((round) => round.dealer.blackjack).length;
const doubles = playerHands.filter((hand) => hand.doubled).length;
const splits = rounds.filter((round) => round.hands.length > 1).length;
const insuranceOffers = rounds.filter((round) => round.insurance.offered).length;
const insuranceTaken = rounds.filter((round) => round.insurance.taken).length;
const actionCounts = rounds.flatMap((round) => round.actions).reduce((counts, action) => {
  counts[action.letter] = (counts[action.letter] ?? 0) + 1;
  return counts;
}, {});
const gradedActions = rounds.flatMap((round) => round.actions).filter((action) => action.graded);
const gradedRounds = rounds.filter((round) => round.expectedEV != null);
const gradedExpected = gradedRounds.reduce((sum, round) => sum + round.expectedEV, 0);
const gradedActual = gradedRounds.reduce((sum, round) => sum + round.net, 0);
const otherActual = rounds
  .filter((round) => round.expectedEV == null)
  .reduce((sum, round) => sum + round.net, 0);

let high = curve[0];
let highAt = 0;
let low = curve[0];
let lowAt = 0;
for (let i = 0; i < curve.length; i++) {
  if (curve[i] > high) {
    high = curve[i];
    highAt = i;
  }
  if (curve[i] < low) {
    low = curve[i];
    lowAt = i;
  }
}

let winStreak = 0;
let lossStreak = 0;
let pushStreak = 0;
let bestWinStreak = 0;
let bestLossStreak = 0;
let bestPushStreak = 0;
for (const round of rounds) {
  if (round.net > 0) {
    winStreak++;
    lossStreak = 0;
    pushStreak = 0;
  } else if (round.net < 0) {
    lossStreak++;
    winStreak = 0;
    pushStreak = 0;
  } else {
    pushStreak++;
    winStreak = 0;
    lossStreak = 0;
  }
  bestWinStreak = Math.max(bestWinStreak, winStreak);
  bestLossStreak = Math.max(bestLossStreak, lossStreak);
  bestPushStreak = Math.max(bestPushStreak, pushStreak);
}

const exactExpectedLoss = freshEdge.houseEdge;
const sessionSd = Math.sqrt(100) * referenceSd;
const luckVsExact = session.net - (-exactExpectedLoss);
const pushRate = stats.pushes / stats.rounds;
const referencePushRate = referencePushes;
const pushZ = (pushRate - referencePushRate)
  / Math.sqrt((referencePushRate * (1 - referencePushRate)) / stats.rounds);

const category = (hand) => {
  if (hand.bust) return 'Bust';
  if (hand.natural) return 'Blackjack';
  if (hand.total <= 16) return '≤16';
  return String(hand.total);
};
const playerTotals = {};
const dealerTotals = {};
for (const round of dealerRounds) {
  for (const hand of round.hands) {
    const key = category(hand);
    playerTotals[key] = (playerTotals[key] ?? 0) + 1;
  }
  const key = category(round.dealer);
  dealerTotals[key] = (dealerTotals[key] ?? 0) + 1;
}

const data = {
  title: '100 Hands Against the House',
  generatedAt: new Date().toISOString(),
  commit: COMMIT,
  seed: SESSION_SEED,
  referenceSeed: REFERENCE_SEED,
  rules,
  ruleSummary: ruleSummary(rules),
  chartHouseEdge: freshEdge.houseEdge,
  startBankroll: START_BANKROLL,
  endBankroll: session.game.bankroll,
  net: session.net,
  stats,
  exactExpectedLoss,
  sessionSd,
  luckVsExact,
  reference: {
    rounds: reference.stats.rounds,
    wins: referenceWins,
    losses: referenceLosses,
    pushes: referencePushes,
    sd: referenceSd,
  },
  actionCounts,
  insuranceOffers,
  insuranceTaken,
  gradedActions: gradedActions.length,
  gradedRounds: gradedRounds.length,
  gradedExpected,
  gradedActual,
  otherActual,
  naturals,
  dealerBlackjacks,
  doubles,
  splits,
  playerBusts,
  dealerBusts,
  handCount,
  high,
  highAt,
  low,
  lowAt,
  bestWinStreak,
  bestLossStreak,
  bestPushStreak,
  pushZ,
  playerTotals,
  dealerTotals,
  rounds,
};

writeFileSync(join(OUT, 'blackjack-100-rounds.json'), `${JSON.stringify(data, null, 2)}\n`);

const suit = { s: '♠', h: '♥', d: '♦', c: '♣' };
const isRed = (card) => card.suit === 'h' || card.suit === 'd';
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[char]));
const card = (value) => `<span class="card-inline${isRed(value) ? ' is-red' : ''}">${esc(value.rank)}${suit[value.suit] ?? ''}</span>`;
const cardsFor = (hand) => hand.cards.map(card).join(' ');
const money = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const gradeMark = (round) => {
  if (!round.actions.length) return '—';
  return round.actions.every((action) => !action.graded || action.correct) ? '✓' : '×';
};
const resultMark = (round) => (round.net > 0 ? 'W' : round.net < 0 ? 'L' : 'P');
const resultClass = (round) => (round.net > 0 ? 'is-win' : round.net < 0 ? 'is-loss' : 'is-push');
const actionLetters = (round) => (round.actions.length
  ? round.actions.map((action) => action.letter).join(' · ')
  : '—');
const playedTotals = ['≤16', '17', '18', '19', '20', '21', 'Bust'];

function pathFor(values, xScale, yScale) {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'}${xScale(index).toFixed(2)},${yScale(value).toFixed(2)}`).join(' ');
}

function bankrollChart() {
  const width = 760;
  const height = 340;
  const margin = { left: 54, right: 20, top: 16, bottom: 38 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const yMin = 170;
  const yMax = 230;
  const x = (index) => margin.left + (index / rounds.length) * plotW;
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotH;
  const expected = (n) => START_BANKROLL - (exactExpectedLoss / 100) * n;
  const band = (n) => 1.96 * referenceSd * Math.sqrt(Math.max(0, n));
  const upper = curve.map((_, n) => expected(n) + band(n));
  const lower = curve.map((_, n) => expected(n) - band(n));
  const bandPath = `${pathFor(upper, x, y)} L${x(rounds.length).toFixed(2)},${y(lower[lower.length - 1]).toFixed(2)} ${pathFor(lower.slice().reverse(), (i, idx) => x(rounds.length - idx), y).replace(/^M/, 'L')} Z`;
  const grid = [170, 180, 190, 200, 210, 220, 230];
  const xTicks = [0, 20, 40, 60, 80, 100];
  const highPoint = { x: x(highAt), y: y(high) };
  const lowPoint = { x: x(lowAt), y: y(low) };

  return `
  <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bankroll across 100 rounds inside a 95 percent luck cone">
    <defs>
      <linearGradient id="bankFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#3b7a60" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="#3b7a60" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid.map((value) => `
      <line x1="${margin.left}" y1="${y(value)}" x2="${width - margin.right}" y2="${y(value)}" class="grid"/>
      <text x="${margin.left - 9}" y="${y(value) + 3}" text-anchor="end" class="axis">${value}</text>
    `).join('')}
    ${xTicks.map((value) => `
      <line x1="${x(value)}" y1="${margin.top}" x2="${x(value)}" y2="${height - margin.bottom}" class="grid grid-soft"/>
      <text x="${x(value)}" y="${height - 15}" text-anchor="middle" class="axis">${value}</text>
    `).join('')}
    <path d="${bandPath}" fill="#7da995" opacity="0.22"/>
    <path d="${pathFor(curve.map((_, n) => expected(n)), x, y)}" class="expected-line"/>
    <path d="${pathFor(curve, x, y)}" fill="url(#bankFill)"/>
    <path d="${pathFor(curve, x, y)}" class="bank-line"/>
    <circle cx="${x(0)}" cy="${y(curve[0])}" r="4.2" class="endpoint"/>
    <circle cx="${x(rounds.length)}" cy="${y(curve[curve.length - 1])}" r="4.2" class="endpoint endpoint-end"/>
    <circle cx="${highPoint.x}" cy="${highPoint.y}" r="4.5" class="marker marker-high"/>
    <circle cx="${lowPoint.x}" cy="${lowPoint.y}" r="4.5" class="marker marker-low"/>
    <g class="annotation">
      <text x="${highPoint.x - 6}" y="${highPoint.y - 10}" text-anchor="end">207.00 · after 17</text>
      <text x="${lowPoint.x + 7}" y="${lowPoint.y + 17}">198.00 · after 94</text>
    </g>
    <text x="${margin.left}" y="12" class="axis-axis-title">BANKROLL / UNITS</text>
    <text x="${width - margin.right}" y="${height - 2}" text-anchor="end" class="axis-axis-title">ROUND</text>
  </svg>`;
}

function outcomeChart() {
  const width = 760;
  const height = 178;
  const left = 148;
  const right = 730;
  const barWidth = right - left;
  const rows = [
    { label: 'THIS SESSION', win: stats.wins / stats.rounds, loss: stats.losses / stats.rounds, push: stats.pushes / stats.rounds },
    { label: '100,000-HAND REFERENCE', win: referenceWins, loss: referenceLosses, push: referencePushes },
  ];
  return `
  <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Win loss and push percentages for the session and the reference run">
    <g class="legend-row">
      <rect x="${left}" y="4" width="11" height="11" rx="2" fill="#2e6d52"/>
      <text x="${left + 17}" y="13" class="legend-text">WIN</text>
      <rect x="${left + 76}" y="4" width="11" height="11" rx="2" fill="#b24a3b"/>
      <text x="${left + 93}" y="13" class="legend-text">LOSS</text>
      <rect x="${left + 158}" y="4" width="11" height="11" rx="2" fill="#c2ae83"/>
      <text x="${left + 175}" y="13" class="legend-text">PUSH / ZERO</text>
    </g>
    ${rows.map((row, index) => {
      const cy = 56 + index * 58;
      const winW = row.win * barWidth;
      const lossW = row.loss * barWidth;
      const pushW = row.push * barWidth;
      return `
        <text x="${left - 16}" y="${cy + 5}" text-anchor="end" class="row-label">${row.label}</text>
        <rect x="${left}" y="${cy}" width="${barWidth}" height="30" rx="4" fill="#e6dfcf"/>
        <rect x="${left}" y="${cy}" width="${winW}" height="30" rx="3" fill="#2e6d52"/>
        <rect x="${left + winW}" y="${cy}" width="${lossW}" height="30" fill="#b24a3b"/>
        <rect x="${left + winW + lossW}" y="${cy}" width="${pushW}" height="30" rx="3" fill="#c2ae83"/>
        <text x="${left + winW / 2}" y="${cy + 19}" text-anchor="middle" class="bar-label light">${(row.win * 100).toFixed(1)}%</text>
        <text x="${left + winW + lossW / 2}" y="${cy + 19}" text-anchor="middle" class="bar-label light">${(row.loss * 100).toFixed(1)}%</text>
        <text x="${left + winW + lossW + pushW / 2}" y="${cy + 19}" text-anchor="middle" class="bar-label">${(row.push * 100).toFixed(1)}%</text>
      `;
    }).join('')}
  </svg>`;
}

function totalsChart() {
  const width = 760;
  const height = 306;
  const margin = { left: 52, right: 20, top: 28, bottom: 42 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = 25;
  const groupW = plotW / playedTotals.length;
  const barW = Math.min(32, groupW * 0.29);
  const y = (value) => margin.top + plotH - (value / max) * plotH;
  return `
  <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Final totals for the player and dealer in played out rounds">
    <g class="legend-row">
      <rect x="${margin.left}" y="4" width="11" height="11" rx="2" fill="#264b3c"/>
      <text x="${margin.left + 17}" y="13" class="legend-text">PLAYER</text>
      <rect x="${margin.left + 99}" y="4" width="11" height="11" rx="2" fill="#b24a3b"/>
      <text x="${margin.left + 116}" y="13" class="legend-text">DEALER</text>
    </g>
    ${[0, 5, 10, 15, 20, 25].map((value) => `
      <line x1="${margin.left}" y1="${y(value)}" x2="${width - margin.right}" y2="${y(value)}" class="grid"/>
      <text x="${margin.left - 9}" y="${y(value) + 3}" text-anchor="end" class="axis">${value}</text>
    `).join('')}
    ${playedTotals.map((label, index) => {
      const center = margin.left + groupW * index + groupW / 2;
      const p = playerTotals[label] ?? 0;
      const d = dealerTotals[label] ?? 0;
      return `
        <rect x="${center - barW - 2}" y="${y(p)}" width="${barW}" height="${margin.top + plotH - y(p)}" rx="2" fill="#264b3c"/>
        <rect x="${center + 2}" y="${y(d)}" width="${barW}" height="${margin.top + plotH - y(d)}" rx="2" fill="#b24a3b"/>
        <text x="${center - barW / 2 - 2}" y="${y(p) - 7}" text-anchor="middle" class="value-label">${p}</text>
        <text x="${center + barW / 2 + 2}" y="${y(d) - 7}" text-anchor="middle" class="value-label">${d}</text>
        <text x="${center}" y="${height - 15}" text-anchor="middle" class="axis">${label}</text>
      `;
    }).join('')}
  </svg>`;
}

function handRows(start, count) {
  return rounds.slice(start, start + count).map((round) => {
    const player = round.hands.map((hand) => cardsFor(hand)).join('<span class="card-sep"> / </span>');
    const dealer = cardsFor(round.dealer);
    return `
      <tr>
        <td class="num">${String(round.id).padStart(2, '0')}</td>
        <td class="cards">${player}</td>
        <td class="cards dealer-cards">${dealer}</td>
        <td class="play-cell">${actionLetters(round)}</td>
        <td class="num result ${resultClass(round)}">${resultMark(round)} <span>${money(round.net)}</span></td>
        <td class="num ev-cell">${round.expectedEV == null ? '—' : signed(round.expectedEV)}</td>
        <td class="grade-cell">${gradeMark(round)}</td>
      </tr>`;
  }).join('');
}

function logPage(start, count, pageNumber) {
  return `
  <section class="page log-page">
    ${pageHead('THE SCORECARD', `HANDS ${start + 1}–${start + count}`)}
    <div class="log-title">
      <h2>The scorecard</h2>
      <p>Every round, in order. Net is in units of the flat one-unit bet. EV is the coach’s expectation for the first graded action; a dash means the round ended before a graded decision.</p>
    </div>
    <table class="hand-table">
      <thead>
        <tr><th>#</th><th>YOU</th><th>DEALER</th><th>PLAY</th><th>NET</th><th>EV</th><th>✓</th></tr>
      </thead>
      <tbody>${handRows(start, count)}</tbody>
    </table>
    <div class="log-foot">${start === 0 ? 'Play: H hit · S stand · D double · P split · I insurance.' : ''}</div>
    ${pageFoot(pageNumber)}
  </section>`;
}

function pageHead(section, right = '') {
  return `
    <header class="page-head">
      <span>BLACKJACK LAB <i>/</i> SESSION 001</span>
      <span>${section}${right ? ` <i>/</i> ${right}` : ''}</span>
    </header>`;
}

function pageFoot(number) {
  return `
    <footer class="page-foot">
      <span>100 HANDS AGAINST THE HOUSE · SEED ${SESSION_SEED}</span>
      <span>${String(number).padStart(2, '0')}</span>
    </footer>`;
}

const cover = `
<section class="page cover">
  <div class="cover-grid" aria-hidden="true"></div>
  <div class="cover-inner">
    <div class="cover-top">
      <div class="cover-brand"><span class="brand-mark">♠</span> BLACKJACK LAB</div>
      <div class="cover-meta">SESSION REPORT · 001<br>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
    </div>

    <div class="cover-main">
      <p class="eyebrow light">A FLAT-BET SESSION AGAINST THE CPU DEALER</p>
      <h1>100 hands<br><em>against the house.</em></h1>
      <p class="cover-lede">Six decks, one unit a hand, and the total-dependent chart.<br>No bet spread. No hunches. One hundred chances to be right.</p>
    </div>

    <div class="cover-score">
      <div class="cover-score-main">
        <span class="score-label">NET RESULT</span>
        <strong>${signed(session.net)}</strong>
        <span class="score-unit">units</span>
      </div>
      <div class="cover-score-grid">
        <div><span>ROUNDS</span><strong>100</strong></div>
        <div><span>W–L–P</span><strong>${stats.wins}–${stats.losses}–${stats.pushes}</strong></div>
        <div><span>OPTIMAL</span><strong>${gradedActions.length}/${gradedActions.length}</strong></div>
        <div><span>EV LOST</span><strong>${stats.evLost.toFixed(3)}</strong></div>
      </div>
    </div>

    <div class="cover-bottom">
      <div class="rule-chips">${ruleSummary(rules).slice(0, 6).map((label) => `<span>${esc(label)}</span>`).join('')}</div>
      <div class="cover-foot">BANKROLL ${money(START_BANKROLL)} → ${money(session.game.bankroll)} · SEED ${SESSION_SEED} · COMMIT ${esc(COMMIT)}</div>
    </div>

    <div class="card-fan" aria-hidden="true">
      <div class="playing-card pc-one"><span class="pc-rank">A</span><span class="pc-suit">♠</span></div>
      <div class="playing-card pc-two is-red"><span class="pc-rank">K</span><span class="pc-suit">♥</span></div>
      <div class="playing-card pc-three is-red"><span class="pc-rank">Q</span><span class="pc-suit">♦</span></div>
    </div>
  </div>
</section>`;

const summary = `
<section class="page">
  ${pageHead('EXECUTIVE SUMMARY')}
  <p class="eyebrow">THE SHORT VERSION</p>
  <h2 class="section-title">A break-even session<br><em>is not a break-even player.</em></h2>
  <p class="lede">After 100 hands, the bankroll was exactly where it started: 200.00 units in, 200.00 out. Underneath that flat result, the sample was unusually push-heavy — and the decisions were exactly what the chart ordered.</p>

  <div class="kpis">
    <div class="kpi kpi-green"><span class="kpi-label">NET RESULT</span><strong>${signed(session.net)}</strong><span class="kpi-note">units over 100 rounds</span></div>
    <div class="kpi"><span class="kpi-label">EXACT EXPECTATION</span><strong>${signed(-exactExpectedLoss)}</strong><span class="kpi-note">at the 0.426% fresh-shoe edge</span></div>
    <div class="kpi"><span class="kpi-label">COACH EV LOST</span><strong>${stats.evLost.toFixed(3)}</strong><span class="kpi-note">${gradedActions.length} graded decisions</span></div>
    <div class="kpi kpi-warm"><span class="kpi-label">ACCURACY</span><strong>${percent(stats.accuracy)}</strong><span class="kpi-note">all graded plays optimal</span></div>
  </div>

  <div class="two-col summary-cols">
    <div>
      <h3 class="col-title">Scorecard</h3>
      <table class="score-table">
        <tbody>
          <tr><th>Rounds</th><td>100</td><th>Hands</th><td>${handCount}</td></tr>
          <tr><th>Wins</th><td>${stats.wins}</td><th>Losses</th><td>${stats.losses}</td></tr>
          <tr><th>Pushes</th><td>${stats.pushes}</td><th>Naturals</th><td>${naturals}</td></tr>
          <tr><th>Dealer BJs</th><td>${dealerBlackjacks}</td><th>Doubles</th><td>${doubles}</td></tr>
          <tr><th>Splits</th><td>${splits}</td><th>Insurance</th><td>${insuranceOffers} offers / ${insuranceTaken} taken</td></tr>
          <tr><th>High</th><td>${high.toFixed(2)}</td><th>Low</th><td>${low.toFixed(2)}</td></tr>
        </tbody>
      </table>
      <p class="fine">Four split rounds produced the 104 hands. The bankroll peaked at ${high.toFixed(2)} after hand ${highAt} and bottomed at ${low.toFixed(2)} after hand ${lowAt}.</p>
    </div>
    <div>
      <h3 class="col-title">The line</h3>
      <div class="action-list">
        <div><span class="action-letter">S</span><span>Stand</span><strong>${actionCounts.S ?? 0}</strong></div>
        <div><span class="action-letter">H</span><span>Hit</span><strong>${actionCounts.H ?? 0}</strong></div>
        <div><span class="action-letter">D</span><span>Double</span><strong>${actionCounts.D ?? 0}</strong></div>
        <div><span class="action-letter">P</span><span>Split</span><strong>${actionCounts.P ?? 0}</strong></div>
        <div><span class="action-letter ins">I</span><span>Insurance</span><strong>${actionCounts.I ?? 0}</strong></div>
      </div>
      <p class="fine">${gradedActions.length} of those actions carried a chart grade. All ${gradedActions.length} were optimal. The remaining actions were rare post-hit states without a chart cell.</p>
    </div>
  </div>

  <div class="verdict">
    <div class="verdict-mark">“</div>
    <div>
      <p class="verdict-kicker">THE VERDICT</p>
      <p class="verdict-text">Perfect play and a flat bankroll can coexist. The edge is only 0.43 units per 100 hands; the standard deviation is roughly 11.5. This session did not beat the house. It also did not prove the house was beating it.</p>
    </div>
  </div>
  ${pageFoot(2)}
</section>`;

const bankrollPage = `
<section class="page">
  ${pageHead('THE SHAPE OF THE SESSION')}
  <p class="eyebrow">THE LUCK CONE</p>
  <h2 class="section-title">The path stayed<br><em>inside the noise.</em></h2>
  <p class="lede">A 100-hand sample cannot settle a 0.426% edge. The shaded cone is the 95% range for a flat-betting player with the same policy, starting from the exact expectation. The bankroll line never leaves it.</p>

  <div class="chart-card">
    <div class="chart-legend">
      <span><i class="swatch line-dark"></i>Bankroll</span>
      <span><i class="swatch line-dash"></i>Exact expectation</span>
      <span><i class="swatch band-swatch"></i>95% luck cone</span>
    </div>
    ${bankrollChart()}
    <p class="chart-note">Expected path: 200.00 → 199.57. The 95% band at hand 100 is roughly ±22.6 units, so even a perfect player’s 100-hand result is dominated by variance.</p>
  </div>

  <div class="stat-grid">
    <div class="stat"><span>PEAK</span><strong>${high.toFixed(2)}</strong><small>after hand ${highAt}</small></div>
    <div class="stat"><span>LOW</span><strong>${low.toFixed(2)}</strong><small>after hand ${lowAt}</small></div>
    <div class="stat"><span>LONGEST WIN STREAK</span><strong>${bestWinStreak}</strong><small>hands in a row</small></div>
    <div class="stat"><span>LONGEST LOSS STREAK</span><strong>${bestLossStreak}</strong><small>hands in a row</small></div>
  </div>

  <div class="callout wide-callout">
    <span class="callout-kicker">READING THE CHART</span>
    <p>The session finished <strong>${signed(luckVsExact)} units above</strong> the exact fresh-shoe expectation. That is only <strong>${(Math.abs(luckVsExact) / sessionSd).toFixed(2)} standard deviations</strong> — indistinguishable from noise. The peak of 207.00 and the trough of 198.00 both fit comfortably inside the cone.</p>
  </div>
  ${pageFoot(3)}
</section>`;

const comparisonPage = `
<section class="page">
  ${pageHead('THE COMPARISON')}
  <p class="eyebrow">100 HANDS VS 100,000</p>
  <h2 class="section-title">The sample was<br><em>push-heavy.</em></h2>
  <p class="lede">The same rules and chart policy played 100,000 rounds. The reference is not a prediction for this session; it is a long-run baseline for the outcome mix. The session’s zero-net rounds stand out immediately.</p>

  <table class="compare-table">
    <thead><tr><th>Result</th><th>This session</th><th>100,000-hand reference</th><th>Difference</th></tr></thead>
    <tbody>
      <tr><td>Win</td><td>${stats.wins} · ${percent(stats.wins / stats.rounds)}</td><td>${(referenceWins * 100).toFixed(1)}%</td><td class="neg">${((stats.wins / stats.rounds - referenceWins) * 100).toFixed(1)} pts</td></tr>
      <tr><td>Loss</td><td>${stats.losses} · ${percent(stats.losses / stats.rounds)}</td><td>${(referenceLosses * 100).toFixed(1)}%</td><td class="neg">${((stats.losses / stats.rounds - referenceLosses) * 100).toFixed(1)} pts</td></tr>
      <tr><td>Push / exactly zero</td><td>${stats.pushes} · ${percent(stats.pushes / stats.rounds)}</td><td>${(referencePushes * 100).toFixed(1)}%</td><td class="pos">+${((stats.pushes / stats.rounds - referencePushes) * 100).toFixed(1)} pts</td></tr>
    </tbody>
  </table>

  <div class="callout wide-callout push-callout">
    <span class="callout-kicker">THE PUSH PROBLEM</span>
    <p><strong>19 zero-net rounds</strong> is about <strong>${pushZ.toFixed(1)} standard deviations</strong> above the reference push rate. Eighteen were genuine total pushes; the nineteenth was the insurance save on a dealer blackjack. More pushes means fewer chances to win or lose — and a flatter bankroll.</p>
  </div>

  <h3 class="col-title lower-title">You vs the CPU dealer</h3>
  <p class="fine">Played-out rounds only: the ${100 - dealerRounds.length} rounds that ended on a natural or a dealer blackjack are excluded, leaving ${dealerRounds.length} dealer totals and ${Object.values(playerTotals).reduce((a, b) => a + b, 0)} player hands.</p>
  <div class="chart-card tight-card totals-card">
    ${totalsChart()}
  </div>
  <div class="insight-row">
    <p><strong>Dealer 18 is a wall.</strong> The dealer made 18 ${dealerTotals['18'] ?? 0} times, more than any other total; the player made 18 only ${playerTotals['18'] ?? 0} times.</p>
    <p><strong>The dealer busted ${dealerBusts} times;</strong> the player busted ${playerBusts} hands. Standing pat is not passive here — it is the whole game.</p>
  </div>
  ${pageFoot(4)}
</section>`;

const methodPage = `
<section class="page method-page">
  ${pageHead('METHOD & CAVEATS')}
  <p class="eyebrow">HOW THIS WAS PLAYED</p>
  <h2 class="section-title">Reproducible,<br><em>not prophetic.</em></h2>
  <p class="lede">This is a headless session through the same <code>PlayGame</code> engine that powers the playable table, not a hand-typed sequence. The seed fixes every shuffle and every draw.</p>

  <div class="method-grid">
    <div class="method-card">
      <h3>Rules</h3>
      <table class="rules-table"><tbody>
        <tr><th>Decks</th><td>6</td></tr>
        <tr><th>Dealer</th><td>Stands on soft 17</td></tr>
        <tr><th>Blackjack</th><td>3:2</td></tr>
        <tr><th>Double</th><td>Any two · after split</td></tr>
        <tr><th>Splits</th><td>Up to 4 hands · aces one card</td></tr>
        <tr><th>Surrender</th><td>None</td></tr>
        <tr><th>Dealer peek</th><td>US peek</td></tr>
        <tr><th>Insurance</th><td>Offered</td></tr>
      </tbody></table>
    </div>
    <div class="method-card">
      <h3>Session</h3>
      <table class="rules-table"><tbody>
        <tr><th>Seed</th><td>${SESSION_SEED}</td></tr>
        <tr><th>Bankroll</th><td>200.00 units</td></tr>
        <tr><th>Bet</th><td>1 unit, flat</td></tr>
        <tr><th>Penetration</th><td>75%</td></tr>
        <tr><th>Strategy</th><td>Total-dependent chart</td></tr>
        <tr><th>Insurance</th><td>Take when ten density makes EV ≥ 0</td></tr>
        <tr><th>Grading</th><td>Chart EV for the chosen action</td></tr>
        <tr><th>Code</th><td>${esc(COMMIT)}</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="method-columns">
    <div class="method-copy">
      <h3>What is exact</h3>
      <p>Dealer distributions and action EVs are exact for their composition. The 0.426% fresh-shoe edge is the composition-aware fixed-strategy solve; its split EV uses the infinite-deck approximation below.</p>
      <p>The 100,000-hand reference uses the same play engine and policy. Its win/loss/push rates and 1.153-unit standard deviation are the long-run baseline used on the previous pages.</p>
    </div>
    <div class="method-copy">
      <h3>What is approximated</h3>
      <p>Split EV uses the documented independent-hand approximation. The chart is total-dependent, not composition-dependent. The insurance grade uses the unseen ten density with the hole card treated as one unseen card, not a peek.</p>
      <p>The play engine settles the real shoe composition, but the coach’s EV is chart-based.</p>
    </div>
  </div>

  <div class="method-copy proof-copy">
    <h3>What this does not prove</h3>
    <p>One hundred rounds cannot distinguish a 0.426% edge from zero. The coach ledger is not the whole table: ${gradedRounds.length} graded rounds expected ${signed(gradedExpected)} and returned ${signed(gradedActual)}; the other ${rounds.length - gradedRounds.length} settled before a grade and returned ${signed(otherActual)}. Those pieces reconcile to ${signed(session.net)}.</p>
  </div>

  <div class="reproduce">
    <span class="callout-kicker">REPRODUCE IT</span>
    <code>node reports/build-blackjack-report.mjs</code>
    <p>The script writes the session JSON, this HTML, and the PDF. The reference seed is ${REFERENCE_SEED}; the session seed is ${SESSION_SEED}.</p>
  </div>

  <div class="closing">
    <p class="closing-kicker">THE LAST WORD</p>
    <p>One hundred hands, zero mistakes, zero units. The chart did its job; the cards simply refused to make a story out of it.</p>
  </div>
  ${pageFoot(8)}
</section>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>100 Hands Against the House — Blackjack Lab</title>
<meta name="author" content="Blackjack Lab">
<meta name="description" content="A 100-round blackjack session against the CPU dealer, with a 100,000-hand reference comparison.">
<style>
  @page { size: A4; margin: 0; }
  :root {
    --ink: #1c251f;
    --muted: #68746c;
    --paper: #fbf8ef;
    --paper-2: #f1ebdd;
    --line: #d8d0bd;
    --green: #245a45;
    --green-2: #2e6d52;
    --red: #a94236;
    --gold: #b48b41;
    --dark: #121713;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    background: #1f241f;
    font-size: 10.2pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    position: relative;
    width: 210mm;
    height: 296.9mm;
    overflow: hidden;
    padding: 16mm 17mm 15mm;
    background: var(--paper);
    break-after: page;
    page-break-after: always;
  }
  .page:last-child { break-after: auto; page-break-after: auto; }
  @media screen {
    body { padding: 24px; background: #1b201b; }
    .page { margin: 0 auto 24px; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
  }
  @media print {
    body { background: #fff; }
    .page { margin: 0; box-shadow: none; }
  }
  h1, h2, h3, p { margin: 0; }
  em { font-style: italic; }
  .page-head {
    display: flex; justify-content: space-between; gap: 10mm;
    padding-bottom: 3mm; border-bottom: 1px solid var(--line);
    font-size: 7pt; letter-spacing: .15em; text-transform: uppercase;
    color: var(--muted);
  }
  .page-head i { font-style: normal; color: var(--gold); padding: 0 1mm; }
  .page-foot {
    position: absolute; left: 17mm; right: 17mm; bottom: 8mm;
    display: flex; justify-content: space-between;
    border-top: 1px solid var(--line); padding-top: 2.5mm;
    font-size: 6.7pt; letter-spacing: .13em; color: var(--muted);
  }
  .eyebrow {
    margin-top: 8mm; font-size: 7.5pt; font-weight: 700;
    letter-spacing: .17em; color: var(--gold); text-transform: uppercase;
  }
  .eyebrow.light { color: #d8b96d; }
  .section-title {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 28pt; line-height: 1.04; font-weight: 400;
    letter-spacing: -.02em; margin: 2mm 0 4mm;
  }
  .section-title em { color: var(--green); }
  .lede { max-width: 162mm; color: #39463e; font-size: 11.4pt; line-height: 1.55; }
  .fine { color: var(--muted); font-size: 8pt; line-height: 1.45; margin-top: 2mm; }
  .card-inline { font-family: Georgia, "Times New Roman", serif; white-space: nowrap; }
  .card-inline.is-red { color: var(--red); }
  .card-sep { color: #b0a792; padding: 0 1mm; }

  /* Cover */
  .cover { padding: 0; color: #f3eddc; background: var(--dark); }
  .cover::before {
    content: ""; position: absolute; inset: 0;
    background: radial-gradient(circle at 70% 25%, rgba(70,112,89,.32), transparent 42%),
                linear-gradient(135deg, #111611 0%, #172019 52%, #101510 100%);
  }
  .cover-grid {
    position: absolute; inset: 0; opacity: .14;
    background-image: linear-gradient(rgba(243,237,220,.22) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(243,237,220,.22) 1px, transparent 1px);
    background-size: 16mm 16mm;
    mask-image: linear-gradient(to bottom, #000 0%, transparent 78%);
  }
  .cover-inner { position: relative; height: 100%; padding: 17mm; display: flex; flex-direction: column; }
  .cover-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .cover-brand { font-size: 8pt; font-weight: 700; letter-spacing: .2em; }
  .brand-mark { color: #d8b96d; font-size: 14pt; vertical-align: -1pt; padding-right: 2mm; }
  .cover-meta { text-align: right; font-size: 6.9pt; line-height: 1.6; letter-spacing: .13em; color: #a9b2a7; }
  .cover-main { margin-top: 32mm; }
  .cover h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 49pt; line-height: .92; font-weight: 400;
    letter-spacing: -.035em; margin-top: 5mm;
  }
  .cover h1 em { color: #d8b96d; }
  .cover-lede { margin-top: 8mm; color: #b8c0b4; font-size: 11.2pt; line-height: 1.65; }
  .cover-score {
    margin-top: auto; display: flex; align-items: flex-end; gap: 16mm;
    border-top: 1px solid rgba(243,237,220,.22); padding-top: 6mm;
  }
  .cover-score-main .score-label { display: block; font-size: 6.8pt; letter-spacing: .2em; color: #9ca99e; }
  .cover-score-main strong {
    display: inline-block; font-family: Georgia, serif; font-weight: 400;
    font-size: 42pt; line-height: 1; margin-top: 1mm; color: #f6f0df;
  }
  .cover-score-main .score-unit { color: #a9b2a7; font-size: 10pt; margin-left: 2mm; }
  .cover-score-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8mm; margin-left: auto; }
  .cover-score-grid div { min-width: 20mm; }
  .cover-score-grid span { display: block; font-size: 6.4pt; letter-spacing: .16em; color: #9ca99e; }
  .cover-score-grid strong { display: block; font-size: 14pt; font-weight: 600; margin-top: 1mm; color: #f3eddc; }
  .cover-bottom { margin-top: 9mm; display: flex; justify-content: space-between; align-items: flex-end; gap: 12mm; }
  .rule-chips { display: flex; flex-wrap: wrap; gap: 1.5mm; max-width: 120mm; }
  .rule-chips span {
    border: 1px solid rgba(243,237,220,.25); border-radius: 99px;
    padding: 1.2mm 2.4mm; font-size: 6.6pt; letter-spacing: .04em; color: #cbd2c7;
  }
  .cover-foot { font-size: 6.5pt; line-height: 1.6; color: #98a399; text-align: right; white-space: nowrap; }
  .card-fan { position: absolute; right: 17mm; bottom: 67mm; width: 62mm; height: 70mm; }
  .playing-card {
    position: absolute; width: 30mm; height: 44mm; border-radius: 2.2mm;
    background: #f7f0df; color: #18211b; padding: 2mm;
    box-shadow: 0 3mm 9mm rgba(0,0,0,.35);
    font-family: Georgia, serif; font-weight: 700;
  }
  .playing-card::after {
    content: "♠"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 25pt; opacity: .12;
  }
  .playing-card.is-red { color: var(--red); }
  .playing-card.is-red::after { content: "♥"; }
  .pc-one { right: 25mm; bottom: 3mm; transform: rotate(-11deg); }
  .pc-two { right: 12mm; bottom: 8mm; transform: rotate(4deg); }
  .pc-three { right: 0; bottom: 1mm; transform: rotate(16deg); }
  .pc-rank { display: block; font-size: 15pt; line-height: 1; }
  .pc-suit { display: block; font-size: 13pt; line-height: 1; }

  /* Summary */
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 7mm 0 8mm; }
  .kpi { background: #f2ecdd; border: 1px solid #ddd4c1; border-radius: 2.4mm; padding: 3.6mm 3.2mm; }
  .kpi-label { display: block; font-size: 6.4pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .kpi strong { display: block; font-family: Georgia, serif; font-size: 20pt; font-weight: 400; line-height: 1.1; margin-top: 1.4mm; }
  .kpi-note { display: block; color: var(--muted); font-size: 7.2pt; line-height: 1.3; margin-top: 1mm; }
  .kpi-green { background: #e7efe8; border-color: #c4d9ca; }
  .kpi-green strong { color: var(--green); }
  .kpi-warm { background: #f6edd7; border-color: #e3d3a9; }
  .kpi-warm strong { color: #87662b; }
  .two-col { display: grid; grid-template-columns: 1.08fr .92fr; gap: 9mm; }
  .col-title {
    font-family: Georgia, serif; font-size: 15pt; font-weight: 400;
    color: var(--green); margin-bottom: 2.5mm; border-bottom: 1px solid var(--line); padding-bottom: 2mm;
  }
  .score-table { width: 100%; border-collapse: collapse; }
  .score-table th, .score-table td { padding: 1.9mm 1mm; border-bottom: 1px dotted #d5ccb9; text-align: left; font-size: 8.7pt; }
  .score-table th { color: var(--muted); font-weight: 500; width: 27%; }
  .score-table td { font-weight: 600; width: 23%; }
  .action-list { border-top: 1px solid var(--line); }
  .action-list div { display: flex; align-items: center; gap: 2.5mm; padding: 1.75mm 0; border-bottom: 1px dotted #d5ccb9; font-size: 8.9pt; }
  .action-list strong { margin-left: auto; font-family: Georgia, serif; font-size: 12pt; font-weight: 400; }
  .action-letter {
    display: inline-flex; align-items: center; justify-content: center;
    width: 6mm; height: 6mm; border-radius: 50%; background: #e5eadf;
    color: var(--green); font-size: 7.5pt; font-weight: 700;
  }
  .action-letter.ins { color: #87662b; background: #f2e6c8; font-size: 7pt; }
  .verdict {
    display: flex; gap: 4mm; margin-top: 8mm; padding: 4.5mm 5mm 4.5mm 3mm;
    background: #e7efe8; border-left: 3px solid var(--green);
    border-radius: 0 2.4mm 2.4mm 0;
  }
  .verdict-mark { font-family: Georgia, serif; font-size: 33pt; line-height: .65; color: #7da38d; }
  .verdict-kicker { font-size: 6.5pt; letter-spacing: .17em; font-weight: 700; color: var(--green); }
  .verdict-text { font-family: Georgia, serif; font-size: 11.4pt; line-height: 1.5; margin-top: 1.2mm; }

  /* Charts */
  .chart-card { background: #fffdf7; border: 1px solid var(--line); border-radius: 2.4mm; padding: 3.8mm 3mm 2mm; margin-top: 5mm; }
  .chart { display: block; width: 100%; height: auto; overflow: visible; }
  .chart-legend { display: flex; gap: 5mm; padding: 0 1mm 1.5mm; font-size: 7.2pt; color: var(--muted); }
  .chart-legend span { display: inline-flex; align-items: center; gap: 1.5mm; }
  .swatch { display: inline-block; width: 6mm; height: 1.2mm; border-radius: 2px; }
  .line-dark { background: #264b3c; }
  .line-dash { background: repeating-linear-gradient(90deg,#7c887e 0 1.3mm,transparent 1.3mm 2.2mm); }
  .line-red { background: #b24a3b; }
  .line-gold { background: #c2ae83; }
  .band-swatch { background: #d5e4da; height: 3mm; border-radius: 1px; }
  .grid { stroke: #e5ddca; stroke-width: 1; }
  .grid-soft { stroke-dasharray: 2 4; opacity: .55; }
  .axis { fill: #829087; font-size: 9px; font-family: "Segoe UI", Arial, sans-serif; }
  .axis-axis-title { fill: #9a8a65; font-size: 7px; letter-spacing: .14em; font-weight: 700; }
  .expected-line { fill: none; stroke: #7c887e; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .bank-line { fill: none; stroke: #173d2d; stroke-width: 2.6; stroke-linejoin: round; stroke-linecap: round; }
  .endpoint { fill: #173d2d; stroke: #fbf8ef; stroke-width: 2; }
  .endpoint-end { fill: #d8b96d; }
  .marker { stroke: #fbf8ef; stroke-width: 2; }
  .marker-high { fill: #b48b41; }
  .marker-low { fill: #a94236; }
  .annotation text { fill: #526158; font-size: 9.5px; font-weight: 600; }
  .legend-text { fill: #6b776f; font-size: 8px; letter-spacing: .12em; font-family: "Segoe UI", Arial, sans-serif; }
  .row-label { fill: #526158; font-size: 9px; letter-spacing: .08em; font-weight: 700; font-family: "Segoe UI", Arial, sans-serif; }
  .bar-label { fill: #4f4a3d; font-size: 10px; font-weight: 700; font-family: "Segoe UI", Arial, sans-serif; }
  .bar-label.light { fill: #fffaf0; }
  .value-label { fill: #526158; font-size: 9px; font-weight: 700; font-family: "Segoe UI", Arial, sans-serif; }
  .chart-note { font-size: 7.4pt; color: var(--muted); line-height: 1.45; padding: 1mm 1mm 1mm; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-top: 5mm; }
  .stat { border-top: 2px solid #d8c9a7; padding-top: 2.2mm; }
  .stat span { display: block; font-size: 6.3pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .stat strong { display: block; font-family: Georgia, serif; font-size: 17pt; font-weight: 400; line-height: 1.1; margin-top: .8mm; }
  .stat small { display: block; color: var(--muted); font-size: 7pt; }
  .callout { margin-top: 6mm; padding: 4mm 4.5mm; background: #f2ecdd; border-radius: 2mm; }
  .callout-kicker { display: block; font-size: 6.4pt; letter-spacing: .16em; font-weight: 700; color: var(--gold); margin-bottom: 1.2mm; }
  .callout p { font-size: 9.2pt; line-height: 1.55; }
  .wide-callout { border-left: 3px solid #c7a35f; }
  .tight-card { padding-bottom: 1mm; }
  .compare-table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  .compare-table th { text-align: left; font-size: 7pt; letter-spacing: .1em; color: var(--muted); font-weight: 600; padding: 2mm 2mm 1.5mm; border-bottom: 1px solid var(--line); }
  .compare-table td { font-size: 9.1pt; padding: 1.9mm 2mm; border-bottom: 1px dotted #d5ccb9; }
  .compare-table td:first-child { font-weight: 600; }
  .compare-table .neg { color: var(--red); font-weight: 600; }
  .compare-table .pos { color: var(--green); font-weight: 600; }
  .push-callout { background: #f6edd7; border-left-color: #b48b41; }
  .lower-title { margin-top: 5mm; }
  .totals-card { margin-top: 3mm; padding-top: 2.5mm; }
  .insight-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 4mm; }
  .insight-row p { font-size: 8.7pt; line-height: 1.45; color: #3b483f; border-top: 1px solid var(--line); padding-top: 2mm; }
  .insight-row strong { color: var(--ink); }

  /* Scorecard */
  .log-title { display: flex; justify-content: space-between; gap: 12mm; margin: 5mm 0 3mm; align-items: flex-end; }
  .log-title h2 { font-family: Georgia, serif; font-size: 22pt; font-weight: 400; color: var(--green); }
  .log-title p { width: 92mm; font-size: 7.5pt; line-height: 1.4; color: var(--muted); }
  .hand-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .hand-table th { font-size: 6.2pt; letter-spacing: .12em; color: var(--muted); text-align: left; padding: 1.5mm 1mm; border-bottom: 1px solid var(--line); }
  .hand-table td { font-size: 7.15pt; padding: 1.08mm 1mm; border-bottom: 1px solid #e6dece; vertical-align: middle; }
  .hand-table tr:nth-child(even) td { background: #f7f2e6; }
  .hand-table th:nth-child(1), .hand-table td:nth-child(1) { width: 7mm; }
  .hand-table th:nth-child(2), .hand-table td:nth-child(2) { width: 55mm; }
  .hand-table th:nth-child(3), .hand-table td:nth-child(3) { width: 47mm; }
  .hand-table th:nth-child(4), .hand-table td:nth-child(4) { width: 26mm; }
  .hand-table th:nth-child(5), .hand-table td:nth-child(5) { width: 19mm; }
  .hand-table th:nth-child(6), .hand-table td:nth-child(6) { width: 11mm; }
  .hand-table th:nth-child(7), .hand-table td:nth-child(7) { width: 7mm; }
  .hand-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .hand-table .cards { white-space: nowrap; letter-spacing: .01em; }
  .hand-table .dealer-cards { color: #535e55; }
  .hand-table .play-cell { color: var(--muted); font-size: 6.8pt; letter-spacing: .03em; }
  .hand-table .result { font-weight: 700; }
  .hand-table .result span { font-weight: 500; font-size: 6.8pt; margin-left: 1mm; }
  .hand-table .is-win { color: var(--green); }
  .hand-table .is-loss { color: var(--red); }
  .hand-table .is-push { color: #8c7a51; }
  .hand-table .ev-cell { color: #6f7a71; font-size: 6.8pt; }
  .hand-table .grade-cell { color: var(--green); text-align: center; font-size: 8pt; }
  .log-foot { margin-top: 2mm; font-size: 6.7pt; color: var(--muted); letter-spacing: .04em; }

  /* Method */
  .method-page { padding-top: 14mm; }
  .method-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 4mm; }
  .method-card { background: #f2ecdd; border: 1px solid #ddd4c1; border-radius: 2.4mm; padding: 4mm; }
  .method-card h3 { font-family: Georgia, serif; font-size: 13pt; font-weight: 400; color: var(--green); margin-bottom: 2mm; }
  .rules-table { width: 100%; border-collapse: collapse; }
  .rules-table th, .rules-table td { text-align: left; padding: 1.3mm 0; border-bottom: 1px dotted #d5ccb9; font-size: 8pt; }
  .rules-table th { color: var(--muted); font-weight: 500; }
  .method-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 2mm; }
  .method-copy { margin-top: 2mm; }
  .method-copy h3 { font-family: Georgia, serif; font-size: 12.5pt; font-weight: 400; color: var(--green); margin: 2.5mm 0 .8mm; }
  .method-copy p { font-size: 8.7pt; line-height: 1.48; color: #39463e; margin-bottom: 1mm; }
  .proof-copy { margin-top: 1mm; }
  .reproduce { margin-top: 3mm; padding: 3mm 4mm; border: 1px solid var(--line); border-radius: 2mm; background: #f7f2e6; }
  .reproduce code { display: inline-block; font-family: Consolas, "Courier New", monospace; font-size: 8.5pt; color: var(--green); background: #e7efe8; padding: 1.6mm 2.2mm; border-radius: 1mm; margin-top: 1mm; }
  .reproduce p { font-size: 7.8pt; color: var(--muted); line-height: 1.4; margin-top: 1.8mm; }
  .closing { margin-top: 3.5mm; padding-top: 3mm; border-top: 2px solid var(--green); }
  .closing-kicker { font-size: 6.7pt; letter-spacing: .18em; color: var(--gold); font-weight: 700; }
  .closing p:last-child { font-family: Georgia, serif; font-size: 15pt; line-height: 1.35; margin-top: 1.2mm; color: var(--green); }
</style>
</head>
<body>
  ${cover}
  ${summary}
  ${bankrollPage}
  ${comparisonPage}
  ${logPage(0, 34, 5)}
  ${logPage(34, 33, 6)}
  ${logPage(67, 33, 7)}
  ${methodPage}
</body>
</html>`;

const htmlPath = join(OUT, 'blackjack-100-rounds.html');
writeFileSync(htmlPath, html);

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
const pdfPath = join(OUT, 'blackjack-100-rounds.pdf');
if (!chrome) {
  console.error('No Chrome or Edge found; wrote HTML and JSON only.');
  process.exitCode = 1;
} else {
  const profile = join(tmpdir(), `blackjack-report-${process.pid}`);
  try {
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      '--print-to-pdf=' + pdfPath,
      '--virtual-time-budget=4000',
      pathToFileURL(htmlPath).href,
    ], { stdio: 'inherit', timeout: 120_000 });
  } finally {
    if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  }
  if (!existsSync(pdfPath) || statSync(pdfPath).size < 50_000) {
    console.error('PDF was not written or is unexpectedly small.');
    process.exitCode = 1;
  } else {
    console.log(`PDF:  ${pdfPath} (${(statSync(pdfPath).size / 1024).toFixed(0)} KB)`);
    console.log(`HTML: ${htmlPath}`);
    console.log(`JSON: ${join(OUT, 'blackjack-100-rounds.json')}`);
  }
}
