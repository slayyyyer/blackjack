import { PlayGame } from '../play/game.js';
import { SolverClient } from '../workers/solver-client.js';
import { buildPolicy, optimalAction } from '../sim/strategies.js';
import {
  ACTION_INFO,
  actionClass,
  actionName,
  escapeHtml,
  formatEV,
  formatNumber,
} from './format.js';

const ACTION_BUTTONS = [
  { id: 'hit', letter: 'H', label: 'Hit', key: 'h' },
  { id: 'stand', letter: 'S', label: 'Stand', key: 's' },
  { id: 'double', letter: 'D', label: 'Double', key: 'd' },
  { id: 'split', letter: 'P', label: 'Split', key: 'p' },
  { id: 'surrender', letter: 'R', label: 'Surrender', key: 'r' },
];

const LETTERS = {
  hit: 'H',
  stand: 'S',
  double: 'D',
  split: 'P',
  surrender: 'R',
};

const ACTIONS_BY_LETTER = {
  H: 'hit',
  S: 'stand',
  D: 'double',
  P: 'split',
  R: 'surrender',
};

const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };

function cardText(card) {
  return `${card.rank}${SUIT_GLYPH[card.suit] ?? ''}`;
}

function cardMarkup(card, hidden = false) {
  if (hidden) {
    return '<span class="card-back" aria-label="Hidden hole card">?</span>';
  }
  const red = card.red ? ' is-red' : '';
  return `<span class="card-rank">${card.rank}</span><span class="card-suit">${SUIT_GLYPH[card.suit] ?? ''}</span>`;
}

function cardAria(card) {
  return `${card.rank} of ${card.suit === 's' ? 'spades' : card.suit === 'h' ? 'hearts' : card.suit === 'd' ? 'diamonds' : 'clubs'}`;
}

function renderCard(card, hidden = false) {
  if (hidden) {
    return `<div class="playing-card is-back" aria-label="Hidden hole card"><span class="card-back">?</span></div>`;
  }
  return `<div class="playing-card${card.red ? ' is-red' : ''}" aria-label="${cardAria(card)}"><span class="card-rank">${card.rank}</span><span class="card-suit">${SUIT_GLYPH[card.suit] ?? ''}</span></div>`;
}

function handTotalLabel(hand) {
  if (hand.surrendered) return 'surrendered';
  if (hand.bust) return `bust ${hand.total}`;
  if (hand.natural) return 'blackjack';
  return hand.soft ? `soft ${hand.total}` : `${hand.total}`;
}

function handCardsText(cards) {
  return cards.map(cardText).join(' ');
}

function renderHand(hand, dealer = false) {
  const cards = hand.cards.map((c) => renderCard(c)).join('');
  const active = hand.active ? ' is-active' : '';
  const total = dealer
    ? (hand.hidden ? `showing ${hand.total}` : handTotalLabel({ ...hand, natural: false }))
    : handTotalLabel(hand);
  const wager = !dealer && hand.wager > 1 ? `<span class="hand-wager">${hand.wager}×</span>` : '';
  return `
    <div class="table-hand${active}${hand.bust ? ' is-bust' : ''}" ${active ? 'aria-current="true"' : ''}>
      <div class="hand-head">
        <span class="hand-label">${dealer ? 'Dealer' : hand.index != null ? `Hand ${hand.index + 1}` : 'Hand'}</span>
        <span class="hand-total">${total}</span>
        ${wager}
      </div>
      <div class="card-row">${cards || '<span class="card-back">?</span>'}</div>
      ${!dealer && hand.net != null ? `<span class="hand-net ${hand.net >= 0 ? 'is-gain' : 'is-cost'}">${hand.net >= 0 ? '+' : ''}${hand.net.toFixed(2)}</span>` : ''}
    </div>
  `;
}

function renderHistoryRow(row) {
  return `
    <tr>
      <td class="num">#${row.id}</td>
      <td>${row.cards.map((cards) => `<span class="mini-cards">${handCardsText(cards)}</span>`).join(' ')}</td>
      <td><span class="mini-cards">${handCardsText(row.dealer)}</span></td>
      <td class="num ${row.net > 0 ? 'is-gain' : row.net < 0 ? 'is-cost' : ''}">${row.net > 0 ? '+' : ''}${row.net.toFixed(2)}</td>
      <td>${escapeHtml(row.note)}</td>
    </tr>
  `;
}

function coachLabel(mode) {
  if (mode === 'off') return 'Off';
  if (mode === 'hint') return 'Hint on request';
  return 'Always on';
}

