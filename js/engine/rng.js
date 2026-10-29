/**
 * mulberry32: small, fast, deterministic 32-bit PRNG.
 * The same seed always produces the same sequence, which is what makes the
 * simulation and shoe reproducible.
 *
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a second independent-looking stream from one seed. Useful when two
 * simulations need the same seed but must not share an RNG instance.
 * @param {number} seed
 * @param {number} stream
 */
export function seedStream(seed, stream) {
  let x = (seed >>> 0) ^ Math.imul(stream + 1, 0x9e3779b1);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** @returns {number} a seed suitable for mulberry32 */
export function randomSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Render a seed consistently in the UI. */
export function formatSeed(seed) {
  return String(seed >>> 0);
}

export function parseSeed(text, fallback = 1) {
  const n = Number(String(text).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n) >>> 0;
}
