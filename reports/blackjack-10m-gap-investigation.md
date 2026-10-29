# The 10M gap: insurance, not the cut card

**Question:** the 10,000,000-round run finished at a 0.518% house edge, while the fresh-shoe reference is 0.426%. Is the 0.092-point gap caused by the 75% cut-card shoe or by using a fresh-shoe reference?

**Answer:** neither. The gap is a bug in the live insurance ten-density calculation. The main game is consistent with the reference. The 10M run's insurance decisions cost 0.0796 points, and that is almost the entire gap.

## The decomposition

All rows use the same seed (`8675309`), rules, chart policy, and 75% cut card unless noted.

| Run | Total edge | Main-game edge | Insurance effect | Gap vs 0.426% | Distance |
|---|---:|---:|---:|---:|---:|
| Shipped 10M | 0.5180% | 0.4385% | **+0.0796** (cost) | +0.0924 | **2.54σ** |
| Insurance declined | 0.4385% | 0.4385% | 0 | +0.0129 | 0.35σ |
| Corrected ten density | 0.4172% | 0.4385% | −0.0212 (gain) | −0.0084 | 0.23σ |
| Fresh shoe, corrected | 0.4067% | 0.4067% | 0 | −0.0189 | 0.52σ |

The 95% interval for the shipped 10M run was **0.447%–0.589%**, just above the 0.426% reference. With insurance declined, the same sequence gives **0.367%–0.510%**, which covers the reference. Correcting the density gives **0.346%–0.489%**, also covering it.

The main game did not move: its 0.4385% edge is identical in the shipped, declined, and corrected runs. Only the insurance layer changed.

## Why the 1M run looked fine

The 1M sample had a lucky main game:

- Main game: **0.3892%** — 0.036 points *below* the reference.
- Insurance: **+0.0768 points** against the player.
- Total: **0.4660%** — only 0.040 points above the reference.

The two errors nearly canceled. At 10M, the main game drifted up to 0.4385% while insurance stayed at roughly 0.080 points, so the total moved to 0.518% and the interval stopped covering 0.426%.

## Root cause

`PlayGame.tenDensity()` does this:

```js
const unseen = this.cardsLeftUnseen(); // remaining + unrevealed
return this.counts[8] / unseen;
```

The hole card has already been removed from `counts` by `draw(false)`, but `cardsLeftUnseen()` adds it back to the denominator. The numerator and denominator therefore describe different sets of cards. Worse, the numerator is conditioned on the hole: if the hole is a ten, `counts[8]` is one lower.

At the 1/3 insurance threshold, that one-card shift selects the wrong hands. In the shipped 10M run:

- Insurance was taken **82,698** times.
- The hands won **22,262** times, a **26.92%** dealer-blackjack rate.
- Their own ten densities implied **34.92%**.
- That is a **~48σ** shortfall, not sampling noise.

When insurance was taken on every ace-up hand in a 1M control, the observed blackjack rate was **30.79%**, matching the **30.66%** implied by the density. The settlement and the density formula are fine in isolation; the selection is what breaks.

Changing only the denominator to `remaining` does **not** fix it. The 10M control finished at **0.5268%** and still selected a 27.06% blackjack set. The estimate still conditions on the already-drawn hole.

### Correct calculation

Track visible cards, not the post-hole `counts` array:

```js
// Reset on every new shoe.
seenCards = 0;
seenTens = 0;

// On every visible draw and on revealHole:
seenCards++;
if (bucket === 10) seenTens++;

// Pre-hole ten density. The current hole is not in seenCards, so it stays in
// the denominator, which is correct: it is still unknown.
tenDensity() {
  const total = 52 * Number(this.rules.decks);
  const cards = total - seenCards;
  if (cards <= 0) return 4 / 13;
  return (16 * Number(this.rules.decks) - seenTens) / cards;
}
```

With that estimator, the 10M run takes insurance 92,778 times, wins **34.86%** of them, and the decision is calibrated: expected net **+2,278.85**, actual **+2,124.00** (`-0.7σ`). Total edge: **0.4172%**.

## Cut-card control

The fresh-shoe run starts every round from a full six-deck shoe. The 75% run starts with whatever is left after the cut card.

| Shoe | Main-game edge | 95% interval |
|---|---:|---:|
| 75% cut card | 0.4385% | 0.3671%–0.5098% |
| Fresh every round | 0.4067% | 0.3354%–0.4781% |

The difference is **0.0317 points**, with a standard error of **0.0515 points** — **0.62σ**. This sample does not establish a cut-card effect, and it bounds any effect well below the 0.092-point gap. The 0.426% reference sits inside both intervals, between the two point estimates. The cut card is not the explanation for the 10M anomaly.

## What this means for the report

1. **Fix `tenDensity()`** by tracking visible cards. This also fixes the live insurance grade, not just the report.
2. **Decide what insurance policy the report is measuring.** The 0.426% reference is a no-insurance, fixed-chart solve. A simulation that takes count-based insurance is a different strategy. For an apples-to-apples basic-strategy report, decline insurance. If the report wants to show count-aware insurance, the exact reference must include the same policy, or the insurance contribution must be shown separately.
3. **Regenerate the 10M PDF.** Its "model gap / fresh-shoe reference" conclusion is superseded. With insurance declined, the same run is 0.4385% and the interval covers 0.426%. With the density fixed, it is 0.4172%. Either result is a consistency check, not a 2.5σ anomaly.

## Reproduce

```bash
NODE=node

# Shipped configuration
"$NODE" reports/investigate-10m-gap.mjs --rounds 10000000 --seed 8675309 --quiet

# Match the no-insurance reference
"$NODE" reports/investigate-10m-gap.mjs --rounds 10000000 --seed 8675309 --quiet --insurance decline

# Corrected pre-hole density
"$NODE" reports/investigate-10m-gap.mjs --rounds 10000000 --seed 8675309 --quiet --ten-density prehole

# Fresh shoe every round, corrected density
"$NODE" reports/investigate-10m-gap.mjs --rounds 10000000 --seed 8675309 --quiet --fresh --ten-density prehole
```

Each run writes `reports/blackjack-10m-gap-investigation.json`. The per-decision diagnostic is `reports/diagnose-insurance.mjs`.

No shipped code or report was changed by this investigation.
