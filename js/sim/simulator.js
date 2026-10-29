import { bucketFromIndex, bucketIndex, bucketValue, countsTotal } from '../engine/cards.js';
import { addValue, baseForSplitCard, pairBucketOf, stateFromBuckets } from '../engine/hand.js';
import { mulberry32 } from '../engine/rng.js';
import { freshCounts } from '../solver/finite.js';
import { countValue, systemById, trueCountFor } from '../counting/systems.js';
import { chooseAction } from './strategies.js';

function makeHand(c1, c2) {
  const state = stateFromBuckets([c1, c2]);
  return {
    total: state.total,
    soft: state.soft,
    cards: 2,
    pairBucket: pairBucketOf(c1, c2),
    wager: 1,
    fromSplit: false,
    canSurrender: false,
    natural: state.blackjack,
    surrendered: false,
    bust: false,
    done: false,
    aceOneCard: false,
  };
}

function makeSplitHand(cardBucket, aceOneCard) {
  const base = baseForSplitCard(cardBucket);
  return {
    total: base.total,
    soft: base.soft,
    cards: 1,
    pairBucket: cardBucket,
    wager: 1,
    fromSplit: true,
    canSurrender: false,
    natural: false,
    surrendered: false,
    bust: false,
    done: false,
    aceOneCard,
  };
}

/**
 * A seeded, stateful blackjack simulator. It draws rank buckets rather than
 * physical cards, which is equivalent for the rules modeled here and much
 * faster. The shoe composition is exact.
 */
export class BlackjackSimulator {
  /**
   * @param {{
   *   rules: import('../engine/rules.js').Rules,
   *   policy: ReturnType<import('./strategies.js').buildPolicy>,
   *   strategy: string,
   *   seed: number,
   *   shoeMode?: 'infinite'|'finite'|'fresh',
   *   penetration?: number,
   *   countSystemId?: string,
   *   indexPlays?: Array<object>|null,
   *   betSizer?: ((context: {trueCount: number|null, runningCount: number, decksRemaining: number, bankroll: number|null}) => number)|null,
   *   bankroll?: number|null,
   * }} options
   */
  constructor(options) {
    this.rules = options.rules;
    this.policy = options.policy;
    this.strategy = options.strategy;
    this.rng = mulberry32(options.seed);
    this.shoeMode = options.shoeMode ?? 'finite';
    this.penetration = Math.min(0.95, Math.max(0.4, options.penetration ?? 0.75));
    this.infinite = this.shoeMode === 'infinite';
    this.fresh = this.shoeMode === 'fresh';
    this.countSystem = systemById(options.countSystemId ?? 'hi-lo');
    this.indexPlays = options.indexPlays ?? null;
    this.betSizer = options.betSizer ?? null;
    this.bankroll = Number.isFinite(options.bankroll) ? options.bankroll : null;
    this.peakBankroll = this.bankroll;
    this.currentBet = 1;
    this.ruined = false;
    this.counts = null;
    this.remaining = 0;
    this.totalCards = 0;
    this.cutRemaining = 0;
    this.needsShuffle = false;
    this.shoes = 0;
    this.midRoundResets = 0;
    this.runningCount = 0;
    this.unrevealed = 0;
    this.hiddenHole = null;

    this.hands = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.wagered = 0;
    this.cashWagered = 0;
    this.wins = 0;
    this.losses = 0;
    this.pushes = 0;
    this.naturals = 0;
    this.busts = 0;

    if (!this.infinite) this.resetShoe();
  }

  resetShoe() {
    this.counts = freshCounts(Number(this.rules.decks));
    this.remaining = countsTotal(this.counts);
    this.totalCards = this.remaining;
    this.cutRemaining = Math.ceil(this.remaining * (1 - this.penetration));
    this.needsShuffle = false;
    this.runningCount = 0;
    this.unrevealed = 0;
    this.hiddenHole = null;
    this.shoes++;
  }

