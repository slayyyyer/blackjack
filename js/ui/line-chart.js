/**
 * Small dependency-free line chart used by the simulation and counting labs.
 * It deliberately supports only what those views need: multiple series, a
 * shaded confidence band, a horizontal target line, log or linear x, and
 * accessible text attributes.
 */

const COLORS = {
  grid: 'rgba(148, 163, 184, 0.13)',
  axis: 'rgba(148, 163, 184, 0.24)',
  text: 'rgba(148, 163, 184, 0.85)',
  textStrong: 'rgba(232, 238, 246, 0.92)',
  target: 'rgba(251, 191, 36, 0.9)',
};

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
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = start; value <= max + step * 0.001; value += step) ticks.push(value);
  return ticks;
}

function formatCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   series?: Array<{points: Array<{x:number,y:number}>, color?: string, width?: number, dashed?: boolean}>,
 *   band?: {points: Array<{x:number,low:number,high:number}>, color?: string},
 *   target?: {value:number,label?:string,color?:string},
 *   xLog?: boolean,
 *   xLabel?: string,
 *   yLabel?: string,
 *   height?: number,
 *   yDomain?: [number,number],
 *   xDomain?: [number,number],
 *   formatY?: (v:number)=>string,
 *   formatX?: (v:number)=>string,
 *   ariaLabel?: string,
 * }} options
 */
export function drawLineChart(canvas, options) {
  const height = options.height ?? 280;
  const draw = () => {
    const prepared = prepare(canvas, height);
    if (!prepared) return;
    const { ctx, width, height: h } = prepared;

    const series = (options.series ?? []).filter((s) => s.points?.length);
    const bandPoints = options.band?.points ?? [];
    const allPoints = [
      ...series.flatMap((s) => s.points),
      ...(options.target ? [{ x: null, y: options.target.value }] : []),
    ];
    if (!allPoints.length && !bandPoints.length) return;

    const margin = { left: 56, right: 18, top: 22, bottom: 42 };
    const plotW = Math.max(1, width - margin.left - margin.right);
    const plotH = Math.max(1, h - margin.top - margin.bottom);

    const xs = [
      ...series.flatMap((s) => s.points.map((p) => p.x)),
      ...bandPoints.map((p) => p.x),
    ].filter(Number.isFinite);
    let xMin = options.xDomain?.[0] ?? Math.min(...xs);
    let xMax = options.xDomain?.[1] ?? Math.max(...xs);
    if (xMin === xMax) xMax = xMin + 1;

    const ys = [
      ...series.flatMap((s) => s.points.map((p) => p.y)),
      ...bandPoints.flatMap((p) => [p.low, p.high]),
      ...(options.target ? [options.target.value] : []),
    ].filter(Number.isFinite);
    let yMin = options.yDomain?.[0] ?? Math.min(...ys);
    let yMax = options.yDomain?.[1] ?? Math.max(...ys);
    if (yMin === yMax) {
      yMin -= 0.1;
      yMax += 0.1;
    }
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad;
    yMax += yPad;

    const xScale = (x) => {
      if (options.xLog) {
        const lo = Math.log10(Math.max(1, xMin));
        const hi = Math.log10(Math.max(10, xMax));
        const t = (Math.log10(Math.max(1, x)) - lo) / Math.max(1e-9, hi - lo);
        return margin.left + t * plotW;
      }
      return margin.left + ((x - xMin) / (xMax - xMin)) * plotW;
    };
    const yScale = (y) => margin.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Horizontal grid and y-axis labels.
    const yTicks = niceTicks(yMin, yMax, 4);
    for (const value of yTicks) {
      const y = yScale(value);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'right';
      ctx.fillText(options.formatY ? options.formatY(value) : formatCompact(value), margin.left - 9, y);
    }

    // X labels: five positions in data space.
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.text;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      let x;
      if (options.xLog) {
        const lo = Math.log10(Math.max(1, xMin));
        const hi = Math.log10(Math.max(10, xMax));
        x = 10 ** (lo + (hi - lo) * t);
      } else {
        x = xMin + (xMax - xMin) * t;
      }
      const px = xScale(x);
      ctx.fillText(options.formatX ? options.formatX(x) : formatCompact(x), px, margin.top + plotH + 20);
      ctx.strokeStyle = COLORS.axis;
      ctx.beginPath();
      ctx.moveTo(px, margin.top + plotH);
      ctx.lineTo(px, margin.top + plotH + 4);
      ctx.stroke();
    }

    // Baseline and labels.
    ctx.strokeStyle = COLORS.axis;
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
      ctx.fillStyle = COLORS.text;
      ctx.fillText(options.yLabel, 0, 0);
      ctx.restore();
    }
    if (options.xLabel) {
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(options.xLabel, width - margin.right, h - 8);
    }

    // Confidence band.
    if (bandPoints.length > 1) {
      ctx.beginPath();
      bandPoints.forEach((p, i) => {
        const x = xScale(p.x);
        const y = yScale(p.high);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      for (let i = bandPoints.length - 1; i >= 0; i--) {
        const p = bandPoints[i];
        ctx.lineTo(xScale(p.x), yScale(p.low));
      }
      ctx.closePath();
      ctx.fillStyle = options.band?.color ?? 'rgba(94, 234, 212, 0.14)';
      ctx.fill();
    }

    // Target line.
    if (options.target) {
      const y = yScale(options.target.value);
      ctx.strokeStyle = options.target.color ?? COLORS.target;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (options.target.label) {
        ctx.fillStyle = options.target.color ?? COLORS.target;
        ctx.textAlign = 'right';
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(options.target.label, margin.left + plotW - 2, y - 9);
      }
    }

    // Series.
    for (const s of series) {
      if (s.points.length < 2) continue;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xScale(p.x);
        const y = yScale(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color ?? '#5eead4';
      ctx.lineWidth = s.width ?? 2;
      ctx.setLineDash(s.dashed ? [5, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current value marker on the last series.
    const lastSeries = series[series.length - 1];
    const last = lastSeries?.points[lastSeries.points.length - 1];
    if (last) {
      ctx.beginPath();
      ctx.arc(xScale(last.x), yScale(last.y), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = lastSeries.color ?? '#5eead4';
      ctx.fill();
    }

    const label = options.ariaLabel ?? 'Line chart';
    canvas.setAttribute('aria-label', label);
    canvas.setAttribute('role', 'img');
  };

  draw();
  if (typeof ResizeObserver !== 'undefined') {
    canvas._lineChartObserver?.disconnect();
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    canvas._lineChartObserver = observer;
  }
}

export function chartColors() {
  return { ...COLORS };
}
