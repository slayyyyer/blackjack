import { bucketIndex, countsTotal } from '../engine/cards.js';
import { addValue, baseForSplitCard, pairBucketOf, stateFromBuckets } from '../engine/hand.js';
import { doubleAllowedByTotal } from '../engine/rules.js';
import { mulberry32 } from '../engine/rng.js';
import { freshCounts } from '../solver/finite.js';
import { countValue, systemById, trueCountFor } from '../counting/systems.js';

const RANKS = {
  2: ['2'], 3: ['3'], 4: ['4'], 5: ['5'], 6: ['6'], 7: ['7'], 8: ['8'], 9: ['9'],
  10: ['10', 'J', 'Q', 'K'], 11: ['A'],
};
const SUITS = ['s', 'h', 'd', 'c'];

function rankForBucket(bucket, rng) {
  const ranks = RANKS[bucket] ?? [String(bucket)];
  return ranks[Math.floor(rng() * ranks.length)];
}

function makeCard(bucket, rng) {
  const suit = SUITS[Math.floor(rng() * SUITS.length)];
  return {
    bucket,
    value: bucket === 11 ? 11 : bucket,
    rank: rankForBucket(bucket, rng),
    suit,
    red: suit === 'h' || suit === 'd',
  };
}

function cardSortKey(card) {
  return card.value;
}

/**
 * A stateful, seeded play-table engine. It owns the shoe, round state,
 * settlement, count, bankroll and session log. It never touches the DOM, which
 * makes every rule interaction testable in Node.
 *
 * Public actions: startRound(), act(action), takeInsurance(), declineInsurance(),
 * nextHand(), newShoe(), resetSession(), setBet(), setPenetration().
 * The UI reads getView(), snapshotForCoach(), exportHistory().
 */
export class PlayGame {
  constructor(options = {}) {
    this.rules = options.rules;
    this.seed = (options.seed ?? 20261028) >>> 0;
    this.rng = mulberry32(this.seed);
    this.penetration = Math.min(0.9, Math.max(0.5, options.penetration ?? 0.75));
    this.countSystem = systemById(options.countSystemId ?? 'hi-lo');
    this.startingBankroll = Math.max(10, Number(options.bankroll ?? 200));
    this.bankroll = this.startingBankroll;
    this.bet = Math.max(1, Number(options.bet ?? 1));
    this.infinite = this.rules.decks === 'infinite';
    this.shoeNumber = 0;
    this.counts = null;
    this.remaining = 0;
    this.cutRemaining = 0;
    this.needsShuffle = false;
    this.runningCount = 0;
    this.unrevealed = 0;
    this.seenCards = 0;
    this.seenTens = 0;
    this.phase = 'bet';
    this.round = null;
    this.history = [];
    this.roundSerial = 0;
    this.message = 'Place a bet and deal.';
    this.stats = {
      rounds: 0,
      hands: 0,
      decisions: 0,
      correct: 0,
      evLost: 0,
      actualNet: 0,
      expectedNet: 0,
      expectedActualNet: 0,
      expectedCount: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
    };
    this.newShoe(true);
  }

  newShoe(initial = false) {
    if (!this.infinite) {
      this.counts = freshCounts(Number(this.rules.decks));
      this.remaining = countsTotal(this.counts);
      this.cutRemaining = Math.max(12, Math.ceil(this.remaining * (1 - this.penetration)));
      this.shoeNumber++;
      this.needsShuffle = false;
      this.runningCount = 0;
      this.unrevealed = 0;
    } else {
      this.shoeNumber++;
      this.needsShuffle = false;
      this.runningCount = 0;
      this.unrevealed = 0;
    }
    this.seenCards = 0;
    this.seenTens = 0;
    this.message = initial ? 'New shoe ready. Place a bet.' : `Shoe ${this.shoeNumber} shuffled.`;
  }

  /**
   * Account for a card whose face is now visible to the player. The running
   * count and the insurance density must be built from the same information:
   * cards the player has actually seen. A hidden hole card is not passed here.
   */
  recordVisible(bucket) {
    this.seenCards++;
    if (bucket === 10) this.seenTens++;
    this.runningCount += countValue(this.countSystem, bucket);
  }

  cardsLeftUnseen() {
    return this.infinite ? Infinity : this.remaining + this.unrevealed;
  }

  trueCount() {
    if (this.infinite) return null;
    return trueCountFor(this.countSystem, this.runningCount, this.cardsLeftUnseen());
  }

