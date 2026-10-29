import { makeRules, ruleSummary } from './engine/rules.js';
import { diffCharts } from './solver/chart.js';
import { SolverClient } from './workers/solver-client.js';
import { mountRulesPanel } from './ui/rules-panel.js';
import { setupTabs } from './ui/tabs.js';
import { mountStrategyView } from './ui/strategy-view.js';
import { formatEdge } from './ui/format.js';
import { mountSimulationView } from './ui/sim-view.js';
import { mountCountingView } from './ui/counting-view.js';
import { mountPlayView } from './ui/play-view.js';

const els = {
  houseEdge: document.querySelector('#house-edge'),
  houseEdgeNote: document.querySelector('#house-edge-note'),
  ruleChips: document.querySelector('#rule-chips'),
  rulesMount: document.querySelector('#rules-controls'),
  status: document.querySelector('#solver-status'),
  statusText: document.querySelector('#solver-status-text'),
  charts: document.querySelector('#strategy-charts'),
  detail: document.querySelector('#cell-detail'),
  diff: document.querySelector('#diff-banner'),
  tablist: document.querySelector('.tabs'),
  solveMeta: document.querySelector('#solve-meta'),
};

const panels = {
  strategy: document.querySelector('#panel-strategy'),
  simulation: document.querySelector('#panel-simulation'),
  counting: document.querySelector('#panel-counting'),
  play: document.querySelector('#panel-play'),
};

const state = {
  rules: makeRules(),
  chart: null,
  previousChart: null,
  diff: null,
  selected: { section: 'hard', value: 16, upcard: 10 },
  requestId: 0,
  edgeToken: 0,
  pending: false,
  lastError: null,
  lastMs: 0,
  edge: null,
  edgeTarget: null,
  edgePending: false,
  countSystemId: 'hi-lo',
};

let solver = null;
let edgeSolver = null;
let solverError = null;
try {
  solver = new SolverClient();
  edgeSolver = new SolverClient();
} catch (error) {
  solverError = error;
}

function renderRuleChips() {
  els.ruleChips.innerHTML = ruleSummary(state.rules)
    .map((label) => `<span class="rule-chip">${label}</span>`)
    .join('');
}

