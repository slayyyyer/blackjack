export const ACTION_INFO = Object.freeze({
  S: { name: 'Stand', className: 'action-S' },
  H: { name: 'Hit', className: 'action-H' },
  D: { name: 'Double', className: 'action-D' },
  P: { name: 'Split', className: 'action-P' },
  R: { name: 'Surrender', className: 'action-R' },
});

export const ACTION_ORDER = Object.freeze(['S', 'H', 'D', 'P', 'R']);

/** @param {string} action */
export function actionName(action) {
  return ACTION_INFO[action]?.name ?? action;
}

/** @param {string} action */
export function actionClass(action) {
  return ACTION_INFO[action]?.className ?? '';
}

/** A probability in [0,1] rendered as a percentage. */
export function formatProbability(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** A house edge already expressed in percent, e.g. 0.511 -> "0.511%". */
export function formatEdge(value, digits = 3) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Signed change in percentage points. */
export function formatEdgeDelta(value, digits = 3) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** EV in bets, always with a sign. */
export function formatEV(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

/** Compact EV for cell metadata/table. */
export function formatEVShort(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

/** Dealer upcard labels use T for ten? The app uses 10 for clarity. */
export function upcardLabel(upcard) {
  return upcard === 11 ? 'A' : String(upcard);
}

export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Escape text before putting it into an attribute/template string. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