  decksRemaining() {
    if (this.infinite) return Infinity;
    return this.cardsLeftUnseen() / 52;
  }

  draw(visible = true) {
    if (this.infinite) {
      const r = Math.floor(this.rng() * 13);
      const bucket = r < 8 ? r + 2 : r < 12 ? 10 : 11;
      return makeCard(bucket, this.rng);
    }
    if (this.remaining <= 0) {
      // This should not happen in normal play because the cut card is above
      // 12 cards, but a many-split round can outlast the reserve. Shuffle and
      // record it; the UI surfaces the mid-round reshuffle.
      this.newShoe();
      this.message = 'The shoe ran out mid-round and was reshuffled.';
    }
    let bucket = null;
    let r = this.rng() * this.remaining;
    for (let i = 0; i < this.counts.length; i++) {
      r -= this.counts[i];
      if (r < 0 && this.counts[i] > 0) {
        this.counts[i]--;
        this.remaining--;
        bucket = i === 9 ? 11 : i + 2;
        break;
      }
    }
    if (bucket == null) {
      for (let i = this.counts.length - 1; i >= 0; i--) {
        if (this.counts[i] > 0) {
          this.counts[i]--;
          this.remaining--;
          bucket = i === 9 ? 11 : i + 2;
          break;
        }
      }
    }
    if (bucket == null) {
      this.newShoe();
      return this.draw(visible);
    }
    if (visible) {
      this.recordVisible(bucket);
    } else {
      this.unrevealed++;
    }
    return makeCard(bucket, this.rng);
  }

  revealHole() {
    if (!this.round?.dealer?.holeHidden) return;
    this.round.dealer.holeHidden = false;
    this.recordVisible(this.round.dealer.hole.bucket);
    this.unrevealed = Math.max(0, this.unrevealed - 1);
  }

  handFromCards(cards, wager, fromSplit = false) {
    const hand = {
      cards: [...cards],
      total: 0,
      soft: false,
      pairBucket: null,
      wager,
      fromSplit,
      canSurrender: false,
      natural: false,
      surrendered: false,
      bust: false,
      done: false,
      doubled: false,
      aceOneCard: false,
    };
    if (cards.length === 1) {
      const base = baseForSplitCard(cards[0].bucket);
      hand.total = base.total;
      hand.soft = base.soft;
      hand.pairBucket = cards[0].bucket;
    } else {
      const state = stateFromBuckets(cards.map((c) => c.bucket));
      hand.total = state.total;
      hand.soft = state.soft;
      hand.pairBucket = pairBucketOf(cards[0].bucket, cards[1].bucket);
      hand.natural = !fromSplit && state.blackjack;
    }
    return hand;
  }

  addCard(hand, card) {
    const next = addValue(hand.total, hand.soft, card.value);
    hand.cards.push(card);
    hand.total = next.total;
    hand.soft = next.soft;
    hand.bust = next.bust;
    if (hand.cards.length === 2) {
      hand.pairBucket = pairBucketOf(hand.cards[0].bucket, hand.cards[1].bucket);
    } else if (hand.cards.length > 2) {
      hand.pairBucket = null;
    }
    if (hand.bust) hand.done = true;
    return next;
  }

  dealerFromCards(upcard, hole) {
    const base = upcard.bucket === 11
      ? addValue(11, true, hole.value)
      : addValue(upcard.value, false, hole.value);
    return {
      cards: [upcard, hole],
      upcard,
      hole,
      holeHidden: true,
      total: base.total,
      soft: base.soft,
      bust: base.bust,
      blackjack: this.isDealerBlackjack(upcard, hole),
    };
  }

  isDealerBlackjack(upcard, hole) {
    return (upcard.bucket === 11 && hole.bucket === 10)
      || (upcard.bucket === 10 && hole.bucket === 11);
  }

