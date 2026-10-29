# Blackjack Lab

An offline, static blackjack lab that computes optimal strategy instead of copying a chart, proves the result by seeded Monte Carlo simulation, measures card-counting systems, and grades your play at a real table.

No backend, no framework, no build step, no CDN, no analytics. HTML, CSS, Canvas, vanilla ES modules, and Web Workers.

- **Exact solver** — expected value of every legal action for every hand, memoized recursion over an infinite-deck model, plus composition-dependent finite-shoe solves.
- **Strategy chart** — hard, soft, and pair grids derived cell by cell, with an EV breakdown, dealer outcome distribution, and rule-diff highlighting.
- **Proof by simulation** — millions of seeded hands in a worker, a shrinking 95% band converging on the solver's edge, and a six-strategy comparison.
- **Counting lab** — solver-derived edge-by-true-count curve, bet-ramp and risk-of-ruin simulation, index thresholds, a Hi-Lo quality scatter, and a speed trainer.
- **Play mode** — a real shoe with a cut card and penetration, a coach that prices every decision in bets, session stats, and JSON export.

## Quick start

You need a modern browser and any static HTTP server. ES modules and module workers do not load from `file://`.

```bash
# from the repository root
node tools/serve.mjs 8080
# open http://127.0.0.1:8080
```

The site opens on the playable table. Set a bet and press **Deal**; the strategy, simulation, and counting tools are the other tabs.

`tools/serve.mjs` is a dependency-free development server included in the repo. It accepts an optional root directory and port:

```bash
node tools/serve.mjs . 4173
```

Python works too:

```bash
python3 -m http.server 8080
# or, if the project scripts are installed: npm run serve
```

There is nothing to install or build. `package.json` exists only for the development scripts.

## Reports

Rebuild the four report PDFs in order and verify that their nested totals agree:

```bash
npm run reports
```

This runs the 100-hand session, the 100,000-round report, the 1,000,000-round report, and the 10,000,000-round report from their own seeds. It then checks that the 100k prefix in the 1M and 10M runs matches the 100k report, that the 1M midpoint matches the 1M report, and that the session's 100k baseline matches the 100k report. Any mismatch exits non-zero. Outputs are written to `reports/` as HTML, JSON, and PDF.

To check the JSON files already in `reports/` without rebuilding the PDFs:

```bash
npm run reports -- --verify-only
```

This runs the same nested-total checks and exits non-zero on a mismatch or missing file. It does not write anything.

## Tests

```bash
npm test
# equivalent without npm
node --test tests/*.test.js
```

Node 20+ recommended. The suite has no dependencies and runs the engine and solver directly, outside the browser. It covers:

- bucket mapping, soft/hard evaluation, and every hand transition the solver relies on;
- exact infinite-deck dealer distributions, normalization, naturals, bust rates, and peek conditioning;
- published Wizard-of-Odds infinite-deck EVs and a standard S17/DAS basic-strategy chart;
- the house edge (0.5117% for the default infinite-deck rules) and the direction/magnitude of rule changes;
- the exact four H17 strategy flips and the rule-diff output;
- deterministic headless play sessions, chosen-action expected net, bet-size weighting, and insurance grading.

## What is in each tab

### 01 · Strategy

Three charts (hard totals, soft totals, pairs) against every dealer upcard. Each cell is the action with the highest expected value, computed for the rules in the left panel. Select a cell to see:

- the EV of every legal action, with the best action highlighted;
- the dealer's final-outcome distribution for that upcard;
- a plain-English explanation of why the best action wins.

Changing a rule re-solves everything and marks the cells that flipped, with the change in house edge. For example, switching from S17 to H17 flips four cells and costs about 0.2%.

### 02 · Simulation

Run 10,000 to 10 million hands against the solved chart using a seed you control. The running average is plotted against the solver's reference edge with a shrinking 95% confidence band. The panel says explicitly whether the result agrees with the reference within its standard error.

Deal models:

- **Fresh shoe each hand** — the cleanest comparison with the fresh-shoe reference.
- **Continuous shoe** — a realistic shoe with penetration, shuffles, and a cut card.
- **Infinite deck** — draws with replacement.

"Compare strategies" runs optimal chart, chart plus standard index deviations, mimic-the-dealer, never-bust, always-stand, and random legal action on the same starting seed. Each row shows the edge, 95% interval, and cost versus optimal.

### 03 · Counting

- **Edge vs count** — the finite solver is run at representative compositions for true counts from −4 to +8 by default. The result is the actual player edge for the displayed strategy, fitted with a slope in points per true count. For six decks the fit is roughly +0.4 points per true count, crossing zero near +1.
- **Bet ramp** — flat betting versus a selectable ramp (or Kelly), with median bankroll paths, 5th–95th percentile bands, risk of ruin, and final-bankroll statistics. Sessions stop at ruin. The edge model is the solved slope, not a guessed +0.5%.
- **Indices** — for 18 borderline decisions, the solver walks representative counts and finds where the best action flips. The derived threshold is shown beside the standard Illustrious-18-style value where the table has one, so you can verify both.
- **Hi-Lo quality** — each dot is a full composition solved across every initial deal, plotted against its true count, with a linear fit and correlation. This shows how much of the real edge true count explains.
- **Trainer** — cards are flashed one at a time; enter the running count and get graded on accuracy and speed.

