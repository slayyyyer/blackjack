import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addValue,
  handLabel,
  pairBucketOf,
  pairTotal,
  stateFromBuckets,
  stateFromCards,
} from '../js/engine/hand.js';
import { bucketOfRank } from '../js/engine/cards.js';

const card = (rank) => ({ rank, suit: 0 });

test('bucket mapping groups tens and separates aces', () => {
  assert.equal(bucketOfRank(2), 2);
  assert.equal(bucketOfRank(9), 9);
  assert.equal(bucketOfRank(10), 10);
  assert.equal(bucketOfRank(11), 10);
  assert.equal(bucketOfRank(12), 10);
  assert.equal(bucketOfRank(13), 10);
  assert.equal(bucketOfRank(14), 11);
});

test('soft and hard totals are evaluated correctly', () => {
  assert.deepEqual(stateFromCards([card(14), card(6)]), {
    total: 17,
    soft: true,
    bust: false,
    blackjack: false,
  });
  assert.equal(stateFromCards([card(14), card(6), card(10)]).total, 17);
  assert.equal(stateFromCards([card(14), card(6), card(10)]).soft, false);
  assert.equal(stateFromCards([card(14), card(14)]).total, 12);
  assert.equal(stateFromCards([card(14), card(14)]).soft, true);
  assert.equal(stateFromCards([card(14), card(14), card(14)]).total, 13);
  assert.equal(stateFromCards([card(14), card(14), card(14)]).soft, true);
  assert.equal(stateFromCards([card(14), card(10)]).blackjack, true);
  assert.equal(stateFromCards([card(10), card(14)]).blackjack, true);
  assert.equal(stateFromCards([card(9), card(9)]).total, 18);
  assert.equal(stateFromCards([card(10), card(10), card(2)]).total, 22);
  assert.equal(stateFromCards([card(10), card(10), card(2)]).bust, true);
});

test('addValue handles every soft/hard transition that the solver relies on', () => {
  const a6 = stateFromCards([card(14), card(6)]);
  assert.deepEqual(addValue(a6.total, a6.soft, 10), { total: 17, soft: false, bust: false });
  assert.deepEqual(addValue(a6.total, a6.soft, 11), { total: 18, soft: true, bust: false });

  const soft21 = stateFromCards([card(14), card(10)]);
  assert.deepEqual(addValue(soft21.total, soft21.soft, 11), { total: 12, soft: false, bust: false });

  const hard20 = stateFromCards([card(10), card(10)]);
  assert.deepEqual(addValue(hard20.total, hard20.soft, 11), { total: 21, soft: false, bust: false });
  assert.deepEqual(addValue(21, false, 11), { total: 22, soft: false, bust: true });

  const soft12 = stateFromCards([card(14), card(14)]);
  assert.deepEqual(addValue(soft12.total, soft12.soft, 10), { total: 12, soft: false, bust: false });
  assert.deepEqual(addValue(soft12.total, soft12.soft, 9), { total: 21, soft: true, bust: false });
});

test('pair helpers cover aces, tens and ordinary pairs', () => {
  assert.equal(pairBucketOf(10, 10), 10);
  assert.equal(pairBucketOf(11, 11), 11);
  assert.equal(pairBucketOf(8, 9), null);
  assert.equal(pairTotal(11), 12);
  assert.equal(pairTotal(10), 20);
  assert.equal(pairTotal(2), 4);
  assert.equal(stateFromBuckets([11, 11]).total, 12);
});

test('hand labels distinguish soft and hard hands', () => {
  assert.equal(handLabel(17, true), 'Soft 17');
  assert.equal(handLabel(17, false), '17');
  assert.equal(handLabel(22, false), 'Bust (22)');
});