  startRound() {
    if (this.phase !== 'bet' && this.phase !== 'settled') return false;
    if (this.bankroll < this.bet) {
      this.message = 'Bankroll is below the bet. Start a new session or lower the bet.';
      return false;
    }
    if (!this.infinite && (this.needsShuffle || this.remaining < 12)) {
      this.newShoe();
    }
    this.roundSerial++;
    const id = this.roundSerial;
    const round = {
      id,
      startedAt: new Date().toISOString(),
      bet: this.bet,
      hands: [],
      dealer: null,
      decisions: [],
      insuranceBet: 0,
      insuranceOffered: false,
      insuranceTaken: null,
      unitNet: 0,
      net: 0,
      actionsTaken: 0,
      expectedEV: null,
      expectedCounted: false,
      note: '',
      midRoundShuffle: false,
    };
    this.round = round;

    const p1 = this.draw();
    const up = this.draw();
    const p2 = this.draw();
    const hole = this.draw(false);
    const dealer = this.dealerFromCards(up, hole);
    round.dealer = dealer;

    const hand = this.handFromCards([p1, p2], 1, false);
    hand.canSurrender = this.rules.surrender === 'late' && this.rules.peek && !hand.natural;
    round.hands = [hand];
    this.phase = 'player';
    this.message = 'Your action.';

    if (
      this.rules.insurance
      && up.bucket === 11
      && !hand.natural
      && this.bankroll >= this.bet * 0.5
    ) {
      round.insuranceOffered = true;
      this.phase = 'insurance';
      this.message = 'Insurance is offered. Dealer shows an ace.';
      return true;
    }

    this.resolvePeek();
    return true;
  }

  takeInsurance() {
    if (this.phase !== 'insurance') return false;
    this.round.insuranceTaken = true;
    this.round.insuranceBet = 0.5;
    this.phase = 'player';
    this.message = 'Insurance taken. Dealer will check the hole card.';
    this.resolvePeek();
    return true;
  }

  declineInsurance() {
    if (this.phase !== 'insurance') return false;
    this.round.insuranceTaken = false;
    this.round.insuranceBet = 0;
    this.phase = 'player';
    this.message = 'Insurance declined. Dealer will check the hole card.';
    this.resolvePeek();
    return true;
  }

  resolvePeek() {
    const { dealer, hands } = this.round;
    const player = hands[0];
    const peek = this.rules.peek && (dealer.upcard.bucket === 10 || dealer.upcard.bucket === 11);

    if (peek && dealer.blackjack) {
      this.revealHole();
      this.settleRound('Dealer blackjack.');
      return;
    }

    if (player.natural && !this.rules.peek) {
      // ENHC: the natural is not paid yet. Let the dealer draw/reveal and
      // settle once, because a dealer blackjack beats the player's natural.
      this.phase = 'dealer';
      this.dealerPlay();
      return;
    }

    if (player.natural) {
      this.revealHole();
      this.settleRound('Natural blackjack.');
      return;
    }

    if (peek) {
      // The hole is known not to be blackjack; it stays hidden by the table.
      this.phase = 'player';
      this.message = 'Dealer does not have blackjack. Your action.';
      return;
    }

    // No peek and no natural: the player acts before the dealer reveals.
    this.phase = 'player';
    this.message = 'Your action. The dealer will reveal the hole after you play.';
  }

  legalActions() {
    if (this.phase !== 'player' || !this.round) return [];
    const hand = this.round.hands[this.activeIndex];
    if (!hand || hand.done) return [];
    const handCount = this.round.hands.length;
    if (hand.aceOneCard) {
      const actions = ['stand'];
      if (
        this.rules.resplitAces
        && hand.pairBucket === 11
        && hand.cards.length === 2
        && handCount + 1 <= this.rules.resplitLimit
        && this.bankroll >= this.bet * hand.wager
      ) {
        actions.push('split');
      }
      return actions;
    }
    const actions = ['stand'];
    if (hand.total < 21) actions.push('hit');
    if (
      hand.cards.length === 2
      && (!hand.fromSplit || this.rules.doubleAfterSplit)
      && doubleAllowedByTotal(this.rules, hand.total, hand.soft)
      && this.bankroll >= this.bet * hand.wager
    ) {
      actions.push('double');
    }
    if (
      hand.cards.length === 2
      && hand.pairBucket != null
      && handCount + 1 <= this.rules.resplitLimit
      && !(hand.pairBucket === 11 && hand.fromSplit && !this.rules.resplitAces)
      && this.bankroll >= this.bet * hand.wager
    ) {
      actions.push('split');
    }
    if (hand.canSurrender && hand.cards.length === 2 && !hand.fromSplit) {
      actions.push('surrender');
    }
    return actions;
  }

  get activeIndex() {
    if (!this.round) return 0;
    return this.round.hands.findIndex((h) => !h.done);
  }