Counting systems are a data table: Hi-Lo, KO, and Omega II are included. Balanced systems show a true count; KO is unbalanced and exposes its running and key counts instead. The index lab and simulation deviations use Hi-Lo.

### 04 · Play

A shoe with a cut card, configurable penetration, bankroll, and bet. All modeled actions are available: hit, stand, double, split (up to four hands), resplit aces if enabled, late surrender if enabled, and insurance if offered.

The coach can be off, hint-on-request, or always-on. After each decision it reports the best action, your action, and the EV lost in bets. With **count-aware** enabled, it solves the exact remaining composition; otherwise it grades against the chart.

Session stats separate skill from luck: hands played, decision accuracy, EV lost to mistakes, actual net, expected net, and the difference. The count display can be hidden and revealed for practice. The hand history exports as JSON with rules, seed, cards, decisions, and results.

## Rules modeled

| Rule | Options |
| --- | --- |
| Decks | 1, 2, 4, 6, 8, or infinite |
| Dealer soft 17 | stands (S17) or hits (H17) |
| Blackjack payout | 3:2, 6:5, or 1:1 |
| Doubling | any two cards, or hard 9–11 only |
| Double after split | on or off |
| Split aces | one card only, or may hit |
| Resplits | up to 2, 3, or 4 total hands |
| Resplit aces | on or off |
| Surrender | none or late |
| Dealer peek | US peek or ENHC/no-peek |
| Insurance | offered in play mode, or off |

Late surrender is only offered in peek games, matching the common rule that surrender is resolved after the dealer checks for blackjack.

## How the math works

### Dealer distribution

For an infinite deck, the dealer's final total is a memoized recursion over `(total, soft)` with the upcard fixed. Each draw adds one of thirteen ranks with its fixed probability. The recursion records 17, 18, 19, 20, 21, blackjack, and bust. Dealer blackjack is a separate terminal branch when the upcard is an ace or ten.

For a finite shoe, the recursion takes the remaining ten-bucket composition and branches on the actual number of each rank left. The distribution is exact for that composition. In a peek game, the player's action EVs use the distribution conditioned on the dealer not having blackjack, and the initial hand's EV includes the probability of losing to a peeked blackjack.

### Player EV

`EV(stand)` is the win/loss/push expectation against the dealer distribution. `EV(hit)` is the probability-weighted sum of the EVs of every resulting total, memoized on the hand state. `EV(double)` draws exactly one card and stands, with both the win and the loss doubled, so it is twice the expectation of the resulting total. `EV(surrender)` is −0.5. The best action is the maximum, with a deterministic tie order.

### Splits

A split creates two hands from the pair, each with its own wager. The infinite-deck solver evaluates one post-split hand recursively, including the option to resplit up to the limit, then doubles it for the two independent hands. Split aces receive one card unless the rules allow otherwise. The finite solver uses the same independent-hand model after dealing the split cards from the real composition; see the approximation list below.

### House edge

The displayed edge is the negative of the player's expected value per initial bet, weighted over every initial `(upcard, card1, card2)` deal from a full shoe. In a peek game, dealer blackjack is settled before player action. The edge is shown as a positive number when the casino has the advantage.

The header uses two models:

- **Infinite deck** — the exact composition-independent edge, solved instantly.
- **Finite shoe** — the fresh-shoe, composition-aware edge for the displayed total-dependent chart. This is the reference the simulator converges to in fresh-shoe mode.

### Simulation

`mulberry32` provides a seedable stream. The simulator draws rank buckets from the actual shoe, deals, plays the hand with the selected policy, plays the dealer, and settles. Variance and standard error come from the per-hand results, so the 95% band is measured rather than assumed. All runs show their seed.

### Counting

The edge curve starts from a representative shoe at the requested penetration. Cards are removed in low/neutral/high groups so the running count hits the target exactly; removal within a group is proportional to the remaining composition, which matters because tens outnumber aces four to one. The full edge is then solved for that composition, across every initial deal, with the chart held fixed. The fit and zero crossing come from those solved points.

Index thresholds use the same compositions, walking a small count grid around each candidate decision and locating the flip. The ramp simulator replays full shoes with a bet sizer, optionally adding the standard index table.

## Project layout

```
index.html                 shell, tab strip, rules sidebar, placeholders
css/styles.css             dark theme, CSS variables, responsive layout
js/
  engine/                  cards, hand evaluation, rules normalization, seeded RNG
  solver/                  dealer distributions, EV recursion, charts, finite/fixed solvers
  sim/                     seeded simulator and strategy policies
  counting/                systems, edge curve, index derivation, ramp, scatter
  play/                    play-table state machine and settlement
  workers/                 solver, simulation, and counting workers plus clients
  ui/                      rules panel, tabs, charts, and the four tab views
tests/                     Node test runner suites
tools/serve.mjs            dependency-free static server
```

Engine, solver, simulator, counting, and play logic are DOM-free. Only `js/ui`, `js/workers`, and `js/main.js` touch the browser.

