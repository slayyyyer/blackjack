import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dealerDistributionInfinite,
  distributionMass,
} from '../js/solver/dealer.js';
import { BUCKETS } from '../js/engine/cards.js';

test('every infinite-deck dealer distribution is normalized', () => {
  for (const upcard of BUCKETS) {
    for (const h17 of [false, true]) {
      const { raw, noBJ } = dealerDistributionInfinite(upcard, h17);
      assert.ok(Math.abs(distributionMass(raw) - 1) < 1e-12, `raw up=${upcard} h17=${h17}`);
      assert.ok(Math.abs(distributionMass(noBJ) - 1) < 1e-12, `noBJ up=${upcard} h17=${h17}`);
    }
  }
});

test('infinite-deck natural probabilities are exact', () => {
  for (const upcard of BUCKETS) {
    const { raw } = dealerDistributionInfinite(upcard, false);
    if (upcard === 11) assert.ok(Math.abs(raw.bj - 4 / 13) < 1e-12);
    else if (upcard === 10) assert.ok(Math.abs(raw.bj - 1 / 13) < 1e-12);
    else assert.equal(raw.bj, 0);
  }
});

test('known S17 dealer bust rates (8-deck limit, after peek)', () => {
  // Wizard of Odds 8-deck S17 after-peek bust rates. The infinite-deck
  // distribution is the with-replacement limit, so the 8-deck values are the
  // closest published comparison. Upcard 10/A must use the no-blackjack
  // conditional branch because the published table is after the peek.
  const expected = {
    2: 0.353530,
    3: 0.374115,
    4: 0.395469,
    5: 0.417902,
    6: 0.422922,
    7: 0.262031,
    8: 0.243954,
    9: 0.229037,
    10: 0.230125,
    11: 0.166904,
  };
  for (const [upcard, value] of Object.entries(expected)) {
    const { noBJ } = dealerDistributionInfinite(Number(upcard), false);
    assert.ok(Math.abs(noBJ.bust - value) < 0.002, `up=${upcard}: ${noBJ.bust} vs ${value}`);
  }
});

test('H17 changes soft-17 outcomes but not the natural rate', () => {
  const s17 = dealerDistributionInfinite(6, false);
  const h17 = dealerDistributionInfinite(6, true);
  assert.ok(h17.raw.bust > s17.raw.bust);
  assert.equal(s17.raw.bj, h17.raw.bj);
});

test('no-blackjack conditioning removes the natural branch and renormalizes', () => {
  const { raw, noBJ } = dealerDistributionInfinite(11, false);
  assert.ok(raw.bj > 0);
  assert.equal(noBJ.bj, 0);
  assert.ok(noBJ.bust > raw.bust);
  assert.ok(Math.abs(distributionMass(noBJ) - 1) < 1e-12);
});