  act(action) {
    if (this.phase !== 'player') return false;
    const legal = this.legalActions();
    if (!legal.includes(action)) return false;
    const index = this.activeIndex;
    const hand = this.round.hands[index];
    if (!hand) return false;
    this.round.lastAction = action;

    // Count actions, not log entries: grading is asynchronous and two split
    // hands can finish out of order. The first action in the round is the only
    // one whose EV represents the round's initial expectation.
    this.round.actionsTaken = (this.round.actionsTaken ?? 0) + 1;

    if (action === 'hit') {
      this.addCard(hand, this.draw());
      hand.canSurrender = false;
      if (hand.bust || hand.total >= 21) hand.done = true;
      this.message = hand.bust ? 'Bust.' : 'Hit.';
      this.advanceAfterAction();
      return true;
    }

    if (action === 'stand') {
      hand.done = true;
      hand.canSurrender = false;
      this.message = 'Stand.';
      this.advanceAfterAction();
      return true;
    }

    if (action === 'double') {
      hand.wager *= 2;
      hand.doubled = true;
      this.addCard(hand, this.draw());
      hand.done = true;
      hand.canSurrender = false;
      this.message = hand.bust ? 'Double and bust.' : 'Double.';
      this.advanceAfterAction();
      return true;
    }

    if (action === 'split') {
      const original = hand;
      const first = original.cards[0];
      const second = original.cards[1];
      const left = this.handFromCards([first], 1, true);
      const right = this.handFromCards([second], 1, true);
      this.addCard(left, this.draw());
      this.addCard(right, this.draw());
      const aceOneCard = this.rules.splitAcesOneCard && first.bucket === 11;
      left.aceOneCard = aceOneCard;
      right.aceOneCard = aceOneCard;
      left.canSurrender = false;
      right.canSurrender = false;
      if (aceOneCard) {
        const leftCanResplit = this.rules.resplitAces && left.pairBucket === 11 && this.round.hands.length + 1 < this.rules.resplitLimit;
        const rightCanResplit = this.rules.resplitAces && right.pairBucket === 11 && this.round.hands.length + 2 < this.rules.resplitLimit;
        left.done = !leftCanResplit;
        right.done = !rightCanResplit;
      }
      this.round.hands.splice(index, 1, left, right);
      this.phase = 'player';
      this.message = 'Split.';
      this.advanceAfterAction();
      return true;
    }

    if (action === 'surrender') {
      hand.surrendered = true;
      hand.done = true;
      this.settleRound('Late surrender.');
      return true;
    }

    return false;
  }

  advanceAfterAction() {
    const next = this.round.hands.findIndex((h) => !h.done);
    if (next === -1) {
      this.dealerPlay();
      return;
    }
    this.phase = 'player';
    this.message = `Hand ${next + 1}: your action.`;
  }

  dealerPlay() {
    if (this.phase === 'settled') return;
    this.revealHole();
    this.phase = 'dealer';
    const dealer = this.round.dealer;
    if (dealer.blackjack) {
      this.settleRound('Dealer blackjack.');
      return;
    }
    while (
      dealer.total < 17
      || (dealer.total === 17 && dealer.soft && this.rules.dealerHitsSoft17)
    ) {
      const card = this.draw();
      const next = addValue(dealer.total, dealer.soft, card.value);
      dealer.cards.push(card);
      dealer.total = next.total;
      dealer.soft = next.soft;
      dealer.bust = next.bust;
      if (dealer.bust) break;
    }
    this.settleRound(dealer.bust ? 'Dealer busts.' : `Dealer stands on ${dealer.total}.`);
  }

