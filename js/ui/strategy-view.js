import {
  ACTION_ORDER,
  actionClass,
  actionName,
  escapeHtml,
  formatEdge,
  formatEdgeDelta,
  formatEV,
  formatProbability,
  upcardLabel,
} from './format.js';
import { drawDealerDistribution, distributionSummary } from './canvas.js';

const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const SECTIONS = [
  {
    key: 'hard',
    title: 'Hard totals',
    blurb: 'No ace is currently counted as 11.',
  },
  {
    key: 'soft',
    title: 'Soft totals',
    blurb: 'One ace is counted as 11; the row stays soft until it must drop.',
  },
  {
    key: 'pairs',
    title: 'Pairs',
    blurb: 'Split EVs include both hands and the extra wager.',
  },
];

function keyOf(section, value, upcard) {
  return `${section}:${value}:${upcard}`;
}

function findSelection(chart, selected) {
  const rows = chart[selected.section] ?? chart.hard;
  const row = rows.find((r) => r.value === selected.value) ?? rows[0];
  const col = Math.max(0, UPCARDS.indexOf(selected.upcard));
  const upcard = UPCARDS.includes(selected.upcard) ? selected.upcard : UPCARDS[col];
  const cell = row.cells[UPCARDS.indexOf(upcard)];
  return { rows, row, cell, section: selected.section, value: row.value, upcard };
}

function rowHeading(section, row, upcard) {
  const dealer = `dealer ${upcardLabel(upcard)}`;
  if (section === 'hard') return `Hard ${row.label} vs ${dealer}`;
  if (section === 'soft') return `Soft ${row.value} (${row.label}) vs ${dealer}`;
  return `Pair ${row.label} vs ${dealer}`;
}

function rowAria(section, row, upcard) {
  if (section === 'hard') return `Hard ${row.label} versus dealer ${upcardLabel(upcard)}`;
  if (section === 'soft') return `Soft ${row.value}, ${row.label}, versus dealer ${upcardLabel(upcard)}`;
  return `Pair of ${row.label} versus dealer ${upcardLabel(upcard)}`;
}

function flipMap(diff) {
  const map = new Map();
  for (const flip of diff?.flips ?? []) {
    map.set(keyOf(flip.section, flip.value, flip.upcard), flip);
  }
  return map;
}