  cardsLeftUnseen() {
    return this.remaining + this.unrevealed;
  }

  trueCount() {
    if (this.infinite) return null;
    return trueCountFor(this.countSystem, this.runningCount, this.cardsLeftUnseen());
  }

  decksRemaining() {
    if (this.infinite) return Infinity;
    return this.cardsLeftUnseen() / 52;
  }

  /**
   * Draw one card. `visible=false` is used for the dealer's hole card, which
   * does not enter the player's count until it is revealed.
   */
  draw(visible = true) {
    if (this.infinite) {
      // 0..7 = 2..9, 8..11 = ten-value, 12 = ace.
      const r = Math.floor(this.rng() * 13);
      return r < 8 ? r + 2 : r < 12 ? 10 : 11;
    }
    if (this.remaining <= 0) {
      this.midRoundResets++;
      this.resetShoe();
    }
    let bucket = null;
    let r = this.rng() * this.remaining;
    for (let i = 0; i < this.counts.length; i++) {
      r -= this.counts[i];
      if (r < 0) {
        this.counts[i]--;
        this.remaining--;
        bucket = bucketFromIndex(i);
        break;
      }
    }
    if (bucket == null) {
      for (let i = this.counts.length - 1; i >= 0; i--) {
        if (this.counts[i] > 0) {
          this.counts[i]--;
          this.remaining--;
          bucket = bucketFromIndex(i);
          break;
        }
      }
    }
    if (bucket == null) {
      this.midRoundResets++;
      this.resetShoe();
      return this.draw(visible);
    }
    if (visible) {
      this.runningCount += countValue(this.countSystem, bucket);
    } else {
      this.unrevealed++;
      this.hiddenHole = bucket;
    }
    return bucket;
  }

  revealHole() {
    if (this.hiddenHole == null) return;
    this.runningCount += countValue(this.countSystem, this.hiddenHole);
    this.unrevealed = Math.max(0, this.unrevealed - 1);
    this.hiddenHole = null;
  }

  addCard(hand, bucket) {
    const next = addValue(hand.total, hand.soft, bucketValue(bucket));
    hand.total = next.total;
    hand.soft = next.soft;
    hand.cards++;
    hand.pairBucket = null;
    if (next.bust) {
      hand.bust = true;
      hand.done = true;
    }
    return next;
  }

  addSplitCard(hand, bucket) {
    const next = addValue(hand.total, hand.soft, bucketValue(bucket));
    hand.total = next.total;
    hand.soft = next.soft;
    hand.cards++;
    hand.pairBucket = bucket === hand.pairBucket ? hand.pairBucket : null;
    if (next.bust) {
      hand.bust = true;
      hand.done = true;
    }
    return next;
  }

  dealerState(upcard, hole) {
    const base = upcard === 11
      ? addValue(11, true, bucketValue(hole))
      : addValue(upcard, false, bucketValue(hole));
    return { total: base.total, soft: base.soft, bust: base.bust };
  }

  isDealerBlackjack(upcard, hole) {
    return (upcard === 11 && hole === 10) || (upcard === 10 && hole === 11);
  }

  playDealer(upcard, hole, dealerBJ) {
    this.revealHole();
    if (dealerBJ) return { blackjack: true, bust: false, total: 21 };
    let state = this.dealerState(upcard, hole);
    while (
      !state.bust
      && (state.total < 17 || (state.total === 17 && state.soft && this.rules.dealerHitsSoft17))
    ) {
      const next = this.addValueState(state, this.draw());
      state = next;
    }
    return { blackjack: false, bust: state.bust, total: state.total };
  }

  addValueState(state, bucket) {
    const next = addValue(state.total, state.soft, bucketValue(bucket));
    return { total: next.total, soft: next.soft, bust: next.bust };
  }