  settleRound(note = '') {
    if (!this.round || this.phase === 'settled') return;
    this.revealHole();
    const { dealer, hands } = this.round;
    let unitNet = 0;
    for (const hand of hands) {
      let handNet = 0;
      if (hand.surrendered) {
        handNet = -0.5;
      } else if (hand.bust) {
        handNet = -hand.wager;
      } else if (dealer.blackjack) {
        handNet = hand.natural && this.rules.peek ? 0 : -hand.wager;
      } else if (hand.natural) {
        handNet = this.rules.blackjackPayout;
      } else if (dealer.bust) {
        handNet = hand.wager;
      } else if (hand.total > dealer.total) {
        handNet = hand.wager;
      } else if (hand.total < dealer.total) {
        handNet = -hand.wager;
      }
      hand.net = handNet;
      unitNet += handNet;
    }

    if (this.round.insuranceBet > 0) {
      unitNet += dealer.blackjack ? this.round.insuranceBet * 2 : -this.round.insuranceBet;
      this.round.insuranceNet = dealer.blackjack ? this.round.insuranceBet * 2 : -this.round.insuranceBet;
    }

    // Settlement follows the wager that was actually made for this round.
    // The live `this.bet` may already have been edited for the next deal while
    // an asynchronous coach grade is still in flight.
    const cashNet = unitNet * this.round.bet;
    this.round.unitNet = unitNet;
    this.round.net = cashNet;
    this.round.note = note;
    this.round.endedAt = new Date().toISOString();
    this.bankroll += cashNet;
    this.phase = 'settled';
    this.message = `${note} ${cashNet >= 0 ? '+' : ''}${cashNet.toFixed(2)} units.`;

    this.stats.rounds++;
    this.stats.hands += hands.length;
    this.stats.actualNet += cashNet;
    if (this.round.expectedEV != null && !this.round.expectedCounted) {
      this.stats.expectedActualNet += cashNet;
      this.round.expectedCounted = true;
    }
    if (cashNet > 0) this.stats.wins++;
    else if (cashNet < 0) this.stats.losses++;
    else this.stats.pushes++;

    this.history.unshift(this.round);
    if (!this.infinite && this.remaining <= this.cutRemaining) this.needsShuffle = true;
  }

  nextHand() {
    if (this.phase !== 'settled') return false;
    this.phase = 'bet';
    this.round = null;
    this.message = 'Place a bet and deal.';
    if (!this.infinite && this.needsShuffle) {
      this.newShoe();
    }
    return true;
  }

  setBet(value) {
    if (this.phase !== 'bet' && this.phase !== 'settled') return false;
    const next = Math.floor(Number(value));
    if (!Number.isFinite(next) || next < 1) return false;
    this.bet = Math.min(next, Math.max(1, Math.floor(this.bankroll)));
    return true;
  }

  setPenetration(value) {
    const next = Number(value);
    if (!Number.isFinite(next)) return false;
    this.penetration = Math.min(0.9, Math.max(0.5, next));
    if (this.phase === 'bet' || this.phase === 'settled') this.newShoe();
    return true;
  }

  setCountSystem(id) {
    this.countSystem = systemById(id);
    return true;
  }

  resetSession({ bankroll, bet, seed } = {}) {
    if (Number.isFinite(bankroll)) {
      this.startingBankroll = Math.max(10, Math.floor(bankroll));
      this.bankroll = this.startingBankroll;
    }
    if (Number.isFinite(bet)) this.bet = Math.max(1, Math.floor(bet));
    if (Number.isFinite(seed)) {
      this.seed = seed >>> 0;
      this.rng = mulberry32(this.seed);
    }
    this.stats = {
      rounds: 0,
      hands: 0,
      decisions: 0,
      correct: 0,
      evLost: 0,
      actualNet: 0,
      expectedNet: 0,
      expectedActualNet: 0,
      expectedCount: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
    };
    this.history = [];
    this.round = null;
    this.phase = 'bet';
    this.newShoe();
    return true;
  }

  /**
   * A plain-data snapshot for the finite-shoe coach. The returned counts
   * exclude the current hand's cards and the dealer upcard, and include the
   * hidden hole card, which is exactly what evaluateHandFinite expects.
   */
  snapshotForCoach() {
    if (this.phase !== 'player' || !this.round) return null;
    const index = this.activeIndex;
    const hand = this.round.hands[index];
    if (!hand || hand.done) return null;
    const legal = this.legalActions();
    const upcard = this.round.dealer.upcard;
    const counts = this.infinite ? null : this.counts.slice();
    if (counts && this.round.dealer.holeHidden) {
      counts[bucketIndex(this.round.dealer.hole.bucket)]++;
    }
    return {
      roundId: this.round.id,
      handIndex: index,
      handLabel: `Hand ${index + 1}`,
      actionIndex: this.round.actionsTaken ?? 0,
      cards: hand.cards.map((c) => ({ ...c })),
      upcard: { ...upcard },
      counts,
      state: {
        total: hand.total,
        soft: hand.soft,
        pairBucket: hand.cards.length === 2 ? hand.pairBucket : null,
        upcard: upcard.bucket,
        canDouble: legal.includes('double'),
        canSurrender: legal.includes('surrender'),
        splitHands: this.round.hands.length,
      },
      legalActions: legal,
      fromSplit: hand.fromSplit,
      aceOneCard: hand.aceOneCard,
      trueCount: this.trueCount(),
      runningCount: this.runningCount,
      decksRemaining: this.decksRemaining(),
    };
  }

