import { COUNT_SYSTEMS, systemById, countValue, trueCountFor } from '../counting/systems.js';
import { RAMP_PRESETS, rampPreset } from '../counting/ramp.js';
import { STANDARD_INDEX_PLAYS } from '../sim/strategies.js';
import { freshCounts } from '../solver/finite.js';
import { bucketFromIndex } from '../engine/cards.js';
import { mulberry32 } from '../engine/rng.js';
import { CountingClient } from '../workers/counting-client.js';
import { drawLineChart } from './line-chart.js';
import { drawScatterChart } from './scatter-chart.js';
import {
  ACTION_INFO,
  actionClass,
  actionName,
  escapeHtml,
  formatEdge,
  formatEV,
  formatNumber,
  upcardLabel,
} from './format.js';

const COUNT_TABS = [
  { id: 'edge', label: 'Edge vs count' },
  { id: 'ramp', label: 'Bet ramp' },
  { id: 'indices', label: 'Indices' },
  { id: 'quality', label: 'Hi-Lo quality' },
  { id: 'trainer', label: 'Trainer' },
];

const SPEEDS = [
  { value: 1600, label: 'Slow · 1.6s' },
  { value: 1100, label: 'Medium · 1.1s' },
  { value: 750, label: 'Fast · 0.75s' },
  { value: 450, label: 'Blitz · 0.45s' },
];

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = [
  { id: 's', glyph: '♠', red: false },
  { id: 'h', glyph: '♥', red: true },
  { id: 'd', glyph: '♦', red: true },
  { id: 'c', glyph: '♣', red: false },
];

function cardForBucket(bucket, rng) {
  const suit = SUITS[Math.floor(rng() * SUITS.length)];
  if (bucket === 11) return { rank: 'A', value: 11, suit, red: suit.red };
  if (bucket === 10) {
    const tenRank = ['10', 'J', 'Q', 'K'][Math.floor(rng() * 4)];
    return { rank: tenRank, value: 10, suit, red: suit.red };
  }
  return { rank: String(bucket), value: bucket, suit, red: suit.red };
}