  /**
   * Split the hand at `index` into two hands, draw their first cards, and
   * return the new total hand count. The first child replaces the hand at
   * `index`; the second is appended.
   */
  splitHand(hands, index, handCount) {
    const original = hands[index];
    const pairBucket = original.pairBucket;
    const aceOneCard = pairBucket === 11 && this.rules.splitAcesOneCard;
    const left = makeSplitHand(pairBucket, aceOneCard);
    const right = makeSplitHand(pairBucket, aceOneCard);
    this.addSplitCard(left, this.draw());
    this.addSplitCard(right, this.draw());
    hands[index] = left;
    hands.push(right);
    return handCount + 1;
  }

  /**
   * Resolve a hand that receives exactly one card after splitting aces. If it
   * drew another ace and resplit aces is enabled, split again; otherwise stand.
   */
  resolveAceOneCard(hands, index, handCount) {
    const hand = hands[index];
    if (hand.bust) {
      hand.done = true;
      return handCount;
    }
    if (
      hand.cards === 2
      && hand.pairBucket === 11
      && this.rules.resplitAces
      && handCount + 1 <= this.rules.resplitLimit
    ) {
      return this.splitHand(hands, index, handCount);
    }
    hand.done = true;
    return handCount;
  }

  playHands(hands, upcard) {
    let handCount = 1;
    for (let index = 0; index < hands.length; index++) {
      let hand = hands[index];
      if (hand.done || hand.natural) {
        hand.done = true;
        continue;
      }

      if (hand.aceOneCard) {
        handCount = this.resolveAceOneCard(hands, index, handCount);
        continue;
      }

      while (!hand.done) {
        const action = chooseAction(
          this.strategy,
          this.policy,
          this.rules,
          hand,
          upcard,
          handCount,
          this.rng,
          {
            trueCount: this.trueCount(),
            runningCount: this.runningCount,
            indexPlays: this.indexPlays,
          },
        );

        if (action === 'S') {
          hand.done = true;
          break;
        }

        if (action === 'H') {
          this.addCard(hand, this.draw());
          hand.canSurrender = false;
          if (hand.bust) break;
          continue;
        }

        if (action === 'D') {
          hand.wager = 2;
          this.addCard(hand, this.draw());
          hand.done = true;
          break;
        }

        if (action === 'R') {
          hand.surrendered = true;
          hand.done = true;
          break;
        }

        if (action === 'P') {
          handCount = this.splitHand(hands, index, handCount);
          hand = hands[index];
          if (hand.aceOneCard) {
            handCount = this.resolveAceOneCard(hands, index, handCount);
            break;
          }
          continue;
        }

        // Unknown fallback: stand rather than loop.
        hand.done = true;
        break;
      }

      if (hand.cards > 2) hand.canSurrender = false;
    }
  }

  settleHand(hand, dealer) {
    if (hand.surrendered) return -0.5;
    if (hand.bust) return -hand.wager;
    if (dealer.blackjack) {
      // The peek-game natural push is settled before play. In ENHC a natural
      // still loses only its original bet to a dealer blackjack.
      return -hand.wager;
    }
    if (hand.natural) return this.rules.blackjackPayout;
    if (dealer.bust) return hand.wager;
    if (hand.total > dealer.total) return hand.wager;
    if (hand.total < dealer.total) return -hand.wager;
    return 0;
  }

  chooseBet() {
    if (!this.betSizer) {
      this.currentBet = 1;
      return 1;
    }
    const raw = Number(this.betSizer({
      trueCount: this.trueCount(),
      runningCount: this.runningCount,
      decksRemaining: this.decksRemaining(),
      bankroll: this.bankroll,
    }));
    let bet = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    if (this.bankroll != null) bet = Math.min(bet, Math.max(0, this.bankroll));
    this.currentBet = bet;
    return bet;
  }

  finishRound() {
    if (!this.infinite && this.remaining <= this.cutRemaining) this.needsShuffle = true;
  }

