import { buildStrategyChart } from '../solver/chart.js';
import { buildPolicy, STANDARD_INDEX_PLAYS } from '../sim/strategies.js';
import { BlackjackSimulator } from '../sim/simulator.js';

/**
 * Bet-ramp presets. The model is deliberately plain: a bet is placed before
 * the round from the count that is already visible, and the hand result is
 * multiplied by that bet. A session starts with one bankroll and stops if the
 * bankroll reaches zero.
 */
export const RAMP_PRESETS = Object.freeze([
  {
    id: 'flat',
    name: 'Flat betting',
    description: 'One unit every hand. The control group.',
    bets: [1, 1, 1, 1],
  },
  {
    id: '1-2-4-8',
    name: '1–2–4–8 spread',
    description: 'One unit at TC ≤ 1, then 2, 4 and 8 units as the count rises.',
    bets: [1, 2, 4, 8],
  },
  {
    id: '1-4-8-12',
    name: '1–4–8–12 spread',
    description: 'A wider spread for a stronger count response.',
    bets: [1, 4, 8, 12],
  },
  {
    id: 'kelly',
    name: 'Kelly-sized',
    description: 'Bet a fraction of bankroll proportional to estimated edge and inverse variance.',
    bets: null,
  },
]);

export function rampPreset(id) {
  return RAMP_PRESETS.find((r) => r.id === id) ?? RAMP_PRESETS[0];
}

/**
 * Turn a true count and a four-step ramp into a bet. Steps apply at
 * TC <= 1, TC = 2, TC = 3, and TC >= 4. Bets are in units.
 */
export function betFromRamp(trueCount, bets) {
  const tc = Number.isFinite(trueCount) ? trueCount : 0;
  if (tc <= 1) return bets[0];
  if (tc <= 2) return bets[1];
  if (tc <= 3) return bets[2];
  return bets[3];
}

/**
 * Kelly sizing uses the player edge estimated as basePlayerEdge +
 * edgePerTrueCount * TC. Variance is in squared bets; blackjack is roughly
 * 1.3. A fraction below 1 is fractional Kelly.
 */
export function kellyBet({ trueCount, bankroll, basePlayerEdge, edgePerTrueCount, variance = 1.3, fraction = 0.5, maxBet = 20 }) {
  const tc = Number.isFinite(trueCount) ? trueCount : 0;
  const edge = basePlayerEdge + edgePerTrueCount * tc;
  if (!(edge > 0) || !(bankroll > 0)) return 1;
  const raw = (bankroll * edge) / variance * fraction;
  return Math.max(1, Math.min(maxBet, raw));
}