  /**
   * Ten-value density among the cards still unseen at the insurance decision.
   *
   * The hole card is one of those unseen cards. `counts` no longer contains
   * it, so using `counts[8] / cardsLeftUnseen()` would condition the numerator
   * on the hole while leaving it in the denominator. That biases the estimate
   * downward exactly when the hole is a ten, which makes the 1/3 insurance
   * threshold select the wrong hands.
   *
   * Instead, count only cards the player has actually seen. The numerator is
   * the original number of tens minus the visible tens; the denominator is the
   * original shoe size minus all visible cards, so the hidden hole stays in
   * both the unseen set and the unknown-ten set.
   */
  tenDensity() {
    if (this.infinite) return 4 / 13;
    const decks = Number(this.rules.decks);
    const unseen = 52 * decks - this.seenCards;
    if (!Number.isFinite(unseen) || unseen <= 0) return 4 / 13;
    return (16 * decks - this.seenTens) / unseen;
  }

  /**
   * EV of taking insurance, per unit of the main bet. Insurance costs half a
   * unit and pays 2:1 when the dealer has blackjack: EV = 0.5 * (3t - 1).
   */
  insuranceEV() {
    if (this.phase !== 'insurance' || !this.round) return null;
    const t = this.tenDensity();
    return 0.5 * (3 * t - 1);
  }

