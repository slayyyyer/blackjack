const OUTCOME_META = [
  { key: 17, label: '17', color: '#38bdf8' },
  { key: 18, label: '18', color: '#34d399' },
  { key: 19, label: '19', color: '#a3e635' },
  { key: 20, label: '20', color: '#fbbf24' },
  { key: 21, label: '21', color: '#f59e0b' },
  { key: 'bj', label: 'BJ', color: '#c084fc' },
  { key: 'bust', label: 'Bust', color: '#fb7185' },
];

export function distributionSummary(dist) {
  const parts = OUTCOME_META
    .filter((m) => (dist[m.key] || 0) > 0)
    .map((m) => `${m.label} ${(dist[m.key] * 100).toFixed(1)}%`);
  return parts.join(', ');
}

function prepare(canvas, cssHeight) {
  const parentWidth = canvas.parentElement?.getBoundingClientRect().width ?? 0;
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width || parentWidth || 320);
  if (width <= 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, cssHeight);
  return { ctx, width, height: cssHeight };
}

function roundedRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw the dealer's final-total distribution. If the distribution is the
 * no-blackjack conditional one, the BJ bar is naturally absent.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Record<string, number>} dist
 * @param {{peek?: boolean}} [options]
 */
export function drawDealerDistribution(canvas, dist, options = {}) {
  const draw = () => {
    const prepared = prepare(canvas, 224);
    if (!prepared) return;
    const { ctx, width, height } = prepared;

    const entries = OUTCOME_META
      .filter((m) => (dist[m.key] || 0) > 0)
      .map((m) => ({ ...m, value: dist[m.key] || 0 }));

    const margin = { left: 38, right: 8, top: 24, bottom: 34 };
    const plotW = Math.max(1, width - margin.left - margin.right);
    const plotH = Math.max(1, height - margin.top - margin.bottom);
    const maxValue = Math.max(...entries.map((e) => e.value), 0.1);
    const axisMax = Math.min(0.8, Math.max(0.1, Math.ceil(maxValue * 10) / 10));

    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Horizontal grid + percentage labels.
    for (let i = 0; i <= 4; i++) {
      const p = (axisMax / 4) * i;
      const y = margin.top + plotH - (p / axisMax) * plotH;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(p * 100)}%`, margin.left - 8, y);
    }

    const slot = plotW / entries.length;
    const barW = Math.min(38, slot * 0.58);

    entries.forEach((entry, i) => {
      const x = margin.left + slot * i + (slot - barW) / 2;
      const barH = Math.max(1, (entry.value / axisMax) * plotH);
      const y = margin.top + plotH - barH;

      ctx.fillStyle = entry.color;
      roundedRect(ctx, x, y, barW, barH, 5);

      ctx.fillStyle = 'rgba(232, 238, 246, 0.92)';
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      const label = `${(entry.value * 100).toFixed(1)}%`;
      const labelY = Math.max(margin.top - 2, y - 9);
      ctx.fillText(label, x + barW / 2, labelY);

      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(entry.label, x + barW / 2, margin.top + plotH + 18);
    });

    // Baseline.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    const summary = distributionSummary(dist);
    canvas.setAttribute('aria-label', `Dealer final total distribution: ${summary}.`);
    canvas.setAttribute(
      'title',
      `${options.peek ? 'Conditional on no dealer blackjack. ' : ''}${summary}`,
    );
  };

  draw();
  if (typeof ResizeObserver !== 'undefined') {
    canvas._distributionObserver?.disconnect();
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    canvas._distributionObserver = observer;
  }
}