export function mountPlayView({ root, getRules, getChart, getCountSystem, onCountSystemChange }) {
  root.innerHTML = `
    <div class="module-head play-head">
      <div>
        <p class="eyebrow">Blackjack · the table</p>
        <h1>Sit down. Play.</h1>
        <p class="lede">A real six-deck shoe with a cut card, doubles, splits, insurance, and dealer blackjack checks. The coach will grade your decisions if you leave it on.</p>
      </div>
      <div class="play-bankroll">
        <span class="stat-label">Bankroll</span>
        <strong id="play-bankroll">—</strong>
        <span class="stat-note">units</span>
      </div>
    </div>

    <div class="play-layout">
      <section class="table-card" aria-label="Blackjack table">
        <div class="table-toolbar">
          <div class="shoe-meter">
            <span class="stat-label">Shoe <strong id="play-shoe-number">1</strong></span>
            <div class="shoe-track"><span id="play-shoe-fill"></span></div>
            <span class="stat-note" id="play-shoe-text">—</span>
          </div>
          <div class="table-count">
            <span class="stat-label">Count</span>
            <strong id="play-count-inline">—</strong>
          </div>
        </div>

        <div class="felt">
          <div class="dealer-area" id="play-dealer-area">
            <div class="dealer-line">
              <span class="eyebrow">Dealer</span>
              <span class="dealer-total" id="play-dealer-total">—</span>
            </div>
            <div class="card-row" id="play-dealer-cards"></div>
          </div>

          <div class="felt-line" aria-hidden="true"></div>
          <p class="table-message" id="play-message" role="status" aria-live="polite">Place a bet and deal.</p>

          <div class="player-area" id="play-hand-area"></div>
        </div>

        <div class="insurance-bar" id="play-insurance" hidden>
          <span>Dealer shows an ace. Insurance costs half your bet and pays 2:1 if the hole card is a ten.</span>
          <div>
            <button class="btn" type="button" id="play-insurance-take">Take insurance</button>
            <button class="btn" type="button" id="play-insurance-decline">No insurance</button>
          </div>
        </div>

        <div class="action-bar" id="play-actions" role="group" aria-label="Player actions">
          ${ACTION_BUTTONS.map((a) => `
            <button class="btn action-btn ${actionClass(a.letter)}" type="button" data-play-action="${a.id}" aria-keyshortcuts="${a.key.toUpperCase()}" disabled>
              <kbd>${a.letter}</kbd>${a.label}
            </button>
          `).join('')}
        </div>

        <div class="bet-bar">
          <div class="bet-controls" id="play-bet-controls">
            <button class="btn btn-icon" type="button" id="play-bet-down" aria-label="Decrease bet">−</button>
            <label class="field bet-field" for="play-bet">
              <span class="field-label">Bet</span>
              <input id="play-bet" type="number" min="1" step="1" value="1">
            </label>
            <button class="btn btn-icon" type="button" id="play-bet-up" aria-label="Increase bet">+</button>
          </div>
          <button class="btn btn-primary" type="button" id="play-deal">Deal</button>
          <button class="btn" type="button" id="play-new-shoe">New shoe</button>
          <span class="round-result" id="play-round-result"></span>
        </div>
      </section>

      <aside class="play-side">
        <section class="control-card coach-card" aria-labelledby="coach-title">
          <div class="control-head">
            <h2 id="coach-title">Coach</h2>
            <select id="coach-mode" aria-label="Coach mode">
              <option value="off">Off</option>
              <option value="hint">Hint on request</option>
              <option value="always">Always on</option>
            </select>
          </div>
          <label class="check-field"><input id="coach-count-aware" type="checkbox" checked> Count-aware finite solver</label>
          <div class="control-actions">
            <button class="btn" type="button" id="coach-hint" disabled>Get hint</button>
          </div>
          <div class="coach-box coach-hint" id="coach-hint-box" hidden>
            <span class="coach-kicker">Hint</span>
            <div id="coach-hint-content"></div>
          </div>
          <div class="coach-box coach-grade" id="coach-grade-box" hidden>
            <span class="coach-kicker">Last decision</span>
            <div id="coach-grade-content"></div>
          </div>
          <p class="fine-print" id="coach-note">The coach grades after each decision. Count-aware mode solves the real remaining composition; otherwise it grades against the chart.</p>
        </section>

        <section class="control-card count-card" aria-labelledby="count-title">
          <div class="control-head">
            <h2 id="count-title">Count</h2>
            <label class="check-field compact"><input id="play-count-show" type="checkbox" checked> Show</label>
          </div>
          <div id="count-display" class="count-display">
            <div><span>Running</span><strong id="play-running-count">0</strong></div>
            <div><span id="play-primary-label">True count</span><strong id="play-true-count">—</strong></div>
            <div><span>Decks left</span><strong id="play-decks-left">—</strong></div>
          </div>
          <div id="count-hidden" class="count-hidden" hidden>
            <span>Count hidden</span>
            <button class="btn btn-small" type="button" id="count-reveal">Reveal</button>
          </div>
          <p class="fine-print" id="play-count-note">Hi-Lo. The running count includes every card you have seen; the hole card joins it when revealed.</p>
        </section>

        <section class="control-card stats-card" aria-labelledby="stats-title">
          <div class="control-head"><h2 id="stats-title">Session</h2><span class="stat-note" id="stats-seed">—</span></div>
          <div class="stat-stack">
            <div><span>Rounds</span><strong id="stats-rounds">0</strong></div>
            <div><span>Accuracy</span><strong id="stats-accuracy">—</strong></div>
            <div><span>EV lost to mistakes</span><strong id="stats-ev-lost">—</strong></div>
            <div><span>Actual net</span><strong id="stats-actual">0.00</strong></div>
            <div><span>Expected net</span><strong id="stats-expected">—</strong></div>
            <div><span>Luck</span><strong id="stats-luck">—</strong></div>
          </div>
          <p class="fine-print" id="stats-luck-note">Expected net covers graded rounds only; luck is actual minus expected.</p>
        </section>

        <section class="control-card session-card" aria-labelledby="session-title">
          <div class="control-head"><h2 id="session-title">Session settings</h2></div>
          <div class="form-grid">
            <label class="field" for="session-bankroll"><span class="field-label">Bankroll</span><input id="session-bankroll" type="number" min="10" step="10" value="200"></label>
            <label class="field" for="session-seed"><span class="field-label">Seed</span><input id="session-seed" type="number" min="0" max="4294967295" step="1" value="20261028"></label>
            <label class="field" for="session-pen"><span class="field-label">Penetration</span><select id="session-pen">${[0.5, 0.65, 0.75, 0.85, 0.9].map((p) => `<option value="${p}"${p === 0.75 ? ' selected' : ''}>${Math.round(p * 100)}%</option>`).join('')}</select></label>
          </div>
          <button class="btn" type="button" id="session-new">Start new session</button>
          <p class="fine-print">Rules changes start a fresh session with the same seed and bankroll settings.</p>
        </section>
      </aside>
    </div>

    <section class="history-card" aria-labelledby="history-title">
      <div class="chart-card-head">
        <div>
          <h2 id="history-title">Hand history</h2>
          <p>Every round is logged. Export the whole session as JSON when you want to inspect it elsewhere.</p>
        </div>
        <button class="btn" type="button" id="play-export">Export JSON</button>
      </div>
      <div class="table-scroll">
        <table class="data-table history-table">
          <thead><tr><th scope="col">Round</th><th scope="col">You</th><th scope="col">Dealer</th><th scope="col">Net</th><th scope="col">Note</th></tr></thead>
          <tbody id="play-history"><tr><td colspan="5" class="empty-cell">No hands yet.</td></tr></tbody>
        </table>
      </div>
    </section>
  `;

  const els = {
    bankroll: root.querySelector('#play-bankroll'),
    shoeNumber: root.querySelector('#play-shoe-number'),
    shoeFill: root.querySelector('#play-shoe-fill'),
    shoeText: root.querySelector('#play-shoe-text'),
    countInline: root.querySelector('#play-count-inline'),
    dealerTotal: root.querySelector('#play-dealer-total'),
    dealerCards: root.querySelector('#play-dealer-cards'),
    message: root.querySelector('#play-message'),
    handArea: root.querySelector('#play-hand-area'),
    insurance: root.querySelector('#play-insurance'),
    insuranceTake: root.querySelector('#play-insurance-take'),
    insuranceDecline: root.querySelector('#play-insurance-decline'),
    actions: root.querySelector('#play-actions'),
    actionButtons: [...root.querySelectorAll('[data-play-action]')],
    bet: root.querySelector('#play-bet'),
    betDown: root.querySelector('#play-bet-down'),
    betUp: root.querySelector('#play-bet-up'),
    deal: root.querySelector('#play-deal'),
    newShoe: root.querySelector('#play-new-shoe'),
    roundResult: root.querySelector('#play-round-result'),
    coachMode: root.querySelector('#coach-mode'),
    countAware: root.querySelector('#coach-count-aware'),
    coachHint: root.querySelector('#coach-hint'),
    hintBox: root.querySelector('#coach-hint-box'),
    hintContent: root.querySelector('#coach-hint-content'),
    gradeBox: root.querySelector('#coach-grade-box'),
    gradeContent: root.querySelector('#coach-grade-content'),
    coachNote: root.querySelector('#coach-note'),
    countShow: root.querySelector('#play-count-show'),
    countDisplay: root.querySelector('#count-display'),
    countHidden: root.querySelector('#count-hidden'),
    reveal: root.querySelector('#count-reveal'),
    runningCount: root.querySelector('#play-running-count'),
    primaryLabel: root.querySelector('#play-primary-label'),
    trueCount: root.querySelector('#play-true-count'),
    decksLeft: root.querySelector('#play-decks-left'),
    countNote: root.querySelector('#play-count-note'),
    statsSeed: root.querySelector('#stats-seed'),
    statsRounds: root.querySelector('#stats-rounds'),
    statsAccuracy: root.querySelector('#stats-accuracy'),
    statsEvLost: root.querySelector('#stats-ev-lost'),
    statsActual: root.querySelector('#stats-actual'),
    statsExpected: root.querySelector('#stats-expected'),
    statsLuck: root.querySelector('#stats-luck'),
    statsLuckNote: root.querySelector('#stats-luck-note'),
    sessionBankroll: root.querySelector('#session-bankroll'),
    sessionSeed: root.querySelector('#session-seed'),
    sessionPen: root.querySelector('#session-pen'),
    sessionNew: root.querySelector('#session-new'),
    history: root.querySelector('#play-history'),
    export: root.querySelector('#play-export'),
  };

  let rules = getRules();
  let rulesKey = JSON.stringify(rules);
  let chart = getChart();
  let policy = chart ? buildPolicy(chart) : null;
  let countSystemId = getCountSystem();
  let game = createGame();
  let solver = null;
  try {
    solver = new SolverClient();
  } catch {
    solver = null;
  }
  let coachMode = 'hint';
  let countVisible = true;
  let lastGrade = null;
  let lastHint = null;
  let generation = 0;
  let decisionSeq = 0;
  let hintToken = 0;
  let hintKey = null;
  let autoHintKey = null;
  const solverCache = new Map();

  function createGame(overrides = {}) {
    return new PlayGame({
      rules,
      seed: overrides.seed ?? Number(els.sessionSeed?.value ?? 20261028) >>> 0,
      penetration: overrides.penetration ?? Number(els.sessionPen?.value ?? 0.75),
      bankroll: overrides.bankroll ?? Number(els.sessionBankroll?.value ?? 200),
      bet: Number(els.bet?.value ?? 1),
      countSystemId,
    });
  }

  function clearCoaching() {
    hintToken++;
    lastGrade = null;
    lastHint = null;
    hintKey = null;
    autoHintKey = null;
    els.hintBox.hidden = true;
    els.gradeBox.hidden = true;
    els.hintContent.innerHTML = '';
    els.gradeContent.innerHTML = '';
  }

  function resetTransient() {
    generation++;
    decisionSeq++;
    clearCoaching();
    solverCache.clear();
  }

  function mapLetter(letter) {
    return ACTIONS_BY_LETTER[letter] ?? null;
  }

  function actionLetter(action) {
    return LETTERS[action] ?? null;
  }

  function solverCacheKey(snapshot) {
    return JSON.stringify({
      counts: snapshot.counts,
      state: snapshot.state,
      rules: JSON.stringify(rules),
    });
  }

  function getSolverResult(snapshot) {
    if (!solver || !snapshot?.counts || rules.decks === 'infinite') return Promise.resolve(null);
    const key = solverCacheKey(snapshot);
    if (solverCache.has(key)) return solverCache.get(key);
    const promise = solver.solveHand(rules, snapshot.counts, snapshot.state)
      .then((data) => data.result ?? null)
      .catch(() => null);
    solverCache.set(key, promise);
    if (solverCache.size > 300) {
      solverCache.delete(solverCache.keys().next().value);
    }
    return promise;
  }

  function resultForSnapshot(snapshot) {
    return getSolverResult(snapshot);
  }

  function basicBest(snapshot) {
    if (!policy) return null;
    const handLike = {
      total: snapshot.state.total,
      soft: snapshot.state.soft,
      pairBucket: snapshot.state.pairBucket,
      cards: snapshot.cards.length,
      fromSplit: snapshot.fromSplit,
      canDouble: snapshot.legalActions.includes('double'),
      canSurrender: snapshot.legalActions.includes('surrender'),
    };
    return optimalAction(policy, rules, handLike, snapshot.upcard.bucket, snapshot.state.splitHands);
  }

  function renderCoaching() {
    const mode = coachMode;
    els.coachHint.disabled = mode === 'off' || game.phase !== 'player';
    els.coachMode.value = mode;
    els.countAware.disabled = mode === 'off' || rules.decks === 'infinite';
    els.coachNote.textContent = rules.decks === 'infinite'
      ? 'Infinite-deck rules: the coach grades against the chart. Select a finite deck count for composition-aware grading.'
      : 'The coach grades after each decision. Count-aware mode solves the real remaining composition; otherwise it grades against the chart.';
    els.hintBox.hidden = !lastHint || mode === 'off';
    els.gradeBox.hidden = !lastGrade || mode === 'off';
    if (lastHint) els.hintContent.innerHTML = lastHint.html;
    if (lastGrade) els.gradeContent.innerHTML = lastGrade.html;
  }

  function renderCount(view) {
    const system = view.countSystem;
    const show = countVisible;
    els.countShow.checked = show;
    els.countDisplay.hidden = !show;
    els.countHidden.hidden = show;
    els.primaryLabel.textContent = system.balanced ? 'True count' : 'Key count';
    els.countNote.textContent = system.balanced
      ? `${system.name}. Running count includes every card you have seen; true count divides by decks left.`
      : `${system.name} is unbalanced. Use the running count; the key count is ${system.keyCount}.`;
    if (!show) {
      els.countInline.textContent = 'hidden';
      return;
    }
    const rc = view.runningCount;
    const displayCount = system.balanced
      ? (view.trueCount == null ? '—' : `${view.trueCount >= 0 ? '+' : ''}${view.trueCount.toFixed(1)}`)
      : (view.runningCount >= 0 ? `+${view.runningCount}` : String(view.runningCount));
    els.runningCount.textContent = rc >= 0 ? `+${rc}` : String(rc);
    els.trueCount.textContent = displayCount;
    els.decksLeft.textContent = Number.isFinite(view.decksRemaining) ? view.decksRemaining.toFixed(1) : '∞';
    els.countInline.textContent = system.balanced
      ? `TC ${displayCount}`
      : `RC ${displayCount}`;
  }

  function renderStats(view) {
    const stats = view.stats;
    els.statsSeed.textContent = `seed ${game.seed}`;
    els.statsRounds.textContent = formatNumber(stats.rounds);
    els.statsAccuracy.textContent = stats.accuracy == null ? '—' : `${(stats.accuracy * 100).toFixed(1)}%`;
    els.statsEvLost.textContent = stats.decisions > 0 ? `${formatEV(stats.evLost)} bets` : '—';
    els.statsActual.textContent = `${stats.actualNet >= 0 ? '+' : ''}${stats.actualNet.toFixed(2)}`;
    if (stats.expectedCount > 0) {
      els.statsExpected.textContent = `${stats.expectedNet >= 0 ? '+' : ''}${stats.expectedNet.toFixed(2)}`;
      els.statsLuck.textContent = `${stats.luck >= 0 ? '+' : ''}${stats.luck.toFixed(2)}`;
      els.statsLuck.textContent += ' units';
      els.statsLuck.className = stats.luck >= 0 ? 'is-gain' : 'is-cost';
      els.statsLuckNote.textContent = `Actual on graded rounds ${stats.expectedActualNet >= 0 ? '+' : ''}${stats.expectedActualNet.toFixed(2)} units; expected ${stats.expectedNet >= 0 ? '+' : ''}${stats.expectedNet.toFixed(2)}.`;
    } else {
      els.statsExpected.textContent = '—';
      els.statsLuck.textContent = '—';
      els.statsLuck.className = '';
      els.statsLuckNote.textContent = 'Expected net appears after the coach grades a decision.';
    }
  }

  function renderHistory(view) {
    if (!view.history.length) {
      els.history.innerHTML = '<tr><td colspan="5" class="empty-cell">No hands yet.</td></tr>';
      return;
    }
    els.history.innerHTML = view.history.map(renderHistoryRow).join('');
  }

  function renderActions(view) {
    const legal = new Set(view.legalActions);
    for (const button of els.actionButtons) {
      button.disabled = !legal.has(button.dataset.playAction);
    }
    els.insurance.hidden = !view.insuranceOffered;
    els.actions.hidden = view.insuranceOffered || view.phase === 'insurance' || view.phase === 'settled' || view.phase === 'dealer';
    els.bet.disabled = view.phase !== 'bet' && view.phase !== 'settled';
    els.betDown.disabled = els.bet.disabled;
    els.betUp.disabled = els.bet.disabled;
    if (view.phase === 'bet') {
      els.deal.textContent = 'Deal';
      els.deal.disabled = !view.canDeal;
    } else if (view.phase === 'settled') {
      els.deal.textContent = 'Deal next';
      els.deal.disabled = !view.canDeal;
    } else {
      els.deal.textContent = 'Deal';
      els.deal.disabled = true;
    }
    els.newShoe.disabled = !(view.phase === 'bet' || view.phase === 'settled');
  }

  function render() {
    const view = game.getView();
    els.bankroll.textContent = view.bankroll.toFixed(2);
    els.shoeNumber.textContent = view.infinite ? '∞' : String(view.shoeNumber);
    const pct = view.infinite ? 100 : Math.max(0, Math.min(100, (view.remaining / (view.remaining + (view.cutRemaining ?? 0) + 1)) * 100));
    // Use the cut card position as the visual penetration mark rather than
    // inventing a total; the initial total is recoverable from the shoe.
    const totalShoe = view.infinite ? 0 : 52 * Number(rules.decks);
    const penetration = view.infinite ? 100 : ((totalShoe - view.remaining) / totalShoe) * 100;
    els.shoeFill.style.width = `${Math.max(0, Math.min(100, penetration))}%`;
    els.shoeText.textContent = view.infinite
      ? 'Infinite deck · no cut card'
      : `${view.remaining} cards left${view.needsShuffle ? ' · shuffle next' : ''}`;
    els.dealerTotal.textContent = view.dealer
      ? (view.dealer.hidden ? `showing ${view.dealer.blackjack ? '' : view.dealer.total}` : handTotalLabel({ ...view.dealer, natural: false, surrendered: false }))
      : '—';
    els.dealerCards.innerHTML = view.dealer
      ? view.dealer.cards.map((c) => renderCard(c)).join('') + (view.dealer.hidden ? renderCard(null, true) : '')
      : '';
    els.handArea.innerHTML = view.hands.map((hand) => renderHand(hand)).join('') || `
      <div class="empty-table">Place a bet to start the round.</div>
    `;
    els.message.textContent = view.message;
    els.roundResult.textContent = view.phase === 'settled' && view.roundNet != null
      ? `${view.roundNet >= 0 ? '+' : ''}${view.roundNet.toFixed(2)} units`
      : '';
    els.roundResult.className = `round-result ${view.roundNet > 0 ? 'is-gain' : view.roundNet < 0 ? 'is-cost' : ''}`;
    if (document.activeElement !== els.bet) els.bet.value = String(view.bet);
    els.bet.max = String(Math.max(1, Math.floor(view.bankroll)));
    if (document.activeElement !== els.sessionBankroll) els.sessionBankroll.value = String(view.startingBankroll);
    if (document.activeElement !== els.sessionSeed) els.sessionSeed.value = String(game.seed);
    renderActions(view);
    renderCount(view);
    renderStats(view);
    renderHistory(view);
    renderCoaching();
    els.insuranceTake.disabled = !view.insuranceOffered;
    els.insuranceDecline.disabled = !view.insuranceOffered;
    if (coachMode === 'always' && view.phase === 'player') {
      maybeAutoHint();
    }
    return view;
  }

  function snapshotKey(snapshot) {
    return JSON.stringify({ round: snapshot.roundId, hand: snapshot.handIndex, cards: snapshot.cards.map((c) => c.bucket), up: snapshot.upcard.bucket });
  }

  function hintHtml(snapshot, result, basic) {
    if (result && result.best) {
      const letter = result.best;
      const ev = result.actions?.[letter];
      return `
        <span class="action-badge ${actionClass(letter)}"><span class="badge-letter">${letter}</span>${actionName(letter)}</span>
        <span class="coach-value">${ev == null ? '' : `EV ${formatEV(ev)} bets`}</span>
        ${result.approximateSplit ? '<p class="fine-print">Split EV uses the documented approximation.</p>' : ''}
      `;
    }
    if (basic) {
      return `<span class="action-badge ${actionClass(basic)}"><span class="badge-letter">${basic}</span>${actionName(basic)}</span><span class="coach-value">chart play</span>`;
    }
    return '<span class="coach-value">No hint available for this hand.</span>';
  }

  async function requestHint({ auto = false } = {}) {
    if (coachMode === 'off') return;
    const snapshot = game.snapshotForCoach();
    if (!snapshot) return;
    const key = snapshotKey(snapshot);
    if (auto && autoHintKey === key) return;
    autoHintKey = key;
    const token = ++hintToken;
    lastHint = { html: '<span class="coach-value">Solving…</span>' };
    renderCoaching();
    let result = null;
    if (rules.decks !== 'infinite' && els.countAware.checked) {
      result = await resultForSnapshot(snapshot);
    }
    if (token !== hintToken || game.phase !== 'player') return;
    const basic = result?.best ? null : basicBest(snapshot);
    lastHint = {
      key,
      html: hintHtml(snapshot, result, basic),
      snapshot: { hand: snapshot.handLabel, upcard: snapshot.upcard.rank },
    };
    els.hintBox.hidden = false;
    renderCoaching();
  }

  function maybeAutoHint() {
    if (coachMode !== 'always' || game.phase !== 'player') return;
    const snapshot = game.snapshotForCoach();
    if (!snapshot) return;
    const key = snapshotKey(snapshot);
    if (autoHintKey === key) return;
    requestHint({ auto: true });
  }

  function gradeHtml(decision) {
    if (!decision.graded) {
      return '<span class="coach-value">Coach was off; this decision was not graded.</span>';
    }
    if (decision.mode === 'basic') {
      return decision.correct
        ? `<span class="grade-ok">Basic strategy: ${decision.bestName}.</span>`
        : `<span class="grade-miss">Basic strategy prefers ${decision.bestName}; you chose ${decision.actionName}.</span>`;
    }
    if (decision.correct) {
      return `<span class="grade-ok">Optimal: ${decision.bestName}${decision.bestEV == null ? '' : ` (${formatEV(decision.bestEV)} EV)`}.</span>`;
    }
    return `<span class="grade-miss">${decision.actionName} cost ${decision.evLost == null ? '—' : `${decision.evLost.toFixed(3)} bets`}.</span><span class="coach-value">Best ${decision.bestName}${decision.bestEV == null ? '' : ` (${formatEV(decision.bestEV)})`}; you ${decision.actionName}${decision.actionEV == null ? '' : ` (${formatEV(decision.actionEV)})`}.</span>`;
  }

  async function gradeDecision(snapshot, action, seq) {
    if (coachMode === 'off') {
      game.logDecision(snapshot.roundId, {
        action,
        actionName: actionName(actionLetter(action)),
        graded: false,
        timestamp: new Date().toISOString(),
      });
      if (seq === decisionSeq) render();
      return;
    }
    const token = generation;
    let result = null;
    let mode = 'basic';
    if (snapshot && snapshot.aceOneCard) {
      result = null;
    } else if (snapshot && rules.decks !== 'infinite' && els.countAware.checked) {
      result = await resultForSnapshot(snapshot);
      if (result?.best) mode = 'finite';
    }
    if (token !== generation) return;

    let bestLetter = result?.best ?? null;
    if (!bestLetter && snapshot?.aceOneCard) {
      bestLetter = 'S';
      mode = 'basic';
    }
    if (!bestLetter) {
      const basic = basicBest(snapshot);
      if (basic) {
        bestLetter = basic;
        mode = 'basic';
      }
    }
    const chosenLetter = actionLetter(action);
    const actionEV = result?.actions?.[chosenLetter] ?? null;
    const bestEV = result?.ev ?? null;
    const evLost = result && actionEV != null && bestEV != null ? Math.max(0, bestEV - actionEV) : null;
    const correct = result?.best
      ? (result.best === chosenLetter || (evLost != null && evLost < 0.001))
      : (bestLetter ? bestLetter === chosenLetter : false);
    const decision = {
      action,
      actionLetter: chosenLetter,
      actionName: actionName(chosenLetter),
      actionEV,
      best: result?.best ?? bestLetter,
      bestLetter: result?.best ?? bestLetter,
      bestName: actionName(result?.best ?? bestLetter),
      bestEV,
      evLost,
      correct,
      graded: Boolean(result?.best || bestLetter),
      mode,
      trueCount: snapshot?.trueCount ?? null,
      runningCount: snapshot?.runningCount ?? null,
      cards: snapshot?.cards?.map((c) => ({ rank: c.rank, suit: c.suit })) ?? [],
      upcard: snapshot?.upcard?.rank ?? null,
      hand: snapshot?.handLabel ?? null,
      timestamp: new Date().toISOString(),
    };
    game.logDecision(snapshot.roundId, decision);
    if (seq === decisionSeq) {
      lastGrade = { html: gradeHtml(decision), decision };
      render();
    }
  }

  function performAction(action) {
    if (game.phase !== 'player') return;
    const snapshot = game.snapshotForCoach();
    if (!snapshot || !game.act(action)) return;
    const seq = ++decisionSeq;
    lastHint = null;
    autoHintKey = null;
    render();
    gradeDecision(snapshot, action, seq);
  }

  function dealOrNext() {
    if (game.phase === 'settled') game.nextHand();
    if (game.phase === 'bet') {
      decisionSeq++;
      clearCoaching();
      game.setBet(Number(els.bet.value));
      game.startRound();
      render();
    }
  }

  function newSession() {
    const bankroll = Number(els.sessionBankroll.value);
    const seed = Number(els.sessionSeed.value) >>> 0;
    const penetration = Number(els.sessionPen.value);
    game = new PlayGame({
      rules,
      seed,
      penetration,
      bankroll: Math.max(10, Math.floor(bankroll || 200)),
      bet: Number(els.bet.value) || 1,
      countSystemId,
    });
    resetTransient();
    render();
  }

  function resetForRules(nextRules) {
    rules = nextRules;
    rulesKey = JSON.stringify(nextRules);
    chart = getChart();
    policy = chart ? buildPolicy(chart) : null;
    game = new PlayGame({
      rules,
      seed: Number(els.sessionSeed.value) >>> 0,
      penetration: Number(els.sessionPen.value),
      bankroll: Number(els.sessionBankroll.value) || 200,
      bet: Number(els.bet.value) || 1,
      countSystemId,
    });
    resetTransient();
    render();
  }

  // ------------------------------------------------------------------ events
  els.actionButtons.forEach((button) => {
    button.addEventListener('click', () => performAction(button.dataset.playAction));
  });
  els.insuranceTake.addEventListener('click', () => {
    game.takeInsurance();
    render();
  });
  els.insuranceDecline.addEventListener('click', () => {
    game.declineInsurance();
    render();
  });
  els.deal.addEventListener('click', dealOrNext);
  els.newShoe.addEventListener('click', () => {
    if (game.phase === 'bet' || game.phase === 'settled') {
      game.newShoe();
      decisionSeq++;
      clearCoaching();
      render();
    }
  });
  els.bet.addEventListener('change', () => {
    if (!game.setBet(Number(els.bet.value))) {
      els.bet.value = String(game.bet);
    }
    render();
  });
  els.betDown.addEventListener('click', () => {
    game.setBet(game.bet - 1);
    render();
  });
  els.betUp.addEventListener('click', () => {
    game.setBet(game.bet + 1);
    render();
  });
  els.coachMode.addEventListener('change', () => {
    coachMode = els.coachMode.value;
    lastHint = null;
    autoHintKey = null;
    render();
  });
  els.countAware.addEventListener('change', () => {
    lastHint = null;
    autoHintKey = null;
    render();
  });
  els.coachHint.addEventListener('click', () => requestHint());
  els.countShow.addEventListener('change', () => {
    countVisible = els.countShow.checked;
    render();
  });
  els.reveal.addEventListener('click', () => {
    countVisible = true;
    render();
  });
  els.sessionNew.addEventListener('click', newSession);
  els.sessionPen.addEventListener('change', () => {
    if (game.phase === 'bet' || game.phase === 'settled') {
      game.setPenetration(Number(els.sessionPen.value));
      decisionSeq++;
      clearCoaching();
      render();
    }
  });
  els.export.addEventListener('click', () => {
    const data = game.exportHistory();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackjack-session-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });  root.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (root.hidden) return;
    const key = event.key.toLowerCase();
    const action = ACTION_BUTTONS.find((a) => a.key === key);
    if (action) {
      event.preventDefault();
      performAction(action.id);
    } else if (key === 'enter' && (game.phase === 'bet' || game.phase === 'settled')) {
      event.preventDefault();
      dealOrNext();
    }
  });

  render();

  return {
    setRules(nextRules) {
      const key = JSON.stringify(nextRules);
      if (key === rulesKey) return;
      resetForRules(nextRules);
    },
    setChart(nextChart) {
      chart = nextChart;
      policy = chart ? buildPolicy(chart) : null;
      render();
    },
    setCountSystem(id) {
      countSystemId = id;
      game.setCountSystem(id);
      render();
    },
    redraw() {
      render();
    },
    getGame() {
      return game;
    },
  };
}
