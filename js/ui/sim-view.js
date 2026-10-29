import { SimClient } from '../workers/sim-client.js';
import { STRATEGIES, strategyById } from '../sim/strategies.js';
import { drawLineChart } from './line-chart.js';
import {
  escapeHtml,
  formatEdge,
  formatEdgeDelta,
  formatNumber,
  formatProbability,
} from './format.js';

const HAND_OPTIONS = [
  { value: 10_000, label: '10,000' },
  { value: 100_000, label: '100,000' },
  { value: 1_000_000, label: '1 million' },
  { value: 5_000_000, label: '5 million' },
  { value: 10_000_000, label: '10 million' },
];

const COMPARE_STRATEGIES = ['optimal', 'deviations', 'mimic', 'neverBust', 'alwaysStand', 'random'];

function seedValue() {
  return 20261028;
}

function handsLabel(value) {
  return HAND_OPTIONS.find((o) => o.value === value)?.label ?? formatNumber(value);
}

function modeLabel(mode) {
  if (mode === 'fresh') return 'Fresh shoe each hand';
  if (mode === 'finite') return 'Continuous shoe';
  return 'Infinite deck';
}

function renderStrategyRows(results, target) {
  const optimalEdge = results.get('optimal')?.snapshot?.houseEdge ?? null;
  return COMPARE_STRATEGIES.map((id) => {
    const meta = strategyById(id);
    const result = results.get(id);
    const snapshot = result?.snapshot;
    const edge = snapshot?.houseEdge ?? null;
    const cost = edge != null && optimalEdge != null ? edge - optimalEdge : null;
    const width = edge == null ? 0 : Math.min(100, Math.max(2, (Math.abs(edge) / 3) * 100));
    return `
      <tr class="${id === 'optimal' ? 'is-reference' : ''}">
        <th scope="row">
          <span class="strategy-name">${escapeHtml(meta.name)}</span>
          <span class="strategy-desc">${escapeHtml(meta.description)}</span>
        </th>
        <td class="num">${edge == null ? '—' : formatEdge(edge)}</td>
        <td class="num">${snapshot ? `±${(snapshot.ci95 * 100).toFixed(3)}%` : '—'}</td>
        <td class="num ${cost != null && cost > 0.0005 ? 'is-cost' : cost != null && cost < -0.0005 ? 'is-gain' : ''}">${cost == null ? '—' : formatEdgeDelta(cost)}</td>
        <td class="compare-bar-cell" aria-hidden="true"><span class="compare-bar" style="width:${width}%"></span></td>
      </tr>
    `;
  }).join('');
}

function agreementText(snapshot, target) {
  if (!snapshot || !target) return '';
  const diff = snapshot.houseEdge - target.edge;
  const se = snapshot.se * 100;
  const z = se > 0 ? Math.abs(diff) / se : 0;
  const within = Math.abs(diff) <= snapshot.ci95 * 100;
  if (within) {
    return `The simulated edge is ${formatEdge(snapshot.houseEdge)} and the reference is ${formatEdge(target.edge)}. The gap is ${Math.abs(diff).toFixed(3)} points, inside the 95% band (±${(snapshot.ci95 * 100).toFixed(3)}). That is a ${z.toFixed(2)}σ difference: the simulation agrees with the exact model within error.`;
  }
  return `The simulated edge is ${formatEdge(snapshot.houseEdge)} and the reference is ${formatEdge(target.edge)}. The gap is ${Math.abs(diff).toFixed(3)} points, currently outside the 95% band (±${(snapshot.ci95 * 100).toFixed(3)}). That is ${z.toFixed(2)}σ; add hands before drawing a conclusion.`;
}

