# Cape — Strategy V3: Entry & Exit Recommendations

> **Date**: 2026-07-01 · **Updated 2026-07-06** with validation against the full MongoDB history (506 trades, `options_log`, 2026-04-20 → 2026-07-02) — see §0.1. The update **confirms** every original root cause, quantifies the panic-sell problem at 56% of all exits, and adds two newly-discovered code fixes (B6, B7).
> **Status**: Recommendation only — NO code has been modified.
> **Audience**: (1) Raghav, to understand *why* trades are failing and what will make them win; (2) Opus/Sonnet, as an implementation spec. Every change lists the file, the parameter/function, the exact change, and why.
> **Supersedes**: `ENTRY_STRATEGY_V2.md` §1 diagnosis (v2 is now implemented; this doc diagnoses the implemented v2). CLAUDE.md's config table is stale (it says `CAPE_QP_OFFSET = 0.01` / `CAPE_TRAILING_SL_OFFSET = 0.25`; actual `config.py` values are `0.05` / `0.10`).

---

## 0. Executive summary — what is actually going wrong

**Evidence base**: 32 manual trades in `backend/logs/manual_trades.csv` (Apr 24 – May 22, 2026), where you entered manually and the bot managed the exit. This isolates the exit engine perfectly. *(2026-07-06: every number below was re-validated against the complete 506-trade MongoDB history — same conclusions at 16× the sample; see §0.1.)*

| Metric | Value | What it tells us |
|---|---|---|
| Win rate | 10 W / 3 BE / 19 L = **31%** | Break-even requires ~67% at current TP/SL ratio — structurally unwinnable |
| Net PnL | **−$95** (avg win $6.00, avg loss $8.16) | Losing on both frequency AND size |
| Exits via clean TP fill | **3 of 32 (9%)** | The profit-capture mechanism almost never completes |
| Exits via broker SL fill | 8 of 32 | The "normal" stop path is a minority |
| Exits via emergency market fallback (`ORDER_SYSTEM_FAILURE_MARKET_EXIT` + `SL_PRICE_BREACH_MARKET_EXIT`) | **21 of 32 (66%)** | The SL-replacement ratchet is failing so often that panic market sells are the *de facto* exit mechanism — this is the "ratchet breaks" you observe |
| Largest single loss | −$35 (peak was +0.8%) | Fallback exits during fast tape have terrible fill quality |
| Typical hold time | 37–130 seconds | The exit engine kills trades within ~1 min of the 30s minimum-duration gate lifting |
| Peak-vs-exit pattern | Peaks of +1.5% to +4.2% routinely exit at ≤ 0 | Profit reached, never locked — the "QP doesn't kick in" you observe |

**Three root causes, in priority order:**

1. **The LOSS-mode SL ratchet halves your stop distance and guarantees you're out before recoveries.** In loss mode, the stop is tightened by the full drawdown amount (`SL = initial_SL + (entry − current)`), so the stop *meets* the falling price after only **half** the configured SL distance — and it never widens back (one-way ratchet). Your "lucky" smaller-than-−10% stop-outs are not luck: they are this mechanism ejecting you at the bottom of ordinary dips, right before the market recovers. This is the single biggest exit fix.
2. **The profit trail is tighter than market noise, and the broker-replacement machinery can't keep up with it.** A $0.05 QP trail on a $5–7 option is ~1% — inside normal 1-min bid oscillation. Worse, ratcheting the broker stop on every $0.01 tick creates a constant stream of replace calls; each in-flight/failed replace opens a window where a price dip fires an emergency market exit (the 66% fallback rate above).
3. **Entry is starved by a direct filter contradiction, not by strictness in general.** Tier 1 requires price on the correct side of VWAP; the S/R-wall veto then rejects any bar within ±0.5% *of VWAP*. SPY spends most of the session within 0.5% of VWAP, so nearly every regime-approved bar is vetoed. Removing filters instead exposes the raw RSI crossover, which is a mean-reversion trigger — hence wrong-direction entries and 90% stop-outs.