## Deploying to GitHub Pages

Deployment runs through GitHub Actions: [.github/workflows/pages.yml](.github/workflows/pages.yml) checks out the repository, stages only `index.html`, `css/`, and `js/`, uploads the Pages artifact, and deploys it. There is no build step and no asset pipeline.

One-time setup per repository or fork:

1. Open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

After that, every push to `main` deploys automatically. To deploy on demand, open **Actions → Deploy to GitHub Pages → Run workflow**. The workflow can also be triggered from the command line:

```bash
git push origin main
# or trigger the workflow_dispatch event from the Actions tab
```

The site appears at `https://<user>.github.io/blackjack/` once the first run completes (for this repository, that is `https://slayyyyer.github.io/blackjack/`).

The workflow needs `contents: read`, `pages: write`, and `id-token: write`, declared in the file. It uses the `github-pages` environment and a `pages` concurrency group with `cancel-in-progress: false`, so an in-flight deployment is never cut off. Only the three site paths are uploaded; tests, tooling, and repository metadata are not served.

All asset URLs are relative, and worker URLs use `new URL('./x.worker.js', import.meta.url)`, so the site works from a project subpath. HTTPS is provided by Pages, which module workers require. No `.nojekyll` file is needed for an Actions artifact because Jekyll is not in the path. A custom domain can be configured on the same Pages screen.

## Known approximations and limitations

These are deliberate, visible in the UI where relevant, and stated here so results are not over-claimed.

1. **The chart is a total-dependent, infinite-deck model.** It optimizes by total, softness, and pair status, not by the exact composition of the shoe. This is the standard basic-strategy chart, not a composition-dependent strategy. The finite solver and count-aware coach do use the real composition.
2. **Split EV uses the independent-hand approximation.** After the split cards are dealt, each post-split hand is evaluated against the same remaining composition. This ignores depletion caused by the sibling hand's later draws and competition for the resplit limit. It is exact for an infinite deck and very close for multi-deck shoes. The counting lab and play coach label results that use it.
3. **Hole-card conditioning.** In peek games, player draw probabilities treat the dealer's unknown hole card as still in the shoe; only the dealer's final distribution is conditioned on no blackjack. This is a small composition bias in finite-shoe results.
4. **The fresh-shoe edge holds the chart fixed.** It measures the displayed strategy at a full shoe, not a strategy that re-optimizes every decision for that shoe. Re-optimizing is what the coach does for a single hand.
5. **Count edges are representative compositions.** A true count does not determine a unique shoe. The edge curve uses one plausible composition per count at the chosen penetration, so the curve is a composition model, not an average over every shoe with that count. Different penetrations shift it slightly.
6. **Index thresholds are composition-specific.** They are derived at the representative holding shown, with the split approximation where pairs are involved. A different composition can move a threshold by a fraction of a true count. Rows that exceed the node budget are reported as budget-limited rather than guessed.
7. **The simulation's "with deviations" strategy uses a fixed standard table** (Illustrious-18-style), not the solver-derived thresholds. The Index lab shows the derived and standard values side by side; the two are not automatically swapped into the simulation.
8. **Insurance does not change the chart or the house edge.** Taking insurance is never the EV-maximizing action for a basic-strategy player, so the optimal edge is the same whether or not it is offered. Play mode offers and grades it using the unseen ten density (0.5 × (3t − 1) per main-bet unit). The hole card is treated as one unseen card at that density, so this is a count-based estimate, not a peek.
9. **Only late surrender is modeled**, and only when the dealer peeks. Early surrender, surrender after a split, and surrender in ENHC are not supported.
10. **No other rule variants.** No 5-card Charlie, no 6-card bonuses, no dealer 22 push, no double on fewer than two cards, no "double only 10/11" restriction, no side bets, and no continuous shuffler.
11. **Split depth is capped at four hands.** This matches the UI and keeps the recursion finite. A table with a higher resplit limit is not modeled.
12. **Budget-limited solves.** Pathological finite compositions can hit the node budget (4M for the fresh edge, 3M for the count-edge curve, 2.5M for the quality scatter, 150k per index point, 350k per coach hand). The UI reports "budget-limited", falls back to the chart where possible, and never presents an unfinished solve as exact.
13. **No service worker.** The app makes zero network requests and has no external assets, so it runs with no internet once served. It does not yet cache itself for installation or for reopening offline; add a service worker if you want that.
14. **Browser support.** Requires ES modules, module workers, Canvas 2D, and `ResizeObserver` — current Chrome, Edge, Firefox, and Safari. It will not run from `file://`.
15. **Floating point.** Results use IEEE-754 doubles. Ties are broken by a fixed action order, and displayed values are rounded; a cell within about `1e-12` of another is treated as a tie.

## Reproducibility

Every simulation and play session accepts a seed. The same seed, rules, deal model, strategy, and bet schedule reproduce the same sequence of hands and the same aggregate result. Comparisons share an initial seed but diverge once strategies make different decisions, so they are not hand-for-hand paired after the first difference.

Timing figures (`ms`, solved nodes) depend on the machine and are reported for transparency, not as benchmarks.
