/**
 * Rebuild every Blackjack Lab report from one command.
 *
 * The four reports are deliberately nested:
 *   - the 100-hand session uses the first 100,000 rounds of the reference run;
 *   - the 1,000,000-round run contains the 100,000-round run as its prefix;
 *   - the 10,000,000-round run contains both smaller runs as prefixes.
 *
 * Each builder is a separate process, so a fresh rebuild is also a
 * determinism check. After the builders finish, this script compares the
 * aggregate totals in the written JSON files. A mismatch is a hard failure:
 * the PDFs may look plausible while telling different stories.
 *
 * Pass --verify-only to skip the builders and check the JSON files that are
 * already in reports/. That mode never writes to disk, so it can run in CI or
 * after inspecting a build without spending time regenerating four PDFs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const OUT = join(ROOT, 'reports');
const VERIFY_ONLY = process.argv.includes('--verify-only');
const UNKNOWN_ARGS = process.argv.slice(2).filter(
  (arg) => arg !== '--verify-only' && arg !== '--',
);

if (UNKNOWN_ARGS.length > 0) {
  console.error(`Unknown argument${UNKNOWN_ARGS.length === 1 ? '' : 's'}: ${UNKNOWN_ARGS.join(' ')}`);
  console.error('Usage: node reports/build-all-reports.mjs [--verify-only]');
  process.exit(1);
}

const REPORTS = [
  {
    id: '001',
    name: '100-hand session',
    script: 'build-blackjack-report.mjs',
    json: 'blackjack-100-rounds.json',
  },
  {
    id: '002',
    name: '100,000 rounds',
    script: 'build-blackjack-100k-report.mjs',
    json: 'blackjack-100k.json',
  },
  {
    id: '003',
    name: '1,000,000 rounds',
    script: 'build-blackjack-1m-report.mjs',
    json: 'blackjack-1m.json',
  },
  {
    id: '004',
    name: '10,000,000 rounds',
    script: 'build-blackjack-10m-report.mjs',
    json: 'blackjack-10m.json',
  },
];

const AGGREGATE_FIELDS = [
  'n',
  'net',
  'wins',
  'losses',
  'pushes',
  'hands',
  'mean',
  'sd',
  'se',
  'edge',
  'halfWidth',
  'ciLow',
  'ciHigh',
  'expectedNet',
  'difference',
  'z',
  'winRate',
  'lossRate',
  'pushRate',
  'width',
];

const numberFormat = new Intl.NumberFormat('en-US');
const moneyFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function signedMoney(value) {
  const text = moneyFormat.format(Math.abs(value));
  return value < 0 ? `-${text}` : `+${text}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(join(OUT, file), 'utf8'));
}

function loadReport(report) {
  const jsonPath = join(OUT, report.json);
  if (!existsSync(jsonPath)) {
    throw new Error(
      `${report.id} is missing ${report.json}`
      + (VERIFY_ONLY ? ' (run without --verify-only to build it)' : ''),
    );
  }
  return readJson(report.json);
}

function runReport(report) {
  if (VERIFY_ONLY) {
    console.log(`\n=== ${report.id} · ${report.name} (existing JSON) ===`);
    return loadReport(report);
  }

  const script = join(OUT, report.script);
  if (!existsSync(script)) throw new Error(`Missing builder: ${script}`);

  console.log(`\n=== ${report.id} · ${report.name} ===`);
  const started = Date.now();
  execFileSync(process.execPath, [script], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const seconds = (Date.now() - started) / 1000;
  console.log(`=== ${report.id} finished in ${seconds.toFixed(1)}s ===`);

  return loadReport(report);
}

/**
 * Normalize the 100k report's top-level aggregates to the shape used by the
 * larger runs' nested prefix snapshots.
 */
function prefixOf100k(report) {
  return {
    n: report.rounds,
    net: report.net,
    wins: report.wins,
    losses: report.losses,
    pushes: report.pushes,
    hands: report.hands,
    mean: report.mean,
    sd: report.sd,
    se: report.se,
    edge: report.observedEdge,
    halfWidth: report.edgeHalf,
    ciLow: report.ciLow,
    ciHigh: report.ciHigh,
    expectedNet: report.expectedNet,
    difference: report.difference,
    z: report.z,
    winRate: report.winRate,
    lossRate: report.lossRate,
    pushRate: report.pushRate,
    width: report.edgeHalf * 2,
  };
}

const mismatches = [];

function closeEnough(a, b) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tolerance = Math.max(1, Math.abs(a), Math.abs(b)) * 1e-9;
  return Math.abs(a - b) <= tolerance;
}