export function mountSimulationView({ root, getRules, getTarget }) {
  root.innerHTML = `
    <div class="module-head">
      <div>
        <p class="eyebrow">Module 03 · proof by simulation</p>
        <h1>Make the number move.</h1>
        <p class="lede">Run the same strategy over millions of seeded hands. The running average should walk toward the solver’s number, and the 95% band should close around it.</p>
      </div>
      <div class="module-badge">
        <span class="module-badge-label">Reference</span>
        <strong id="sim-target">—</strong>
        <span id="sim-target-note">Waiting for the solver</span>
      </div>
    </div>

    <div class="sim-layout">
      <section class="control-card sim-controls" aria-labelledby="sim-run-title">
        <div class="control-head">
          <h2 id="sim-run-title">Run</h2>
          <span class="status-pill" id="sim-state">Idle</span>
        </div>
        <div class="form-grid">
          <label class="field" for="sim-hands">
            <span class="field-label">Hands</span>
            <select id="sim-hands">
              ${HAND_OPTIONS.map((o) => `<option value="${o.value}"${o.value === 1_000_000 ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </label>
          <label class="field" for="sim-seed">
            <span class="field-label">Seed</span>
            <input id="sim-seed" type="number" min="0" max="4294967295" step="1" value="${seedValue()}" inputmode="numeric">
          </label>
          <label class="field" for="sim-mode">
            <span class="field-label">Deal model</span>
            <select id="sim-mode">
              <option value="fresh" selected>Fresh shoe each hand (proof)</option>
              <option value="finite">Continuous shoe (realistic)</option>
              <option value="infinite">Infinite deck</option>
            </select>
            <span class="field-help" id="sim-mode-help">The exact target is the fresh-shoe model.</span>
          </label>
          <label class="field" for="sim-penetration">
            <span class="field-label">Penetration</span>
            <select id="sim-penetration">
              <option value="0.5">50%</option>
              <option value="0.65">65%</option>
              <option value="0.75" selected>75%</option>
              <option value="0.85">85%</option>
              <option value="0.9">90%</option>
            </select>
            <span class="field-help">Only used by a continuous shoe.</span>
          </label>
        </div>
        <div class="control-actions">
          <button class="btn btn-primary" type="button" id="sim-run">Run simulation</button>
          <button class="btn" type="button" id="sim-stop" disabled>Stop</button>
          <button class="btn" type="button" id="sim-compare">Compare strategies</button>
        </div>
        <div class="progress-wrap" aria-label="Simulation progress">
          <div class="progress-track"><span id="sim-progress" class="progress-fill" style="width:0%"></span></div>
          <div class="progress-meta"><span id="sim-progress-text">No run yet.</span><span id="sim-speed"></span></div>
        </div>
        <p class="fine-print" id="sim-model-note">Every hand is deterministic from the seed. The run uses the strategy chart at the current rules.</p>
      </section>

      <section class="chart-card sim-chart-card" aria-labelledby="sim-chart-title">
        <div class="chart-card-head">
          <div>
            <h2 id="sim-chart-title">Convergence</h2>
            <p>Running house edge per hand with a 95% confidence band. Lower is better for the player.</p>
          </div>
          <div class="chart-legend">
            <span><i class="legend-line"></i> running edge</span>
            <span><i class="legend-band"></i> 95% band</span>
            <span><i class="legend-target"></i> exact target</span>
          </div>
        </div>
        <div class="canvas-wrap chart-tall">
          <canvas id="sim-chart" role="img" aria-label="Running simulation edge converging toward the exact target"></canvas>
        </div>
        <div class="metric-strip" id="sim-metrics">
          <div><span>Hands</span><strong>0</strong></div>
          <div><span>Simulated edge</span><strong>—</strong></div>
          <div><span>Standard error</span><strong>—</strong></div>
          <div><span>95% interval</span><strong>—</strong></div>
        </div>
        <p class="sim-verdict" id="sim-verdict" role="status">Run the simulation to see whether the Monte Carlo result agrees with the exact answer.</p>
      </section>
    </div>

    <section class="compare-card" aria-labelledby="compare-title">
      <div class="chart-card-head">
        <div>
          <h2 id="compare-title">Same seed, six strategies</h2>
          <p>The optimal chart is the benchmark. A positive cost is how many percentage points of edge a strategy gives away.</p>
        </div>
        <span class="status-pill" id="compare-state">Not run</span>
      </div>
      <div class="table-scroll">
        <table class="data-table compare-table">
          <thead>
            <tr><th scope="col">Strategy</th><th scope="col">House edge</th><th scope="col">95% error</th><th scope="col">Cost vs optimal</th><th scope="col" aria-label="Relative edge bar"></th></tr>
          </thead>
          <tbody id="compare-body">
            ${renderStrategyRows(new Map(), null)}
          </tbody>
        </table>
      </div>
      <p class="fine-print" id="compare-note">Comparisons use the same seed and hand count. The with-indices strategy uses the standard Illustrious-18-style thresholds from the counting lab.</p>
    </section>
  `;

  const els = {
    hands: root.querySelector('#sim-hands'),
    seed: root.querySelector('#sim-seed'),
    mode: root.querySelector('#sim-mode'),
    penetration: root.querySelector('#sim-penetration'),
    run: root.querySelector('#sim-run'),
    stop: root.querySelector('#sim-stop'),
    compare: root.querySelector('#sim-compare'),
    progress: root.querySelector('#sim-progress'),
    progressText: root.querySelector('#sim-progress-text'),
    speed: root.querySelector('#sim-speed'),
    state: root.querySelector('#sim-state'),
    compareState: root.querySelector('#compare-state'),
    compareBody: root.querySelector('#compare-body'),
    compareNote: root.querySelector('#compare-note'),
    chart: root.querySelector('#sim-chart'),
    metrics: root.querySelector('#sim-metrics'),
    verdict: root.querySelector('#sim-verdict'),
    target: root.querySelector('#sim-target'),
    targetNote: root.querySelector('#sim-target-note'),
    modelNote: root.querySelector('#sim-model-note'),
    modeHelp: root.querySelector('#sim-mode-help'),
  };

  const client = new SimClient();
  let samples = [];
  let lastSnapshot = null;
  let running = false;
  let startedAt = 0;
  let comparison = new Map();
  let target = getTarget();

  function currentMode() {
    if (getRules().decks === 'infinite') return 'infinite';
    return els.mode.value;
  }

  function effectiveTarget(mode) {
    if (!target) return null;
    if (mode === 'fresh' || mode === 'infinite') return target;
    // A continuous shoe has a different average composition; the fresh-shoe
    // edge is still the right visual reference, but it is not an exact target.
    return target;
  }

  function renderTarget() {
    const mode = currentMode();
    const t = effectiveTarget(mode);
    if (!t) {
      els.target.textContent = '—';
      els.targetNote.textContent = 'Waiting for the solver';
      return;
    }
    els.target.textContent = formatEdge(t.edge);
    if (mode === 'finite') {
      els.targetNote.textContent = 'Fresh-shoe reference (continuous shoe differs slightly)';
    } else if (mode === 'infinite') {
      els.targetNote.textContent = 'Exact infinite-deck edge';
    } else {
      els.targetNote.textContent = t.exact ? 'Exact infinite-deck edge' : 'Fresh-shoe fixed-strategy edge';
    }
  }

  function renderMetrics() {
    if (!lastSnapshot) {
      els.metrics.innerHTML = `
        <div><span>Hands</span><strong>0</strong></div>
        <div><span>Simulated edge</span><strong>—</strong></div>
        <div><span>Standard error</span><strong>—</strong></div>
        <div><span>95% interval</span><strong>—</strong></div>
      `;
      return;
    }
    const s = lastSnapshot;
    els.metrics.innerHTML = `
      <div><span>Hands</span><strong>${formatNumber(s.hands)}</strong></div>
      <div><span>Simulated edge</span><strong>${formatEdge(s.houseEdge)}</strong></div>
      <div><span>Standard error</span><strong>±${(s.se * 100).toFixed(3)}%</strong></div>
      <div><span>95% interval</span><strong>${formatEdge(s.edgeLow)} to ${formatEdge(s.edgeHigh)}</strong></div>
    `;
  }

  function drawChart() {
    const mode = currentMode();
    const t = effectiveTarget(mode);
    const points = samples.map((s) => ({ x: s.hands, y: s.houseEdge }));
    const band = samples.map((s) => ({ x: s.hands, low: s.edgeLow, high: s.edgeHigh }));
    drawLineChart(els.chart, {
      series: [{ points, color: '#5eead4', width: 2 }],
      band: { points: band, color: 'rgba(94, 234, 212, 0.13)' },
      target: t ? { value: t.edge, label: `target ${formatEdge(t.edge)}` } : null,
      xLog: true,
      xLabel: 'hands (log scale)',
      yLabel: 'house edge %',
      height: 330,
      yDomain: points.length ? undefined : [0.2, 0.8],
      formatX: (v) => formatNumber(v),
      formatY: (v) => `${v.toFixed(2)}%`,
      ariaLabel: points.length
        ? `Running house edge after ${formatNumber(points[points.length - 1].x)} hands: ${formatEdge(points[points.length - 1].y)}.`
        : 'Convergence chart with no data yet.',
    });
  }

  function resetChart() {
    samples = [];
    lastSnapshot = null;
    drawChart();
    renderMetrics();
    els.progress.style.width = '0%';
    els.progressText.textContent = 'No run yet.';
    els.speed.textContent = '';
    els.verdict.textContent = 'Run the simulation to see whether the Monte Carlo result agrees with the exact answer.';
  }

  function setRunning(value) {
    running = value;
    els.run.disabled = value;
    els.compare.disabled = value;
    els.stop.disabled = !value;
    els.state.textContent = value ? 'Running' : 'Idle';
    els.state.classList.toggle('is-live', value);
  }

  function showError(error) {
    setRunning(false);
    els.progressText.textContent = error.message ?? 'Simulation failed.';
    els.state.textContent = 'Error';
    els.verdict.textContent = `Simulation failed: ${error.message ?? error}`;
  }

  async function run() {
    if (running) return;
    const rules = getRules();
    let mode = currentMode();
    if (rules.decks === 'infinite') mode = 'infinite';
    const hands = Number(els.hands.value);
    const seed = Number(els.seed.value) >>> 0;
    resetChart();
    setRunning(true);
    startedAt = performance.now();
    els.progressText.textContent = `Starting ${formatNumber(hands)} hands…`;
    els.modelNote.textContent = `${modeLabel(mode)} · seed ${seed} · ${handsLabel(hands)} hands.`;
    try {
      const result = await client.run({
        rules,
        strategy: 'optimal',
        seed,
        hands,
        shoeMode: mode,
        penetration: Number(els.penetration.value),
        countSystemId: 'hi-lo',
      }, {
        onSample: (data) => {
          samples.push(data.snapshot);
          lastSnapshot = data.snapshot;
          const pct = Math.min(100, (data.snapshot.hands / hands) * 100);
          els.progress.style.width = `${pct}%`;
          els.progressText.textContent = `${formatNumber(data.snapshot.hands)} of ${formatNumber(hands)} hands · edge ${formatEdge(data.snapshot.houseEdge)}`;
          const elapsed = (performance.now() - startedAt) / 1000;
          els.speed.textContent = elapsed > 0.1
            ? `${formatNumber(data.snapshot.hands / elapsed)} hands/s`
            : '';
          drawChart();
          renderMetrics();
        },
        onResult: (data) => {
          samples.push(data.snapshot);
          lastSnapshot = data.snapshot;
          els.progress.style.width = '100%';
          els.progressText.textContent = `${formatNumber(data.snapshot.hands)} hands complete · ${formatEdge(data.snapshot.houseEdge)} edge`;
          const t = effectiveTarget(mode);
          els.verdict.textContent = t
            ? agreementText(data.snapshot, t)
            : `${formatNumber(data.snapshot.hands)} hands complete. The exact target is not available yet.`;
          drawChart();
          renderMetrics();
        },
      });
      setRunning(false);
      return result;
    } catch (error) {
      showError(error);
      return null;
    }
  }

  async function compare() {
    if (running) return;
    const rules = getRules();
    let mode = currentMode();
    if (rules.decks === 'infinite') mode = 'infinite';
    const hands = Number(els.hands.value);
    const seed = Number(els.seed.value) >>> 0;
    comparison = new Map();
    els.compareBody.innerHTML = renderStrategyRows(comparison, effectiveTarget(mode));
    els.compareState.textContent = 'Running';
    els.compareState.classList.add('is-live');
    els.compareNote.textContent = `${formatNumber(hands)} hands per strategy, seed ${seed}, ${modeLabel(mode)}.`;
    setRunning(true);
    els.progressText.textContent = `Comparing ${COMPARE_STRATEGIES.length} strategies…`;
    try {
      await client.compare({
        rules,
        strategies: COMPARE_STRATEGIES,
        seed,
        hands,
        shoeMode: mode,
        penetration: Number(els.penetration.value),
        countSystemId: 'hi-lo',
      }, {
        onProgress: (data) => {
          comparison.set(data.strategy, data);
          els.compareBody.innerHTML = renderStrategyRows(comparison, effectiveTarget(mode));
          const done = data.snapshot?.hands ?? 0;
          els.progress.style.width = `${Math.min(100, (done / hands) * 100)}%`;
          els.progressText.textContent = `${strategyById(data.strategy).name} · ${formatNumber(done)} hands`;
        },
        onResult: (data) => {
          comparison.set(data.strategy, data);
          els.compareBody.innerHTML = renderStrategyRows(comparison, effectiveTarget(mode));
        },
      });
      els.compareState.textContent = 'Complete';
      els.compareState.classList.remove('is-live');
      els.progress.style.width = '100%';
      els.progressText.textContent = `Compared ${COMPARE_STRATEGIES.length} strategies on the same seed.`;
      const optimal = comparison.get('optimal')?.snapshot;
      if (optimal) {
        els.verdict.textContent = `Optimal chart: ${formatEdge(optimal.houseEdge)} ±${(optimal.ci95 * 100).toFixed(3)}. Every other row is measured against it.`;
      }
    } catch (error) {
      els.compareState.textContent = 'Error';
      showError(error);
    }
  }

  els.run.addEventListener('click', run);
  els.stop.addEventListener('click', () => {
    client.cancel();
    setRunning(false);
    els.progressText.textContent = 'Stopped by user. Samples already collected remain on the chart.';
  });
  els.compare.addEventListener('click', compare);
  els.mode.addEventListener('change', () => {
    const mode = currentMode();
    els.penetration.disabled = mode !== 'finite';
    els.modeHelp.textContent = mode === 'fresh'
      ? 'The exact target is the fresh-shoe model.'
      : mode === 'finite'
        ? 'A cut card changes the average composition; the target line is a reference.'
        : 'Draws with replacement; composition effects disappear.';
    renderTarget();
    if (!running) drawChart();
  });
  els.hands.addEventListener('change', () => {
    if (!running) resetChart();
  });
  els.seed.addEventListener('change', () => {
    if (!running) resetChart();
  });

  function setRules() {
    client.cancel();
    setRunning(false);
    target = getTarget();
    if (getRules().decks === 'infinite') {
      els.mode.value = 'infinite';
      els.penetration.disabled = true;
    } else if (els.mode.value === 'infinite') {
      els.mode.value = 'fresh';
      els.penetration.disabled = false;
    }
    renderTarget();
    resetChart();
  }

  function setTarget(nextTarget) {
    target = nextTarget;
    renderTarget();
    drawChart();
  }

  renderTarget();
  els.penetration.disabled = currentMode() !== 'finite';
  drawChart();
  renderMetrics();

  return {
    setRules,
    setTarget,
    redraw() {
      drawChart();
    },
  };
}