  playRound() {
    if (this.infinite) {
      // No shoe, no count.
    } else if (this.fresh) {
      this.resetShoe();
    } else if (this.needsShuffle || this.remaining < 15) {
      this.resetShoe();
    }

    const bet = this.chooseBet();
    if (this.bankroll != null && bet < 1) {
      this.ruined = true;
      return 0;
    }

    const c1 = this.draw();
    const c2 = this.draw();
    const upcard = this.draw();
    const hole = this.draw(false);
    const player = makeHand(c1, c2);
    player.canSurrender = this.rules.surrender === 'late' && this.rules.peek;
    const dealerBJ = this.isDealerBlackjack(upcard, hole);
    const peek = this.rules.peek && (upcard === 10 || upcard === 11);

    if (peek && dealerBJ) {
      this.revealHole();
      this.finishRound();
      return player.natural ? 0 : -1;
    }

    if (player.natural && peek) {
      this.finishRound();
      return this.rules.blackjackPayout;
    }

    const hands = [player];
    if (!player.natural) this.playHands(hands, upcard);

    const dealer = this.playDealer(upcard, hole, dealerBJ);
    let net = 0;
    let wager = 0;
    for (const hand of hands) {
      net += this.settleHand(hand, dealer);
      wager += hand.wager;
    }

    this.finishRound();
    this.wagered += wager;
    this.cashWagered += wager * bet;
    return net;
  }

  run(handsToPlay, onSample) {
    const start = this.hands;
    for (let i = 0; i < handsToPlay; i++) {
      const net = this.playRound();
      this.hands++;
      this.sum += net;
      this.sumSq += net * net;
      if (net > 0) this.wins++;
      else if (net < 0) this.losses++;
      else this.pushes++;
      if (this.bankroll != null) {
        this.bankroll += net * this.currentBet;
        if (this.bankroll > this.peakBankroll) this.peakBankroll = this.bankroll;
        if (this.bankroll <= 0) this.ruined = true;
      }
      if (onSample && (this.hands - start) % 1000 === 0) onSample(this);
      if (this.ruined) break;
    }
    return this.snapshot();
  }

  snapshot() {
    const n = this.hands;
    const mean = n > 0 ? this.sum / n : 0;
    const variance = n > 1 ? Math.max(0, (this.sumSq - (this.sum * this.sum) / n) / (n - 1)) : 0;
    const se = n > 0 ? Math.sqrt(variance / n) : 0;
    const ci95 = 1.96 * se;
    return {
      hands: n,
      mean,
      houseEdge: -mean * 100,
      variance,
      sd: Math.sqrt(variance),
      se,
      ci95,
      ciLow: mean - ci95,
      ciHigh: mean + ci95,
      edgeLow: -(mean + ci95) * 100,
      edgeHigh: -(mean - ci95) * 100,
      wagered: this.wagered,
      avgWager: n > 0 ? this.wagered / n : 0,
      wins: this.wins,
      losses: this.losses,
      pushes: this.pushes,
      shoes: this.shoes,
      midRoundResets: this.midRoundResets,
      remaining: this.infinite ? null : this.remaining,
      runningCount: this.runningCount,
      trueCount: this.trueCount(),
      decksRemaining: this.infinite ? null : this.decksRemaining(),
      countSystemId: this.countSystem.id,
      currentBet: this.currentBet,
      bankroll: this.bankroll,
      peakBankroll: this.peakBankroll,
      ruined: this.ruined,
    };
  }
}

/** Fisher-Yates over a counts-per-bucket shoe is not needed: draws are weighted. */
export function totalCardsInShoe(rules) {
  return 52 * Number(rules.decks);
}

/** Bucket index helper re-exported for UI shoe displays. */
export function shoeBucketIndex(bucket) {
  return bucketIndex(bucket);
}

/** T conversion kept local to avoid importing card objects in the hot loop. */
export function shoeTotal(counts) {
  return countsTotal(counts);
}