Also answered below: **candle patterns — you already have them** (don't add more; add a 5-minute timeframe confirmation instead). **News/tweets — no for signal generation; yes as a cheap calendar-based blackout filter.**

### 0.1 Validation against the full MongoDB history (added 2026-07-06)

Queried `options_log` directly (per-trade docs include `exit_reason`, `peak_pnl_pct`, `exit_sl_pct`, durations). **506 trades, 2026-04-20 → 2026-07-02**: W=120 / L=361 / BE=25 → **25% win rate, net −$3,700**. Avg win $19.02 vs avg loss $16.57 (1.15:1) → required break-even win rate ≈ 47%; actual 25%.

**Q: Does the historical data support the panic-sell finding? — Yes, emphatically.**

| Exit reason (all time) | Count | W/L | Total PnL | Avg peak before exit |
|---|---|---|---|---|
| `STOP_LOSS_EXIT` (broker stop fill) | 188 | 49/129 | −$918 | +1.07% |
| `ORDER_SYSTEM_FAILURE_MARKET_EXIT` | 163 | 15/138 | **−$2,124** | +1.04% |
| `SL_MISSED_GAPDOWN_MARKET_EXIT` | 63 | 7/54 | −$1,083 | +0.88% |
| `SL_PRICE_BREACH_MARKET_EXIT` | 36 | 5/29 | −$636 | +1.12% |
| `TAKE_PROFIT_EXIT` | 31 | 29/1 | **+$828** | +2.57% |
| `TP_PRICE_ABOVE_MARKET_EXIT` | 11 | 11/0 | +$315 | — |
| `QP_SL_REPLACE_FAILED_MARKET_EXIT` | 7 | 1/6 | −$89 | +1.13% |
| Other (`MANUAL_LIQUIDATE`, `BROKER_SL_DISABLED`, `PROFIT_GIVEBACK`) | 7 | — | +$7 | — |

- **Panic/fallback market exits: 282 of 506 = 56% of all exits** (April 43%, May 66%, June 65%). `ORDER_SYSTEM_FAILURE_MARKET_EXIT` alone destroyed $2,124 — 57% of the total net loss. The May-08 monitoring bug-fix pass did *not* reduce the fallback share; it is structural (replacement churn, B3), not a transient bug.
- **The only profitable exit mechanisms are the TP paths**: `TAKE_PROFIT_EXIT` + `TP_PRICE_ABOVE_MARKET_EXIT` = 42 trades, 40 wins, **+$1,143**. Every stop/ratchet-driven mechanism loses in aggregate. Only 8% of trades ever reach a TP path.
- **Peak give-back confirmed at scale**: 141 trades peaked ≥ +1.5%; **40% of them still exited at ≤ $0**. Average peak across the three big fallback reasons is ≈ +1.0% — trades are broadly reaching profit and then being panic-sold on the way down.
- **Loss-ratchet (B1) confirmed**: losing trades overwhelmingly exit at −0.3% to −2.5% against a −10%-equivalent configured static SL, and dozens of losses show `exit_sl_pct` *positive* (dynamic stop ratcheted above breakeven off a +0.7–1.6% blip) with the fill landing negative. The configured stop is decorative; the ratchet + fallback machinery is the real (and far tighter) stop.
- **Median hold time is 35 seconds** (avg 57s; 92% of trades < 2 min), with a dense cluster at 35–42s = the 30s `MIN_TRADE_DURATION_SEC` gate + ~2s fallback grace + poll interval. Trades that dip early are *held* for 30s, then panic-market-sold at a worse price — see new fix B7.
- **New root cause found — 63 gap-down misses**: `SL_MISSED_GAPDOWN_MARKET_EXIT` fires when the bracket's stop-**limit** child triggers but the market is below its limit floor. `SL_STOP_LIMIT_BUFFER_PCT = 0.20` (%) puts the limit floor ≈ **1 cent** below the stop on a $5 option — effectively unfillable in any real down-move. See new fix B6.
- **Trade-type breakdown**: AIT n=223 → 19% WR, −$2,216; MANUAL n=232 → 22% WR, −$1,845; STRADDLE n=8 → 1W/7L, −$363; **RECOVERY n=34 → 76% WR, +$737**. Two lessons: (a) manual entries performed no better than AIT entries under the same exit engine — the exit engine, not entry, dominates outcomes, which validates fixing exits first (Part C sequencing); (b) RECOVERY positions — the only cohort not managed from the first tick by the fresh-entry ratchet — are the only profitable cohort, direct evidence that trades given room (Tier 0 of B2) perform.
- Straddle is a side-show but 1W/7L: keep `STRADDLE_ENABLED = False`.

**Verdict: all recommendations hold.** The full history strengthens B1–B4 quantitatively and adds B6 (stop-limit buffer) and B7 (min-duration interaction) below.

---

## PART A — ENTRY

### A1. Why the bot never enters (filters contradicting)

The v2 three-tier gate (`strategy_helpers.py:determine_signal`) is implemented and sound in architecture. The starvation comes from four specific interactions:

| # | Contradiction / over-restriction | Where | Detail |
|---|---|---|---|
| A1.1 | **VWAP in the S/R-wall veto vs. VWAP in the regime gate** | `rsi_analyer.py:668-683`, `config.py: ENTRY_SR_PROXIMITY_PCT = 0.005` | Tier 1 BULL requires `price > VWAP`. The veto then rejects any bar within ±0.5% of VWAP. A fresh uptrend *by definition* starts near VWAP; on SPY (±0.5% ≈ $3.70) price is near VWAP most of the day. Result: the only bars that pass are late-stage extended trends — which then trip the RSI-overextension veto. |
| A1.2 | **ATR floor calibrated for TSLA applied to SPY** | `config.py: ENTRY_ATR_PCT_MIN = 0.08` | SPY 1-min ATR% is typically 0.03–0.08 outside the open; TSLA 0.10–0.25. A single absolute floor blocks most of the SPY session while doing little on TSLA. |
| A1.3 | **Volume confluence point is unreachable on IEX** | `strategy_helpers.py:256` (`_confluence_score` item 3), `config.py: STOCK_DATA_FEED = "iex"` | The free-point-on-unavailable behavior was (correctly) removed, but now on IEX bars with 0 volume the max achievable score is 3/4, while the requirement stays 2/4 with one component permanently dead — effectively requiring 2-of-3. |
| A1.4 | **Setup A requires three same-bar conditions during fast moves** | `strategy_helpers.py:_setup_a_pullback` | Prev-bar EMA9 kiss within 0.20% AND current-bar directional close AND break of prior high/low. In strong trends the kiss is often 0.25–0.35% (esp. TSLA), so the workhorse trend setup rarely fires. |

**When filters are removed** the trigger degenerates to the RSI crossover — a lagging mean-reversion signal traded as a trend signal (fully diagnosed in `ENTRY_STRATEGY_V2.md` §1b–1c; still correct). That's the wrong-direction / 90%-stop-loss mode. So the answer is *not* fewer filters and *not* more filters — it is fixing the four interactions above.

### A2. Recommended entry changes (implementation spec)

**A2.1 — Remove VWAP from the S/R-wall veto.** *(highest impact, one line)*
- File: `rsi_analyer.py:668-683`. Keep PDH and PDL walls; delete the VWAP wall (line ~680-681).
- Rationale: VWAP alignment is already enforced (in the correct direction) by Tier 1. Keeping it as a repulsion level directly fights the regime gate.
- Keep PDH/PDL veto but tighten proximity: `ENTRY_SR_PROXIMITY_PCT: 0.005 → 0.0015` (±0.15%). PDH/PDL are genuine walls, but a ±0.5% dead zone around each removes too much tradable range.

**A2.2 — Per-symbol ATR floor.**
- File: `config.py`. Replace `ENTRY_ATR_PCT_MIN = 0.08` with a dict: `{"SPY": 0.035, "TSLA": 0.10}` (fallback 0.05 for unlisted symbols). Consumer: `_confluence_score` in `strategy_helpers.py` (thread the symbol through, or read from `rsi_result`).
- Rationale: the chop veto is right in principle; it just needs symbol-relative calibration.

**A2.3 — Make the confluence denominator honest when volume is dead.**
- File: `strategy_helpers.py:_confluence_score`. When `volume_unavailable = True`, score out of 3 and require ≥ 2/3 (i.e., unchanged min score, reduced denominator has no numeric effect — the real change is to **log** `score/3` so starvation analysis is honest), OR (better) upgrade `STOCK_DATA_FEED = "iex" → "sip"` so the volume component actually works. SIP is the single best data investment for this system; volume confirmation is a strong scalping edge and it is currently dark.

**A2.4 — Loosen Setup A to one confirmation, not two.**
- File: `strategy_helpers.py:_setup_a_pullback` and `config.py`.
- `ENTRY_SETUP_A_PULLBACK_MAX_PCT: 0.20 → 0.30` (per-symbol optional: SPY 0.20, TSLA 0.35).
- Change the current-bar condition from `candle_is_bullish AND candle_breaks_prev_high` to `candle_is_bullish AND (candle_breaks_prev_high OR candle_body_ratio ≥ 0.50)` (mirror for PUT). The break-of-structure is the strongest confirm but demanding it on the same bar as the bounce misses half the resumptions; a strong-bodied bounce candle is an acceptable alternative confirm because Tier 3 still scores the bar independently.

**A2.5 — Add per-gate rejection counters (observability, no behavior change).**
- Every rejection branch in `determine_signal` already logs a line. Add a per-day counter dict `{gate_name: count}` persisted to `logs/entry_rejections_YYYY-MM-DD.json` and exposed via a small API endpoint, so after each session you can see exactly which gate is the limiting factor. Without this, every future tuning debate is guesswork. (This was Phase 0 of the v2 plan; it was never built and is why today's starvation went undiagnosed.)

**A2.6 — Re-enable the time window, replacing the opening-zone veto's overlap.**
- `ENTRY_TIME_WINDOW_ENABLED: False → True` with the existing windows (9:45–10:45, 13:15–14:15 ET). With entries confined to the two statistically directional windows, several vetoes get lighter duty and the "quiet day = zero trades" outcome becomes acceptable rather than a bug. If you find frequency too low after a week, widen the morning window to 9:45–11:30 before touching anything else.

### A3. Should we add candle-pattern reading? — **You already have it. Don't add more; add timeframe context instead.**

The system already computes and uses: candle body ratio, bullish/bearish candle, break of previous high/low, engulfing, hammer, shooting star, pin bar, inside bar (`rsi_analyer.py:448-538`), consumed by Setup A/B conditions, confluence item 1 and 4, and the inside-bar hard veto. Adding more single-bar patterns (doji variants, three-bar patterns, etc.) will add correlated noise, not edge — on 1-minute bars, individual patterns have weak predictive value and most named patterns duplicate what body-ratio + break-of-structure already measure.

What is genuinely missing is **higher-timeframe context**, which is worth more than any additional pattern:

**A3.1 — 5-minute regime confirmation (recommended).**
- In `rsi_analyer.py`, resample the already-fetched 1-min bars to 5-min and compute EMA9/EMA21 on the 5-min series. Add `htf_bull = EMA9(5m) > EMA21(5m)` / `htf_bear` to `rsi_result`.
- In `classify_regime`, require the 5-min direction to agree (BULL needs `htf_bull`). This is one extra boolean, zero extra API calls, and is the standard fix for "1-min regime says BULL inside a 5-min downtrend" — the residual wrong-direction source after Tier 1.
- Trade-off: adds ~2–4 min of lag at trend birth. Acceptable — Setup A (pullback) re-offers entry repeatedly during a real trend.

### A4. Should we add news/tweet/post reading? — **Not for signals. Yes for a blackout calendar.**

**Do not** build real-time news/social sentiment for *directional* signals at this trade horizon:
- Your holding period is 1–10 minutes. News NLP pipelines (fetch → parse → classify) deliver signals seconds-to-minutes after algos have already repriced the underlying — you would systematically buy the top of the news spike.
- Sentiment models produce weak, noisy directional labels; combined with options spreads and 0-2 week expiries, the cost of false positives exceeds the value of true ones.
- It is a large engineering surface (feeds, rate limits, dedup, model quality) bolted onto a system whose core exit engine still needs hardening.

**Do** add a **scheduled-event blackout filter** — 90% of the value at 1% of the cost, with no external ML:
- **A4.1** Static intraday blackout times (config list, ET): block new entries ±10 min around 10:00 ET (ISM/consumer-sentiment class releases) and ±30 min around 14:00 ET on FOMC days; block 8:30 ET-release days' opening window only if you ever widen trading before 9:45. Implementation: a `NEWS_BLACKOUT_WINDOWS` list in `config.py` + a date-keyed `EVENT_DATES` dict (FOMC/CPI/NFP dates are published a year ahead; hand-maintain a small JSON, or fetch once daily from a free economic-calendar API).
- **A4.2** Per-symbol earnings blackout: no TSLA entries on TSLA earnings day and the following morning. SPY is exempt (index).
- This directly attacks a real loss mode: scheduled-macro whipsaws are exactly the bars where a regime gate reads "clean trend" for 3 minutes and then reverses violently — unwinnable for this exit engine.

---

## PART B — EXIT

The exit engine's *plumbing* (fallback conditions 1–10, verification, adoption chains) is genuinely robust — the problem is the *strategy math* it enforces. Four changes, in order of impact:

### B1. Kill the LOSS-mode drawdown ratchet — it doubles your stop-out rate

- Where: `monitoring.py:_update_dynamic_thresholds`, LOSS-mode branch (~lines 2328-2344): `trailing_sl_price = sl_static_price + drawdown; sl_candidate = max(existing, trailing_sl_price)`.
- What it does today: entry $5.00, SL $4.50. Price dips to $4.80 → stop jumps to $4.70 (gap $0.10). At $4.75 the stop *equals* price → filled. **You are stopped out at −5% with a −10% configured stop, at 2× speed, on ordinary noise** — and because the ratchet is one-way, a single 1-tick wide-spread bid flicker permanently tightens the stop even if the quote instantly recovers.
- This is precisely your observation: "50% of the time SL gets reset (luckily) and it's not the original −10%… but still doesn't end in profit though the market went up from the buying point." Not luck — the mechanism ejects you at the bottom of the dip that precedes the recovery.
- **Change**: in LOSS mode, hold the stop at `sl_static` (no tightening). Delete the drawdown-tightening block; the loss zone keeps the entry-time stop until price re-enters profit. If some loss-tightening is desired later, make it *time-based* (e.g., after 4 min underwater, tighten to −5%) — never *drawdown-based*, which is self-triggering.

### B2. Replace the flat $0.05 trail with tiered profit locking (fixes "QP doesn't kick in at the right time")

Today (`config.py: CAPE_QP_OFFSET = 0.05`, `CAPE_TRAILING_SL_OFFSET = 0.10`), the stop trails $0.05 below every profit tick from the first uptick. On a $5–7 option that is ~1% — inside routine bid oscillation — so winners are cut at +$0.02–0.10 (your data: max win $10; TP configured at $25 was never reached). Simultaneously it's *too slow* on real reversals because the broker stop lags the internal ratchet by replace-latency (see B3), so fast drops blow through it → market fallback → occasional −$18/−$35 fills.

**Change to a peak-based tier ladder** (all thresholds in % of fill price so they scale across $4–$11 contracts; implement in `_update_dynamic_thresholds` PROFIT branch, replacing the `qp_price`/`trailing_sl` calc):

| Tier | Trigger (peak PnL since fill) | Stop level | Intent |
|---|---|---|---|
| 0 | peak < +3% | initial static SL (no trailing) | Room to breathe; nothing armed |
| 1 | peak ≥ +3% | fill × 1.005 (breakeven + spread) | Trade can no longer lose |
| 2 | peak ≥ +6% | fill × (1 + 0.5 × peak_pct/100) | Lock 50% of the peak gain |
| 3 | peak ≥ +10% | fill × (1 + 0.7 × peak_pct/100) | Lock 70% of an outsized move |

- Config: replace `CAPE_QP_OFFSET`/`CAPE_TRAILING_SL_OFFSET` with `QP_TIERS = [(3.0, "BE+0.5"), (6.0, "LOCK50"), (10.0, "LOCK70")]` (representation up to implementer; keep it data, not code).
- `qp_armed` semantics: arm at Tier 1 (peak ≥ +3%), not on the first uptick. This is literally "QP kicks in at the right time."
- Keep the one-way ratchet invariant (stop only rises) — it is correct *in the profit zone*.
- Why 3/6/10: your winners peaked at +1.5–4.2% under a hostile trail; with room to run, the +3% breakeven trigger converts today's "peaked +2.9%, exited −0.5%" trades into scratches, and the 50%-lock converts +4%+ moves into real wins. Tune with data after two weeks (A2.5-style logging of peak-vs-exit per trade).

### B3. Stop hammering the broker: coarser, slower stop replacement (fixes "ratchet breaks")

66% of your exits were emergency market fallbacks. Mechanism: every $0.01 profit tick triggers `replace_order_by_id` + verification round-trip (`_place_sl_stop_order`); during any in-flight/failed/throttled replace, `sl_last_placed_pct` lags `sl_dynamic_pct`, and the moment price dips to the internal trigger, Condition 5 (`QP_SL_REPLACE_FAILED_MARKET_EXIT`) or Conditions 3/4 fire a market sell. The more often you replace, the more windows exist. The fallback detector is doing its job — the ratchet is simply generating 10–50× more replaces than necessary.

**Changes** (all in `_update_dynamic_thresholds` / `_place_sl_stop_order` gating):
- **B3.1** Minimum step: only send a broker replacement when the new stop ≥ last placed stop + max($0.05, 1% of fill). Config: `SL_REPLACE_MIN_STEP_USD = 0.05`, `SL_REPLACE_MIN_STEP_PCT = 1.0`.
- **B3.2** Minimum interval: no more than one replace per 5 seconds per position (`SL_REPLACE_MIN_INTERVAL_SEC = 5.0`) — the existing 1s failure throttle stays as-is for the failure path.
- **B3.3** Tier transitions (B2) bypass both gates — a tier jump (e.g., breakeven arm) always replaces immediately. Tier ladders produce ~2–4 replaces per trade instead of dozens; with B2's discrete tiers, most of B3 falls out naturally.
- The fine-grained *internal* trigger (`sl_dynamic_pct`) still updates every tick, so the Condition-5 guard still protects the gap — but the gap is now a deliberate ≤1% band, not an accident of replace latency.

### B4. Fix the reward:risk math — currently you must win 67% just to break even

- `config.py: TAKE_PROFIT_PCT = 0.25` (+$0.25), `STOP_LOSS_PCT = 0.50` (−$0.50): risking 2 to make 1. With B1/B2 in place, invert it and switch to percent mode so it scales with contract price:
  - `EXIT_TAKE_PROFIT_MODE = "pct"`, `EXIT_TAKE_PROFIT_VALUE = 0.08` (+8%, ≈ $0.40–0.55 on your typical contracts)
  - `EXIT_STOP_LOSS_MODE = "pct"`, `EXIT_STOP_LOSS_VALUE = 0.04` (−4%, ≈ $0.20–0.28)
  - Break-even win rate drops from 67% to **33%** — your *current* 31% win rate is at the doorstep of profitability even before entry improves, and B1/B2 mechanically raise both win rate (fewer noise stop-outs, breakeven tier creates scratches instead of losses) and average win (50% peak lock).
  - Note: a −4% static stop is *tighter in dollars* than today's −$0.50, but it is now a real floor (B1) instead of a decorative number that the loss-ratchet halves.
- **Enable the time stop**: `EXIT_MAX_HOLD_ENABLED = True`, `EXIT_MAX_HOLD_SEC = 300`, `EXIT_MAX_HOLD_PNL_THRESHOLD_PCT = 1.0` — if a scalp hasn't reached +1% in 5 minutes, theta and regret are the only things left in the trade. (Must be honored in bracket mode: route it through the fallback detector or a caller-level check, since `_evaluate_priority_exit` is skipped — implementer note.)

### B5. Price-source hygiene (secondary but cheap)

- Mode/trigger decisions (`PROFIT` vs `LOSS`, tier triggers) currently key off single sellable-price (bid) ticks. Add a spread guard: if `(ask − bid)/mid > 5%`, skip mode transitions and ratchet updates for that tick (still allow fill checks). One wide-spread flicker should not (a) enter LOSS mode, or (b) mark a fake peak.
- Require 2 consecutive qualifying ticks before a *tier upgrade* (B2), so a single anomalous print doesn't lock a phantom peak. The 2-second grace timers already do this on the exit side; this mirrors it on the ratchet side.

### B6. Widen the stop-limit buffer or use stop-market for the bracket SL child *(new 2026-07-06 — fixes 63 gap-down panic sells)*

- Evidence: 63 × `SL_MISSED_GAPDOWN_MARKET_EXIT` (−$1,083), plus an unknown share of the 163 `ORDER_SYSTEM_FAILURE_MARKET_EXIT` via Condition 3 (triggered-but-unfilled).
- Mechanism: the bracket's original SL child is a stop-**limit** order. Its limit floor is derived from `SL_STOP_LIMIT_BUFFER_PCT = 0.20` (`config.py`) — 0.20% of a $5 option is **$0.01**. A stop-limit whose limit sits one cent below the stop cannot fill in any genuine down-move; the stop triggers, the limit is skipped, Condition 2/3 fires a panic market sell 2s later at whatever the bid has fallen to.
- **Change (pick one, first preferred)**:
  - **B6.1** Make the bracket SL child a **stop-market**, matching the ratchet replacements (which already use `StopOrderRequest`). Where: bracket construction in `order_execution.py:place_market_order` (the `use_bracket=True` path — the `StopLossRequest` should carry only `stop_price`, no `limit_price`). This removes the gap-down failure class entirely; fill-price control is not lost in practice because the alternative today *is already a market sell*, just 2+ seconds later and lower.
  - **B6.2** If a limit floor is kept deliberately: `SL_STOP_LIMIT_BUFFER_PCT: 0.20 → 5.0` (≈ $0.25 below the stop on a $5 contract) so the limit only rejects true flash-crash prints instead of every ordinary tick sequence. Condition 2 remains as the safety net for genuine gaps.
- Also verify `_detect_market_fallback_reason` Condition 2 (`monitoring.py`) still behaves when `limit_price` is absent (stop-market child) — it already guards on `limit_price > 0`.

### B7. Stop holding losers for the 30-second gate, then panic-selling them *(new 2026-07-06)*

- Evidence: median hold across 506 trades is **35s**, with a dense cluster at 35–42s spanning `SL_MISSED_GAPDOWN` / `SL_PRICE_BREACH` / `ORDER_SYSTEM_FAILURE` exits. Signature: `MIN_TRADE_DURATION_SEC = 30` blocks exits, the position is already below its (ratchet-tightened, see B1) stop level during the gate, and at ~35s (gate + 2s grace + poll) the fallback detector force-market-sells at a worse price than the original stop would have achieved.
- The gate's purpose (avoid same-candle whipsaw exits) is legitimate for *discretionary* internal exits, but it must never delay **safety** exits — a delayed safety exit is strictly worse than an immediate one.
- **Change**: exempt all broker-side stop fills and all `_detect_market_fallback_reason` conditions from the minimum-duration gate (`monitoring.py` / caller checks in `api_server.py` that consult `MIN_TRADE_DURATION_ENABLED`). The gate should apply only to `_evaluate_priority_exit`-style discretionary exits (non-bracket mode) — and once B1 (no loss-ratchet) and B2 (Tier 0 = no trailing until +3%) are in, early whipsaw exits stop happening anyway because the only active early exit is the wide static SL.
- Note: with B1+B2+B6 in place, expect the 35s duration cluster to disappear; use that as a regression signal in paper trading.

### B8. Audit items surfaced by the data (bugs to investigate before tuning, no strategy change)

1. **`TAKE_PROFIT_EXIT` rows filled at +$0.06–0.08 against a +$0.25 target** (rows 14, 17, 19 of `manual_trades.csv`; Mongo shows the same pattern, e.g. 05-11/05-12 TP exits at +1.3–2.0%). Partially explained by Mongo's separate `TP_PRICE_ABOVE_MARKET_EXIT` reason (11 trades — TP computed at/below the market at placement time → immediate backstop market sell). For the remainder: verify `compute_tp_price` input is the actual `filled_avg_price` in the manual-trade path, and that `TAKE_PROFIT_EXIT` is only recorded on genuine TP-limit fills.
2. **Symbol mislabel**: row 9 logs contract `TSLA260515C00400000` under symbol `SPY` — check the manual-buy endpoint's `underlying` handling; this can corrupt per-symbol analytics and the position-monitor ownership checks.
3. **`config.py` duplicate constants**: `EXIT_QUICK_PROFIT_ENABLED`, `QP_GAP_PCT` (0.01 then 0.0), `EXIT_TRAILING_STOP_ENABLED`, `SL_STOP_LIMIT_BUFFER_PCT` are each defined twice; later silently wins. Dedupe *before* any tuning, otherwise half the tuning edits will be no-ops. Also sync CLAUDE.md's stale config table.
4. **−$35 loss over 540s** (row 9): pull `trade.log` for 2026-05-06 13:12–13:21 and confirm which fallback condition held the position 9 minutes; that duration contradicts every configured exit path.

---

## PART C — Phased implementation plan (hand this to Opus/Sonnet)

Each phase is independently shippable and testable in paper trading. Do not merge phases.

| Phase | Changes | Files | Acceptance criteria (paper session) |
|---|---|---|---|
| 0 | B8.3 config dedupe + CLAUDE.md sync; A2.5 rejection counters; B8.1/B8.2/B8.4 audits (report, fix if trivial) | `config.py`, `strategy_helpers.py`, `CLAUDE.md` | Startup log prints effective exit knobs once; `entry_rejections_*.json` populates; audit findings documented |
| 1 | **B1** remove LOSS-mode drawdown ratchet; **B6** bracket SL child → stop-market (or buffer 0.20 → 5.0); **B7** exempt safety exits from the 30s gate | `monitoring.py`, `order_execution.py`, `config.py` | Zero stop-outs above the static SL price in loss zone; `SL_MISSED_GAPDOWN_MARKET_EXIT` count ≈ 0 (was 63 all-time); the 35–42s exit-duration cluster disappears |
| 2 | **B2 + B3** tier ladder + replace gating; **B5** spread guard | `monitoring.py`, `config.py` | Replaces per trade ≤ 5 (was dozens); fallback-reason exits < 20% of trades (was 56% all-time, 65% in June); `qp_armed` only when peak ≥ +3% |
| 3 | **B4** R:R flip to pct mode + max-hold enable | `config.py`, `monitoring.py` (bracket-mode max-hold path) | Avg win / avg loss ≥ 1.5 over ≥ 30 paper trades (all-time baseline: 1.15) |
| 4 | **A2.1–A2.4** entry unblocking (VWAP-wall removal, ATR dict, Setup-A loosening, confluence logging) | `rsi_analyer.py`, `config.py`, `strategy_helpers.py` | AIT produces 1–4 entries/symbol/day; wrong-direction rate (adverse move ≥ SL distance within 90s) < 25% |
| 5 | **A3.1** 5-min regime confirm; **A2.6** time windows; **A4** blackout calendar | `rsi_analyer.py`, `strategy_helpers.py`, `config.py` | Wrong-direction rate < 15%; no entries inside blackout windows |
| 6 | (Optional, paid) SIP feed upgrade → real volume confluence | `config.py` | Volume point achievable; re-tune `ENTRY_CONFLUENCE_MIN_SCORE` with 4 live components |

**Sequencing rationale**: exit first (Phases 1–3) because you can validate it daily with manual entries — your current MT workflow is the perfect test harness — and because entry improvements are unmeasurable while the exit engine converts +3% peaks into losses. Entry phases (4–5) then get judged on clean exit data.

**Success definition** (after Phase 5, over ≥ 50 paper trades): win rate ≥ 45% with avg-win/avg-loss ≥ 1.5 (expectancy ≈ +0.35R/trade), fallback-exit share < 15%, zero loss exceeding the static SL by more than spread. All-time baselines to beat (506 trades): 25% win rate, 1.15 avg-win/avg-loss, 56% fallback share.

---

## PART D — Direct answers to your questions

1. **"Filters contradict or are too stringent"** — Correct, and it is specifically the VWAP-wall veto vs. the VWAP regime gate (A1.1), the SPY-hostile ATR floor (A1.2), the dead volume point on IEX (A1.3), and Setup A's triple same-bar requirement (A1.4). Fix those four; do not loosen the regime gate itself — it is what protects direction.
2. **"Remove filters → wrong direction, 90% stop loss"** — With filters off, the trigger is a lagging mean-reversion RSI cross traded as a trend signal, *and* the exit engine (B1) stops you at half the configured distance. Both halves compound: wrong-ish entries meet a stop that fires on noise.
3. **"QP doesn't kick in at the right time"** — Today QP arms on the first uptick with a 1%-wide trail (too early, too tight) while the broker stop lags replacement churn (too late where it matters). The tier ladder (B2) + replacement gating (B3) fixes both ends.
4. **"Ratchet breaks and ends up in stop loss"** — The 66% emergency-fallback exit rate is the ratchet "breaking": per-cent replacement churn creates permanent replace-failure windows. B3 reduces replaces ~10×; the fallback conditions remain as true safety nets rather than the main exit path.
5. **"SL gets reset (luckily) but still no profit"** — Not luck: the LOSS-mode drawdown ratchet (B1). Removing it is the highest-value single change in this document.
6. **Candle patterns?** — Already implemented and in use; adding more single-bar patterns adds noise. Add the 5-minute regime confirmation (A3.1) instead.
7. **News/tweets?** — Not as a directional signal at 1-minute horizon (latency + noise make it net-negative). Yes as a static blackout calendar for FOMC/CPI/NFP windows and TSLA earnings (A4) — cheap, no ML, removes a real loss mode.
8. **"Do the past MongoDB transactions support the panic-sell finding?"** *(asked 2026-07-06)* — Yes. Across all 506 recorded trades, 282 (56%) exited through forced `*_MARKET_EXIT` fallback paths, and `ORDER_SYSTEM_FAILURE_MARKET_EXIT` alone accounts for −$2,124 of the −$3,700 total. The panic-sell share *rose* after the May-08 monitoring bug fixes (Apr 43% → May 66% → Jun 65%), proving it is a design property of the per-cent ratchet + 1¢ stop-limit buffer + 30s gate (fixed by B3, B6, B7), not a code defect that was already patched. Full breakdown in §0.1.
