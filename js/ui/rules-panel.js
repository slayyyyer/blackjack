import {
  DECK_OPTIONS,
  PAYOUT_OPTIONS,
  RESPLIT_OPTIONS,
  makeRules,
} from '../engine/rules.js';

const DECK_LABELS = {
  1: '1 deck',
  2: '2 decks',
  4: '4 decks',
  6: '6 decks',
  8: '8 decks',
  infinite: 'Infinite deck',
};

function option(value, label, selected) {
  return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
}

function selectField(key, label, help, options, value) {
  return `
    <label class="field" for="rule-${key}">
      <span class="field-label">${label}</span>
      <select id="rule-${key}" data-rule="${key}">
        ${options.map((o) => option(o.value, o.label, String(o.value) === String(value))).join('')}
      </select>
      ${help ? `<span class="field-help">${help}</span>` : ''}
    </label>
  `;
}

function switchField(key, label, help, checked, disabled = false) {
  return `
    <label class="switch-field${disabled ? ' is-disabled' : ''}">
      <span class="switch-copy">
        <span class="field-label">${label}</span>
        ${help ? `<span class="field-help">${help}</span>` : ''}
      </span>
      <span class="switch">
        <input id="rule-${key}" data-rule="${key}" type="checkbox"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="switch-track" aria-hidden="true"></span>
      </span>
    </label>
  `;
}

/**
 * @param {HTMLElement} container
 * @param {import('../engine/rules.js').Rules} initialRules
 * @param {(rules: import('../engine/rules.js').Rules) => void} onChange
 */
export function mountRulesPanel(container, initialRules, onChange) {
  let rules = makeRules(initialRules);

  container.innerHTML = `
    <div class="rules-head">
      <div>
        <h2>Table rules</h2>
        <p>Shared by every tab.</p>
      </div>
      <div class="rules-actions">
        <button class="btn btn-ghost btn-small rules-toggle" type="button" aria-expanded="true" aria-controls="rules-form">Hide</button>
        <button class="btn btn-ghost btn-small" type="button" data-reset-rules>Reset</button>
      </div>
    </div>
    <form class="rules-form" id="rules-form" novalidate>
      <fieldset class="rule-group">
        <legend>Shoe &amp; dealer</legend>
        ${selectField('decks', 'Decks', 'Infinite draws with replacement.', DECK_OPTIONS.map((d) => ({ value: d, label: DECK_LABELS[d] })), rules.decks)}
        ${switchField('dealerHitsSoft17', 'Dealer hits soft 17', 'Checked = H17. Unchecked = S17.', rules.dealerHitsSoft17)}
        ${switchField('peek', 'Dealer peeks for blackjack', 'US peek. Unchecked = ENHC / no-peek.', rules.peek)}
      </fieldset>

      <fieldset class="rule-group">
        <legend>Payouts &amp; player options</legend>
        ${selectField('blackjackPayout', 'Blackjack pays', 'A natural 21, before splits.', PAYOUT_OPTIONS, rules.blackjackPayout)}
        ${switchField('doubleAnyTwo', 'Double on any two cards', 'Unchecked = hard 9–11 only.', rules.doubleAnyTwo)}
        ${switchField('doubleAfterSplit', 'Double after split', 'DAS. Applies to each post-split two-card hand.', rules.doubleAfterSplit)}
        ${switchField('insurance', 'Insurance offered', 'Off removes the side bet entirely.', rules.insurance)}
        ${selectField('surrender', 'Surrender', 'Late surrender is only available when the dealer peeks.', [
          { value: 'none', label: 'None' },
          { value: 'late', label: 'Late' },
        ], rules.surrender)}
        <p class="rule-note" data-surrender-note></p>
      </fieldset>

      <fieldset class="rule-group">
        <legend>Splits</legend>
        ${switchField('splitAcesOneCard', 'Split aces receive one card', 'The standard rule. Unchecked lets split aces hit.', rules.splitAcesOneCard)}
        ${switchField('resplitAces', 'Resplit aces', 'Only matters when a split ace draws another ace.', rules.resplitAces)}
        ${selectField('resplitLimit', 'Maximum hands after splits', 'Includes the original hand. 4 = up to three resplits.', RESPLIT_OPTIONS.map((n) => ({ value: n, label: `${n} hands` })), rules.resplitLimit)}
      </fieldset>

      <p class="rules-footnote">Every change re-solves the chart, the house edge, and the simulation target.</p>
    </form>
  `;

  const form = container.querySelector('form');
  const toggle = container.querySelector('.rules-toggle');
  const panel = container.closest('.rules-panel') ?? container;
  const mobileQuery = window.matchMedia('(max-width: 960px)');
  const setCollapsed = (collapsed) => {
    panel.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.textContent = collapsed ? 'Show' : 'Hide';
  };
  setCollapsed(mobileQuery.matches);
  toggle.addEventListener('click', () => {
    setCollapsed(!container.classList.contains('is-collapsed'));
  });
  mobileQuery.addEventListener?.('change', (event) => {
    setCollapsed(event.matches);
  });

  const surrenderSelect = form.querySelector('[data-rule="surrender"]');
  const surrenderNote = container.querySelector('[data-surrender-note]');
  const resplitAces = form.querySelector('[data-rule="resplitAces"]');
  const resplitLimit = form.querySelector('[data-rule="resplitLimit"]');

  function sync(nextRules) {
    rules = makeRules(nextRules);
    for (const input of form.querySelectorAll('[data-rule]')) {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') input.checked = Boolean(rules[key]);
      else input.value = String(rules[key]);
    }

    const surrenderAvailable = rules.peek;
    surrenderSelect.disabled = !surrenderAvailable;
    if (!surrenderAvailable && rules.surrender !== 'none') {
      rules = makeRules({ ...rules, surrender: 'none' });
      surrenderSelect.value = 'none';
    }
    surrenderNote.textContent = surrenderAvailable
      ? 'Surrender is resolved after the dealer checks for blackjack.'
      : 'Late surrender is unavailable in ENHC; it has been set to none.';
    surrenderNote.hidden = false;

    const acesResplitPossible = rules.resplitLimit >= 3;
    resplitAces.disabled = !acesResplitPossible;
    resplitAces.closest('.switch-field')?.classList.toggle('is-disabled', !acesResplitPossible);
    resplitLimit.title = acesResplitPossible ? '' : 'Resplitting aces needs a limit of at least 3 hands.';
  }

  function read() {
    const next = { ...rules };
    for (const input of form.querySelectorAll('[data-rule]')) {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') {
        next[key] = input.checked;
      } else if (key === 'decks') {
        next[key] = input.value === 'infinite' ? 'infinite' : Number(input.value);
      } else if (key === 'blackjackPayout' || key === 'resplitLimit') {
        next[key] = Number(input.value);
      } else {
        next[key] = input.value;
      }
    }
    if (!next.peek) next.surrender = 'none';
    return makeRules(next);
  }

  form.addEventListener('change', () => {
    const next = read();
    // Keep dependent controls truthful even when the change came from a
    // different field (for example, turning peek off).
    sync(next);
    onChange(makeRules(read()));
  });

  form.addEventListener('submit', (event) => event.preventDefault());

  container.querySelector('[data-reset-rules]').addEventListener('click', () => {
    const defaults = makeRules();
    sync(defaults);
    onChange(defaults);
  });

  sync(rules);
  return {
    update(nextRules) {
      sync(nextRules);
    },
    getRules() {
      return makeRules(rules);
    },
  };
}