function buildTable(chart, section, diffFlips, selectedKey) {
  const meta = SECTIONS.find((s) => s.key === section);
  const rows = chart[section];
  const head = UPCARDS.map((u) => `<th scope="col">${upcardLabel(u)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = UPCARDS.map((upcard) => {
      const cell = row.cells[UPCARDS.indexOf(upcard)];
      const key = keyOf(section, row.value, upcard);
      const flip = diffFlips.get(key);
      const selected = selectedKey === key;
      const classes = [
        'strategy-cell',
        actionClass(cell.best),
        selected ? 'selected' : '',
        flip ? 'flipped' : '',
      ].filter(Boolean).join(' ');
      const change = flip ? ` Changed from ${actionName(flip.from)}.` : '';
      const label = `${rowAria(section, row, upcard)}: ${actionName(cell.best)}, expected value ${formatEV(cell.ev)}.${change}`;
      return `<td><button type="button" class="${classes}" data-cell="${key}" data-section="${section}" data-value="${row.value}" data-upcard="${upcard}" aria-pressed="${selected}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="action-letter">${cell.best}</span>${flip ? '<span class="flip-dot" aria-hidden="true"></span>' : ''}</button></td>`;
    }).join('');
    return `<tr><th scope="row">${escapeHtml(row.label)}</th>${cells}</tr>`;
  }).join('');

  return `
    <section class="chart-card" aria-labelledby="chart-${section}-title">
      <div class="chart-card-head">
        <div>
          <h3 id="chart-${section}-title">${meta.title}</h3>
          <p>${meta.blurb}</p>
        </div>
        <span class="chart-count">${rows.length} rows × ${UPCARDS.length} upcards</span>
      </div>
      <div class="chart-scroll">
        <table class="strategy-table" aria-label="${meta.title} strategy chart">
          <thead><tr><th scope="col" class="hand-col">Hand</th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderLegend() {
  return `
    <div class="chart-toolbar">
      <div class="legend" aria-label="Action legend">
        ${ACTION_ORDER.map((a) => `
          <span class="legend-item ${actionClass(a)}">
            <span class="legend-dot" aria-hidden="true"></span><strong>${a}</strong> ${actionName(a)}
          </span>
        `).join('')}
        <span class="legend-item legend-flip"><span class="flip-dot" aria-hidden="true"></span> changed by latest rule edit</span>
      </div>
      <p class="chart-hint">Click any cell for the EV breakdown. Arrow keys move focus inside a grid.</p>
    </div>
  `;
}

function renderDiffBanner(diff) {
  if (!diff) {
    return { hidden: true, html: '' };
  }
  const count = diff.flips.length;
  const delta = diff.houseEdgeDelta;
  const direction = delta > 0.0000001
    ? 'House edge increased'
    : delta < -0.0000001
      ? 'House edge decreased'
      : 'House edge unchanged';
  const chips = diff.flips.slice(0, 14).map((flip) => {
    const label = `${flip.rowLabel} vs ${flip.upcardLabel}: ${flip.from}→${flip.to}`;
    return `<button type="button" class="diff-chip" data-select-cell="${keyOf(flip.section, flip.value, flip.upcard)}" title="Show ${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  }).join('');
  const more = count > 14 ? `<span class="diff-more">+${count - 14} more</span>` : '';
  const title = count === 0
    ? 'No strategy cells flipped'
    : `${count} cell${count === 1 ? '' : 's'} flipped`;
  return {
    hidden: false,
    html: `
      <div class="diff-icon" aria-hidden="true">Δ</div>
      <div class="diff-copy">
        <strong>${title}</strong>
        <span>${direction} ${formatEdgeDelta(delta)} · ${formatEdge(diff.houseEdgeBefore)} → ${formatEdge(diff.houseEdgeAfter)}</span>
        ${chips ? `<div class="diff-chips">${chips}${more}</div>` : ''}
      </div>
    `,
  };
}

