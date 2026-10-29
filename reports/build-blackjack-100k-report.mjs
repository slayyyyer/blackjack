/**
 * Build the abridged 100,000-round blackjack report.
 *
 * This is the long-run companion to the 100-hand session report. It runs the
 * same PlayGame engine, rules, seedable shoe, chart policy and grading as the
 * browser table, but keeps only the aggregate evidence and a sampled bankroll
 * curve. The PDF is printed from local HTML with Chrome, just like the session
 * report.
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

const SEED = 8675309;
const ROUNDS = 100_000;
const CURVE_STEP = 100;
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

const run = playRounds({
  rules,
  chart,
  policy,
  seed: SEED,
  rounds: ROUNDS,
  bankroll: 1_000_000_000,
  betRamp: 1,
  penetration: 0.75,
});

const ordered = run.game.history.slice().reverse();
const nets = ordered.map((round) => round.net);
if (nets.length !== ROUNDS) {
  throw new Error(`Expected ${ROUNDS} rounds, got ${nets.length}`);
}

const net = nets.reduce((sum, value) => sum + value, 0);
const mean = net / ROUNDS;
const variance = nets.reduce((sum, value) => sum + (value - mean) ** 2, 0)
  / Math.max(1, ROUNDS - 1);
const sd = Math.sqrt(variance);
const se = sd / Math.sqrt(ROUNDS);
const observedEdge = -mean * 100;
const edgeHalf = 1.96 * se * 100;
const ciLow = observedEdge - edgeHalf;
const ciHigh = observedEdge + edgeHalf;
const exactEdge = exact.houseEdge;
const expectedNet = -(exactEdge / 100) * ROUNDS;
const difference = net - expectedNet;
const z = difference / (sd * Math.sqrt(ROUNDS));

const wins = run.stats.wins;
const losses = run.stats.losses;
const pushes = run.stats.pushes;
const winRate = wins / ROUNDS;
const lossRate = losses / ROUNDS;
const pushRate = pushes / ROUNDS;

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
const curve = [{ round: 0, net: 0 }];

for (let i = 0; i < nets.length; i++) {
  const value = nets[i];
  running += value;

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

  if (value > 0) {
    winStreak++;
    lossStreak = 0;
    pushStreak = 0;
  } else if (value < 0) {
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

  if ((i + 1) % CURVE_STEP === 0 || i + 1 === ROUNDS) {
    curve.push({ round: i + 1, net: running });
  }
}

const data = {
  title: '100,000 Rounds Against the House',
  label: 'ABRIDGED REPORT · 002',
  generatedAt: new Date().toISOString(),
  commit: COMMIT,
  seed: SEED,
  rounds: ROUNDS,
  hands: run.stats.hands,
  decisions: run.stats.decisions,
  correct: run.stats.correct,
  accuracy: run.stats.accuracy,
  evLost: run.stats.evLost,
  rules,
  ruleSummary: ruleSummary(rules),
  net,
  mean,
  sd,
  se,
  exactEdge,
  observedEdge,
  edgeHalf,
  ciLow,
  ciHigh,
  expectedNet,
  difference,
  z,
  wins,
  losses,
  pushes,
  winRate,
  lossRate,
  pushRate,
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

writeFileSync(join(OUT, 'blackjack-100k.json'), `${JSON.stringify(data, null, 2)}\n`);

const number = (value) => value.toLocaleString('en-US');
const fixed = (value, digits = 2) => value.toFixed(digits);
const signed = (value, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
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
      <span>100,000 ROUNDS AGAINST THE HOUSE · SEED ${SEED}</span>
      <span>${String(pageNumber).padStart(2, '0')}</span>
    </footer>`;
}

function edgeIntervalChart() {
  const width = 760;
  const height = 154;
  const margin = { left: 16, right: 16, top: 20, bottom: 30 };
  const min = -0.5;
  const max = 1.2;
  const x = (value) => margin.left + ((value - min) / (max - min)) * (width - margin.left - margin.right);
  const axisY = 96;
  const ticks = [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
  return `
  <svg class="chart edge-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="95 percent confidence interval for the observed house edge compared with the exact edge">
    <line x1="${margin.left}" y1="${axisY}" x2="${width - margin.right}" y2="${axisY}" class="axis-line"/>
    ${ticks.map((tick) => `
      <line x1="${x(tick)}" y1="${axisY - 5}" x2="${x(tick)}" y2="${axisY + 5}" class="tick-line"/>
      <text x="${x(tick)}" y="${axisY + 21}" text-anchor="middle" class="axis">${tick === 0 ? '0%' : `${tick.toFixed(1)}%`}</text>
    `).join('')}
    <line x1="${x(0)}" y1="30" x2="${x(0)}" y2="${axisY + 6}" class="zero-line"/>
    <line x1="${x(ciLow)}" y1="${axisY - 16}" x2="${x(ciHigh)}" y2="${axisY - 16}" class="ci-line"/>
    <line x1="${x(ciLow)}" y1="${axisY - 24}" x2="${x(ciLow)}" y2="${axisY - 8}" class="ci-cap"/>
    <line x1="${x(ciHigh)}" y1="${axisY - 24}" x2="${x(ciHigh)}" y2="${axisY - 8}" class="ci-cap"/>
    <circle cx="${x(observedEdge)}" cy="${axisY - 16}" r="5.2" class="observed-dot"/>
    <line x1="${x(exactEdge)}" y1="20" x2="${x(exactEdge)}" y2="${axisY - 4}" class="exact-line"/>
    <text x="${x(exactEdge) + 5}" y="18" class="chart-label exact-label">EXACT ${edgeText(exactEdge)}</text>
    <text x="${x(observedEdge)}" y="63" text-anchor="middle" class="chart-label observed-label">OBSERVED ${edgeText(observedEdge)}</text>
    <text x="${margin.left}" y="${height - 3}" class="chart-label ci-label">95% CONFIDENCE INTERVAL FOR THE OBSERVED EDGE: ${edgeText(ciLow)} TO ${edgeText(ciHigh)}</text>
  </svg>`;
}

function bankrollChart() {
  const width = 760;
  const height = 340;
  const margin = { left: 58, right: 18, top: 18, bottom: 38 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const min = -1200;
  const max = 400;
  const x = (round) => margin.left + (round / ROUNDS) * plotW;
  const y = (value) => margin.top + ((max - value) / (max - min)) * plotH;
  const expected = (round) => -(exactEdge / 100) * round;
  const band = (round) => 1.96 * sd * Math.sqrt(round);
  const upper = curve.map((point) => ({ round: point.round, net: expected(point.round) + band(point.round) }));
  const lower = curve.map((point) => ({ round: point.round, net: expected(point.round) - band(point.round) }));
  const bandPath = `${pathFor(upper, x, y)} L${x(ROUNDS).toFixed(2)},${y(expected(ROUNDS) - band(ROUNDS)).toFixed(2)} ${pathFor(lower.slice().reverse(), x, y).replace(/^M/, 'L')} Z`;
  const grid = [-1200, -1000, -800, -600, -400, -200, 0, 200, 400];
  const xTicks = [0, 25_000, 50_000, 75_000, 100_000];
  const expectedPoints = curve.map((point) => ({ round: point.round, net: expected(point.round) }));
  const highPoint = { x: x(highAt), y: y(high), value: high };
  const lowPoint = { x: x(lowAt), y: y(low), value: low };
  return `
  <svg class="chart path-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative net over 100,000 rounds against the exact expectation and a 95 percent luck cone">
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
      <text x="${x(value)}" y="${height - 14}" text-anchor="middle" class="axis">${value === 0 ? '0' : `${value / 1000}k`}</text>
    `).join('')}
    <path d="${bandPath}" fill="#7da995" opacity=".24"/>
    <path d="${pathFor(expectedPoints, x, y)}" class="expected-line"/>
    <path d="${pathFor(curve, x, y)}" fill="url(#pathFill)"/>
    <path d="${pathFor(curve, x, y)}" class="bank-line"/>
    <circle cx="${x(0)}" cy="${y(0)}" r="4" class="endpoint"/>
    <circle cx="${x(ROUNDS)}" cy="${y(net)}" r="4" class="endpoint endpoint-end"/>
    <circle cx="${highPoint.x}" cy="${highPoint.y}" r="4.2" class="marker marker-high"/>
    <circle cx="${lowPoint.x}" cy="${lowPoint.y}" r="4.2" class="marker marker-low"/>
    <g class="annotation">
      <text x="${highPoint.x + 7}" y="${highPoint.y - 8}">+${fixed(high)} · after ${number(highAt)}</text>
      <text x="${lowPoint.x - 7}" y="${lowPoint.y + 17}" text-anchor="end">${fixed(low)} · after ${number(lowAt)}</text>
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
      <div class="cover-meta">ABRIDGED REPORT · 002<br>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
    </div>

    <div class="cover-main">
      <p class="eyebrow light">THE LONG RUN AGAINST THE CPU DEALER</p>
      <h1>100,000 rounds.<br><em>Still noise.</em></h1>
      <p class="cover-lede">Six decks, one unit a hand, and the total-dependent chart.<br>The same engine as Session 001, played 1,000 times longer.</p>
    </div>

    <div class="cover-score">
      <div class="cover-score-main">
        <span class="score-label">NET RESULT</span>
        <strong>${signed(net)}</strong>
        <span class="score-unit">units</span>
      </div>
      <div class="cover-score-grid">
        <div class="wlp"><span>W–L–P</span><strong>${number(wins)}–${number(losses)}–${number(pushes)}</strong></div>
        <div><span>OBSERVED EDGE</span><strong>${observedEdge.toFixed(3)}%</strong></div>
        <div><span>EXACT EDGE</span><strong>${exactEdge.toFixed(3)}%</strong></div>
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
  ${pageHead('EXECUTIVE SUMMARY')}
  <p class="eyebrow">THE SHORT VERSION</p>
  <h2 class="section-title">The long run is<br><em>still noisy.</em></h2>
  <p class="lede">After 100,000 rounds the chart was ${net < 0 ? `down ${number(Math.abs(net))}` : `up ${number(net)}`} units. The exact solver expected a loss of ${Math.abs(expectedNet).toFixed(2)} units. The sample finished ${Math.abs(difference).toFixed(2)} units ${difference >= 0 ? 'better' : 'worse'} than expectation — about ${Math.abs(z).toFixed(2)} standard deviations. That is ordinary luck, not evidence that the chart is wrong.</p>

  <div class="kpis">
    <div class="kpi kpi-green"><span class="kpi-label">NET RESULT</span><strong>${signed(net)}</strong><span class="kpi-note">units over 100,000 rounds</span></div>
    <div class="kpi"><span class="kpi-label">OBSERVED EDGE</span><strong>${observedEdge.toFixed(3)}%</strong><span class="kpi-note">against the player</span></div>
    <div class="kpi"><span class="kpi-label">EXACT EDGE</span><strong>${exactEdge.toFixed(3)}%</strong><span class="kpi-note">composition-aware solver</span></div>
    <div class="kpi kpi-warm"><span class="kpi-label">95% INTERVAL</span><strong>${ciLow.toFixed(2)}%</strong><span class="kpi-note">to ${ciHigh.toFixed(2)}%</span></div>
  </div>

  <div class="two-col summary-cols">
    <div>
      <h3 class="col-title">The run</h3>
      <table class="score-table">
        <tbody>
          <tr><th>Rounds</th><td>100,000</td><th>Hands after splits</th><td>${number(data.hands)}</td></tr>
          <tr><th>Wins</th><td>${number(wins)} · ${percent(winRate)}</td><th>Losses</th><td>${number(losses)} · ${percent(lossRate)}</td></tr>
          <tr><th>Pushes</th><td>${number(pushes)} · ${percent(pushRate)}</td><th>Graded actions</th><td>${number(data.decisions)}</td></tr>
          <tr><th>Net per round</th><td>${fixed(mean, 5)} units</td><th>SD per round</th><td>${sd.toFixed(3)} units</td></tr>
          <tr><th>Expected net</th><td>${signed(expectedNet)} units</td><th>Net vs exact</th><td>${signed(difference)} units</td></tr>
        </tbody>
      </table>
      <p class="fine">The reference seed is ${SEED}. A round includes all split hands; the 100,000 rounds became ${number(data.hands)} settled hands.</p>
    </div>
    <div>
      <h3 class="col-title">Read the interval</h3>
      <p class="body-copy">The standard error of the observed edge is <strong>${(edgeHalf / 1.96).toFixed(3)} percentage points</strong>. The 95% interval runs from <strong>${ciLow.toFixed(3)}%</strong> to <strong>${ciHigh.toFixed(3)}%</strong>.</p>
      <p class="body-copy">The exact ${exactEdge.toFixed(3)}% edge is inside that interval. So is break-even. The result is consistent with both a tiny player edge and a house edge above 1%.</p>
      <div class="verdict compact-verdict">
        <div class="verdict-mark">“</div>
        <div>
          <p class="verdict-kicker">THE POINT</p>
          <p class="verdict-text">100,000 rounds is enough to measure the engine. It is not enough to measure a 0.4% edge.</p>
        </div>
      </div>
    </div>
  </div>

  <div class="chart-card edge-card">
    <div class="chart-legend">
      <span><i class="swatch line-dark"></i>Observed edge</span>
      <span><i class="swatch line-dash"></i>Exact edge</span>
      <span><i class="swatch band-swatch"></i>95% interval</span>
    </div>
    ${edgeIntervalChart()}
    <p class="chart-note">A 95% confidence interval is a statement about the method, not a promise about this run. The interval is wide because one round can swing more than a full bet.</p>
  </div>

  <div class="callout wide-callout">
    <span class="callout-kicker">WHY THE MISS IS SMALL</span>
    <p>The gap between the observed and exact edge is <strong>${Math.abs(observedEdge - exactEdge).toFixed(3)} percentage points</strong>. The standard error alone is <strong>${(edgeHalf / 1.96).toFixed(3)} points</strong>. The simulation did not fail to find the edge; it found a sample whose center is very close and whose error bar is wider than the effect.</p>
  </div>
  ${pageFoot(2)}
</section>`;

const pathPage = `
<section class="page">
  ${pageHead('THE PATH')}
  <p class="eyebrow">THE LUCK CONE</p>
  <h2 class="section-title">${net < 0 ? 'Down' : 'Up'} ${number(Math.abs(net))} units.<br><em>Well inside the cone.</em></h2>
  <p class="lede">Cumulative net over 100,000 rounds. The dashed line is the exact expectation; the shaded cone is the 95% range for a flat-betting player with the same policy.</p>

  <div class="chart-card">
    <div class="chart-legend">
      <span><i class="swatch line-dark"></i>Cumulative net</span>
      <span><i class="swatch line-dash"></i>Exact expectation</span>
      <span><i class="swatch band-swatch"></i>95% luck cone</span>
    </div>
    ${bankrollChart()}
    <p class="chart-note">Expected path: 0 → ${signed(expectedNet)}. The 95% band at round 100,000 is roughly ±${fixed(1.96 * sd * Math.sqrt(ROUNDS))} units. The observed path ends ${signed(difference)} units above expectation.</p>
  </div>

  <div class="stat-grid">
    <div class="stat"><span>PEAK</span><strong>${signed(high)}</strong><small>after round ${number(highAt)}</small></div>
    <div class="stat"><span>TROUGH</span><strong>${signed(low)}</strong><small>after round ${number(lowAt)}</small></div>
    <div class="stat"><span>MAX DRAWDOWN</span><strong>${fixed(maxDrawdown)}</strong><small>units, peak to trough</small></div>
    <div class="stat"><span>LONGEST LOSS STREAK</span><strong>${bestLossStreak}</strong><small>rounds in a row</small></div>
  </div>

  <div class="insight-row">
    <p><strong>The path peaked at ${signed(high)}</strong> after round ${number(highAt)}, then spent most of the run below zero. Its lowest point was ${fixed(low)} at round ${number(lowAt)}.</p>
    <p><strong>The final result is ${Math.abs(z).toFixed(2)} standard deviations</strong> ${z >= 0 ? 'above' : 'below'} the exact expectation. The cone is ${fixed(1.96 * sd * Math.sqrt(ROUNDS))} units wide at the end. A flat 100,000-round result is supposed to look like this.</p>
  </div>

  <div class="callout wide-callout">
    <span class="callout-kicker">THE HOUSE EDGE IS AVERAGE, NOT A TREND</span>
    <p>Blackjack does not lose a little on every round. The player wins ${number(wins)} rounds, loses ${number(losses)} and pushes ${number(pushes)}. Naturals pay 3:2, and doubles and splits change the size of the bet. The ${exactEdge.toFixed(3)}% edge is the average of all those outcomes, not a line the bankroll follows.</p>
  </div>
  ${pageFoot(3)}
</section>`;

const methodPage = `
<section class="page method-page">
  ${pageHead('METHOD & LIMITS')}
  <p class="eyebrow">HOW THIS WAS PLAYED</p>
  <h2 class="section-title">Reproducible.<br><em>Not proof.</em></h2>
  <p class="lede">This is a headless run through the same <code>PlayGame</code> engine that powers the browser table, not a hand-typed sequence. The seed fixes every shuffle and every draw.</p>

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
      <h3>Run</h3>
      <table class="rules-table"><tbody>
        <tr><th>Seed</th><td>${SEED}</td></tr>
        <tr><th>Rounds</th><td>100,000</td></tr>
        <tr><th>Hands after splits</th><td>${number(data.hands)}</td></tr>
        <tr><th>Bet</th><td>1 unit, flat</td></tr>
        <tr><th>Penetration</th><td>75%</td></tr>
        <tr><th>Strategy</th><td>Total-dependent chart</td></tr>
        <tr><th>Grading</th><td>${number(data.decisions)} decisions · ${percent(data.accuracy, 2)} on-chart</td></tr>
        <tr><th>Code</th><td>${esc(COMMIT)}</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="method-columns">
    <div class="method-copy">
      <h3>What is exact</h3>
      <p>Dealer distributions and action EVs are exact for their composition. The ${exactEdge.toFixed(3)}% fresh-shoe edge is the composition-aware fixed-strategy solve; its split EV uses the documented independent-hand approximation.</p>
      <p>The simulation deals from the real six-deck shoe with a 75% cut card. It settles splits, doubles, insurance and dealer peeks with the same rules the table uses.</p>
    </div>
    <div class="method-copy">
      <h3>What is approximated</h3>
      <p>Split EV uses the independent-hand approximation. The chart is total-dependent, not composition-dependent. The insurance grade treats the hole card as one unseen card rather than a peek.</p>
      <p>The play harness matched the chart on ${percent(data.accuracy, 2)} of decisions. The ${number(data.decisions - data.correct)} exceptions are rare post-hit or legal-action states; their combined EV cost was ${data.evLost.toFixed(2)} units over the run.</p>
    </div>
  </div>

  <div class="method-copy proof-copy">
    <h3>What this does not prove</h3>
    <p>One hundred thousand rounds cannot pin a sub-1% edge to three decimals. The 95% interval on the observed edge spans ${ciLow.toFixed(2)}% to ${ciHigh.toFixed(2)}%, so this sample is consistent with break-even and with a house edge above 1%. The exact solver is the source of the ${exactEdge.toFixed(3)}% number; the simulation is a consistency check, not a replacement.</p>
  </div>

  <div class="reproduce">
    <span class="callout-kicker">REPRODUCE IT</span>
    <code>node reports/build-blackjack-100k-report.mjs</code>
    <p>Writes <code>blackjack-100k.json</code>, this HTML and the PDF. The reference seed is ${SEED}; the 100-round session seed is 20261029.</p>
  </div>

  <div class="closing">
    <p class="closing-kicker">THE LAST WORD</p>
    <p>The edge is real. The sample is still mostly a story about variance.</p>
  </div>
  ${pageFoot(4)}
</section>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>100,000 Rounds Against the House — Blackjack Lab</title>
<meta name="author" content="Blackjack Lab">
<meta name="description" content="An abridged 100,000-round blackjack report with the exact edge, simulation interval, and bankroll path.">
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
  .body-copy strong { color: var(--ink); }

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
  .cover-main { margin-top: 26mm; }
  .cover h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 48pt; line-height: .94; font-weight: 400;
    letter-spacing: -.035em; margin-top: 5mm;
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
    font-size: 39pt; line-height: 1; margin-top: 1mm; color: #f6f0df;
  }
  .cover-score-main .score-unit { color: #a9b2a7; font-size: 10pt; margin-left: 2mm; }
  .cover-score-grid { display: grid; grid-template-columns: 1.65fr 1fr 1fr; gap: 6mm; margin-left: auto; }
  .cover-score-grid div { min-width: 20mm; }
  .cover-score-grid span { display: block; font-size: 6.2pt; letter-spacing: .15em; color: #9ca99e; }
  .cover-score-grid strong { display: block; font-size: 11.5pt; font-weight: 600; margin-top: 1mm; color: #f3eddc; white-space: nowrap; }
  .cover-score-grid .wlp strong { font-size: 9.2pt; letter-spacing: -.02em; }
  .cover-bottom { margin-top: 7mm; display: flex; justify-content: space-between; align-items: flex-end; gap: 12mm; }
  .rule-chips { display: flex; flex-wrap: wrap; gap: 1.5mm; max-width: 126mm; }
  .rule-chips span {
    border: 1px solid rgba(243,237,220,.25); border-radius: 99px;
    padding: 1.2mm 2.4mm; font-size: 6.6pt; letter-spacing: .04em; color: #cbd2c7;
  }
  .cover-foot { font-size: 6.4pt; line-height: 1.6; color: #98a399; text-align: right; white-space: nowrap; }
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
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 5mm 0 6mm; }
  .kpi { background: #f2ecdd; border: 1px solid #ddd4c1; border-radius: 2.4mm; padding: 3.4mm 3.2mm; }
  .kpi-label { display: block; font-size: 6.3pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .kpi strong { display: block; font-family: Georgia, serif; font-size: 19pt; font-weight: 400; line-height: 1.1; margin-top: 1.4mm; }
  .kpi-note { display: block; color: var(--muted); font-size: 7.1pt; line-height: 1.3; margin-top: 1mm; }
  .kpi-green { background: #e7efe8; border-color: #c4d9ca; }
  .kpi-green strong { color: var(--green); }
  .kpi-warm { background: #f6edd7; border-color: #e3d3a9; }
  .kpi-warm strong { color: #87662b; font-size: 16pt; }
  .two-col { display: grid; grid-template-columns: 1.08fr .92fr; gap: 9mm; }
  .col-title {
    font-family: Georgia, serif; font-size: 15pt; font-weight: 400;
    color: var(--green); margin-bottom: 2.5mm; border-bottom: 1px solid var(--line); padding-bottom: 2mm;
  }
  .score-table { width: 100%; border-collapse: collapse; }
  .score-table th, .score-table td { padding: 1.65mm 1mm; border-bottom: 1px dotted #d5ccb9; text-align: left; font-size: 8.4pt; }
  .score-table th { color: var(--muted); font-weight: 500; width: 26%; }
  .score-table td { font-weight: 600; width: 24%; }
  .compact-verdict { margin-top: 3mm; padding: 3.4mm 4mm 3.4mm 3mm; }
  .compact-verdict .verdict-text { font-size: 10.4pt; }
  .verdict {
    display: flex; gap: 4mm;
    background: #e7efe8; border-left: 3px solid var(--green);
    border-radius: 0 2.4mm 2.4mm 0;
  }
  .verdict-mark { font-family: Georgia, serif; font-size: 29pt; line-height: .65; color: #7da38d; }
  .verdict-kicker { font-size: 6.5pt; letter-spacing: .17em; font-weight: 700; color: var(--green); }
  .verdict-text { font-family: Georgia, serif; font-size: 11.4pt; line-height: 1.5; margin-top: 1.2mm; }

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
  .ci-line { stroke: #9bc0a8; stroke-width: 13; stroke-linecap: round; opacity: .65; }
  .ci-cap { stroke: #6f9c80; stroke-width: 1.5; }
  .observed-dot { fill: #173d2d; stroke: #fbf8ef; stroke-width: 2; }
  .exact-line { stroke: #b48b41; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .chart-label { font-family: "Segoe UI", Arial, sans-serif; font-size: 8px; font-weight: 700; letter-spacing: .05em; }
  .exact-label { fill: #9a7431; }
  .observed-label { fill: #245a45; }
  .ci-label { fill: #68746c; letter-spacing: .1em; }
  .expected-line { fill: none; stroke: #7c887e; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .bank-line { fill: none; stroke: #173d2d; stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
  .endpoint { fill: #173d2d; stroke: #fbf8ef; stroke-width: 2; }
  .endpoint-end { fill: #d8b96d; }
  .marker { stroke: #fbf8ef; stroke-width: 2; }
  .marker-high { fill: #b48b41; }
  .marker-low { fill: #a94236; }
  .annotation text { fill: #526158; font-size: 9.5px; font-weight: 600; }
  .chart-note { font-size: 7.4pt; color: var(--muted); line-height: 1.45; padding: 1mm 1mm 1mm; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-top: 4mm; }
  .stat { border-top: 2px solid #d8c9a7; padding-top: 2.2mm; }
  .stat span { display: block; font-size: 6.2pt; letter-spacing: .14em; color: var(--muted); font-weight: 700; }
  .stat strong { display: block; font-family: Georgia, serif; font-size: 16pt; font-weight: 400; line-height: 1.1; margin-top: .8mm; }
  .stat small { display: block; color: var(--muted); font-size: 7pt; }
  .callout { margin-top: 4mm; padding: 3.4mm 4.5mm; background: #f2ecdd; border-radius: 2mm; }
  .callout-kicker { display: block; font-size: 6.4pt; letter-spacing: .16em; font-weight: 700; color: var(--gold); margin-bottom: 1.2mm; }
  .callout p { font-size: 9.2pt; line-height: 1.55; }
  .wide-callout { border-left: 3px solid #c7a35f; }
  .insight-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 4mm; }
  .insight-row p { font-size: 8.7pt; line-height: 1.45; color: #3b483f; border-top: 1px solid var(--line); padding-top: 2mm; }
  .insight-row strong { color: var(--ink); }

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
  .reproduce code { display: inline-block; font-family: Consolas, "Courier New", monospace; font-size: 8.3pt; color: var(--green); background: #e7efe8; padding: 1.6mm 2.2mm; border-radius: 1mm; margin-top: 1mm; }
  .reproduce p { font-size: 7.8pt; color: var(--muted); line-height: 1.4; margin-top: 1.8mm; }
  .closing { margin-top: 3.5mm; padding-top: 3mm; border-top: 2px solid var(--green); }
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

const htmlPath = join(OUT, 'blackjack-100k.html');
writeFileSync(htmlPath, html);

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
const pdfPath = join(OUT, 'blackjack-100k.pdf');
if (!chrome) {
  console.error('No Chrome or Edge found; wrote HTML and JSON only.');
  process.exitCode = 1;
} else {
  const profile = join(tmpdir(), `blackjack-100k-report-${process.pid}`);
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
    console.log(`JSON: ${join(OUT, 'blackjack-100k.json')}`);
    console.log(`Net: ${signed(net)} units · observed edge ${observedEdge.toFixed(3)}% · exact ${exactEdge.toFixed(3)}% · 95% CI ${ciLow.toFixed(3)}% to ${ciHigh.toFixed(3)}%`);
  }
}
