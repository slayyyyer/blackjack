/**
 * Canvas scatter plot with two optional lines: a least-squares fit through the
 * sampled points and a fixed model line. Used for the Hi-Lo predictability
 * view; intentionally small and dependency-free.
 */

function prepare(canvas, cssHeight) {
  const parentWidth = canvas.parentElement?.getBoundingClientRect().width ?? 0;
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width || parentWidth || 420);
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

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const span = Math.max(1e-9, max - min);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = start; value <= max + step * 0.001; value += step) ticks.push(value);
  return ticks;
}

function formatTick(value) {
  const abs = Math.abs(value);
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   points: Array<{x:number,y:number}>,
 *   fit?: {slope:number,intercept:number},
 *   model?: {slope:number,intercept:number,label?:string},
 *   xLabel?: string,
 *   yLabel?: string,
 *   height?: number,
 *   ariaLabel?: string,
 * }} options
 */
export function drawScatterChart(canvas, options) {
  const height = options.height ?? 320;
  const draw = () => {
    const prepared = prepare(canvas, height);
    if (!prepared) return;
    const { ctx, width, height: h } = prepared;
    const points = options.points ?? [];
    if (!points.length) return;

    const margin = { left: 58, right: 18, top: 22, bottom: 42 };
    const plotW = Math.max(1, width - margin.left - margin.right);
    const plotH = Math.max(1, h - margin.top - margin.bottom);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }
    if (yMin === yMax) {
      yMin -= 0.1;
      yMax += 0.1;
    }
    const yPad = (yMax - yMin) * 0.1;
    yMin -= yPad;
    yMax += yPad;
    const xPad = (xMax - xMin) * 0.05;
    xMin -= xPad;
    xMax += xPad;

    const xScale = (x) => margin.left + ((x - xMin) / (xMax - xMin)) * plotW;
    const yScale = (y) => margin.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const yTicks = niceTicks(yMin, yMax, 4);
    for (const value of yTicks) {
      const y = yScale(value);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.82)';
      ctx.textAlign = 'right';
      ctx.fillText(`${formatTick(value)}`, margin.left - 9, y);
    }
    for (let i = 0; i <= 4; i++) {
      const x = xMin + ((xMax - xMin) * i) / 4;
      const px = xScale(x);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.beginPath();
      ctx.moveTo(px, margin.top + plotH);
      ctx.lineTo(px, margin.top + plotH + 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.82)';
      ctx.textAlign = 'center';
      ctx.fillText(formatTick(x), px, margin.top + plotH + 20);
    }

    // Zero line for EV.
    if (yMin < 0 && yMax > 0) {
      const y = yScale(0);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Scatter points.
    for (const p of points) {
      const x = xScale(p.x);
      const y = yScale(p.y);
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = p.y >= 0 ? 'rgba(94, 234, 212, 0.8)' : 'rgba(251, 113, 133, 0.75)';
      ctx.fill();
    }

    const drawLine = (slope, intercept, color, dashed, label) => {
      if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return;
      const x1 = xMin;
      const x2 = xMax;
      const y1 = slope * x1 + intercept;
      const y2 = slope * x2 + intercept;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(xScale(x1), yScale(y1));
      ctx.lineTo(xScale(x2), yScale(y2));
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color;
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, margin.left + 6, yScale(y2) - 8);
      }
    };

    if (options.model) {
      drawLine(options.model.slope, options.model.intercept, 'rgba(251, 191, 36, 0.85)', true, options.model.label);
    }
    if (options.fit) {
      drawLine(options.fit.slope, options.fit.intercept, 'rgba(94, 234, 212, 0.95)', false, options.fit.label);
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    if (options.yLabel) {
      ctx.save();
      ctx.translate(15, margin.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.fillText(options.yLabel, 0, 0);
      ctx.restore();
    }
    if (options.xLabel) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.fillText(options.xLabel, width - margin.right, h - 8);
    }

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', options.ariaLabel ?? 'Scatter plot of exact expected value against true count.');
  };

  draw();
  if (typeof ResizeObserver !== 'undefined') {
    canvas._scatterObserver?.disconnect();
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    canvas._scatterObserver = observer;
  }
}