  /**
   * Grade the insurance decision before the hole card is revealed. Both taking
   * and declining are legal; the better side depends on whether taking has a
   * non-negative EV. Returned EV values are per unit of the main bet.
   */
  insuranceDecision(taken) {
    const ev = this.insuranceEV();
    if (ev == null) return null;
    const correct = taken ? ev >= 0 : ev <= 0;
    return {
      roundId: this.round.id,
      action: 'insurance',
      actionLetter: null,
      actionName: taken ? 'Take insurance' : 'No insurance',
      actionEV: taken ? ev : 0,
      best: ev >= 0 ? 'insurance' : 'no-insurance',
      bestLetter: null,
      bestName: ev >= 0 ? 'Take insurance' : 'No insurance',
      bestEV: Math.max(ev, 0),
      evLost: correct ? 0 : Math.abs(ev),
      correct,
      graded: true,
      mode: 'insurance',
      isInsurance: true,
      insuranceEV: ev,
      trueCount: this.trueCount(),
      runningCount: this.runningCount,
      cards: [],
      upcard: this.round.dealer?.upcard?.rank ?? 'A',
      hand: 'Insurance',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Recompute this round's expectation after adding a graded decision. The
   * expectation is based on the action that was actually chosen, not the best
   * action, so luck = actual - expected never absorbs the cost of mistakes.
   * Insurance is additive and is included when it was offered and graded.
   */
  syncExpected(round) {
    const insuranceEV = Number.isFinite(round.insuranceExpectedEV)
      ? round.insuranceExpectedEV
      : null;
    const actionEV = Number.isFinite(round.actionExpectedEV)
      ? round.actionExpectedEV
      : null;
    if (insuranceEV == null && actionEV == null) return;

    const next = ((actionEV ?? 0) + (insuranceEV ?? 0)) * round.bet;
    if (round.expectedEV == null) {
      this.stats.expectedCount++;
    } else {
      this.stats.expectedNet -= round.expectedEV;
    }
    round.expectedEV = next;
    this.stats.expectedNet += next;

    if (round.endedAt && !round.expectedCounted) {
      this.stats.expectedActualNet += round.net;
      round.expectedCounted = true;
    }
  }

  logDecision(roundId, decision) {
    const round = this.round?.id === roundId ? this.round : this.history.find((r) => r.id === roundId);
    if (!round) return false;
    const firstAction = decision.firstAction
      ?? !round.decisions.some((d) => d.graded && !d.isInsurance);
    round.decisions.push(decision);
    if (decision.graded) {
      this.stats.decisions++;
      if (decision.correct) this.stats.correct++;
      // Decision EVs are per unit; the session total is in units of the bet
      // actually at risk for this round.
      if (Number.isFinite(decision.evLost)) this.stats.evLost += decision.evLost * round.bet;
      if (decision.isInsurance) {
        round.insuranceExpectedEV = decision.actionEV;
      } else if (firstAction && Number.isFinite(decision.actionEV)) {
        round.actionExpectedEV = decision.actionEV;
      }
      this.syncExpected(round);
    }
    return true;
  }

  statsView() {
    return {
      ...this.stats,
      accuracy: this.stats.decisions > 0 ? this.stats.correct / this.stats.decisions : null,
      luck: this.stats.expectedActualNet - this.stats.expectedNet,
    };
  }

  getView() {
    const round = this.round;
    const active = this.activeIndex;
    const dealer = round?.dealer
      ? {
        cards: round.dealer.holeHidden ? [round.dealer.upcard] : round.dealer.cards,
        hidden: round.dealer.holeHidden,
        total: round.dealer.holeHidden
          ? (round.dealer.upcard.bucket === 11 ? 11 : round.dealer.upcard.value)
          : round.dealer.total,
        soft: round.dealer.holeHidden ? false : round.dealer.soft,
        bust: round.dealer.holeHidden ? false : round.dealer.bust,
        blackjack: round.dealer.holeHidden ? false : round.dealer.blackjack,
        upcard: round.dealer.upcard,
      }
      : null;
    const hands = round?.hands?.map((hand, index) => ({
      index,
      cards: hand.cards,
      total: hand.total,
      soft: hand.soft,
      wager: hand.wager,
      done: hand.done,
      active: index === active && this.phase === 'player',
      bust: hand.bust,
      surrendered: hand.surrendered,
      natural: hand.natural,
      fromSplit: hand.fromSplit,
      doubled: hand.doubled,
      aceOneCard: hand.aceOneCard,
      net: hand.net,
    })) ?? [];
    return {
      phase: this.phase,
      bankroll: this.bankroll,
      startingBankroll: this.startingBankroll,
      bet: this.bet,
      dealer,
      hands,
      activeIndex: active,
      legalActions: this.legalActions(),
      canDeal: (this.phase === 'bet' || this.phase === 'settled') && this.bankroll >= this.bet,
      message: this.message,
      roundNet: round?.net ?? null,
      roundId: round?.id ?? null,
      insuranceOffered: Boolean(round?.insuranceOffered && this.phase === 'insurance'),
      insuranceTaken: round?.insuranceTaken ?? null,
      insuranceBet: round?.insuranceBet ?? 0,
      shoeNumber: this.shoeNumber,
      remaining: this.infinite ? null : this.remaining,
      cutRemaining: this.infinite ? null : this.cutRemaining,
      penetration: this.penetration,
      needsShuffle: this.needsShuffle,
      infinite: this.infinite,
      runningCount: this.runningCount,
      trueCount: this.trueCount(),
      decksRemaining: this.decksRemaining(),
      countSystem: {
        id: this.countSystem.id,
        name: this.countSystem.name,
        balanced: this.countSystem.balanced,
        keyCount: this.countSystem.keyCount,
      },
      stats: this.statsView(),
      history: this.history.slice(0, 12).map((r) => ({
        id: r.id,
        cards: r.hands.map((h) => h.cards),
        dealer: r.dealer.cards,
        net: r.net,
        note: r.note,
      })),
    };
  }

  exportHistory() {
    const serializable = (card) => ({
      rank: card.rank,
      suit: card.suit,
      value: card.value,
      bucket: card.bucket,
    });
    return {
      app: 'Blackjack Lab',
      exportedAt: new Date().toISOString(),
      seed: this.seed,
      rules: this.rules,
      countSystem: this.countSystem.id,
      penetration: this.penetration,
      startingBankroll: this.startingBankroll,
      endingBankroll: this.bankroll,
      stats: this.statsView(),
      rounds: this.history.slice().reverse().map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        bet: r.bet,
        dealer: {
          cards: r.dealer.cards.map(serializable),
          total: r.dealer.total,
          blackjack: r.dealer.blackjack,
        },
        hands: r.hands.map((h) => ({
          cards: h.cards.map(serializable),
          total: h.total,
          wager: h.wager,
          net: h.net,
          bust: h.bust,
          surrendered: h.surrendered,
          natural: h.natural,
        })),
        decisions: r.decisions,
        insuranceBet: r.insuranceBet,
        insuranceTaken: r.insuranceTaken,
        unitNet: r.unitNet,
        net: r.net,
        expectedEV: r.expectedEV,
        note: r.note,
      })),
    };
  }
}

/** Export the rank helper for the play view's card labels. */
export { cardSortKey, makeCard };