function signedPercent(value, digits = 3) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function percentPoints(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)} pts`;
}

function option(value, label, selected) {
  return `<option value="${value}"${String(value) === String(selected) ? ' selected' : ''}>${label}</option>`;
}

function renderCountSystemSelect(selected) {
  return COUNT_SYSTEMS.map((s) => option(s.id, s.name, selected)).join('');
}

function drawCardWeighted(counts, rng) {
  let total = 0;
  for (const n of counts) total += n;
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < counts.length; i++) {
    r -= counts[i];
    if (r < 0 && counts[i] > 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  for (let i = counts.length - 1; i >= 0; i--) {
    if (counts[i] > 0) {
      counts[i]--;
      return bucketFromIndex(i);
    }
  }
  return null;
}

function countOfCards(cards, system) {
  return cards.reduce((sum, c) => sum + countValue(system, c.value), 0);
}

function cardText(card) {
  return `${card.rank}${card.suit.glyph}`;
}

function cardMarkup(card) {
  if (!card) return '<span class="card-back" aria-label="Hidden card">?</span>';
  return `
    <span class="card-rank">${card.rank}</span>
    <span class="card-suit">${card.suit.glyph}</span>
  `;
}

export function mountCountingView({ root, getRules, getTarget, getCountSystem, onCountSystemChange }) {
  root.innerHTML = `
    <div class="module-head">
      <div>
        <p class="eyebrow">Module 04 · card counting</p>
        <h1>Count the shoe, not a feeling.</h1>
        <p class="lede">Hi-Lo’s value is measured, not assumed. The edge curve comes from the finite solver at real compositions; the ramp simulator turns that edge into bankroll paths, risk of ruin, and Kelly sizing.</p>
      </div>
      <div class="module-badge count-system-badge">
        <label class="field-label" for="count-system">Count system</label>
        <select id="count-system" class="select-inline">${renderCountSystemSelect(getCountSystem())}</select>
        <span id="count-system-note" class="stat-note">Hi-Lo powers the edge and index labs.</span>
      </div>
    </div>

    <div class="subtabs" role="tablist" aria-label="Counting labs">
      ${COUNT_TABS.map((t, i) => `
        <button class="subtab" id="count-tab-${t.id}" role="tab" aria-controls="count-panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-count-tab="${t.id}">${t.label}</button>
      `).join('')}
    </div>

    <section class="count-panel" id="count-panel-edge" role="tabpanel" aria-labelledby="count-tab-edge">
      <div class="count-grid">
        <section class="chart-card">
          <div class="chart-card-head">
            <div>
              <h2>Player edge vs true count</h2>
              <p>House edge at a representative composition, solved hand by hand. Lower is better for the casino; the vertical axis is the house edge.</p>
            </div>
            <div class="chart-legend">
              <span><i class="legend-line"></i> solved points</span>
              <span><i class="legend-fit"></i> linear fit</span>
              <span><i class="legend-target"></i> break-even</span>
            </div>
          </div>
          <div class="canvas-wrap chart-tall">
            <canvas id="count-edge-chart" role="img" aria-label="House edge versus true count"></canvas>
            <div class="chart-empty" id="count-edge-empty">Choose “Solve edge curve” to evaluate seven real shoe compositions.</div>
          </div>
          <div class="metric-strip" id="count-edge-metrics">
            <div><span>Player edge per TC</span><strong>—</strong></div>
            <div><span>Break-even TC</span><strong>—</strong></div>
            <div><span>Fit R²</span><strong>—</strong></div>
            <div><span>Points</span><strong>0</strong></div>
          </div>
          <div class="table-scroll">
            <table class="data-table count-table">
              <thead><tr><th scope="col">Target TC</th><th scope="col">Actual TC</th><th scope="col">Running</th><th scope="col">Decks left</th><th scope="col">House edge</th><th scope="col">Player edge</th></tr></thead>
              <tbody id="count-edge-body"><tr><td colspan="6" class="empty-cell">No curve solved yet.</td></tr></tbody>
            </table>
          </div>
        </section>
        <aside class="control-card">
          <div class="control-head"><h2>Solve the curve</h2><span class="status-pill" id="count-edge-state">Idle</span></div>
          <p class="control-copy">Each point starts from a 6-deck-style shoe with 25% of the cards removed, tilted toward the target running count. The edge is the fixed-strategy solver’s result at that composition.</p>
          <label class="field" for="count-edge-pen">
            <span class="field-label">Penetration used for the composition</span>
            <select id="count-edge-pen">${[0.5, 0.6, 0.7, 0.75, 0.8, 0.9].map((p) => option(p, `${Math.round(p * 100)}%`, 0.75)).join('')}</select>
          </label>
          <button class="btn btn-primary" type="button" id="count-edge-run">Solve edge curve</button>
          <div class="progress-wrap">
            <div class="progress-track"><span id="count-edge-progress" class="progress-fill" style="width:0%"></span></div>
            <div class="progress-meta"><span id="count-edge-progress-text">Seven finite solves, about a second each.</span></div>
          </div>
          <p class="fine-print">Split EV uses the independent-hand approximation. The curve is for the displayed basic strategy, not a composition-dependent strategy that re-optimizes every cell.</p>
        </aside>
      </div>
    </section>

    <section class="count-panel" id="count-panel-ramp" role="tabpanel" aria-labelledby="count-tab-ramp" hidden>
      <div class="count-grid">
        <section class="chart-card">
          <div class="chart-card-head">
            <div>
              <h2>Bet ramp, bankroll, ruin</h2>
              <p>Same seeded sessions, two betting plans. The line is the median bankroll; the band is the 5th–95th percentile across sessions.</p>
            </div>
            <div class="chart-legend">
              <span><i class="legend-line"></i> ramp median</span>
              <span><i class="legend-flat"></i> flat median</span>
              <span><i class="legend-band"></i> ramp 5–95%</span>
            </div>
          </div>
          <div class="canvas-wrap chart-tall">
            <canvas id="ramp-chart" role="img" aria-label="Bankroll paths for flat betting and a bet ramp"></canvas>
            <div class="chart-empty" id="ramp-empty">Run the ramp simulator to draw bankroll paths.</div>
          </div>
          <div class="ramp-stats" id="ramp-stats">
            <div class="ramp-stat"><span>Plan</span><strong>Flat</strong><small>—</small></div>
            <div class="ramp-stat"><span>Plan</span><strong>Ramp</strong><small>—</small></div>
          </div>
          <p class="fine-print" id="ramp-note">The simulator uses the selected count system. A session stops when the bankroll reaches zero.</p>
        </section>
        <aside class="control-card">
          <div class="control-head"><h2>Simulate a plan</h2><span class="status-pill" id="ramp-state">Idle</span></div>
          <div class="form-grid">
            <label class="field" for="ramp-preset">
              <span class="field-label">Ramp</span>
              <select id="ramp-preset">
                ${RAMP_PRESETS.map((p) => option(p.id, p.name, '1-2-4-8')).join('')}
                ${option('custom', 'Custom four-step ramp', '1-2-4-8')}
              </select>
            </label>
            <label class="field" for="ramp-sessions">
              <span class="field-label">Sessions</span>
              <select id="ramp-sessions">${[100, 200, 500, 1000].map((n) => option(n, formatNumber(n), 200)).join('')}</select>
            </label>
            <label class="field" for="ramp-hands">
              <span class="field-label">Hands per session</span>
              <select id="ramp-hands">${[500, 1000, 2000, 5000].map((n) => option(n, formatNumber(n), 1000)).join('')}</select>
            </label>
            <label class="field" for="ramp-bankroll">
              <span class="field-label">Starting bankroll (units)</span>
              <input id="ramp-bankroll" type="number" min="20" max="100000" step="10" value="200">
            </label>
            <label class="field" for="ramp-seed">
              <span class="field-label">Seed</span>
              <input id="ramp-seed" type="number" min="0" max="4294967295" step="1" value="20261028">
            </label>
            <label class="field" for="ramp-pen">
              <span class="field-label">Penetration</span>
              <select id="ramp-pen">${[0.5, 0.65, 0.75, 0.85, 0.9].map((p) => option(p, `${Math.round(p * 100)}%`, 0.75)).join('')}</select>
            </label>
            <label class="field" for="ramp-kelly">
              <span class="field-label">Kelly fraction</span>
              <input id="ramp-kelly" type="number" min="0.1" max="1" step="0.1" value="0.5">
            </label>
            <label class="field" for="ramp-max">
              <span class="field-label">Max bet (units)</span>
              <input id="ramp-max" type="number" min="1" max="100" step="1" value="20">
            </label>
          </div>
          <div class="ramp-custom" id="ramp-custom" hidden>
            <span class="field-label">Bets at TC ≤1, 2, 3, ≥4</span>
            <div class="inline-inputs">
              <input id="ramp-bet-0" type="number" min="0" max="100" step="1" value="1" aria-label="Bet at true count 1 or lower">
              <input id="ramp-bet-1" type="number" min="0" max="100" step="1" value="2" aria-label="Bet at true count 2">
              <input id="ramp-bet-2" type="number" min="0" max="100" step="1" value="4" aria-label="Bet at true count 3">
              <input id="ramp-bet-3" type="number" min="0" max="100" step="1" value="8" aria-label="Bet at true count 4 or higher">
            </div>
          </div>
          <label class="check-field"><input id="ramp-indices" type="checkbox"> Use standard index deviations on the ramp</label>
          <div class="control-actions">
            <button class="btn btn-primary" type="button" id="ramp-run">Run ramp</button>
            <button class="btn" type="button" id="ramp-stop" disabled>Stop</button>
          </div>
          <div class="progress-wrap">
            <div class="progress-track"><span id="ramp-progress" class="progress-fill" style="width:0%"></span></div>
            <div class="progress-meta"><span id="ramp-progress-text">200 sessions × 1,000 hands by default.</span></div>
          </div>
          <p class="fine-print" id="ramp-kelly-note">Kelly sizing uses the current edge model: base player edge plus the solver’s slope per true count, divided by variance and scaled by the fraction.</p>
        </aside>
      </div>
    </section>

    <section class="count-panel" id="count-panel-indices" role="tabpanel" aria-labelledby="count-tab-indices" hidden>
      <div class="count-grid indices-grid">
        <section class="chart-card">
          <div class="chart-card-head">
            <div>
              <h2>Illustrious-18-style index plays</h2>
              <p>For each borderline hand, the finite solver compares the two actions at seven true-count compositions. The derived index is the first half-count where the higher action takes over.</p>
            </div>
            <button class="btn btn-primary" type="button" id="indices-run">Derive indices</button>
          </div>
          <div class="table-scroll">
            <table class="data-table count-table index-table">
              <thead><tr><th scope="col">Hand</th><th scope="col">Standard</th><th scope="col">Derived</th><th scope="col">Below</th><th scope="col">At / above</th><th scope="col">Status</th></tr></thead>
              <tbody id="indices-body"><tr><td colspan="6" class="empty-cell">Run the derivation to fill this table.</td></tr></tbody>
            </table>
          </div>
          <div class="index-detail" id="index-detail">
            <div class="index-detail-head">
              <h3>EV by true count</h3>
              <span id="index-detail-note">Select a row to inspect the crossover.</span>
            </div>
            <div class="canvas-wrap chart-mid"><canvas id="index-detail-chart" role="img" aria-label="Expected value by true count for the selected index play"></canvas></div>
            <div class="index-legend">
              <span><i class="legend-line legend-low"></i><span id="index-low-label">Below action</span></span>
              <span><i class="legend-line legend-high"></i><span id="index-high-label">At/above action</span></span>
            </div>
          </div>
          <div class="progress-wrap">
            <div class="progress-track"><span id="indices-progress" class="progress-fill" style="width:0%"></span></div>
            <div class="progress-meta"><span id="indices-progress-text">18 candidate decisions, seven compositions each.</span></div>
          </div>
          <p class="fine-print">Pair rows use the independent-hand split approximation. The threshold depends on the representative holding shown; a different composition can move it by a fraction of a count.</p>
        </section>
        <aside class="control-card">
          <div class="control-head"><h2>How the table is made</h2><span class="status-pill" id="indices-state">Idle</span></div>
          <p class="control-copy">The “standard” column is the familiar Illustrious-18-style seed table. The “derived” column is recomputed from the finite shoe for the current rules. Where they disagree, trust the derivation for this model and study why the representative composition matters.</p>
          <div class="callout">
            <strong>Read a row</strong>
            <p>“Below” is the action before the threshold. “At / above” is the action after it. The status reports whether the solver found a clean crossover, no crossover, or a budget-limited approximation.</p>
          </div>
          <p class="fine-print">Indices are for study and simulation. Live play still depends on the actual remaining composition, not just the true count.</p>
        </aside>
      </div>
    </section>

    <section class="count-panel" id="count-panel-quality" role="tabpanel" aria-labelledby="count-tab-quality" hidden>
      <div class="count-grid">
        <section class="chart-card">
          <div class="chart-card-head">
            <div>
              <h2>How good is Hi-Lo, really?</h2>
              <p>Each dot is a full shoe composition at a random depth, solved over every initial deal. The vertical axis is the exact player edge; the horizontal axis is the Hi-Lo true count visible at that composition.</p>
            </div>
            <div class="chart-legend">
              <span><i class="legend-fit"></i> sample fit</span>
              <span><i class="legend-target"></i> Hi-Lo rule of thumb</span>
            </div>
          </div>
          <div class="canvas-wrap chart-tall">
            <canvas id="quality-chart" role="img" aria-label="Scatter plot of exact player EV against Hi-Lo true count"></canvas>
            <div class="chart-empty" id="quality-empty">Sample the shoe to see how tightly true count predicts the exact hand EV.</div>
          </div>
          <div class="metric-strip" id="quality-metrics">
            <div><span>Correlation r</span><strong>—</strong></div>
            <div><span>Sample slope</span><strong>—</strong></div>
            <div><span>Samples</span><strong>0</strong></div>
            <div><span>Budget misses</span><strong>—</strong></div>
          </div>
          <div class="table-scroll">
            <table class="data-table count-table">
              <thead><tr><th scope="col">True count bin</th><th scope="col">Hands</th><th scope="col">Average exact EV</th><th scope="col">Range</th></tr></thead>
              <tbody id="quality-bins"><tr><td colspan="4" class="empty-cell">No sample yet.</td></tr></tbody>
            </table>
          </div>
        </section>
        <aside class="control-card">
          <div class="control-head"><h2>Sample the shoe</h2><span class="status-pill" id="quality-state">Idle</span></div>
          <p class="control-copy">The point is not that Hi-Lo is perfect. It is a one-number summary of a composition, so it should correlate with the solved composition edge without explaining all of it. Each dot averages every initial deal from one composition, which removes the hand-to-hand noise that would otherwise swamp the signal.</p>
          <label class="field" for="quality-samples">
            <span class="field-label">Compositions to solve</span>
            <select id="quality-samples">${[8, 12, 20, 30].map((n) => option(n, formatNumber(n), 12)).join('')}</select>
          </label>
          <label class="field" for="quality-seed">
            <span class="field-label">Seed</span>
            <input id="quality-seed" type="number" min="0" max="4294967295" step="1" value="20261028">
          </label>
          <button class="btn btn-primary" type="button" id="quality-run">Sample exact EVs</button>
          <div class="progress-wrap">
            <div class="progress-track"><span id="quality-progress" class="progress-fill" style="width:0%"></span></div>
            <div class="progress-meta"><span id="quality-progress-text">Each dot is one full composition, solved over every initial deal.</span></div>
          </div>
          <p class="fine-print">Each composition is solved over all initial deals. Split EV uses the infinite-deck split model; the rule-of-thumb line is fixed at −0.43% base plus +0.5% per true count.</p>
        </aside>
      </div>
    </section>

    <section class="count-panel" id="count-panel-trainer" role="tabpanel" aria-labelledby="count-tab-trainer" hidden>
      <div class="trainer-layout">
        <section class="trainer-card">
          <div class="trainer-top">
            <div>
              <p class="eyebrow">Speed drill</p>
              <h2 id="trainer-title">Count the cards.</h2>
            </div>
            <span class="status-pill" id="trainer-state">Ready</span>
          </div>
          <div class="trainer-stage">
            <div class="trainer-deck" id="trainer-card" aria-live="polite">
              <span class="card-back">?</span>
            </div>
            <div class="trainer-prompt">
              <p id="trainer-prompt">Set a speed and press Start. Cards flash one at a time; then enter the running count.</p>
              <div class="trainer-answer" id="trainer-answer" hidden>
                <label class="field" for="trainer-input">
                  <span class="field-label">Running count after those cards</span>
                  <input id="trainer-input" type="number" step="1" inputmode="numeric" autocomplete="off">
                </label>
                <button class="btn btn-primary" type="button" id="trainer-check">Check</button>
              </div>
              <button class="btn" type="button" id="trainer-next" hidden>Next drill</button>
            </div>
          </div>
          <div class="trainer-seen" id="trainer-seen" aria-label="Cards from the last drill"></div>
          <p class="trainer-feedback" id="trainer-feedback" role="status"></p>
          <div class="trainer-controls">
            <label class="field" for="trainer-speed"><span class="field-label">Speed</span><select id="trainer-speed">${SPEEDS.map((s) => option(s.value, s.label, 1100)).join('')}</select></label>
            <label class="field" for="trainer-cards"><span class="field-label">Cards per drill</span><select id="trainer-cards">${[10, 15, 20, 30].map((n) => option(n, String(n), 15)).join('')}</select></label>
            <label class="field" for="trainer-seed"><span class="field-label">Seed</span><input id="trainer-seed" type="number" min="0" max="4294967295" step="1" value="20261028"></label>
            <div class="control-actions">
              <button class="btn btn-primary" type="button" id="trainer-start">Start drill</button>
              <button class="btn" type="button" id="trainer-stop" disabled>Stop</button>
            </div>
          </div>
          <p class="fine-print">The running count starts at zero. The selected count system is applied to every rank; true count is not required during the drill.</p>
        </section>
        <aside class="control-card trainer-stats">
          <div class="control-head"><h2>Drill stats</h2><span class="stat-note" id="trainer-system-label">Hi-Lo</span></div>
          <div class="stat-stack">
            <div><span>Drills</span><strong id="trainer-drills">0</strong></div>
            <div><span>Correct</span><strong id="trainer-correct">0</strong></div>
            <div><span>Accuracy</span><strong id="trainer-accuracy">—</strong></div>
            <div><span>Average response</span><strong id="trainer-response">—</strong></div>
            <div><span>Cards seen</span><strong id="trainer-total-cards">0</strong></div>
          </div>
          <div class="callout">
            <strong>What is graded</strong>
            <p>Only the final running count for the batch. The timer starts after the last card is shown and stops when you press Check, so speed and accuracy are measured separately.</p>
          </div>
        </aside>
      </div>
    </section>
  `;

  const edgeClient = new CountingClient();
  const rampClient = new CountingClient();
  const indicesClient = new CountingClient();
  const qualityClient = new CountingClient();
  let rules = getRules();
  let target = getTarget();
  let edgeCurve = null;
  let indices = null;
  let selectedIndexId = null;
  let scatter = null;
  let rampResult = null;
  let countSystemId = getCountSystem();
  let activeTab = 'edge';
  let edgeRunning = false;
  let indicesRunning = false;
  let rampRunning = false;
  let qualityRunning = false;
  let trainerRunning = false;
  let trainerTimer = null;
  let trainerAnswerTimer = null;
  let trainerCard = null;
  let trainerRunningCount = 0;
  let trainerCardsSeen = 0;
  let trainerDrillCards = [];
  let trainerAnswerStarted = 0;
  let trainerStats = { drills: 0, correct: 0, responseMs: 0, cards: 0 };
  let trainerShoe = null;
  let trainerRng = null;
  let trainerDrillSeed = 0;

  const els = {
    system: root.querySelector('#count-system'),
    systemNote: root.querySelector('#count-system-note'),
    edgeChart: root.querySelector('#count-edge-chart'),
    edgeEmpty: root.querySelector('#count-edge-empty'),
    edgeMetrics: root.querySelector('#count-edge-metrics'),
    edgeBody: root.querySelector('#count-edge-body'),
    edgeRun: root.querySelector('#count-edge-run'),
    edgePen: root.querySelector('#count-edge-pen'),
    edgeState: root.querySelector('#count-edge-state'),
    edgeProgress: root.querySelector('#count-edge-progress'),
    edgeProgressText: root.querySelector('#count-edge-progress-text'),
    rampChart: root.querySelector('#ramp-chart'),
    rampEmpty: root.querySelector('#ramp-empty'),
    rampStats: root.querySelector('#ramp-stats'),
    rampNote: root.querySelector('#ramp-note'),
    rampRun: root.querySelector('#ramp-run'),
    rampStop: root.querySelector('#ramp-stop'),
    rampState: root.querySelector('#ramp-state'),
    rampProgress: root.querySelector('#ramp-progress'),
    rampProgressText: root.querySelector('#ramp-progress-text'),
    rampPreset: root.querySelector('#ramp-preset'),
    rampCustom: root.querySelector('#ramp-custom'),
    rampSessions: root.querySelector('#ramp-sessions'),
    rampHands: root.querySelector('#ramp-hands'),
    rampBankroll: root.querySelector('#ramp-bankroll'),
    rampSeed: root.querySelector('#ramp-seed'),
    rampPen: root.querySelector('#ramp-pen'),
    rampKelly: root.querySelector('#ramp-kelly'),
    rampMax: root.querySelector('#ramp-max'),
    rampIndices: root.querySelector('#ramp-indices'),
    rampKellyNote: root.querySelector('#ramp-kelly-note'),
    indicesBody: root.querySelector('#indices-body'),
    indicesRun: root.querySelector('#indices-run'),
    indicesState: root.querySelector('#indices-state'),
    indicesProgress: root.querySelector('#indices-progress'),
    indicesProgressText: root.querySelector('#indices-progress-text'),
    indexDetailChart: root.querySelector('#index-detail-chart'),
    indexDetailNote: root.querySelector('#index-detail-note'),
    indexLowLabel: root.querySelector('#index-low-label'),
    indexHighLabel: root.querySelector('#index-high-label'),
    qualityChart: root.querySelector('#quality-chart'),
    qualityEmpty: root.querySelector('#quality-empty'),
    qualityMetrics: root.querySelector('#quality-metrics'),
    qualityBins: root.querySelector('#quality-bins'),
    qualityRun: root.querySelector('#quality-run'),
    qualityState: root.querySelector('#quality-state'),
    qualitySamples: root.querySelector('#quality-samples'),
    qualitySeed: root.querySelector('#quality-seed'),
    qualityProgress: root.querySelector('#quality-progress'),
    qualityProgressText: root.querySelector('#quality-progress-text'),
    trainerCard: root.querySelector('#trainer-card'),
    trainerPrompt: root.querySelector('#trainer-prompt'),
    trainerAnswer: root.querySelector('#trainer-answer'),
    trainerInput: root.querySelector('#trainer-input'),
    trainerCheck: root.querySelector('#trainer-check'),
    trainerNext: root.querySelector('#trainer-next'),
    trainerSeen: root.querySelector('#trainer-seen'),
    trainerFeedback: root.querySelector('#trainer-feedback'),
    trainerState: root.querySelector('#trainer-state'),
    trainerStart: root.querySelector('#trainer-start'),
    trainerStop: root.querySelector('#trainer-stop'),
    trainerSpeed: root.querySelector('#trainer-speed'),
    trainerCards: root.querySelector('#trainer-cards'),
    trainerSeed: root.querySelector('#trainer-seed'),
    trainerSystemLabel: root.querySelector('#trainer-system-label'),
    trainerDrills: root.querySelector('#trainer-drills'),
    trainerCorrect: root.querySelector('#trainer-correct'),
    trainerAccuracy: root.querySelector('#trainer-accuracy'),
    trainerResponse: root.querySelector('#trainer-response'),
    trainerTotalCards: root.querySelector('#trainer-total-cards'),
  };

  function currentSystem() {
    return systemById(countSystemId);
  }

  function updateSystemLabels() {
    const system = currentSystem();
    els.system.value = system.id;
    els.trainerSystemLabel.textContent = system.name;
    els.systemNote.textContent = system.balanced
      ? `${system.name} is balanced; true count = running count ÷ decks left.`
      : `${system.name} is unbalanced; use the running count and key count ${system.keyCount}.`;
    // The edge and index labs are Hi-Lo composition models. Keep the note
    // explicit rather than silently pretending another system changes them.
    els.systemNote.textContent += ' Edge/index labs use Hi-Lo compositions.';
  }

  function switchTab(name) {
    activeTab = name;
    for (const tab of root.querySelectorAll('[data-count-tab]')) {
      const selected = tab.dataset.countTab === name;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('.count-panel')) {
      panel.hidden = panel.id !== `count-panel-${name}`;
    }
    requestAnimationFrame(() => {
      if (name === 'edge') drawEdgeChart();
      if (name === 'ramp') drawRampChart();
      if (name === 'indices') drawIndexDetail();
      if (name === 'quality') drawQualityChart();
    });
  }

  root.querySelectorAll('[data-count-tab]').forEach((tab, index) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.countTab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...root.querySelectorAll('[data-count-tab]')];
      let next = index;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      tabs[next].focus();
      switchTab(tabs[next].dataset.countTab);
    });
  });

  // ------------------------------------------------------------------ edge
  function edgeFitSeries(points) {
    if (!points?.length || !edgeCurve?.fit) return null;
    const xs = points.map((p) => p.trueCount);
    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const { slope, intercept } = edgeCurve.fit;
    return {
      points: [
        { x: x1, y: intercept + slope * x1 },
        { x: x2, y: intercept + slope * x2 },
      ],
      color: '#fbbf24',
      width: 2,
      dashed: true,
    };
  }

  function drawEdgeChart() {
    if (!edgeCurve) {
      els.edgeEmpty.hidden = false;
      return;
    }
    els.edgeEmpty.hidden = true;
    const points = edgeCurve.points.map((p) => ({ x: p.trueCount, y: p.houseEdge }));
    const fit = edgeFitSeries(edgeCurve.points);
    drawLineChart(els.edgeChart, {
      series: [
        ...(fit ? [fit] : []),
        { points, color: '#5eead4', width: 2.5 },
      ],
      target: { value: 0, label: 'break-even' },
      xLabel: 'Hi-Lo true count',
      yLabel: 'house edge %',
      height: 330,
      formatX: (v) => v.toFixed(1),
      formatY: (v) => `${v.toFixed(1)}%`,
      ariaLabel: `House edge versus true count. ${edgeCurve.points.length} solved compositions; player edge per true count ${(-edgeCurve.fit.slope).toFixed(3)} percentage points.`,
    });
  }

  function renderEdgeMetrics() {
    if (!edgeCurve) {
      els.edgeMetrics.innerHTML = `
        <div><span>Player edge per TC</span><strong>—</strong></div>
        <div><span>Break-even TC</span><strong>—</strong></div>
        <div><span>Fit R²</span><strong>—</strong></div>
        <div><span>Points</span><strong>0</strong></div>
      `;
      return;
    }
    const fit = edgeCurve.fit;
    els.edgeMetrics.innerHTML = `
      <div><span>Player edge per TC</span><strong>+${(-fit.slope).toFixed(3)} pts</strong></div>
      <div><span>Break-even TC</span><strong>${fit.zeroCrossing == null ? '—' : fit.zeroCrossing.toFixed(2)}</strong></div>
      <div><span>Fit R²</span><strong>${fit.r2.toFixed(3)}</strong></div>
      <div><span>Points</span><strong>${edgeCurve.points.length}</strong></div>
    `;
    els.edgeBody.innerHTML = edgeCurve.points.map((p) => `
      <tr>
        <td class="num">${p.targetTrueCount > 0 ? '+' : ''}${p.targetTrueCount}</td>
        <td class="num">${p.trueCount.toFixed(2)}</td>
        <td class="num">${p.runningCount > 0 ? '+' : ''}${p.runningCount}</td>
        <td class="num">${p.decksRemaining.toFixed(2)}</td>
        <td class="num">${formatEdge(p.houseEdge)}</td>
        <td class="num ${p.playerEdge >= 0 ? 'is-gain' : 'is-cost'}">${signedPercent(p.playerEdge)}</td>
      </tr>
    `).join('');
  }

  function resetEdge() {
    edgeClient.cancel();
    edgeCurve = null;
    edgeRunning = false;
    els.edgeRun.disabled = false;
    els.edgeState.textContent = 'Idle';
    els.edgeState.classList.remove('is-live');
    els.edgeProgress.style.width = '0%';
    els.edgeProgressText.textContent = rules.decks === 'infinite'
      ? 'Select a finite deck count to build a true-count composition curve.'
      : 'Seven finite solves, about a second each.';
    els.edgeEmpty.hidden = false;
    els.edgeEmpty.textContent = rules.decks === 'infinite'
      ? 'The edge-vs-count curve needs a finite shoe. Change Decks to 1, 2, 4, 6, or 8.'
      : 'Choose “Solve edge curve” to evaluate seven real shoe compositions.';
    renderEdgeMetrics();
  }

  async function runEdge() {
    if (edgeRunning) return;
    if (rules.decks === 'infinite') return;
    edgeRunning = true;
    els.edgeRun.disabled = true;
    els.edgeState.textContent = 'Solving';
    els.edgeState.classList.add('is-live');
    els.edgeEmpty.hidden = true;
    try {
      const result = await edgeClient.edgeCurve(rules, {
        penetration: Number(els.edgePen.value),
      }, {
        onProgress: (p) => {
          const pct = Math.round((p.value ?? 0) * 100);
          els.edgeProgress.style.width = `${pct}%`;
          els.edgeProgressText.textContent = p.total
            ? `Solving true count ${p.targetTrueCount} · ${p.done}/${p.total} compositions`
            : p.phase;
        },
      });
      edgeCurve = result;
      edgeRunning = false;
      els.edgeRun.disabled = false;
      els.edgeState.textContent = 'Solved';
      els.edgeState.classList.remove('is-live');
      els.edgeProgress.style.width = '100%';
      els.edgeProgressText.textContent = `${result.points.length} compositions in ${Math.round(result.ms)} ms · model: ${result.model}`;
      renderEdgeMetrics();
      drawEdgeChart();
      // The ramp's Kelly model uses the solver slope when it is available.
      els.rampKellyNote.textContent = `Kelly sizing uses the solved slope (${(-result.fit.slope).toFixed(3)} pts/TC), variance 1.3, and the fraction below.`;
    } catch (error) {
      edgeRunning = false;
      els.edgeRun.disabled = false;
      els.edgeState.textContent = 'Error';
      els.edgeState.classList.remove('is-live');
      els.edgeProgressText.textContent = error.message;
    }
  }

  // ------------------------------------------------------------------ ramp
  function rampPayload() {
    const presetId = els.rampPreset.value;
    const customBets = [0, 1, 2, 3].map((i) => Math.max(0, Number(root.querySelector(`#ramp-bet-${i}`).value) || 0));
    const edgeFit = edgeCurve?.fit;
    const basePlayerEdge = target ? -target.edge / 100 : -0.0043;
    const edgePerTrueCount = edgeFit ? -edgeFit.slope / 100 : 0.005;
    return {
      rules,
      seed: Number(els.rampSeed.value) >>> 0,
      sessions: Number(els.rampSessions.value),
      handsPerSession: Number(els.rampHands.value),
      bankroll: Number(els.rampBankroll.value),
      penetration: Number(els.rampPen.value),
      rampPreset: presetId === 'custom' ? 'custom' : presetId,
      customBets,
      countSystemId,
      useIndices: els.rampIndices.checked,
      basePlayerEdge,
      edgePerTrueCount,
      kellyFraction: Number(els.rampKelly.value) || 0.5,
      maxBet: Number(els.rampMax.value) || 20,
    };
  }

  function drawRampChart() {
    if (!rampResult) {
      els.rampEmpty.hidden = false;
      return;
    }
    els.rampEmpty.hidden = true;
    const flat = rampResult.flat.curve;
    const ramp = rampResult.ramp.curve;
    drawLineChart(els.rampChart, {
      series: [
        { points: flat.map((p) => ({ x: Math.max(1, p.x), y: p.p50 })), color: '#60a5fa', width: 1.6, dashed: true },
        { points: ramp.map((p) => ({ x: Math.max(1, p.x), y: p.p50 })), color: '#5eead4', width: 2.4 },
      ],
      band: {
        points: ramp.filter((p) => p.x > 0).map((p) => ({ x: p.x, low: p.p05, high: p.p95 })),
        color: 'rgba(94, 234, 212, 0.12)',
      },
      target: { value: rampResult.bankroll, label: 'starting bankroll' },
      xLog: true,
      xLabel: 'hands (log scale)',
      yLabel: 'bankroll (units)',
      height: 330,
      formatX: (v) => formatNumber(v),
      formatY: (v) => formatNumber(v, 0),
      ariaLabel: `Bankroll paths: flat median ${formatNumber(rampResult.flat.stats.medianFinal, 0)} units, ramp median ${formatNumber(rampResult.ramp.stats.medianFinal, 0)} units.`,
    });
  }

  function renderRampStats() {
    if (!rampResult) {
      els.rampStats.innerHTML = `
        <div class="ramp-stat"><span>Plan</span><strong>Flat</strong><small>—</small></div>
        <div class="ramp-stat"><span>Plan</span><strong>Ramp</strong><small>—</small></div>
      `;
      return;
    }
    const cards = [
      { label: 'Flat', data: rampResult.flat.stats, color: 'flat' },
      { label: 'Ramp', data: rampResult.ramp.stats, color: 'ramp' },
    ];
    els.rampStats.innerHTML = cards.map(({ label, data, color }) => `
      <div class="ramp-stat ramp-${color}">
        <span>${label}</span>
        <strong>${formatNumber(data.medianFinal, 0)} units median</strong>
        <small>Risk of ruin ${(data.riskOfRuin * 100).toFixed(1)}% · 5th pct ${formatNumber(data.p05Final, 0)} · mean ${formatNumber(data.meanFinal, 0)}</small>
      </div>
    `).join('');
  }

  async function runRamp() {
    if (rampRunning) return;
    rampRunning = true;
    els.rampRun.disabled = true;
    els.rampStop.disabled = false;
    els.rampState.textContent = 'Running';
    els.rampState.classList.add('is-live');
    els.rampEmpty.hidden = true;
    const payload = rampPayload();
    try {
      const result = await rampClient.ramp(payload, {
        onProgress: (p) => {
          const pct = Math.round((p.value ?? 0) * 100);
          els.rampProgress.style.width = `${pct}%`;
          els.rampProgressText.textContent = `${p.phase ?? 'Simulating'} · ${p.done}/${p.total} sessions`;
        },
      });
      rampResult = result;
      rampRunning = false;
      els.rampRun.disabled = false;
      els.rampStop.disabled = true;
      els.rampState.textContent = 'Complete';
      els.rampState.classList.remove('is-live');
      els.rampProgress.style.width = '100%';
      const preset = payload.rampPreset === 'custom'
        ? `custom ${payload.customBets.join('/')}`
        : rampPreset(payload.rampPreset).name;
      els.rampProgressText.textContent = `${formatNumber(result.sessions)} sessions × ${formatNumber(result.hands)} hands · ${preset} · ${Math.round(result.ms)} ms`;
      els.rampNote.textContent = `Same seed for both plans. Ramp: ${preset}. Bankroll is in units; a session stops at zero.`;
      renderRampStats();
      drawRampChart();
    } catch (error) {
      rampRunning = false;
      els.rampRun.disabled = false;
      els.rampStop.disabled = true;
      els.rampState.textContent = 'Error';
      els.rampState.classList.remove('is-live');
      els.rampProgressText.textContent = error.message;
    }
  }

  function stopRamp() {
    rampClient.cancel();
    rampRunning = false;
    els.rampRun.disabled = false;
    els.rampStop.disabled = true;
    els.rampState.textContent = 'Stopped';
    els.rampState.classList.remove('is-live');
    els.rampProgressText.textContent = 'Stopped by user.';
  }

  function syncRampControls() {
    const custom = els.rampPreset.value === 'custom';
    els.rampCustom.hidden = !custom;
    const kelly = els.rampPreset.value === 'kelly';
    els.rampKelly.disabled = !kelly;
    els.rampMax.disabled = !kelly;
    els.rampKellyNote.textContent = kelly
      ? 'Kelly sizing uses the current edge model, variance 1.3, and the fraction below.'
      : 'Kelly controls apply only to the Kelly preset.';
  }

  // ---------------------------------------------------------------- indices
  function standardFor(id) {
    return STANDARD_INDEX_PLAYS.find((entry) => entry.id === id) ?? null;
  }

  function renderIndices() {
    if (!indices) {
      els.indicesBody.innerHTML = '<tr><td colspan="6" class="empty-cell">Run the derivation to fill this table.</td></tr>';
      return;
    }
    els.indicesBody.innerHTML = indices.indices.map((row) => {
      const standard = standardFor(row.id);
      const standardAction = standard ? `${standard.at} @ ${standard.index >= 0 ? '+' : ''}${standard.index}` : '—';
      const derived = row.index == null ? 'no flip' : `${row.index >= 0 ? '+' : ''}${row.index}`;
      const status = row.incomplete
        ? 'budget-limited'
        : row.index == null
          ? 'no crossover in range'
          : 'derived';
      return `
        <tr class="${selectedIndexId === row.id ? 'is-selected' : ''}" data-index-row="${row.id}">
          <th scope="row">${escapeHtml(row.label)} <span class="hand-cards">${row.cards.map((c) => c === 11 ? 'A' : c).join(' ')}</span></th>
          <td class="num">${standard ? `${standard.at} @ ${standard.index >= 0 ? '+' : ''}${standard.index}` : '—'}</td>
          <td class="num">${derived}</td>
          <td><span class="action-chip ${actionClass(row.below)}">${row.below} ${actionName(row.below)}</span></td>
          <td><span class="action-chip ${actionClass(row.atAbove)}">${row.atAbove} ${actionName(row.atAbove)}</span></td>
          <td><span class="status-text">${status}</span></td>
        </tr>
      `;
    }).join('');
    for (const tr of els.indicesBody.querySelectorAll('[data-index-row]')) {
      tr.addEventListener('click', () => selectIndex(tr.dataset.indexRow));
      tr.tabIndex = 0;
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectIndex(tr.dataset.indexRow);
        }
      });
    }
  }

  function clearIndexDetail() {
    els.indexDetailNote.textContent = 'Select a row to inspect the crossover.';
    els.indexLowLabel.textContent = 'Below action';
    els.indexHighLabel.textContent = 'At/above action';
    const canvas = els.indexDetailChart;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.removeAttribute('aria-label');
  }

  function drawIndexDetail() {
    if (!indices || !selectedIndexId) {
      clearIndexDetail();
      return;
    }
    const row = indices.indices.find((r) => r.id === selectedIndexId);
    if (!row) {
      clearIndexDetail();
      return;
    }
    els.indexLowLabel.textContent = `${row.below} ${actionName(row.below)}`;
    els.indexHighLabel.textContent = `${row.atAbove} ${actionName(row.atAbove)}`;
    const low = row.points.filter((p) => p.low != null).map((p) => ({ x: p.trueCount, y: p.low }));
    const high = row.points.filter((p) => p.high != null).map((p) => ({ x: p.trueCount, y: p.high }));
    drawLineChart(els.indexDetailChart, {
      series: [
        { points: low, color: '#60a5fa', width: 2 },
        { points: high, color: '#fbbf24', width: 2 },
      ],
      target: { value: 0, label: 'EV 0' },
      xLabel: 'true count',
      yLabel: 'EV (bets)',
      height: 260,
      formatX: (v) => v.toFixed(1),
      formatY: (v) => v.toFixed(2),
      ariaLabel: `${row.label}: ${row.below} versus ${row.atAbove}. Derived index ${row.index ?? 'not found'} at true count.`,
    });
    const standard = standardFor(row.id);
    const comparison = standard && row.index != null
      ? `Standard table: ${standard.at} at ${standard.index >= 0 ? '+' : ''}${standard.index}. Derived: ${row.atAbove} at ${row.index >= 0 ? '+' : ''}${row.index}.`
      : 'No derived crossover in the scanned range; the standard row is shown for comparison.';
    els.indexDetailNote.textContent = comparison;
  }

  function selectIndex(id) {
    selectedIndexId = id;
    for (const tr of els.indicesBody.querySelectorAll('[data-index-row]')) {
      tr.classList.toggle('is-selected', tr.dataset.indexRow === id);
    }
    drawIndexDetail();
  }

  async function runIndices() {
    if (indicesRunning) return;
    if (rules.decks === 'infinite') return;
    indicesRunning = true;
    els.indicesRun.disabled = true;
    els.indicesState.textContent = 'Solving';
    els.indicesState.classList.add('is-live');
    try {
      const result = await indicesClient.indices(rules, {
        onProgress: (p) => {
          const pct = Math.round((p.value ?? 0) * 100);
          els.indicesProgress.style.width = `${pct}%`;
          els.indicesProgressText.textContent = `${p.phase ?? 'Solving'} · ${p.done}/${p.total} comparisons`;
        },
      });
      indices = result;
      indicesRunning = false;
      els.indicesRun.disabled = false;
      els.indicesState.textContent = 'Solved';
      els.indicesState.classList.remove('is-live');
      els.indicesProgress.style.width = '100%';
      els.indicesProgressText.textContent = `${result.indices.length} candidates in ${Math.round(result.ms)} ms · ${result.model}`;
      if (!selectedIndexId) selectedIndexId = result.indices[0]?.id ?? null;
      renderIndices();
      drawIndexDetail();
    } catch (error) {
      indicesRunning = false;
      els.indicesRun.disabled = false;
      els.indicesState.textContent = 'Error';
      els.indicesState.classList.remove('is-live');
      els.indicesProgressText.textContent = error.message;
    }
  }

  // ---------------------------------------------------------------- quality
  function renderQuality() {
    if (!scatter) {
      els.qualityMetrics.innerHTML = `
        <div><span>Correlation r</span><strong>—</strong></div>
        <div><span>Sample slope</span><strong>—</strong></div>
        <div><span>Samples</span><strong>0</strong></div>
        <div><span>Budget misses</span><strong>—</strong></div>
      `;
      els.qualityBins.innerHTML = '<tr><td colspan="4" class="empty-cell">No sample yet.</td></tr>';
      return;
    }
    els.qualityEmpty.hidden = true;
    els.qualityMetrics.innerHTML = `
      <div><span>Correlation r</span><strong>${scatter.fit.r.toFixed(3)}</strong></div>
      <div><span>Sample slope</span><strong>${(scatter.fit.slope * 100).toFixed(3)} pts/TC</strong></div>
      <div><span>Samples</span><strong>${scatter.samples}</strong></div>
      <div><span>Budget misses</span><strong>${scatter.incomplete}</strong></div>
    `;
    const bins = [
      { label: '≤ −3', min: -Infinity, max: -3 },
      { label: '−3 to −1', min: -3, max: -1 },
      { label: '−1 to +1', min: -1, max: 1 },
      { label: '+1 to +3', min: 1, max: 3 },
      { label: '+3 to +6', min: 3, max: 6 },
      { label: '> +6', min: 6, max: Infinity },
    ];
    els.qualityBins.innerHTML = bins.map((bin) => {
      const rows = scatter.points.filter((p) => p.trueCount >= bin.min && p.trueCount < bin.max);
      if (!rows.length) return `<tr><td>${bin.label}</td><td class="num">0</td><td class="num">—</td><td class="num">—</td></tr>`;
      const evs = rows.map((p) => p.ev);
      const avg = evs.reduce((s, v) => s + v, 0) / evs.length;
      return `<tr><td>${bin.label}</td><td class="num">${rows.length}</td><td class="num">${formatEV(avg)}</td><td class="num">${formatEV(Math.min(...evs))} to ${formatEV(Math.max(...evs))}</td></tr>`;
    }).join('');
  }

  function drawQualityChart() {
    if (!scatter) {
      els.qualityEmpty.hidden = false;
      return;
    }
    els.qualityEmpty.hidden = true;
    const points = scatter.points.map((p) => ({ x: p.trueCount, y: p.ev * 100 }));
    const fit = {
      slope: scatter.fit.slope * 100,
      intercept: scatter.fit.intercept * 100,
      label: `sample fit ${(scatter.fit.slope * 100).toFixed(2)} pts/TC`,
    };
    const model = {
      slope: 0.5,
      intercept: -0.43,
      label: 'Hi-Lo rule of thumb',
    };
    drawScatterChart(els.qualityChart, {
      points,
      fit,
      model,
      xLabel: 'Hi-Lo true count',
      yLabel: 'exact player EV %',
      height: 330,
      ariaLabel: `Scatter of exact player EV against Hi-Lo true count. Correlation ${scatter.fit.r.toFixed(3)}; sample slope ${(scatter.fit.slope * 100).toFixed(3)} percentage points per true count.`,
    });
  }

  async function runQuality() {
    if (qualityRunning) return;
    if (rules.decks === 'infinite') return;
    qualityRunning = true;
    els.qualityRun.disabled = true;
    els.qualityState.textContent = 'Sampling';
    els.qualityState.classList.add('is-live');
    els.qualityEmpty.hidden = true;
    try {
      const result = await qualityClient.scatter(rules, {
        samples: Number(els.qualitySamples.value),
        seed: Number(els.qualitySeed.value) >>> 0,
      }, {
        onProgress: (p) => {
          const pct = Math.round((p.value ?? 0) * 100);
          els.qualityProgress.style.width = `${pct}%`;
          els.qualityProgressText.textContent = `${p.phase ?? 'Sampling'} · ${p.done}/${p.total} hands`;
        },
      });
      scatter = result;
      qualityRunning = false;
      els.qualityRun.disabled = false;
      els.qualityState.textContent = 'Complete';
      els.qualityState.classList.remove('is-live');
      els.qualityProgress.style.width = '100%';
      els.qualityProgressText.textContent = `${result.samples} compositions in ${Math.round(result.ms)} ms · ${result.approximation}`;
      renderQuality();
      drawQualityChart();
    } catch (error) {
      qualityRunning = false;
      els.qualityRun.disabled = false;
      els.qualityState.textContent = 'Error';
      els.qualityState.classList.remove('is-live');
      els.qualityProgressText.textContent = error.message;
    }
  }

  // ---------------------------------------------------------------- trainer
  function trainerStatsRender() {
    const accuracy = trainerStats.drills > 0 ? (trainerStats.correct / trainerStats.drills) * 100 : null;
    const response = trainerStats.drills > 0 ? trainerStats.responseMs / trainerStats.drills : null;
    els.trainerDrills.textContent = String(trainerStats.drills);
    els.trainerCorrect.textContent = String(trainerStats.correct);
    els.trainerAccuracy.textContent = accuracy == null ? '—' : `${accuracy.toFixed(1)}%`;
    els.trainerResponse.textContent = response == null ? '—' : `${Math.round(response)} ms`;
    els.trainerTotalCards.textContent = formatNumber(trainerStats.cards);
  }

  function resetTrainerDrill() {
    clearInterval(trainerTimer);
    clearTimeout(trainerAnswerTimer);
    trainerTimer = null;
    trainerAnswerTimer = null;
    trainerRunning = false;
    trainerCard = null;
    trainerDrillCards = [];
    trainerRunningCount = 0;
    trainerAnswerStarted = 0;
    els.trainerCard.innerHTML = '<span class="card-back">?</span>';
    els.trainerCard.className = 'trainer-deck is-back';
    els.trainerAnswer.hidden = true;
    els.trainerNext.hidden = true;
    els.trainerInput.value = '';
    els.trainerSeen.innerHTML = '';
    els.trainerStart.textContent = 'Start drill';
    els.trainerStop.disabled = true;
    els.trainerState.textContent = 'Ready';
    els.trainerState.classList.remove('is-live');
    els.trainerPrompt.textContent = 'Set a speed and press Start. Cards flash one at a time; then enter the running count.';
  }

  function stopTrainer() {
    resetTrainerDrill();
    els.trainerPrompt.textContent = 'Stopped. Press Start to begin a new drill.';
  }

  function renderTrainerCard(card) {
    const system = currentSystem();
    trainerCard = card;
    els.trainerCard.className = `trainer-deck${card.red ? ' is-red' : ''}`;
    els.trainerCard.innerHTML = cardMarkup(card);
    els.trainerCard.setAttribute('aria-label', `${card.rank} of ${card.suit.glyph}. Count value ${countValue(system, card.value)}.`);
    trainerDrillCards.push(card);
    trainerRunningCount += countValue(system, card.value);
    trainerStats.cards++;
    trainerCardsSeen++;
    els.trainerSeen.innerHTML = trainerDrillCards.map((c) => `<span class="seen-card${c.red ? ' is-red' : ''}">${cardText(c)}</span>`).join('');
    trainerStatsRender();
  }

  function drawNextTrainerCard() {
    if (!trainerShoe) return;
    let bucket = drawCardWeighted(trainerShoe, trainerRng);
    if (bucket == null) {
      trainerShoe = freshCounts(Number(rules.decks === 'infinite' ? 6 : rules.decks));
      trainerRng = mulberry32(trainerDrillSeed + trainerStats.drills * 7919);
      bucket = drawCardWeighted(trainerShoe, trainerRng);
    }
    if (bucket == null) return;
    renderTrainerCard(cardForBucket(bucket, trainerRng));
    if (trainerDrillCards.length >= Number(els.trainerCards.value)) {
      clearInterval(trainerTimer);
      trainerTimer = null;
      trainerAnswerTimer = setTimeout(showTrainerAnswer, 250);
    }
  }

  function showTrainerAnswer() {
    trainerRunning = false;
    trainerAnswerStarted = performance.now();
    els.trainerState.textContent = 'Answer';
    els.trainerState.classList.remove('is-live');
    els.trainerPrompt.textContent = `You saw ${trainerDrillCards.length} cards. What is the running count?`;
    els.trainerAnswer.hidden = false;
    els.trainerNext.hidden = true;
    els.trainerInput.value = '';
    els.trainerInput.focus();
  }

  function checkTrainerAnswer() {
    if (els.trainerAnswer.hidden) return;
    const value = Number(els.trainerInput.value);
    if (!Number.isFinite(value)) {
      els.trainerFeedback.textContent = 'Enter a whole number for the running count.';
      els.trainerInput.focus();
      return;
    }
    const correct = value === trainerRunningCount;
    const response = performance.now() - trainerAnswerStarted;
    trainerStats.drills++;
    trainerStats.responseMs += response;
    if (correct) trainerStats.correct++;
    trainerStatsRender();
    els.trainerAnswer.hidden = true;
    els.trainerNext.hidden = false;
    els.trainerFeedback.className = `trainer-feedback ${correct ? 'is-correct' : 'is-wrong'}`;
    els.trainerFeedback.textContent = correct
      ? `Correct. Running count ${trainerRunningCount} in ${Math.round(response)} ms.`
      : `Not quite. The running count was ${trainerRunningCount}; you answered ${value}.`;
    els.trainerPrompt.textContent = correct
      ? 'Keep the rhythm. Start the next batch when ready.'
      : 'Review the card strip above, then try another batch.';
    els.trainerState.textContent = correct ? 'Correct' : 'Missed';
    els.trainerNext.focus();
  }

  function startTrainer() {
    resetTrainerDrill();
    trainerRunning = true;
    trainerShoe = freshCounts(Number(rules.decks === 'infinite' ? 6 : rules.decks));
    trainerDrillSeed = Number(els.trainerSeed.value) >>> 0;
    trainerRng = mulberry32((trainerDrillSeed + trainerStats.drills * 7919) >>> 0);
    trainerRunningCount = 0;
    trainerDrillCards = [];
    trainerCardsSeen = 0;
    els.trainerFeedback.textContent = '';
    els.trainerPrompt.textContent = 'Watch the cards. Count down and up with the selected system.';
    els.trainerState.textContent = 'Running';
    els.trainerState.classList.add('is-live');
    els.trainerStart.textContent = 'Restart';
    els.trainerStop.disabled = false;
    els.trainerSeen.innerHTML = '';
    drawNextTrainerCard();
    const speed = Number(els.trainerSpeed.value);
    trainerTimer = setInterval(drawNextTrainerCard, speed);
  }

  els.trainerStart.addEventListener('click', startTrainer);
  els.trainerStop.addEventListener('click', stopTrainer);
  els.trainerCheck.addEventListener('click', checkTrainerAnswer);
  els.trainerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      checkTrainerAnswer();
    }
  });
  els.trainerNext.addEventListener('click', () => {
    startTrainer();
  });

  // ---------------------------------------------------------------- wiring
  els.system.addEventListener('change', () => {
    countSystemId = els.system.value;
    onCountSystemChange?.(countSystemId);
    updateSystemLabels();
    resetTrainerDrill();
    trainerStats = { drills: 0, correct: 0, responseMs: 0, cards: 0 };
    trainerStatsRender();
  });

  els.edgeRun.addEventListener('click', runEdge);
  els.rampRun.addEventListener('click', runRamp);
  els.rampStop.addEventListener('click', stopRamp);
  els.rampPreset.addEventListener('change', syncRampControls);
  els.indicesRun.addEventListener('click', runIndices);
  els.qualityRun.addEventListener('click', runQuality);

  function setRules(nextRules) {
    rules = nextRules;
    edgeClient.cancel();
    rampClient.cancel();
    indicesClient.cancel();
    qualityClient.cancel();
    edgeRunning = false;
    indicesRunning = false;
    rampRunning = false;
    qualityRunning = false;
    edgeCurve = null;
    indices = null;
    selectedIndexId = null;
    scatter = null;
    rampResult = null;
    els.edgeRun.disabled = false;
    els.rampRun.disabled = false;
    els.rampStop.disabled = true;
    els.indicesRun.disabled = false;
    els.qualityRun.disabled = false;
    els.edgeState.textContent = 'Idle';
    els.edgeState.classList.remove('is-live');
    els.rampState.textContent = 'Idle';
    els.rampState.classList.remove('is-live');
    els.indicesState.textContent = 'Idle';
    els.indicesState.classList.remove('is-live');
    els.qualityState.textContent = 'Idle';
    els.qualityState.classList.remove('is-live');
    els.rampEmpty.hidden = false;
    els.qualityEmpty.hidden = false;
    renderEdgeMetrics();
    drawEdgeChart();
    renderRampStats();
    drawRampChart();
    renderIndices();
    clearIndexDetail();
    renderQuality();
    drawQualityChart();
    resetEdge();
    syncRampControls();
    stopTrainer();
    trainerStats = { drills: 0, correct: 0, responseMs: 0, cards: 0 };
    trainerStatsRender();
  }

  function setTarget(nextTarget) {
    target = nextTarget;
  }

  function setCountSystem(id) {
    countSystemId = id;
    updateSystemLabels();
    resetTrainerDrill();
  }

  function redraw() {
    if (activeTab === 'edge') drawEdgeChart();
    if (activeTab === 'ramp') drawRampChart();
    if (activeTab === 'indices') drawIndexDetail();
    if (activeTab === 'quality') drawQualityChart();
  }

  updateSystemLabels();
  syncRampControls();
  renderEdgeMetrics();
  renderRampStats();
  renderIndices();
  renderQuality();
  trainerStatsRender();
  resetEdge();
  drawRampChart();
  drawQualityChart();

  return {
    setRules,
    setTarget,
    setCountSystem,
    redraw,
    switchTab,
  };
}
