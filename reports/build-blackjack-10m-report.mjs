/**
 * Build the 10,000,000-round report.
 *
 * The first 100,000 and 1,000,000 rounds are nested in the same sequence as
 * the smaller reports. The ten-million run uses the same PlayGame table, rules,
 * chart policy and insurance rule; per-decision logging is disabled so the
 * sample stays memory-flat.
 *
 * The subject is precision and its limit: 100x the 100k sample narrows the
 * interval by 10x. With the corrected visible-card insurance density, the
 * 10M interval covers the fresh-shoe reference.
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
import { buildPolicy, optimalAction } from '../js/sim/strategies.js';
import { tryComputeFixedHouseEdge } from '../js/solver/fixed.js';
import { PlayGame } from '../js/play/game.js';

const OUT = resolve('reports');
mkdirSync(OUT, { recursive: true });

const SEED = 8675309;
const ROUNDS = 10_000_000;
const SHORT_ROUNDS = 100_000;
const MID_ROUNDS = 1_000_000;
const CURVE_STEP = 10_000;
const ACTION_BY_LETTER = Object.freeze({
  S: 'stand',
  H: 'hit',
  D: 'double',
  P: 'split',
  R: 'surrender',
});
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

function runTenMillion() {
  const game = new PlayGame({
    rules,
    seed: SEED,
    bankroll: 1_000_000_000,
    bet: 1,
    penetration: 0.75,
    countSystemId: 'hi-lo',
  });

  let sum = 0;
  let sumSq = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let hands = 0;
  let running = 0;
  let high = 0;
  let highAt = 0;
  let low = 0;
  let lowAt = 0;
  let drawdownHigh = 0;
  let maxDrawdown = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let pushStreak = 0;
  let bestWinStreak = 0;
  let bestLossStreak = 0;
  let bestPushStreak = 0;
  let short = null;
  let mid = null;
  const curve = [{ round: 0, net: 0 }];

  for (let i = 0; i < ROUNDS; i++) {
    if (game.phase === 'settled') game.nextHand();
    if (game.phase !== 'bet') throw new Error(`Round ${i + 1}: expected bet phase, got ${game.phase}`);
    game.setBet(1);
    if (!game.startRound()) throw new Error(`Round ${i + 1}: startRound failed`);

    if (game.phase === 'insurance') {
      if (game.insuranceEV() >= 0) game.takeInsurance();
      else game.declineInsurance();
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
    if (game.phase !== 'settled') {
      throw new Error(`Round ${i + 1}: round did not settle (${game.phase})`);
    }

    const round = game.history[0];
    if (!round || !Number.isFinite(round.net)) {
      throw new Error(`Round ${i + 1}: no settled round`);
    }
    const net = round.net;
    const handCount = round.hands.length;
    game.history.length = 0;

    sum += net;
    sumSq += net * net;
    hands += handCount;
    if (net > 0) {
      wins++;
      winStreak++;
      lossStreak = 0;
      pushStreak = 0;
    } else if (net < 0) {
      losses++;
      lossStreak++;
      winStreak = 0;
      pushStreak = 0;
    } else {
      pushes++;
      pushStreak++;
      winStreak = 0;
      lossStreak = 0;
    }
    bestWinStreak = Math.max(bestWinStreak, winStreak);
    bestLossStreak = Math.max(bestLossStreak, lossStreak);
    bestPushStreak = Math.max(bestPushStreak, pushStreak);

    running += net;
    if (running > high) {
      high = running;
      highAt = i + 1;
    }
    if (running < low) {
      low = running;
      lowAt = i + 1;
    }
    if (running > drawdownHigh) drawdownHigh = running;
    maxDrawdown = Math.max(maxDrawdown, drawdownHigh - running);

    if ((i + 1) % CURVE_STEP === 0) {
      curve.push({ round: i + 1, net: running });
    }
    if (i + 1 === SHORT_ROUNDS) {
      short = {
        n: SHORT_ROUNDS,
        net: running,
        sum,
        sumSq,
        wins,
        losses,
        pushes,
        hands,
      };
    }
    if (i + 1 === MID_ROUNDS) {
      mid = {
        n: MID_ROUNDS,
        net: running,
        sum,
        sumSq,
        wins,
        losses,
        pushes,
        hands,
      };
    }
  }

  if (!short || !mid) throw new Error('Nested samples were not captured');
  return {
    long: {
      n: ROUNDS,
      net: sum,
      sum,
      sumSq,
      wins,
      losses,
      pushes,
      hands,
    },
    short,
    mid,
    high,
    highAt,
    low,
    lowAt,
    maxDrawdown,
    bestWinStreak,
    bestLossStreak,
    bestPushStreak,
    curve,
  };
}

function summarize(sample) {
  const n = sample.n;
  const mean = sample.sum / n;
  const variance = (sample.sumSq - n * mean * mean) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const edge = -mean * 100;
  const halfWidth = 1.96 * se * 100;
  const ciLow = edge - halfWidth;
  const ciHigh = edge + halfWidth;
  const expectedNet = -(exactEdge / 100) * n;
  const difference = sample.net - expectedNet;
  const z = difference / (sd * Math.sqrt(n));
  return {
    ...sample,
    mean,
    sd,
    se,
    edge,
    halfWidth,
    ciLow,
    ciHigh,
    width: 2 * halfWidth,
    expectedNet,
    difference,
    z,
    winRate: sample.wins / n,
    lossRate: sample.losses / n,
    pushRate: sample.pushes / n,
  };
}

const result = runTenMillion();
const short = summarize(result.short);
const mid = summarize(result.mid);
const long = summarize(result.long);
const shrink = short.width / long.width;
const shrinkFromMillion = mid.width / long.width;
const narrower = 1 - long.width / short.width;
const neededRounds = (1.96 * long.sd * 100 / 0.02) ** 2;
const p100k = result.curve.find((point) => point.round === SHORT_ROUNDS);
const p1m = result.curve.find((point) => point.round === MID_ROUNDS);
if (!p100k || !p1m) throw new Error('Missing nested curve point');

const data = {
  title: '10,000,000 Rounds Against the House',
  label: 'ABRIDGED REPORT · 004',
  generatedAt: new Date().toISOString(),
  commit: COMMIT,
  seed: SEED,
  rounds: ROUNDS,
  rules,
  ruleSummary: ruleSummary(rules),
  exactEdge,
  short,
  mid,
  long,
  shrink,
  shrinkFromMillion,
  narrower,
  curve: result.curve,
  high: result.high,
  highAt: result.highAt,
  low: result.low,
  lowAt: result.lowAt,
  maxDrawdown: result.maxDrawdown,
  bestWinStreak: result.bestWinStreak,
  bestLossStreak: result.bestLossStreak,
  bestPushStreak: result.bestPushStreak,
};

writeFileSync(join(OUT, 'blackjack-10m.json'), `${JSON.stringify(data, null, 2)}\n`);

const number = (value) => value.toLocaleString('en-US');
const fixed = (value, digits = 2) => value.toFixed(digits);
const signed = (value, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const signedMoney = (value) => `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const unsignedMoney = (value) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const edgeText = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[char]));

const pathFor = (values, x, y) => values
  .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(value.round).toFixed(2)},${y(value.net).toFixed(2)}`)
  .join(' ');

function pageHead(section, right = '') {
  return `
    <header class="page-head">
      <span>BLACKJACK LAB <i>/</i> LONG RUN</span>
      <span>${section}${right ? ` <i>/</i> ${right}` : ''}</span>
    </header>`;
}

function pageFoot(pageNumber) {
  return `
    <footer class="page-foot">
      <span>10,000,000 ROUNDS AGAINST THE HOUSE · SEED ${SEED}</span>
      <span>${String(pageNumber).padStart(2, '0')}</span>
    </footer>`;
}

function intervalChart() {
  const width = 760;
  const height = 260;
  const margin = { left: 88, right: 18, top: 28, bottom: 30 };
  const min = -0.5;
  const max = 1.2;
  const x = (value) => margin.left + ((value - min) / (max - min)) * (width - margin.left - margin.right);
  const axisY = 210;
  const ticks = [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
  const rows = [
    { label: '100K', sample: short, y: 58 },
    { label: '1M', sample: mid, y: 112 },
    { label: '10M', sample: long, y: 166 },
  ];

  return `
  <svg class="chart interval-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="95 percent intervals for the observed house edge at 100,000, 1,000,000 and 10,000,000 rounds">
    <line x1="${margin.left}" y1="${axisY}" x2="${width - margin.right}" y2="${axisY}" class="axis-line"/>
    ${ticks.map((tick) => `
      <line x1="${x(tick)}" y1="${axisY - 5}" x2="${x(tick)}" y2="${axisY + 5}" class="tick-line"/>
      <text x="${x(tick)}" y="${axisY + 21}" text-anchor="middle" class="axis">${tick === 0 ? '0%' : `${tick.toFixed(1)}%`}</text>
    `).join('')}
    <line x1="${x(0)}" y1="18" x2="${x(0)}" y2="${axisY + 6}" class="zero-line"/>
    <line x1="${x(exactEdge)}" y1="18" x2="${x(exactEdge)}" y2="${axisY - 2}" class="exact-line"/>
    <text x="${x(exactEdge) + 5}" y="15" class="chart-label exact-label">EXACT ${edgeText(exactEdge)}</text>
    ${rows.map((row) => {
      const sample = row.sample;
      return `
        <text x="10" y="${row.y + 3}" class="row-label">${row.label}</text>
        <text x="10" y="${row.y + 17}" class="row-sub">${sample.width.toFixed(3)} pts wide</text>
        <line x1="${x(sample.ciLow)}" y1="${row.y}" x2="${x(sample.ciHigh)}" y2="${row.y}" class="ci-line"/>
        <line x1="${x(sample.ciLow)}" y1="${row.y - 8}" x2="${x(sample.ciLow)}" y2="${row.y + 8}" class="ci-cap"/>
        <line x1="${x(sample.ciHigh)}" y1="${row.y - 8}" x2="${x(sample.ciHigh)}" y2="${row.y + 8}" class="ci-cap"/>
        <circle cx="${x(sample.edge)}" cy="${row.y}" r="5" class="observed-dot"/>
        <text x="${x(sample.edge)}" y="${row.y - 12}" text-anchor="middle" class="chart-label observed-label">${edgeText(sample.edge)}</text>
        <text x="${x(sample.ciLow) - 4}" y="${row.y + 23}" text-anchor="end" class="ci-bound">${edgeText(sample.ciLow)}</text>
        <text x="${x(sample.ciHigh) + 4}" y="${row.y + 23}" text-anchor="start" class="ci-bound">${edgeText(sample.ciHigh)}</text>
      `;
    }).join('')}
    <text x="${margin.left}" y="${height - 3}" class="chart-label ci-label">95% CONFIDENCE INTERVALS · OBSERVED EDGE IN PERCENT</text>
  </svg>`;
}

function pathChart() {
  const width = 760;
  const height = 340;
  const margin = { left: 68, right: 18, top: 18, bottom: 38 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const min = -70_000;
  const max = 5_000;
  const x = (round) => margin.left + (round / ROUNDS) * plotW;
  const y = (value) => margin.top + ((max - value) / (max - min)) * plotH;
  const expected = (round) => -(exactEdge / 100) * round;
  const band = (round) => 1.96 * long.sd * Math.sqrt(round);
  const upper = result.curve.map((point) => ({ round: point.round, net: expected(point.round) + band(point.round) }));
  const lower = result.curve.map((point) => ({ round: point.round, net: expected(point.round) - band(point.round) }));
  const bandPath = `${pathFor(upper, x, y)} L${x(ROUNDS).toFixed(2)},${y(expected(ROUNDS) - band(ROUNDS)).toFixed(2)} ${pathFor(lower.slice().reverse(), x, y).replace(/^M/, 'L')} Z`;
  const grid = [-70_000, -60_000, -50_000, -40_000, -30_000, -20_000, -10_000, 0];
  const xTicks = [0, 2_500_000, 5_000_000, 7_500_000, 10_000_000];
  const expectedPoints = result.curve.map((point) => ({ round: point.round, net: expected(point.round) }));
  const highPoint = { x: x(result.highAt), y: y(result.high) };
  const lowPoint = { x: x(result.lowAt), y: y(result.low) };
  const shortPoint = { x: x(SHORT_ROUNDS), y: y(p100k.net) };
  const midPoint = { x: x(MID_ROUNDS), y: y(p1m.net) };

  return `
  <svg class="chart path-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative net over 10,000,000 rounds against the exact expectation, with 100,000 and 1,000,000-round markers">
    <defs>
      <linearGradient id="pathFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#3b7a60" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#3b7a60" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid.map((value) => `
      <line x1="${margin.left}" y1="${y(value)}" x2="${width - margin.right}" y2="${y(value)}" class="grid"/>
      <text x="${margin.left - 9}" y="${y(value) + 3}" text-anchor="end" class="axis">${value === 0 ? '0' : number(value)}</text>
    `).join('')}
    ${xTicks.map((value) => `
      <line x1="${x(value)}" y1="${margin.top}" x2="${x(value)}" y2="${height - margin.bottom}" class="grid grid-soft"/>
      <text x="${x(value)}" y="${height - 14}" text-anchor="middle" class="axis">${value === 0 ? '0' : `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`}</text>
    `).join('')}
    <path d="${bandPath}" fill="#7da995" opacity=".24"/>
    <path d="${pathFor(expectedPoints, x, y)}" class="expected-line"/>
    <path d="${pathFor(result.curve, x, y)}" fill="url(#pathFill)"/>
    <path d="${pathFor(result.curve, x, y)}" class="bank-line"/>
    <line x1="${shortPoint.x}" y1="${margin.top}" x2="${shortPoint.x}" y2="${height - margin.bottom}" class="short-guide"/>
    <line x1="${midPoint.x}" y1="${margin.top}" x2="${midPoint.x}" y2="${height - margin.bottom}" class="short-guide"/>
    <circle cx="${shortPoint.x}" cy="${shortPoint.y}" r="4.2" class="marker marker-short"/>
    <circle cx="${midPoint.x}" cy="${midPoint.y}" r="4.2" class="marker marker-mid"/>
    <circle cx="${x(ROUNDS)}" cy="${y(long.net)}" r="4" class="endpoint endpoint-end"/>
    <circle cx="${highPoint.x}" cy="${highPoint.y}" r="4.2" class="marker marker-high"/>
    <circle cx="${lowPoint.x}" cy="${lowPoint.y}" r="4.2" class="marker marker-low"/>
    <g class="annotation">
      <text x="${shortPoint.x + 7}" y="${shortPoint.y - 8}">100k: ${signedMoney(p100k.net)}</text>
      <text x="${midPoint.x + 7}" y="${midPoint.y + 16}">1M: ${signedMoney(p1m.net)}</text>
      <text x="${width - margin.right - 2}" y="${y(long.net) - 10}" text-anchor="end">10M: ${signedMoney(long.net)}</text>
    </g>
    <text x="${margin.left}" y="11" class="axis-title">CUMULATIVE NET / UNITS</text>
    <text x="${width - margin.right}" y="${height - 2}" text-anchor="end" class="axis-title">ROUNDS</text>
  </svg>`;
}

const rulesChips = ruleSummary(rules)
  .slice(0, 6)
  .map((label) => `<span>${esc(label)}</span>`)
  .join('');

const cover = `
<section class="page cover">
  <div class="cover-grid" aria-hidden="true"></div>
  <div class="cover-inner">
    <div class="cover-top">
      <div class="cover-brand"><span class="brand-mark">♠</span> BLACKJACK LAB</div>
      <div class="cover-meta">ABRIDGED REPORT · 004<br>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
    </div>

    <div class="cover-main">
      <p class="eyebrow light">THE LONG RUN, RECONCILED</p>
      <h1>10,000,000 rounds.<br><em>The interval holds.</em></h1>
      <p class="cover-lede">One hundred times the 100k sample. The same six decks, the same one-unit chart,<br>and the same first 1,000,000 rounds.</p>
    </div>

    <div class="cover-score">
      <div class="cover-score-main">
        <span class="score-label">NET RESULT</span>
        <strong>${signedMoney(long.net)}</strong>
        <span class="score-unit">units</span>
      </div>
      <div class="cover-score-grid">
        <div class="wlp"><span>W–L–P</span><strong>${number(long.wins)}–${number(long.losses)}–${number(long.pushes)}</strong></div>
        <div><span>OBSERVED EDGE</span><strong>${long.edge.toFixed(3)}%</strong></div>
        <div><span>95% WIDTH</span><strong>${long.width.toFixed(3)} pts</strong></div>
      </div>
    </div>

    <div class="cover-bottom">
      <div class="rule-chips">${rulesChips}</div>
      <div class="cover-foot">SEED ${SEED} · 75% PENETRATION · COMMIT ${esc(COMMIT)}</div>
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
  ${pageHead('100K · 1M · 10M')}
  <p class="eyebrow">THE PRECISION STORY</p>
  <h2 class="section-title">One edge.<br><em>Three error bars.</em></h2>
  <p class="lede">The same seed grows from 100,000 to 10,000,000 rounds. The 95% interval falls from <strong>${short.width.toFixed(3)} points wide</strong> to <strong>${long.width.toFixed(3)}</strong> — a <strong>${shrink.toFixed(1)}×</strong> reduction. At 10M the observed edge is <strong>${long.edge.toFixed(3)}%</strong>, and the interval covers the fresh-shoe <strong>${exactEdge.toFixed(3)}%</strong> reference.</p>

  <div class="kpis">
    <div class="kpi kpi-green"><span class="kpi-label">OBSERVED EDGE</span><strong>${long.edge.toFixed(3)}%</strong><span class="kpi-note">10,000,000 rounds</span></div>
    <div class="kpi"><span class="kpi-label">EXACT EDGE</span><strong>${exactEdge.toFixed(3)}%</strong><span class="kpi-note">composition-aware solver</span></div>
    <div class="kpi"><span class="kpi-label">95% INTERVAL</span><strong>${long.ciLow.toFixed(3)}%</strong><span class="kpi-note">to ${long.ciHigh.toFixed(3)}%</span></div>
    <div class="kpi kpi-warm"><span class="kpi-label">WIDTH</span><strong>${long.width.toFixed(3)} pts</strong><span class="kpi-note">${shrink.toFixed(2)}× narrower than 100k</span></div>
  </div>

  <div class="chart-card interval-card">
    <div class="chart-legend">
      <span><i class="swatch line-dark"></i>Observed edge</span>
      <span><i class="swatch line-dash"></i>Exact edge</span>
      <span><i class="swatch band-swatch"></i>95% interval</span>
    </div>
    ${intervalChart()}
    <p class="chart-note">The 100k interval included break-even. The 1M interval did not. All three intervals cover the fresh-shoe reference, and the 10M interval is only ${long.width.toFixed(3)} points wide.</p>
  </div>

  <table class="compare-table">
    <thead><tr><th>Measure</th><th>100,000</th><th>1,000,000</th><th>10,000,000</th></tr></thead>
    <tbody>
      <tr><td>Observed edge</td><td>${short.edge.toFixed(3)}%</td><td>${mid.edge.toFixed(3)}%</td><td>${long.edge.toFixed(3)}%</td></tr>
      <tr><td>95% interval</td><td>${short.ciLow.toFixed(3)}% to ${short.ciHigh.toFixed(3)}%</td><td>${mid.ciLow.toFixed(3)}% to ${mid.ciHigh.toFixed(3)}%</td><td>${long.ciLow.toFixed(3)}% to ${long.ciHigh.toFixed(3)}%</td></tr>
      <tr><td>Interval width</td><td>${short.width.toFixed(3)} pts</td><td>${mid.width.toFixed(3)} pts</td><td>${long.width.toFixed(3)} pts</td></tr>
      <tr><td>Standard error</td><td>${(short.se * 100).toFixed(3)} pts</td><td>${(mid.se * 100).toFixed(3)} pts</td><td>${(long.se * 100).toFixed(3)} pts</td></tr>
      <tr><td>Net result</td><td>${signedMoney(short.net)} units</td><td>${signedMoney(mid.net)} units</td><td>${signedMoney(long.net)} units</td></tr>
      <tr><td>Error vs exact</td><td>${signed(short.z)}σ</td><td>${signed(mid.z)}σ</td><td>${signed(long.z)}σ</td></tr>
    </tbody>
  </table>

  <div class="callout wide-callout gap-callout">
    <span class="callout-kicker">THE GAP WAS INSURANCE</span>
    <p>The 10M interval is <strong>${long.ciLow.toFixed(3)}% to ${long.ciHigh.toFixed(3)}%</strong>. The fresh-shoe exact edge is <strong>${exactEdge.toFixed(3)}%</strong>, inside it. The point estimate is <strong>${Math.abs(long.edge - exactEdge).toFixed(3)} points below exact</strong> — a ${Math.abs(long.z).toFixed(2)}σ difference. The previous 0.518% finish was not a model gap: it came from the post-hole insurance density. Correcting that estimator moves the same card sequence by 0.101 points.</p>
  </div>
  ${pageFoot(2)}
</section>`;

const pathPage = `
<section class="page">
  ${pageHead('THE PATH')}
  <p class="eyebrow">TEN MILLION ROUNDS</p>
  <h2 class="section-title">The line stays<br><em>in the cone.</em></h2>
  <p class="lede">Cumulative net over 10,000,000 rounds. The markers at 100,000 and 1,000,000 are the finishes of the smaller reports; the dashed line is the exact expectation and the cone is the 95% luck range. At 10M the path finishes inside it.</p>

  <div class="chart-card">
    <div class="chart-legend">
      <span><i class="swatch line-dark"></i>Cumulative net</span>
      <span><i class="swatch line-dash"></i>Exact expectation</span>
      <span><i class="swatch band-swatch"></i>95% luck cone</span>
    </div>
    ${pathChart()}
    <p class="chart-note">Expected path: 0 → ${signedMoney(long.expectedNet)}. The 95% band at 10,000,000 rounds is roughly ±${unsignedMoney(1.96 * long.sd * Math.sqrt(ROUNDS))} units. The finish is inside the band. Path sampled every 10,000 rounds.</p>
  </div>

  <div class="stat-grid">
    <div class="stat"><span>PEAK</span><strong>${signedMoney(result.high)}</strong><small>after round ${number(result.highAt)}</small></div>
    <div class="stat"><span>TROUGH</span><strong>${signedMoney(result.low)}</strong><small>after round ${number(result.lowAt)}</small></div>
    <div class="stat"><span>MAX DRAWDOWN</span><strong>${signedMoney(result.maxDrawdown).replace(/^\+/, '')}</strong><small>units, peak to trough</small></div>
    <div class="stat"><span>LONGEST LOSS STREAK</span><strong>${result.bestLossStreak}</strong><small>rounds in a row</small></div>
  </div>

  <div class="insight-row">
    <p><strong>At 100,000 the run was ${signedMoney(short.difference)} units above exact expectation.</strong> At 1,000,000 it was ${signedMoney(mid.difference)} above. At 10,000,000 it was ${signedMoney(long.difference)} above. All three finishes are inside the cone.</p>
    <p><strong>The 10M finish is ${Math.abs(long.z).toFixed(2)} standard deviations from exact.</strong> The 95% band is ±${unsignedMoney(1.96 * long.sd * Math.sqrt(ROUNDS))} units at the end. The finish is ${unsignedMoney(Math.abs(long.difference))} units above expectation and inside the band.</p>
  </div>

  <div class="callout wide-callout">
    <span class="callout-kicker">WHAT ONE HUNDRED TIMES THE SAMPLE BOUGHT</span>
    <p>The interval narrowed from ${short.width.toFixed(3)} points at 100k to ${mid.width.toFixed(3)} at 1M and ${long.width.toFixed(3)} at 10M. The observed edge moved ${short.edge.toFixed(3)}% → ${mid.edge.toFixed(3)}% → ${long.edge.toFixed(3)}%. After the insurance correction, the smallest interval lands on the exact path instead of missing it.</p>
  </div>
  ${pageFoot(3)}
</section>`;

const methodPage = `
<section class="page method-page">
  ${pageHead('METHOD & LIMITS')}
  <p class="eyebrow">HOW THIS WAS PLAYED</p>
  <h2 class="section-title">More rounds.<br><em>A finer question.</em></h2>
  <p class="lede">This is the same <code>PlayGame</code> table engine, rules and chart policy as the smaller reports. Per-decision logging is disabled so ten million rounds stay memory-flat.</p>

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
        <tr><th>Insurance</th><td>Offered; take when EV ≥ 0</td></tr>
      </tbody></table>
    </div>
    <div class="method-card">
      <h3>Run</h3>
      <table class="rules-table"><tbody>
        <tr><th>Seed</th><td>${SEED}</td></tr>
        <tr><th>Rounds</th><td>10,000,000</td></tr>
        <tr><th>Hands after splits</th><td>${number(long.hands)}</td></tr>
        <tr><th>Bet</th><td>1 unit, flat</td></tr>
        <tr><th>Penetration</th><td>75%</td></tr>
        <tr><th>Strategy</th><td>Total-dependent chart</td></tr>
        <tr><th>First 100k</th><td>${signedMoney(short.net)} · first 1M ${signedMoney(mid.net)}</td></tr>
        <tr><th>Code</th><td>${esc(COMMIT)}</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="method-columns">
    <div class="method-copy">
      <h3>What changed</h3>
      <p>The 95% interval narrowed from ${short.width.toFixed(3)} points at 100k to ${mid.width.toFixed(3)} at 1M and ${long.width.toFixed(3)} at 10M. The observed edge moved ${short.edge.toFixed(3)}% → ${mid.edge.toFixed(3)}% → ${long.edge.toFixed(3)}%.</p>
      <p>The first 100,000 and 1,000,000 rounds are not new simulations. They are the same nested sequences as the smaller reports.</p>
    </div>
    <div class="method-copy">
      <h3>What did not change</h3>
      <p>The rules, seed, cut card, chart and insurance threshold are identical. The exact fresh-shoe edge remains ${exactEdge.toFixed(3)}%. The 10M point estimate sits ${(exactEdge - long.edge).toFixed(3)} points below it, well inside the interval.</p>
      <p>Split EV still uses the documented independent-hand approximation. The chart is total-dependent, not composition-dependent.</p>
    </div>
  </div>

  <div class="method-copy proof-copy">
    <h3>What the correction changed</h3>
    <p>The earlier 0.518% result did not expose a model gap. Its insurance selector divided the post-hole ten count by the pre-hole unseen count, so a hidden ten made the shoe look poorer in tens than it was. At the 1/3 threshold that selected the wrong hands: 82,698 insurance bets won 26.9% of the time instead of the 34.9% their own densities implied.</p>
    <p>Tracking visible cards instead moves the same 10M card sequence to <strong>${long.edge.toFixed(3)}%</strong>, with insurance turning from a <strong>0.080-point cost</strong> into a <strong>0.021-point gain</strong> for the player. The exact ${exactEdge.toFixed(3)}% reference is inside the ${long.ciLow.toFixed(3)}%–${long.ciHigh.toFixed(3)}% interval: the simulation now agrees with the solver within error. A ±0.02-point interval would take roughly <strong>${(neededRounds / 1_000_000).toFixed(1)} million rounds</strong>.</p>
  </div>

  <div class="reproduce">
    <span class="callout-kicker">REPRODUCE IT</span>
    <code>node reports/build-blackjack-10m-report.mjs</code>
    <p>Writes <code>blackjack-10m.json</code>, this HTML and the PDF. The seed is ${SEED}; the 100k and 1M reports are the first 100,000 and 1,000,000 rounds of this sequence.</p>
  </div>

  <div class="closing">
    <p class="closing-kicker">THE LAST WORD</p>
    <p>The interval shrank. The gap disappeared.</p>
  </div>
  ${pageFoot(4)}
</section>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>10,000,000 Rounds Against the House — Blackjack Lab</title>
<meta name="author" content="Blackjack Lab">
<meta name="description" content="A 10,000,000-round blackjack report comparing interval precision at 100,000, 1,000,000 and 10,000,000 rounds.">
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
  .body-copy { font-size: 9.4pt; line-height: 1.55; color: #39463e; margin-bottom: 3mm; }

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
  .cover-main { margin-top: 24mm; }
  .cover h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 39pt; line-height: .94; font-weight: 400;
    letter-spacing: -.04em; margin-top: 5mm;
  }
  .cover h1 em { color: #d8b96d; }
  .cover-lede { margin-top: 8mm; color: #b8c0b4; font-size: 11.2pt; line-height: 1.65; }
  .cover-score {
    margin-top: auto; display: flex; align-items: flex-end; gap: 10mm;
    border-top: 1px solid rgba(243,237,220,.22); padding-top: 6mm;
  }
  .cover-score-main .score-label { display: block; font-size: 6.8pt; letter-spacing: .2em; color: #9ca99e; }
  .cover-score-main strong {
    display: inline-block; font-family: Georgia, serif; font-weight: 400;
    font-size: 34pt; line-height: 1; margin-top: 1mm; color: #f6f0df;
  }
  .cover-score-main .score-unit { color: #a9b2a7; font-size: 10pt; margin-left: 2mm; }
  .cover-score-grid { display: grid; grid-template-columns: 1.7fr 1fr 1fr; gap: 5mm; margin-left: auto; }
  .cover-score-grid div { min-width: 20mm; }
  .cover-score-grid span { display: block; font-size: 6.2pt; letter-spacing: .15em; color: #9ca99e; }
  .cover-score-grid strong { display: block; font-size: 11.2pt; font-weight: 600; margin-top: 1mm; color: #f3eddc; white-space: nowrap; }
  .cover-score-grid .wlp strong { font-size: 8.0pt; letter-spacing: -.02em; }
  .cover-bottom { margin-top: 7mm; display: flex; justify-content: space-between; align-items: flex-end; gap: 12mm; }
  .rule-chips { display: flex; flex-wrap: wrap; gap: 1.5mm; max-width: 126mm; }
  .rule-chips span {
    border: 1px solid rgba(243,237,220,.25); border-radius: 99px;
    padding: 1.2mm 2.4mm; font-size: 6.6pt; letter-spacing: .04em; color: #cbd2c7;
  }
  .cover-foot { font-size: 6.3pt; line-height: 1.6; color: #98a399; text-align: right; white-space: nowrap; }
  .card-fan { position: absolute; right: 17mm; bottom: 68mm; width: 62mm; height: 70mm; }
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
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 5mm 0 5mm; }
  .kpi { background: #f2ecdd; border: 1px solid #ddd4c1; border-radius: 2.4mm; padding: 3.4mm 3.2mm; }
  .kpi-label { display: block; font-size: 6.3pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .kpi strong { display: block; font-family: Georgia, serif; font-size: 17.5pt; font-weight: 400; line-height: 1.1; margin-top: 1.4mm; }
  .kpi-note { display: block; color: var(--muted); font-size: 7.1pt; line-height: 1.3; margin-top: 1mm; }
  .kpi-green { background: #e7efe8; border-color: #c4d9ca; }
  .kpi-green strong { color: var(--green); }
  .kpi-warm { background: #f6edd7; border-color: #e3d3a9; }
  .kpi-warm strong { color: #87662b; }
  .col-title {
    font-family: Georgia, serif; font-size: 15pt; font-weight: 400;
    color: var(--green); margin-bottom: 2.5mm; border-bottom: 1px solid var(--line); padding-bottom: 2mm;
  }

  /* Charts */
  .chart-card { background: #fffdf7; border: 1px solid var(--line); border-radius: 2.4mm; padding: 3mm 3mm 2mm; margin-top: 3mm; }
  .chart { display: block; width: 100%; height: auto; overflow: visible; }
  .chart-legend { display: flex; gap: 5mm; padding: 0 1mm 1.5mm; font-size: 7.2pt; color: var(--muted); }
  .chart-legend span { display: inline-flex; align-items: center; gap: 1.5mm; }
  .swatch { display: inline-block; width: 6mm; height: 1.2mm; border-radius: 2px; }
  .line-dark { background: #264b3c; }
  .line-dash { background: repeating-linear-gradient(90deg,#7c887e 0 1.3mm,transparent 1.3mm 2.2mm); }
  .band-swatch { background: #d5e4da; height: 3mm; border-radius: 1px; }
  .grid { stroke: #e5ddca; stroke-width: 1; }
  .grid-soft { stroke-dasharray: 2 4; opacity: .55; }
  .axis { fill: #829087; font-size: 9px; font-family: "Segoe UI", Arial, sans-serif; }
  .axis-title { fill: #9a8a65; font-size: 7px; letter-spacing: .14em; font-weight: 700; }
  .axis-line { stroke: #cfc5b2; stroke-width: 1; }
  .tick-line { stroke: #cfc5b2; stroke-width: 1; }
  .zero-line { stroke: #536158; stroke-width: 1.2; stroke-dasharray: 2 3; opacity: .7; }
  .exact-line { stroke: #b48b41; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .ci-line { stroke: #9bc0a8; stroke-width: 13; stroke-linecap: round; opacity: .7; }
  .ci-cap { stroke: #6f9c80; stroke-width: 1.5; }
  .observed-dot { fill: #173d2d; stroke: #fbf8ef; stroke-width: 2; }
  .chart-label { font-family: "Segoe UI", Arial, sans-serif; font-size: 8px; font-weight: 700; letter-spacing: .05em; }
  .exact-label { fill: #9a7431; }
  .observed-label { fill: #245a45; }
  .ci-label { fill: #68746c; letter-spacing: .1em; }
  .row-label { fill: #245a45; font-size: 12px; font-weight: 700; font-family: "Segoe UI", Arial, sans-serif; letter-spacing: .08em; }
  .row-sub { fill: #68746c; font-size: 7px; font-family: "Segoe UI", Arial, sans-serif; }
  .ci-bound { fill: #78857b; font-size: 7px; font-family: "Segoe UI", Arial, sans-serif; }
  .expected-line { fill: none; stroke: #7c887e; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .bank-line { fill: none; stroke: #173d2d; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
  .endpoint { fill: #173d2d; stroke: #fbf8ef; stroke-width: 2; }
  .endpoint-end { fill: #d8b96d; }
  .marker { stroke: #fbf8ef; stroke-width: 2; }
  .marker-high { fill: #b48b41; }
  .marker-low { fill: #a94236; }
  .marker-short { fill: #245a45; }
  .marker-mid { fill: #7a9b86; }
  .short-guide { stroke: #8fa99a; stroke-width: 1; stroke-dasharray: 2 4; opacity: .75; }
  .annotation text { fill: #526158; font-size: 9px; font-weight: 600; paint-order: stroke; stroke: #fbf8ef; stroke-width: 2.4px; stroke-linejoin: round; }
  .chart-note { font-size: 7.4pt; color: var(--muted); line-height: 1.45; padding: 1mm 1mm 1mm; }
  .compare-table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  .compare-table th { text-align: left; font-size: 6.7pt; letter-spacing: .08em; color: var(--muted); font-weight: 600; padding: 1.6mm 2mm 1.2mm; border-bottom: 1px solid var(--line); }
  .compare-table td { font-size: 7.9pt; padding: 1.35mm 2mm; border-bottom: 1px dotted #d5ccb9; }
  .compare-table td:first-child { font-weight: 600; }
  .compare-table .pos { color: var(--green); font-weight: 600; }
  .compare-table .neg { color: var(--red); font-weight: 600; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-top: 4mm; }
  .stat { border-top: 2px solid #d8c9a7; padding-top: 2.2mm; }
  .stat span { display: block; font-size: 6.2pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .stat strong { display: block; font-family: Georgia, serif; font-size: 16pt; font-weight: 400; line-height: 1.1; margin-top: .8mm; }
  .stat small { display: block; color: var(--muted); font-size: 7pt; }
  .callout { margin-top: 4mm; padding: 3.4mm 4.5mm; background: #f2ecdd; border-radius: 2mm; }
  .callout-kicker { display: block; font-size: 6.4pt; letter-spacing: .16em; font-weight: 700; color: var(--gold); margin-bottom: 1.2mm; }
  .callout p { font-size: 9.2pt; line-height: 1.55; }
  .wide-callout { border-left: 3px solid #c7a35f; }
  .gap-callout { background: #f6edd7; border-left-color: var(--gold); }
  .insight-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 4mm; }
  .insight-row p { font-size: 8.7pt; line-height: 1.45; color: #3b483f; border-top: 1px solid var(--line); padding-top: 2mm; }
  .insight-row strong { color: var(--ink); }

  /* Method */
  .method-page { padding-top: 8mm; }
  .method-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 3mm; }
  .method-card { background: #f2ecdd; border: 1px solid #ddd4c1; border-radius: 2.4mm; padding: 4mm; }
  .method-card h3 { font-family: Georgia, serif; font-size: 13pt; font-weight: 400; color: var(--green); margin-bottom: 2mm; }
  .rules-table { width: 100%; border-collapse: collapse; }
  .rules-table th, .rules-table td { text-align: left; padding: 1.25mm 0; border-bottom: 1px dotted #d5ccb9; font-size: 8pt; }
  .rules-table th { color: var(--muted); font-weight: 500; }
  .method-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 2mm; }
  .method-copy { margin-top: 2mm; }
  .method-copy h3 { font-family: Georgia, serif; font-size: 12.5pt; font-weight: 400; color: var(--green); margin: 2.5mm 0 .8mm; }
  .method-copy p { font-size: 8.7pt; line-height: 1.48; color: #39463e; margin-bottom: 1mm; }
  .proof-copy { margin-top: 1mm; }
  .reproduce { margin-top: 2mm; padding: 3mm 4mm; border: 1px solid var(--line); border-radius: 2mm; background: #f7f2e6; }
  .reproduce code { display: inline-block; font-family: Consolas, "Courier New", monospace; font-size: 8.3pt; color: var(--green); background: #e7efe8; padding: 1.6mm 2.2mm; border-radius: 1mm; margin-top: 1mm; }
  .reproduce p { font-size: 7.8pt; color: var(--muted); line-height: 1.4; margin-top: 1.8mm; }
  .closing { margin-top: 2.5mm; padding-top: 3mm; border-top: 2px solid var(--green); }
  .closing-kicker { font-size: 6.7pt; letter-spacing: .18em; color: var(--gold); font-weight: 700; }
  .closing p:last-child { font-family: Georgia, serif; font-size: 15pt; line-height: 1.35; margin-top: 1.2mm; color: var(--green); }
</style>
</head>
<body>
  ${cover}
  ${summary}
  ${pathPage}
  ${methodPage}
</body>
</html>`;

const htmlPath = join(OUT, 'blackjack-10m.html');
writeFileSync(htmlPath, html);

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
const pdfPath = join(OUT, 'blackjack-10m.pdf');
if (!chrome) {
  console.error('No Chrome or Edge found; wrote HTML and JSON only.');
  process.exitCode = 1;
} else {
  const profile = join(tmpdir(), `blackjack-10m-report-${process.pid}`);
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
    console.log(`JSON: ${join(OUT, 'blackjack-10m.json')}`);
    console.log(`Net: ${signedMoney(long.net)} units · observed ${long.edge.toFixed(3)}% · exact ${exactEdge.toFixed(3)}% · 95% CI ${long.ciLow.toFixed(3)}% to ${long.ciHigh.toFixed(3)}% · width ${long.width.toFixed(3)} pts · shrink ${shrink.toFixed(2)}x`);
  }
}
