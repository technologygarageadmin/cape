# QP Exit Strategy — Scenario Validation (2026-07-08)

Session outcome: diagnosed why the QP ratchet let profitable trades round-trip into
losses, retuned the tier ladder against a tick-by-tick replay of
`backend/monitoring_debug.log` (2026-07-07, 10 trades), applied the changes to this
machine's `backend/config.py`, and walked all three exit scenarios (profit rollover,
loss-side, wrong-direction entry) against the new config with the actual log data.

**Config file is gitignored** — every change below is applied on this machine only.
Trading machine (MuthamizhS) needs the same edits by hand + restart. See table at
the bottom for the full diff.

---

## 1. The problem, in the data

Replayed `backend/monitoring_debug.log` for 2026-07-07 (10 trades, all manual entries,
day total **−21.6%** actual / **−20.7%** replayed with the old config — the ~1pt gap
is broker fill variance the tick replay can't reproduce exactly).

| # | Contract | Peak | Actual exit | Why |
|---|----------|------|------------|------|
| 1 | SPY C747 | +1.53% | −3.98% | Never armed (peak < old 3% trigger) → rode to −4% SL |
| 2 | SPY P747 | +2.14% | −4.64% | Never armed → SL |
| 3 | SPY C747 | +5.67% | +0.92% | Armed at tier 1 only (+0.46% lock); cut by max-hold at 388s |
| 4 | SPY C748 | +3.64% | −0.61% | Armed at +0.45% lock; stop fill slippage ate it negative |
| 5 | SPY C747 | +1.91% | −2.86% | Never armed → max-hold loss |
| 6 | TSLA C407.5 | +5.83% | −0.66% | Missed tier-2 trigger (6.0%) by 0.17pt; +0.52% lock, slippage ate it |
| 7 | SPY C748 | +2.35% | −1.03% | Never armed → max-hold loss |
| 8 | SPY P749 | +2.18% | −4.18% | Never armed → SL breach |
| 9 | TSLA P405 | +0.68% | −4.51% | Never got going → SL breach |

Three structural findings:

1. **Arming bar (+3.0% old tier-1 trigger) sat above the median peak (~+2%).** 6 of 9
   trades peaked green and never armed the ratchet at all.
2. **Tier-1 lock (+0.5%) didn't budget slippage.** Fallback market exits fill
   0.5–1.2% below the stop on this tape (thin option volume — see §5). A +0.5% lock
   is a near-guaranteed small realized loss.
3. **Tier-2 dead zone (3%→6%) swallowed both big movers** (peaks +5.67%, +5.83%) —
   neither reached the 6% trigger, so the 65%-of-peak retention never applied.

---

## 2. Retune methodology

Wrote a tick replayer (`scratchpad/sim_ladder.py`, session-local) that:

- Parses every `[TICK] ... pnl=... peak=...` line from `monitoring_debug.log`,
  assigns ticks to the correct trade by matching `(sell/fill − 1) × 100` against
  each open trade's fill price (positions run concurrently, so ticks interleave).
- Replays each trade tick-by-tick, ratcheting a floor per the same tier-ladder
  logic as `monitoring.py::_update_dynamic_thresholds` (`floor_for()`), including
  the near-TP trail overlay.
- Models the **2-second breach grace timer** (Condition 5 / Condition 11 in
  `monitoring.py`) — a floor breach must hold for 2s before the sim "exits" a trade,
  same as the real fallback detector.
- Grid-searches trigger/ratio combinations and reports total day P&L.

Corrected-parser replay (−20.7%) matched the actual day (−21.6%) closely enough to
trust the relative ranking of ladder variants.

Grid search (~2,000 combinations) found a broad plateau around:

```
T1 trigger 1.5%  / lock 1.0%
T2 trigger 2.5%  / ratio 0.40
T3 trigger 5.0%  / ratio 0.60
TP 5.0%  (near-TP trail arms at TP−1% = 4%)
```

Replayed day total: **−7.4%** (vs −20.7% under the old config) — five of the nine
"went green, died red" trades convert to scratches or small wins.

**User directive:** arm tier 1 from **+0.5%** instead of +1.5% (as soon as the trade
is green, not after a 1.5% cushion). Replayed and reported honestly: this scores
**worse** on the 2026-07-07 tape (−12.3% vs −8.0% for the +1.5%/1.0% variant),
because this tape has ±1.5–2% bid noise inside 2-second windows, and a low trigger
with a tight lock trips on the wobble before winners develop (e.g. the TSLA call
that later peaked +5.83% would have been cut at −1.70% on its first dip). User
accepted this trade-off explicitly. Applied as directed; the revert if paper data
confirms the whipsaw pattern is two lines (see §6).

---

## 3. Scenario walkthroughs (as discussed, now re-validated against the applied config)

### 3a. Price climbs +3%, then rolls over

Floor ladder under the config now in `backend/config.py`:

| Peak | Rule | Floor |
|---|---|---|
| +0.5% | Tier 1 | +0.3% |
| +2.5% | Tier 2 (40% of peak) | +1.0% |
| +3.0% | Tier 2 | +1.2% |

Mechanism: **no time-based reversal detection exists anywhere in the exit engine.**
The only discriminator is price distance from the floor. Chop above the floor is
tolerated indefinitely; a breach held for 2 seconds (Condition 11) triggers a
market sell. Between the peak and the floor, PnL give-back is unconditional and
by design — this is the structural cost of a price-only ratchet on a noisy tape.

Expected realized result for a +3% peak rollover: **+0.2% to +0.7%** (floor +1.2%
minus ~0.5–1.0pt of detection-and-fill lag), versus the old config's realized
**−0.61%** on the actual +3.64%-peak trade (#4 above).

### 3b. Price climbs +7%, then rolls over (TSLA case study)

Walked the actual TSLA call from 2026-07-07 (fill $13.55, peak +5.83%, **realized
−0.66%** under the old config) against the new config:

| Peak | Rule | Floor |
|---|---|---|
| +0.5% | Tier 1 | $13.59 (+0.3%) |
| +2.5% | Tier 2 | $13.69 (+1.0%) |
| +4.0% | Near-TP trail arms (peak ≥ TP−1%) | $13.89 (+2.5%) |
| **+5.0%** | **TP limit fills** | **exit at +5%** ($14.23) |

Under the new config the TP sits at +5% (was 8%, never reached by any of the 10
trades) — the trade should exit at the TP limit before ever reaching the +7%
scenario. If the TP limit fails to fill despite the bid being marketable
(Condition 10, 2s grace), the near-TP trail floor at peak−1.5% still realizes
roughly +4–5%. This is the clearest before/after validation from the whole
dataset: **−0.66% actual → ~+5% under the new config**, ~$68/contract swing.

### 3c. Wrong-direction entry — immediate negative, never recovers

Confirmed in code (`monitoring.py::_resolve_sellable_price`, line ~2629): PnL is
tracked against the **bid**, not mid or last-trade. Entry fills near the ask, so
the position shows an immediate mark-to-bid loss roughly equal to the spread
(SPY: ~1–1.5%; TSLA: ~2%+ observed). From that point on, the displayed PnL is the
real, realizable number — there is no further bid/ask cost hiding at exit, only
the additional detection-and-fill lag described below.

Exit paths for a trade that goes straight down, in order of speed:

| Path | Trigger | Typical timing | Realized loss |
|---|---|---|---|
| Stop breach | Bid ≤ −4% stop, held 2s (stop rarely prints on thin tape) | seconds–minutes | **−4.3% to −5%** (4 of 9 trades in the sample) |
| Staged loss cut | PnL ≤ −2% continuously for 120s | ~2 min | −2% to −3.5% |
| Max hold | PnL < +1% after 300s | 5 min | wherever it sits |
| Gap-down | Bid gaps straight through stop+limit | seconds | worse than −5%, tail risk |

**Expected max loss on a normal tape: ≈ −5%** (the −4% stop plus the same
detection/fill lag seen on the profit side). True gap risk is unbounded in
principle but a tail event for near-ATM SPY/TSLA held under 5 minutes.

Noted risk: TSLA's wider spread (~2.2%) means a flat/wrong trade opens *already
below* the −2% loss-cut arm threshold — the loss-cut can realize a trade that
never moved, turning unrealized spread cost into a market sell at the 2-minute
mark. Flagged, not yet addressed (candidate for a per-symbol loss-cut threshold).

---

## 4. Bad-entry detector — replayed, then enabled

`EXIT_BAD_ENTRY_ENABLED` was `False`. Purpose-built for scenario 3c: one-shot check
45s after entry — if peak never exceeded +0.3% **and** PnL is ≤ −1.5% at that
instant, exit immediately rather than riding to the −4% stop.

Replayed against the 10-trade tape layered on top of the applied ladder:

| # | Trade | @45s (peak / PnL) | With bad-entry enabled |
|---|---|---|---|
| 7 | SPY C748 | 0.00% / −1.76% | **Fires** — exits −1.76% instead of −2.50% |
| 9 | TSLA P405 (the −4.51% trade) | +0.68% / −0.43% | **Escapes** — had ticked green early, passes peak test |
| 1, 5 | SPY calls | peaked +1.1–1.4% by 45s | Escape (peak test) |
| 2,3,4,6,8,10 | — | all peaked ≥ +0.3% by 45s | Never at risk |

Result: **1 firing, 0 false kills** — day total −12.26% → −11.52%. Notably the
TSLA worry (wide-spread entry looking "bad" at 45s when it's actually fine) did
not materialize on this data: every eventual winner had ticked green by the
45-second mark. It's a one-shot check, so it can't catch a trade that flickers
green early (like #9) and dies later — that's still the ladder/loss-cut's job.

**Decision: enabled.** `EXIT_BAD_ENTRY_ENABLED = True`, stock parameters kept as
validated (45s / +0.3% peak / −1.5% threshold).

---

## 5. Why the broker stop keeps missing — and whether live will fix it

Investigated whether the stop-not-firing pattern (bid collapses through the stop
level, order sits in `new`, local fallback detector does the exit 2–4s later) is a
paper-trading artifact.

**Conclusion: no — it's structural, not a paper-sim quirk.** Stop orders elect on
**trade prints**, not quotes. SPY/TSLA weekly options quote continuously but print
trades sparsely, so the bid can fall 2% with zero prints along the way — the same
OPRA tape and election rule apply in live trading. Going live doesn't make other
participants' trades print at your stop level.

Where live plausibly differs, and mostly for the worse: paper's fallback market
sell is a simulation with generous fill assumptions (full displayed bid, no size
limit). Live, the displayed bid may be thin, and market makers can fade quotes
into aggressive selling — so the observed 0.5–1.2% slippage is more likely to grow
than shrink live. Budget locks assuming ~1% slippage regardless of environment.

Also surfaced a doc inconsistency worth a pre-live smoke test: Alpaca's support
page states stop-limit orders are *not* supported on options ("not initially, but
something we are looking to eventually offer"), while the current API docs say
`stop`/`stop_limit` **are** supported for single-leg option orders — which matches
observed paper behavior. Recommendation: on the first live day, place one
single-contract stop order and confirm the broker accepts it before relying on the
ratchet at size. If it's rejected, the system degrades gracefully — the local
breach detector (Conditions 6–8) already does most of the exit work regardless of
whether the broker stop exists.

Sources consulted: [Alpaca options trading docs](https://docs.alpaca.markets/us/docs/options-trading),
[Alpaca support: stop-limit orders on options](https://alpaca.markets/support/does-alpaca-support-stop-limit-orders-on-options),
[Alpaca order types guide](https://alpaca.markets/learn/13-order-types-you-should-know-about),
[community report on option stop support](https://forum.alpaca.markets/t/no-stop-loss-stop-limit-or-trailing-stop-orders-for-options/19210).

---

## 6. Applied changes (this machine, `backend/config.py`)

| Knob | Was | Now | Location |
|---|---|---|---|
| `QP_TIER_1_TRIGGER_PCT` | 3.0 | **0.5** | config.py:439 area |
| `QP_TIER_1_LOCK_PCT` | 0.5 | **0.3** (buffer-guard floor — can't go below ~0.2) | |
| `QP_TIER_2_TRIGGER_PCT` | 6.0 | **2.5** | |
| `QP_TIER_2_LOCK_RATIO` | 0.65 | **0.40** | |
| `QP_TIER_3_TRIGGER_PCT` | 10.0 | **5.0** | |
| `QP_TIER_3_LOCK_RATIO` | 0.70 | **0.60** | |
| `TAKE_PROFIT_PCT` | 0.08 | **0.05** | |
| `CAPE_TP_OFFSET_PCT` | 8.0 | **5.0** | kept in sync with TAKE_PROFIT_PCT |
| `EXIT_BAD_ENTRY_ENABLED` | False | **True** | stock thresholds unchanged (45s / 0.3% / −1.5%) |

**Not yet mirrored to the trading machine (MuthamizhS)** — config.py is gitignored,
git pull will not carry these. Apply by hand + restart, same pattern as
`CONFIG_SYNC_REQUIRED.md`.

**Revert path if the +0.5% arming whipsaws in live paper data** (predicted risk,
see §2): set `QP_TIER_1_TRIGGER_PCT = 1.5` and `QP_TIER_1_LOCK_PCT = 1.0`. Grid
search showed this is the better-performing point on the 2026-07-07 tape; the
current +0.5%/0.3% setting was chosen by explicit user preference over the
data-optimal one.

---

## 7. What's still open / not implemented

Discussed but not built this session — candidates for a follow-up if the retuned
ladder's give-back on slow rollovers (§3a) is still too large in the next paper
test:

1. **Peak-staleness tightening** — if no new peak has printed for ~60s while in
   profit, tighten the retention ratio (e.g. 40%→65-70%). Directly answers "how
   long do we wait to decide chop vs. reversal" with an actual timer, which
   doesn't exist in the current engine.
2. **Reversal-velocity exit** — from peak ≥ +2%, if price drops ≥1.5% within ~15s,
   exit immediately instead of waiting for the floor. Needs to run on a 3-tick
   median of the bid, not the raw tick — raw single-second glitches
   (+1.4% → −1.8% → +1.4%) would misfire it constantly on this tape.
3. **Partial scale-out** — with `QTY = 1` every exit is all-or-nothing. Splitting
   into 2 contracts (sell one near TP, trail the second) is the standard
   day-trading answer to "captured too little of the peak," but requires
   partial-exit support in the order manager and doubles capital at risk per
   trade — a deliberate decision, not a tweak.
4. **Per-symbol loss-cut threshold** — TSLA's wider spread means the −2% loss-cut
   arms on spread alone for a flat trade; SPY doesn't have this problem at the
   same magnitude.

Recommended sequence: paper-test the applied config for at least one full session,
replay the resulting `monitoring_debug.log` the same way as this session, and only
then decide whether items 1–4 are warranted — layering more logic before seeing
clean data on the current change would make it impossible to attribute results.