function renderDetail(chart, diff, selection) {
  const found = findSelection(chart, selection);
  const { row, cell, section, upcard } = found;
  const title = rowHeading(section, row, upcard);
  const legal = ACTION_ORDER.filter((a) => cell.actions[a] != null);
  const best = cell.best;
  const bestEV = cell.actions[best];
  const second = legal
    .filter((a) => a !== best)
    .map((a) => ({ action: a, ev: cell.actions[a] }))
    .sort((a, b) => b.ev - a.ev)[0];
  const margin = second ? bestEV - second.ev : null;
  const maxAbs = Math.max(...legal.map((a) => Math.abs(cell.actions[a])), 1e-9);

  const evRows = legal.map((action) => {
    const value = cell.actions[action];
    const width = Math.min(50, (Math.abs(value) / maxAbs) * 50);
    const left = value >= 0 ? 50 : 50 - width;
    const isBest = action === best;
    return `
      <div class="ev-row${isBest ? ' is-best' : ''}" role="img" aria-label="${actionName(action)} expected value ${formatEV(value)}">
        <span class="ev-action"><span class="ev-dot ${actionClass(action)}" aria-hidden="true"></span>${actionName(action)}</span>
        <span class="ev-track"><span class="ev-zero" aria-hidden="true"></span><span class="ev-fill ${actionClass(action)}" style="left:${left}%;width:${width}%"></span></span>
        <span class="ev-value">${formatEV(value)}</span>
      </div>
    `;
  }).join('');

  const dealerData = chart.dealer[upcard];
  const conditional = chart.rules.peek && (upcard === 10 || upcard === 11);
  const dealerDist = conditional ? dealerData.noBJ : dealerData.raw;
  const bustPct = formatProbability(dealerDist.bust, 1);

  let explanation = `The solver prefers <strong>${actionName(best)}</strong> at <strong>${formatEV(bestEV)}</strong> expected bets per initial bet.`;
  if (second) {
    if (margin < 0.0005) {
      explanation += ` ${actionName(second.action)} is essentially tied (${formatEV(second.ev)}).`;
    } else {
      explanation += ` ${actionName(second.action)} is ${margin.toFixed(3)} bets worse (${formatEV(second.ev)}).`;
    }
  }
  if (best === 'D') {
    explanation += ' Doubling adds a second bet and takes exactly one card.';
  } else if (best === 'P') {
    explanation += ' The split EV is the combined net of both hands, including the extra wager and any resplits.';
  } else if (best === 'R') {
    explanation += ' Late surrender gives up half the original bet.';
  } else if (!cell.soft && cell.total >= 12 && cell.total <= 16) {
    explanation += ` This is a dealer-bust decision: the dealer busts ${bustPct} of the time after the peek.`;
  } else if (best === 'S') {
    explanation += ` Standing avoids the risk of drawing into a bust; the dealer busts ${bustPct} of the time.`;
  } else if (best === 'H') {
    explanation += ` The hand cannot win by standing often enough; the dealer busts only ${bustPct} of the time.`;
  }

  const flip = diff?.flips?.find((f) => f.section === section && f.value === row.value && f.upcard === upcard);
  const flipNote = flip
    ? `<p class="detail-flip">Latest rule edit: ${actionName(flip.from)} <span aria-hidden="true">→</span> ${actionName(flip.to)}. The EV gain is ${formatEV(flip.evGain)}.</p>`
    : '';

  return `
    <div class="detail-head">
      <div>
        <p class="eyebrow">Cell detail</p>
        <h3>${escapeHtml(title)}</h3>
        <p class="detail-sub">${chart.rules.peek ? 'US peek' : 'ENHC / no peek'} · ${chart.rules.dealerHitsSoft17 ? 'H17' : 'S17'} · ${chart.rules.doubleAfterSplit ? 'DAS' : 'no DAS'}</p>
      </div>
      <span class="action-badge ${actionClass(best)}"><span class="badge-letter">${best}</span>${actionName(best)}</span>
    </div>
    <div class="detail-grid">
      <div class="detail-col">
        <div class="detail-section-head">
          <h4>Expected value by action</h4>
          <span>per initial bet</span>
        </div>
        <div class="ev-chart">${evRows}</div>
        <p class="ev-note">Positive is good for the player. Bars share a zero line; longer is better, not necessarily positive.</p>
        <p class="explanation">${explanation}</p>
        ${flipNote}
      </div>
      <div class="detail-col">
        <div class="detail-section-head">
          <h4>Dealer outcomes</h4>
          <span>upcard ${upcardLabel(upcard)}${conditional ? ' · after peek' : ''}</span>
        </div>
        <div class="canvas-wrap">
          <canvas id="dealer-dist-canvas" role="img" aria-label="Dealer final total distribution"></canvas>
        </div>
        <p class="fine-print">${distributionSummary(dealerDist)}. ${conditional ? 'Conditional on no dealer blackjack.' : 'Unconditional, including a dealer natural.'}</p>
      </div>
    </div>
  `;
}

/**
 * Mount the strategy view and return its render/selection controls.
 *
 * @param {{
 *   chartsEl: HTMLElement,
 *   detailEl: HTMLElement,
 *   diffEl: HTMLElement,
 *   onSelect?: (selection: {section: string, value: number, upcard: number}) => void,
 * }} options
 */