function compare(label, smaller, larger, fields = AGGREGATE_FIELDS) {
  for (const field of fields) {
    if (smaller[field] === undefined || larger[field] === undefined) {
      mismatches.push(`${label}: missing ${field} in one of the reports`);
      continue;
    }
    if (!closeEnough(smaller[field], larger[field])) {
      mismatches.push(
        `${label}: ${field} is ${smaller[field]} in the smaller report `
        + `but ${larger[field]} in the larger nest`,
      );
    }
  }
}

function matchSessionReference(session, hundred) {
  const reference = session.reference;
  const checks = [
    ['rounds', reference.rounds, hundred.rounds],
    ['wins', reference.wins, hundred.winRate],
    ['losses', reference.losses, hundred.lossRate],
    ['pushes', reference.pushes, hundred.pushRate],
    ['sd', reference.sd, hundred.sd],
    ['seed', session.referenceSeed, hundred.seed],
    ['exact edge', session.chartHouseEdge, hundred.exactEdge],
  ];
  for (const [field, actual, expected] of checks) {
    if (!closeEnough(actual, expected)) {
      mismatches.push(
        `session reference: ${field} is ${actual} but the 100k report has ${expected}`,
      );
    }
  }
}

function summary(report, aggregate, label) {
  return `${label.padEnd(5)} ${signedMoney(aggregate.net).padStart(10)} units · `
    + `${numberFormat.format(aggregate.wins)}–${numberFormat.format(aggregate.losses)}–`
    + `${numberFormat.format(aggregate.pushes)} · ${aggregate.edge.toFixed(3)}% `
    + `[${aggregate.ciLow.toFixed(3)}%, ${aggregate.ciHigh.toFixed(3)}%]`;
}

let session;
let hundred;
let million;
let tenMillion;

try {
  [session, hundred, million, tenMillion] = REPORTS.map(runReport);
} catch (error) {
  console.error(`\nReport ${VERIFY_ONLY ? 'verification' : 'build'} failed: ${error.message}`);
  process.exit(1);
}

const prefix100k = prefixOf100k(hundred);

// The 100k totals should appear twice in the larger runs.
compare('1M.short vs 100k', million.short, prefix100k);
compare('10M.short vs 100k', tenMillion.short, prefix100k);
compare('10M.short vs 1M.short', tenMillion.short, million.short);

// The 1M totals should be the midpoint snapshot of the 10M run.
compare('10M.mid vs 1M', tenMillion.mid, million.long);

// The session's baseline is the same 100k reference run.
matchSessionReference(session, hundred);

// Every report must be describing the same rules and the same exact edge.
for (const [name, report] of [
  ['100k', hundred],
  ['1M', million],
  ['10M', tenMillion],
]) {
  if (report.seed !== hundred.seed) {
    mismatches.push(`${name}: seed ${report.seed} differs from ${hundred.seed}`);
  }
  if (!closeEnough(report.exactEdge, hundred.exactEdge)) {
    mismatches.push(`${name}: exact edge ${report.exactEdge} differs from ${hundred.exactEdge}`);
  }
  if (JSON.stringify(report.rules) !== JSON.stringify(hundred.rules)) {
    mismatches.push(`${name}: rule set differs from the 100k report`);
  }
}

console.log(VERIFY_ONLY ? '\n=== VERIFIED ===' : '\n=== REBUILT ===');
console.log(
  `001 ${signedMoney(session.net).padStart(10)} units · `
  + `${session.stats.wins}–${session.stats.losses}–${session.stats.pushes} · `
  + `${session.stats.correct}/${session.stats.decisions} decisions`,
);
console.log(summary(hundred, prefix100k, '002'));
console.log(summary(million, million.long, '003'));
console.log(summary(tenMillion, tenMillion.long, '004'));

console.log('\n=== NESTED TOTALS ===');
console.log('100,000 prefix:  100k = 1M.short = 10M.short');
console.log('1,000,000 prefix: 1M   = 10M.mid');
console.log(`100,000 baseline: session reference = 100k report (seed ${hundred.seed})`);

if (mismatches.length > 0) {
  console.error('\nNested totals do NOT agree:');
  for (const mismatch of mismatches) console.error(`  ✗ ${mismatch}`);
  process.exit(1);
}

console.log(
  VERIFY_ONLY
    ? '\nAll nested totals agree. Existing report JSON is consistent.'
    : '\nAll nested totals agree. Outputs are in reports/.',
);