function renderStatus() {
  if (state.lastError) {
    els.status.hidden = false;
    els.status.classList.add('is-error');
    els.status.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span id="solver-status-text">${state.lastError}</span>`;
    return;
  }
  if (state.pending) {
    els.status.hidden = false;
    els.status.classList.remove('is-error');
    els.status.innerHTML = '<span class="spinner" aria-hidden="true"></span><span id="solver-status-text">Re-solving the exact chart…</span>';
    return;
  }
  els.status.hidden = true;
  els.status.classList.remove('is-error');
  els.status.innerHTML = '';
}

function edgeIsFinite() {
  return state.rules.decks !== 'infinite';
}

function currentEdgeView() {
  if (state.edge) return state.edge;
  if (!state.chart) return null;
  return {
    houseEdge: state.chart.houseEdge,
    exact: !edgeIsFinite(),
    model: edgeIsFinite() ? 'fresh-finite' : 'infinite',
    approximation: edgeIsFinite() ? 'fresh-shoe edge is still solving' : null,
    pending: state.edgePending,
  };
}

function renderHeader(chart) {
  if (!chart) return;
  const edge = currentEdgeView();
  els.houseEdge.textContent = formatEdge(edge?.houseEdge ?? chart.houseEdge, 3);
  if (state.edgePending) {
    els.houseEdgeNote.textContent = 'Solving fresh-shoe edge…';
  } else if (!edgeIsFinite()) {
    els.houseEdgeNote.textContent = 'Infinite-deck model · exact';
  } else if (edge?.incomplete) {
    els.houseEdgeNote.textContent = 'Approximate · solver budget reached';
  } else {
    els.houseEdgeNote.textContent = 'Fresh-shoe fixed strategy · composition-aware';
  }
  els.houseEdge.title = `Player EV ${formatEdge(-(edge?.houseEdge ?? chart.houseEdge), 3)} per initial bet; positive house edge favors the casino.`;
  renderRuleChips();
}

function renderEdgeTarget() {
  const edge = currentEdgeView();
  state.edgeTarget = edge ? {
    edge: edge.houseEdge,
    exact: Boolean(edge.exact),
    model: edge.model,
    note: edge.approximation,
  } : null;
  simulationView?.setTarget(state.edgeTarget);
  countingView?.setTarget(state.edgeTarget);
}

async function solveEdge(rules, token) {
  if (!edgeSolver) return;
  if (rules.decks === 'infinite') {
    state.edge = {
      houseEdge: state.chart.houseEdge,
      exact: true,
      model: 'infinite',
      approximation: null,
      pending: false,
      incomplete: false,
    };
    state.edgePending = false;
    renderHeader(state.chart);
    renderEdgeTarget();
    return;
  }

  state.edgePending = true;
  state.edge = null;
  renderHeader(state.chart);
  renderEdgeTarget();
  try {
    const data = await edgeSolver.edge(rules, (progress) => {
      if (token !== state.edgeToken) return;
      if (progress?.phase) {
        els.houseEdgeNote.textContent = `${progress.phase}…`;
      }
    });
    if (token !== state.edgeToken) return;
    state.edge = { ...data.edge, pending: false };
    state.edgePending = false;
    renderHeader(state.chart);
    renderEdgeTarget();
  } catch (error) {
    if (token !== state.edgeToken) return;
    state.edgePending = false;
    state.edge = {
      houseEdge: state.chart.houseEdge,
      exact: false,
      model: 'fallback',
      approximation: error?.message ?? 'the fresh-shoe edge solver failed',
      incomplete: true,
    };
    renderHeader(state.chart);
    renderEdgeTarget();
  }
}

function renderSolveMeta(chart) {
  if (!chart) {
    els.solveMeta.textContent = '';
    return;
  }
  const nodes = new Intl.NumberFormat().format(chart.nodes);
  els.solveMeta.textContent = `Solved ${nodes} player states in ${Math.max(1, Math.round(state.lastMs))} ms.`;
}

async function recompute({ withDiff = true } = {}) {
  if (!solver) {
    state.lastError = solverError?.message
      ? `${solverError.message}. Open the app from a static HTTP server in a modern browser.`
      : 'The solver worker is unavailable. Open the app from a static HTTP server in a modern browser.';
    renderStatus();
    return;
  }

  const id = ++state.requestId;
  state.pending = true;
  state.lastError = null;
  state.edge = null;
  state.edgePending = edgeIsFinite();
  state.edgeToken++;
  const token = state.edgeToken;
  simulationView?.setRules();
  renderStatus();
  const started = performance.now();

  try {
    const chart = await solver.chart(state.rules, (progress) => {
      if (id !== state.requestId) return;
      if (progress?.phase && els.statusText) {
        els.statusText.textContent = `${progress.phase}…`;
      }
    });
    if (id !== state.requestId) return;

    const previous = state.chart;
    state.lastMs = performance.now() - started;
    state.chart = chart;
    state.previousChart = previous;
    state.diff = withDiff && previous ? diffCharts(previous, chart) : null;
    state.pending = false;

    // The normalized rules may differ (for example, surrender is disabled in
    // ENHC). Keep the controls and header in sync with what was actually solved.
    state.rules = chart.rules;
    state.chart = chart;

    rulesPanel.update(state.rules);
    renderHeader(chart);
    renderSolveMeta(chart);
    view.render(chart, state.diff, state.selected);
    renderStatus();
    renderEdgeTarget();
    countingView?.setRules(state.rules);
    playView?.setChart(chart);
    playView?.setRules(state.rules);
    solveEdge(state.rules, token);
  } catch (error) {
    if (id !== state.requestId) return;
    state.pending = false;
    state.lastError = error?.message || 'The solver failed.';
    renderStatus();
  }
}

const rulesPanel = mountRulesPanel(els.rulesMount, state.rules, (rules) => {
  state.rules = rules;
  recompute({ withDiff: true });
});

const view = mountStrategyView({
  chartsEl: els.charts,
  detailEl: els.detail,
  diffEl: els.diff,
  onSelect(selection) {
    state.selected = selection;
  },
});

const simulationView = mountSimulationView({
  root: panels.simulation,
  getRules: () => state.rules,
  getTarget: () => state.edgeTarget,
});

let playView = null;
const countingView = mountCountingView({
  root: panels.counting,
  getRules: () => state.rules,
  getTarget: () => state.edgeTarget,
  getCountSystem: () => state.countSystemId,
  onCountSystemChange(id) {
    state.countSystemId = id;
    playView?.setCountSystem(id);
  },
});

playView = mountPlayView({
  root: panels.play,
  getRules: () => state.rules,
  getChart: () => state.chart,
  getCountSystem: () => state.countSystemId,
  onCountSystemChange(id) {
    state.countSystemId = id;
    countingView.setCountSystem(id);
  },
});

setupTabs(els.tablist, panels, (name) => {
  if (name === 'strategy') {
    requestAnimationFrame(() => view.redraw());
  } else if (name === 'simulation') {
    requestAnimationFrame(() => simulationView.redraw());
  } else if (name === 'counting') {
    requestAnimationFrame(() => countingView.redraw());
  } else if (name === 'play') {
    requestAnimationFrame(() => playView?.redraw());
  }
});

// Initial shell state.
els.charts.innerHTML = `
  <div class="loading-card" role="status">
    <span class="spinner spinner-large" aria-hidden="true"></span>
    <div><strong>Solving the exact chart</strong><p>The dealer distribution and every hand state are being computed.</p></div>
  </div>
`;
els.detail.innerHTML = `
  <div class="loading-card loading-card-quiet">
    <div><strong>Cell detail</strong><p>Pick any cell to see the EV of every legal action and the dealer’s outcome distribution.</p></div>
  </div>
`;
renderRuleChips();
renderStatus();
recompute({ withDiff: false });