export function mountStrategyView({ chartsEl, detailEl, diffEl, onSelect }) {
  let chart = null;
  let diff = null;
  let selected = { section: 'hard', value: 16, upcard: 10 };
  let lastDistribution = null;

  function select(next, notify = true) {
    const found = findSelection(chart, next);
    selected = { section: found.section, value: found.value, upcard: found.upcard };
    const selectedKey = keyOf(selected.section, selected.value, selected.upcard);
    for (const button of chartsEl.querySelectorAll('[data-cell]')) {
      const isSelected = button.dataset.cell === selectedKey;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    renderDetailPanel();
    if (notify) onSelect?.(selected);
  }

  function redraw() {
    if (!lastDistribution) return;
    drawDealerDistribution(lastDistribution.canvas, lastDistribution.dist, {
      peek: lastDistribution.conditional,
    });
  }

  function renderDetailPanel() {
    if (!chart) return;
    lastDistribution?.canvas?._distributionObserver?.disconnect();
    detailEl.innerHTML = renderDetail(chart, diff, selected);
    const canvas = detailEl.querySelector('#dealer-dist-canvas');
    if (canvas) {
      const found = findSelection(chart, selected);
      const upcard = found.upcard;
      const conditional = chart.rules.peek && (upcard === 10 || upcard === 11);
      const dealerData = chart.dealer[upcard];
      const dist = conditional ? dealerData.noBJ : dealerData.raw;
      lastDistribution = { canvas, dist, conditional };
      requestAnimationFrame(() => {
        if (canvas.isConnected) {
          drawDealerDistribution(canvas, dist, { peek: conditional });
        }
      });
    } else {
      lastDistribution = null;
    }
  }

  function render(nextChart, nextDiff, nextSelection = selected) {
    chart = nextChart;
    diff = nextDiff;
    const found = findSelection(chart, nextSelection);
    selected = { section: found.section, value: found.value, upcard: found.upcard };
    const selectedKey = keyOf(selected.section, selected.value, selected.upcard);
    const flips = flipMap(diff);

    chartsEl.innerHTML = `
      ${renderLegend()}
      <div class="strategy-grid">
        ${SECTIONS.map((s) => buildTable(chart, s.key, flips, selectedKey)).join('')}
      </div>
    `;

    const banner = renderDiffBanner(diff);
    diffEl.hidden = banner.hidden;
    diffEl.innerHTML = banner.html;

    renderDetailPanel();
  }

  chartsEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-cell]');
    if (!button) return;
    select({
      section: button.dataset.section,
      value: Number(button.dataset.value),
      upcard: Number(button.dataset.upcard),
    });
  });

  chartsEl.addEventListener('keydown', (event) => {
    const button = event.target.closest('button[data-cell]');
    if (!button) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const section = button.dataset.section;
    const value = Number(button.dataset.value);
    const upcard = Number(button.dataset.upcard);
    const rows = chart[section];
    let rowIndex = rows.findIndex((r) => r.value === value);
    let colIndex = UPCARDS.indexOf(upcard);

    if (event.key === 'ArrowUp') rowIndex = Math.max(0, rowIndex - 1);
    else if (event.key === 'ArrowDown') rowIndex = Math.min(rows.length - 1, rowIndex + 1);
    else if (event.key === 'ArrowLeft') colIndex = Math.max(0, colIndex - 1);
    else if (event.key === 'ArrowRight') colIndex = Math.min(UPCARDS.length - 1, colIndex + 1);
    else if (event.key === 'Home') colIndex = 0;
    else if (event.key === 'End') colIndex = UPCARDS.length - 1;

    const next = chartsEl.querySelector(
      `[data-cell="${keyOf(section, rows[rowIndex].value, UPCARDS[colIndex])}"]`,
    );
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  diffEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-select-cell]');
    if (!chip) return;
    const [section, value, upcard] = chip.dataset.selectCell.split(':');
    const cellButton = chartsEl.querySelector(`[data-cell="${chip.dataset.selectCell}"]`);
    if (cellButton) {
      cellButton.focus();
      cellButton.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    select({ section, value: Number(value), upcard: Number(upcard) });
  });

  return {
    render,
    select,
    redraw,
    getSelection() {
      return { ...selected };
    },
  };
}