export function makeBetSizer({ presetId, customBets, basePlayerEdge, edgePerTrueCount, kellyFraction, maxBet }) {
  if (presetId === 'kelly') {
    return ({ trueCount, runningCount, decksRemaining, bankroll }) => {
      const effective = trueCount ?? (runningCount / Math.max(1, decksRemaining));
      return kellyBet({
        trueCount: effective,
        bankroll,
        basePlayerEdge,
        edgePerTrueCount,
        fraction: kellyFraction,
        maxBet,
      });
    };
  }
  const bets = presetId === 'custom' ? customBets : rampPreset(presetId).bets;
  return ({ trueCount, runningCount, decksRemaining }) => {
    const effective = trueCount ?? (runningCount / Math.max(1, decksRemaining));
    return betFromRamp(effective, bets);
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function sessionSeed(baseSeed, index) {
  return (baseSeed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

function curveAtPoints(paths, points) {
  const curve = [];
  for (let i = 0; i < points.length; i++) {
    const values = paths.map((p) => p[i]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    curve.push({
      x: points[i],
      p05: percentile(values, 5),
      p25: percentile(values, 25),
      p50: percentile(values, 50),
      p75: percentile(values, 75),
      p95: percentile(values, 95),
      mean: values.reduce((s, v) => s + v, 0) / Math.max(1, values.length),
    });
  }
  return curve;
}

function scheduleFor(hands) {
  const points = new Set([0, 1, 10, 30, 100, 300, 1000]);
  let value = 1000;
  while (value < hands) {
    value = Math.min(hands, Math.ceil(value * 1.5));
    points.add(value);
  }
  points.add(hands);
  return [...points].filter((n) => n <= hands).sort((a, b) => a - b);
}

function runSession({ rules, chart, policy, strategy, seed, hands, bankroll, penetration, betSizer, schedule, countSystemId }) {
  const sim = new BlackjackSimulator({
    rules,
    policy,
    strategy,
    seed,
    shoeMode: 'finite',
    penetration,
    countSystemId,
    indexPlays: strategy === 'deviations' ? STANDARD_INDEX_PLAYS : null,
    betSizer,
    bankroll,
  });
  const path = [bankroll];
  let cursor = 0;
  let ruinedAt = null;
  for (let i = 1; i < schedule.length; i++) {
    const target = schedule[i];
    if (!sim.ruined && target > cursor) {
      sim.run(target - cursor);
      cursor = target;
    }
    if (sim.ruined && ruinedAt == null) ruinedAt = sim.hands;
    path.push(sim.ruined ? 0 : Math.max(0, sim.bankroll));
  }
  return {
    path,
    ruined: sim.ruined || sim.bankroll <= 0,
    ruinedAt,
    final: Math.max(0, sim.bankroll ?? 0),
    handsPlayed: sim.hands,
  };
}

/**
 * Simulate the same seeded sessions twice: once flat and once with the chosen
 * ramp. Returns percentile bankroll curves and risk-of-ruin statistics.
 *
 * @param {{
 *   rules: import('../engine/rules.js').Rules,
 *   seed?: number,
 *   sessions?: number,
 *   handsPerSession?: number,
 *   bankroll?: number,
 *   penetration?: number,
 *   flatPreset?: string,
 *   rampPreset?: string,
 *   customBets?: number[],
 *   countSystemId?: string,
 *   basePlayerEdge?: number,
 *   edgePerTrueCount?: number,
 *   kellyFraction?: number,
 *   maxBet?: number,
 *   onProgress?: Function,
 * }} options
 */
export function simulateRampComparison(options) {
  const rules = options.rules;
  if (rules.decks === 'infinite') throw new Error('The bet-ramp simulator needs a finite shoe');
  const sessions = Math.max(1, Math.min(2000, Math.floor(options.sessions ?? 200)));
  const hands = Math.max(50, Math.min(200_000, Math.floor(options.handsPerSession ?? 1000)));
  const bankroll = Math.max(10, Number(options.bankroll ?? 200));
  const seed = (options.seed ?? 20261028) >>> 0;
  const penetration = Math.min(0.9, Math.max(0.5, options.penetration ?? 0.75));
  const chart = buildStrategyChart(rules);
  const policy = buildPolicy(chart);
  const schedule = scheduleFor(hands);
  const flatBets = [1, 1, 1, 1];
  const strategy = options.useIndices ? 'deviations' : 'optimal';
  const flatSizer = makeBetSizer({
    presetId: 'custom',
    customBets: flatBets,
    basePlayerEdge: options.basePlayerEdge ?? -0.004,
    edgePerTrueCount: options.edgePerTrueCount ?? 0.0042,
    kellyFraction: options.kellyFraction ?? 0.5,
    maxBet: options.maxBet ?? 20,
  });
  const rampSizer = makeBetSizer({
    presetId: options.rampPreset ?? '1-2-4-8',
    customBets: options.customBets ?? [1, 2, 4, 8],
    basePlayerEdge: options.basePlayerEdge ?? -0.004,
    edgePerTrueCount: options.edgePerTrueCount ?? 0.0042,
    kellyFraction: options.kellyFraction ?? 0.5,
    maxBet: options.maxBet ?? 20,
  });

  const flatPaths = [];
  const rampPaths = [];
  const flatSessions = [];
  const rampSessions = [];
  const started = performance.now();

  for (let i = 0; i < sessions; i++) {
    const s = sessionSeed(seed, i);
    const flat = runSession({
      rules,
      chart,
      policy,
      strategy,
      seed: s,
      hands,
      bankroll,
      penetration,
      betSizer: flatSizer,
      schedule,
      countSystemId: options.countSystemId ?? 'hi-lo',
    });
    const ramp = runSession({
      rules,
      chart,
      policy,
      strategy,
      seed: s,
      hands,
      bankroll,
      penetration,
      betSizer: rampSizer,
      schedule,
      countSystemId: options.countSystemId ?? 'hi-lo',
    });
    flatPaths.push(flat.path);
    rampPaths.push(ramp.path);
    flatSessions.push(flat);
    rampSessions.push(ramp);
    if (i % 5 === 0 || i === sessions - 1) {
      options.onProgress?.({
        phase: 'Simulating bankroll paths',
        done: i + 1,
        total: sessions,
        value: (i + 1) / sessions,
      });
    }
  }

  const summarize = (sessionResults) => {
    const finals = sessionResults.map((s) => s.final).sort((a, b) => a - b);
    return {
      riskOfRuin: sessionResults.filter((s) => s.ruined).length / Math.max(1, sessionResults.length),
      medianFinal: percentile(finals, 50),
      meanFinal: finals.reduce((s, v) => s + v, 0) / Math.max(1, finals.length),
      p05Final: percentile(finals, 5),
      p95Final: percentile(finals, 95),
      ruinedSessions: sessionResults.filter((s) => s.ruined).length,
      averageHandsPlayed: sessionResults.reduce((s, v) => s + v.handsPlayed, 0) / Math.max(1, sessionResults.length),
    };
  };

  return {
    rules,
    sessions,
    hands,
    bankroll,
    schedule,
    flat: {
      curve: curveAtPoints(flatPaths, schedule),
      stats: summarize(flatSessions),
      preset: 'flat',
    },
    ramp: {
      curve: curveAtPoints(rampPaths, schedule),
      stats: summarize(rampSessions),
      preset: options.rampPreset ?? '1-2-4-8',
    },
    kelly: options.rampPreset === 'kelly'
      ? {
        basePlayerEdge: options.basePlayerEdge ?? -0.004,
        edgePerTrueCount: options.edgePerTrueCount ?? 0.0042,
        fraction: options.kellyFraction ?? 0.5,
        variance: 1.3,
      }
      : null,
    ms: performance.now() - started,
  };
}
