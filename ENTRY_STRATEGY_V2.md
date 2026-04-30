# Cape — Entry Strategy v2 (Architecture Proposal)

> Scope: **entry only**. Exit logic (TP/SL/QP/bracket/trailing/monitoring) is unchanged.
> Status: **proposal — no code modified yet**. Awaiting review before implementation.

---

## 1. Diagnosis of current entry behavior

### 1a. What the code actually does today

> **Context note:** The 13 filters in [`config.py`](backend/config.py) are currently set to `False` deliberately, to isolate manual-trading mode for testing. The discussion below describes the *intended* AIT entry state — i.e., the 13 filters re-enabled. The structural conclusions in §1b–§1d hold **even when all 13 filters are turned back on** (see §1e for why).
>
> One related caveat: the CALL and PUT branches in [`strategy_helpers.py:determine_signal()`](backend/strategy_helpers.py) carry `# filters removed` comments at [strategy_helpers.py:174](backend/strategy_helpers.py#L174) and [strategy_helpers.py:202](backend/strategy_helpers.py#L202). This suggests the filter *chain* (the if-checks that read the flags) was also stripped, not just the flags toggled off. Confirm whether re-flipping the flags is enough or whether the chain needs rebuilding.

The intended live entry path applies these gates beyond the strategy detector itself:

| Check | Where | Strength |
|---|---|---|
| Trade time window | [strategy_helpers.py:75-81](backend/strategy_helpers.py#L75-L81) | **Disabled** — `ENTRY_TIME_WINDOW_ENABLED = False` ([config.py:216](backend/config.py#L216)). The rejection log message at [strategy_helpers.py:87](backend/strategy_helpers.py#L87) is hardcoded text and misleading. |
| Conflicting CALL+PUT same bar | [strategy_helpers.py:143](backend/strategy_helpers.py#L143) | OK |
| RSI/RSI-MA gap ≥ 3.0 | [strategy_rsi_crossover.py:13](backend/strategy_rsi_crossover.py#L13) | Tier-3 weakness — see §1c |
| Cooldown (5 bars) after exit | [main.py:718-724](backend/main.py#L718-L724) | OK |
| Same-bar duplicate protection | [main.py:763-776](backend/main.py#L763-L776) | OK |
| Previous-bar cross carryover | [strategy_helpers.py:96-101](backend/strategy_helpers.py#L96-L101) | **Harmful** — see §1d |

All 13 filters in `config.py` ([config.py:139-216](backend/config.py#L139-L216)) are presently `False` — the steady-state plan is for them to be `True` again once MT testing is complete. The only enabled detector in [`logs/strategy_modes.json`](backend/logs/strategy_modes.json) is `RSI_CROSSOVER`, and that does not change in either state. So the **trigger source** is fixed: a 1-min RSI(14) crossing its 9-bar SMA. The 13 filters only modulate which crosses pass.

### 1b. Why "wrong direction" is structural, not bad luck

A 1-minute RSI crossover has three structural problems on US options scalping:

1. **It is a mean-reversion signal sold as a trend signal.** RSI crossing above its MA from below 50 fires regardless of whether the underlying trend is bullish or bearish. In a downtrend, every micro-bounce will fire a CALL into a falling market.
2. **It is lagging.** The cross is computed on the *closed* 1-min bar. By the time we enter on the *next* tick, the move that caused the cross is partially or fully over. Mean reversion frequently completes within the same bar.
3. **`ENTRY_ALLOW_PREV_BAR_CROSS = True`** ([config.py:136](backend/config.py#L136)) makes this strictly worse: if the cross happened on bar T-1 and we missed it, we still take the trade on bar T — by which point momentum has often flipped. This is a direct ingredient of wrong-direction fills.
4. **`MIN_RSI_MA_GAP = 3.0` is non-discriminating.** A 3-point gap when RSI is at 50 (chop center) is the same gate as a 3-point gap when RSI is at 70 (trend extreme). Most weak crosses pass it.

### 1c. Why "never enters during strong moves" is structural

In a strong directional move RSI **pins** above 70 (or below 30) for many consecutive bars. **It does not cross its MA during the run** — by definition, the MA is chasing it. The only crossover that does fire during a strong run is the *exit* cross at the end. That is exactly when we want to be already in, not entering.

This is why you are watching the price rip and the bot is silent: RSI_CROSSOVER cannot fire during the move it should be capturing.

### 1d. Asymmetric R:R amplifies the damage

Current absolute exit levels: `TAKE_PROFIT_PCT = 0.25`, `STOP_LOSS_PCT = 0.50` ([config.py:239,243](backend/config.py#L239)). These are **dollar offsets on the option price**, not the underlying. So:

- TP = +$0.25 per contract → ~3-4% of a $7 option
- SL = −$0.50 per contract → ~7% of a $7 option
- **Break-even win rate = 0.50 / (0.25 + 0.50) ≈ 67%** before slippage and bid/ask spread.

Even with a perfect 67% directional hit-rate, you lose money. The sample log entries in [`logs/trade.log`](backend/logs/trade.log) show this exact failure mode — most exits hit a tight trailing-SL after a brief profit, returning −$3 to −$5 each ([trade.log:7-19](backend/logs/trade.log#L7-L19)).

**This is an exit-side problem, not entry, but the point is: even a perfect entry does not save you under the current TP/SL ratio.** Out of scope for this task, but flagging because entry redesign without exit re-tuning will not close the loop.

### 1e. Why re-enabling all 13 filters is not enough on its own

This is the central question raised once we account for the MT-testing context. Four reasons the structural problems persist even with every flag back to `True`:

1. **No regime classification.** The 13 filters AND together as a flat list — none of them is a top-level question "is the current regime BULL, BEAR, or CHOP?" A CALL can pass {`EMA_CROSS` + `RSI_THRESHOLD` > 55 + `PULLBACK` + `STRONG_CANDLE`} during a counter-trend bounce while VWAP, EMA21>EMA55, and RSI side all disagree — because no single check forces those three to align as a unit. Wrong-direction risk is a function of architecture, not flag state.

2. **The trigger is still the same crossover.** Filters subtract bad crosses; they cannot synthesize entries during a clean trend where RSI is pinned and never crosses. The "never enters when price is moving strong" symptom is built into the trigger source, not the filter layer.

3. **Flat-AND of 13 strict gates tends to starve the signal.** With everything `True`, the bot is likely to take very few or zero trades on quiet days — and there is no per-filter rejection logging today to tell which filter is the limiting one. This matches the symptom you described from earlier filter-on runs.

4. **Pairs of filters overlap or fight each other.**
   - `ENTRY_RSI_THRESHOLD` (CALL ≥ 55) and `ENTRY_RSI_EXTREME_FILTER` (CALL < 58) leave only RSI ∈ [55, 58] for a CALL — a 3-point window that is easy to miss entirely.
   - `ENTRY_RSI_STREAK` requires the streak in [2, 2] — exactly 2 bars — combined with `ENTRY_RSI_MOMENTUM` (`delta ≥ 4.0`), forms a very narrow joint distribution that the cross rarely sits in.
   - `ENTRY_PULLBACK_ENABLED` requires price within 0.35% of EMA9, which during fast moves is rarely true *on the same bar* as the cross.

The combined effect: when ON, the existing 13 filters produce a system that picks the right direction more often than the current `False` state, but at a frequency too low to capture the trend moves you watch and want. The v2 design solves this by giving the bot **alternative ways to enter** (pullback, BB break) so it isn't dependent on a cross occurring during a trend.

### 1f. Indicators already computed but unused

[`rsi_analyer.py:analyze_rsi()`](backend/rsi_analyer.py) already computes — and returns in `rsi_result` — every indicator we need to fix this:

- VWAP and `price_above_vwap` ([rsi_analyer.py:566-585](backend/rsi_analyer.py#L566-L585))
- EMA9/21/55 + triple-stack flags ([rsi_analyer.py:354-369](backend/rsi_analyer.py#L354-L369))
- EMA bullish/bearish "regime" (cross within last 5 bars) ([rsi_analyer.py:371-391](backend/rsi_analyer.py#L371-L391))
- Pullback-to-EMA9 percent ([rsi_analyer.py:394-403](backend/rsi_analyer.py#L394-L403))
- MACD line/signal/hist + cross flags ([rsi_analyer.py:405-423](backend/rsi_analyer.py#L405-L423))
- Bollinger Bands (20, 2σ) + previous bar values ([rsi_analyer.py:425-446](backend/rsi_analyer.py#L425-L446))
- Candle anatomy: body ratio, bullish/bearish, breaks prev high/low ([rsi_analyer.py:448-470](backend/rsi_analyer.py#L448-L470))
- Price-structure patterns: engulfing / hammer / shooting star / pin bar / inside bar ([rsi_analyer.py:472-538](backend/rsi_analyer.py#L472-L538))
- Volume ratio + `volume_unavailable` flag ([rsi_analyer.py:540-564](backend/rsi_analyer.py#L540-L564))
- RSI streaks (up/down) ([rsi_analyer.py:208-220](backend/rsi_analyer.py#L208-L220))

**The signal architecture is starved for data it already has.** The proposal below uses these existing fields — no new indicators are introduced.

---

## 2. Design goals for v2

1. **Direction correctness ≥ 75%** of triggered entries should move at least the SL distance in the trade direction within the first 60–90 seconds.
2. **Catch trending moves**, not just mean reversions. The bot should fire during clean trends (the moves currently being missed).
3. **Refuse to trade chop.** A clear "no-trade" verdict during sideways/inside-bar regimes is more valuable than a loose trade.
4. **Cap signal frequency.** Fewer, higher-quality entries per day. Quality > quantity.
5. **No new indicators.** Use what `analyze_rsi()` already produces.
6. **Entry-only change.** Exits, monitoring, bracket/QP behavior remain untouched.

---

## 3. Recommended architecture: **Three-Tier Confluence Gate**

The entry decision becomes a **three-tier pipeline**. A signal must clear all three tiers to fire. This replaces the current "any detector fires" model.

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 — REGIME (am I allowed to look for a trade?)             │
│   Pass = trend regime is defined and not chop                   │
└──────────────────────┬──────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ TIER 2 — TRIGGER (do I have a setup?)                           │
│   One of three setups, each only valid in matching regime       │
└──────────────────────┬──────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ TIER 3 — CONFIRMATION (does the candle agree?)                  │
│   Confluence score ≥ N from {candle, MACD, volume, structure}   │
└──────────────────────┬──────────────────────────────────────────┘
                       ▼
                  ENTRY FIRES
```

Each tier is a **boolean gate**. No tier is bypassed. This intentionally trades fewer times in exchange for direction correctness.

### Tier 1 — Regime Filter (the "am I allowed to trade" gate)

Compute a `regime` ∈ {`BULL`, `BEAR`, `CHOP`} once per bar. Only `BULL` permits CALL evaluation; only `BEAR` permits PUT. `CHOP` blocks all entries.

**`regime = BULL` requires ALL of:**
- `price > VWAP` (intraday volume-weighted flow is up)
- `EMA9 > EMA21` AND `EMA21 > EMA55` (full EMA stack up — `ema_triple_bull = True`)
- `latest_rsi > 50`

**`regime = BEAR` requires ALL of:**
- `price < VWAP`
- `EMA9 < EMA21 < EMA55` (`ema_triple_bear = True`)
- `latest_rsi < 50`

**`regime = CHOP`** otherwise.

| Outcome | Effect |
|---|---|
| BULL | CALL setups allowed in Tier 2; PUT setups blocked |
| BEAR | PUT setups allowed; CALL blocked |
| CHOP | **No entry attempted**, log "REGIME=CHOP" and wait |

> **This single gate eliminates the wrong-direction problem.** A CALL cannot fire below VWAP with a downward EMA stack. A PUT cannot fire above VWAP with an upward EMA stack. The current bot has no equivalent of this gate, which is the root cause of "entered CALL and market went down".

### Tier 2 — Trigger (the "do I have a setup" gate)

A setup is a **directional event with a specific reason to enter on this bar**. We use three setups, each tuned to a different market behavior. Only setups matching the current regime are evaluated.

#### Setup A — Pullback-to-EMA9 (the trend-following workhorse)

This catches the strong moves the current bot misses. In a BULL regime, price periodically pulls back to EMA9 then resumes. The pullback IS the entry.

CALL fires when (regime = BULL) AND:
- `pullback_to_ema_pct ≤ 0.20%` on the previous bar (price touched/kissed EMA9)
- Current bar `candle_is_bullish = True` (close > open)
- Current bar `candle_breaks_prev_high = True` (the bounce is confirmed by breaking the prior high)

PUT — symmetric on BEAR regime with `candle_is_bearish` and `candle_breaks_prev_low`.

> Why this works: it enters DURING a trend, not at the reversal point. RSI is not used here at all — it would be pinned and unhelpful.

#### Setup B — Range-Break / Squeeze release (catch the breakout moment)

When BB width has compressed (volatility squeeze) and price breaks out, that's a high-probability move. We do not need to compute squeeze explicitly — we approximate it via a Bollinger break with confirmation.

CALL fires when (regime = BULL) AND:
- `previous_close < prev_bb_upper` AND `candle_close > bb_upper` (fresh breakout above upper band)
- `candle_body_ratio ≥ 0.60` (strong-bodied breakout candle, not a wick)

PUT — symmetric on BEAR regime with `bb_lower` break.

> Why this works: a true BB break with body confirmation is where momentum traders pile in. The current `BOLLINGER_BANDS` strategy uses BB the *opposite* way (mean-reversion, fading the break) — we are flipping its semantics for trend regimes.

#### Setup C — Momentum-confirmed RSI cross (rehabilitated RSI_CROSSOVER)

Keep RSI cross but only when the regime AGREES with the cross direction AND momentum is fresh.

CALL fires when (regime = BULL) AND:
- `rsi_ma_cross_up = True` ON THE CURRENT BAR (no `prev_bar_cross` carryover)
- `previous_rsi < 50` (the cross originates from the bear half — actual reversal, not a chop bounce)
- `latest_rsi > 50` AND `latest_rsi - latest_rsi_ma ≥ 5.0` (gap stronger than the current 3.0 — discriminates trend vs noise)
- `delta ≥ 3.0` (RSI is *accelerating* up, not flat)

PUT — symmetric (RSI cross down originating from `previous_rsi > 50`, current RSI < 50, gap ≤ −5.0, delta ≤ −3.0).

> Why this works: by anchoring the cross to a regime AND requiring it to originate on the opposite side of 50, we filter out the "chop crosses around 50" that produce most wrong-direction trades. By requiring `delta`, we filter out dead crosses where RSI is barely moving.

#### Setup priority

If multiple setups fire in the same bar, prefer **A > B > C**. A is highest-quality (in-trend pullback), C is lowest (reversal/momentum). All three feed the same entry; the priority just records `entry_strategies` for diagnostics.

### Tier 3 — Confirmation (the "is the candle on my side" gate)

Compute a **confluence score** from 0–4. Require **score ≥ 2** to fire. Each item below adds 1 if true.

For CALL (mirror for PUT):

| Item | Check | Source |
|---|---|---|
| Strong candle body | `candle_body_ratio ≥ 0.55` AND `candle_is_bullish` | already in `rsi_result` |
| MACD agrees | `macd_line > macd_signal` AND `macd_line > prev_macd_line` (rising) | already in `rsi_result` |
| Volume confirms | `volume_ratio ≥ 1.3` OR `volume_unavailable = True` (don't penalize missing data) | already in `rsi_result` |
| Price structure agrees | `price_structure_bullish = True` (engulfing/hammer/pin bar) — bonus if present | already in `rsi_result` |

**Hard veto regardless of score:**
- `price_structure_neutral = True` (inside bar — no directional edge)
- For CALL: `latest_rsi ≥ 78` (already extended; reversal risk too high)
- For PUT: `latest_rsi ≤ 22` (already extended)

> Why this works: even a clean Tier-2 trigger in the right regime can fire on a doji, against MACD, or on dead volume. Confluence ≥ 2 ensures the bar we are entering on has real participation behind it.

---

## 4. Decision pipeline (single bar evaluation)

```
on each new 1-min bar:

  if cooldown_bars_remaining > 0:                    skip
  if same bar already traded:                        skip

  rsi_result = analyze_rsi(SYMBOL)
  regime = classify_regime(rsi_result)               # Tier 1

  if regime == CHOP:
      log("REGIME=CHOP, no trade")
      return

  setup = first_matching_setup(regime, rsi_result)   # Tier 2 — A > B > C
  if setup is None:
      log("REGIME ok but no setup")
      return

  score, vetoes = confluence(rsi_result, setup.dir)  # Tier 3
  if vetoes:
      log(f"VETO: {vetoes}")
      return
  if score < 2:
      log(f"Confluence {score}/4 < 2, reject")
      return

  fire(setup.dir, setup.name, rsi_result)            # CALL or PUT
```

Every reject path logs *why* — this gives you observability into the silent-watching periods you currently can't explain.

---

## 5. Time-window filter — keep, but make it real

Re-enable `ENTRY_TIME_WINDOW_ENABLED = True` with the existing windows:
- 9:45–10:45 ET (post-open volatility settles, real direction emerges)
- 13:15–14:15 ET (afternoon reversal window)

Avoid 9:30–9:45 (open noise) and 11:00–13:00 (lunchtime chop).
Avoid 14:30–close (gamma chaos near 0DTE expiry — already partially excluded).

Also fix the misleading hardcoded log message in [strategy_helpers.py:87](backend/strategy_helpers.py#L87) — it currently says "outside trade windows (9:45–10:45 AM / 1:15–2:15 PM ET)" even when the filter is disabled.

---

## 6. Why this delivers ≥ 75% directional correctness

The current model has 1 gate (single detector fires). The proposed model has 3 gates AND a hard veto layer:

| Gate | What it filters | Estimated cut |
|---|---|---|
| Regime CHOP | Sideways markets | ~40-60% of bars |
| Wrong-direction regime | All counter-trend signals | nearly all wrong-direction trades |
| Confluence < 2 | Weak-bodied / no-volume / MACD-disagreeing crosses | ~30-40% of remaining |
| Hard vetoes | Inside bar, RSI extreme | additional 5-10% |

The model targets **fewer trades per day** (rough estimate: 1–4 per symbol per session vs. current ~8–15). The directional accuracy of the entries that survive should comfortably exceed 75% based on the textbook win-rate of trend-pullback systems, which historically run 60-80% on intraday timeframes when paired with a regime filter.

**However**: 75% directional correctness ≠ 75% profitable trades, because the existing TP=$0.25 / SL=$0.50 forces 67%+ direction-AND-magnitude correctness just to break even. See §9.

---

## 7. Why this catches the strong moves currently missed

The pullback-to-EMA9 setup (Setup A) **is the trending-market entry**. During the moves you watch and the bot ignores, RSI is pinned and there is no cross — but EMA9 is being hugged by price, with periodic 0.1–0.3% pullbacks. Those pullbacks are entry points. The current code computes `pullback_to_ema_pct` and immediately discards it because `ENTRY_PULLBACK_ENABLED = False` and `determine_signal()` doesn't reference the field at all.

The BB-break setup (Setup B) catches breakouts from morning consolidation, which are also currently invisible to the RSI-cross-only path.

---

## 8. Pseudocode — proposed `determine_signal()` shape

This is illustrative, not final code. It shows the structure to be implemented when you give the go-ahead.

```python
def classify_regime(r) -> str:
    rsi = r["latest_rsi"]
    above_vwap = bool(r.get("price_above_vwap"))
    triple_bull = bool(r.get("ema_triple_bull"))
    triple_bear = bool(r.get("ema_triple_bear"))
    if above_vwap and triple_bull and rsi > 50:  return "BULL"
    if (not above_vwap) and triple_bear and rsi < 50: return "BEAR"
    return "CHOP"

def setup_pullback(r, direction):
    # Setup A — implemented per §3 Setup A
    ...

def setup_bb_break(r, direction):
    # Setup B — implemented per §3 Setup B
    ...

def setup_rsi_momentum(r, direction):
    # Setup C — implemented per §3 Setup C
    ...

def confluence_score(r, direction) -> tuple[int, list[str]]:
    score = 0; vetoes = []
    # ... per §3 Tier 3 table
    return score, vetoes

def determine_signal(rsi_result, current_price):
    if not _in_trade_window():
        return None, None, None, None

    regime = classify_regime(rsi_result)
    if regime == "CHOP":
        info("  REGIME=CHOP, no trade")
        return None, None, None, None

    direction = "CALL" if regime == "BULL" else "PUT"
    setup = (setup_pullback(rsi_result, direction)
             or setup_bb_break(rsi_result, direction)
             or setup_rsi_momentum(rsi_result, direction))
    if not setup:
        info(f"  REGIME={regime} but no setup matched")
        return None, None, None, None

    score, vetoes = confluence_score(rsi_result, direction)
    if vetoes:
        info(f"  VETO: {','.join(vetoes)}")
        return None, None, None, None
    if score < 2:
        info(f"  Confluence {score}/4 < 2, reject")
        return None, None, None, None

    # Build entry_info with setup name + score, return CALL/PUT/...
    ...
```

---

## 9. Things I noticed that are **broken or risky**, separate from the strategy choice

These are independent of the entry redesign and worth fixing in parallel.

### 9a. `MIN_TRADE_DURATION_ENABLED` is imported but **not defined** in `config.py`

[`main.py:84`](backend/main.py#L84), [`api_server.py:165`](backend/api_server.py#L165), [`position_monitor_loop.py:29`](backend/position_monitor_loop.py#L29) all import `MIN_TRADE_DURATION_ENABLED` from `config`. I read [`config.py`](backend/config.py) end to end and the symbol is **not defined there** — only `MIN_TRADE_DURATION_SEC` is. Either there is an unstaged local edit, or the bot is currently failing to start. Worth confirming.

### 9b. `determine_signal()` filter chain may have been deleted, not just gated

The function imports 20+ `ENTRY_*` flags from `config.py` but the live code path in CALL/PUT branches carries `# filters removed` comments at [strategy_helpers.py:174,202](backend/strategy_helpers.py#L174). The 13 flags being `False` was a deliberate MT-testing choice — but if the *if-checks that read those flags* were also removed, then flipping flags back to `True` will not restore filtering. Confirm whether the filter chain still exists somewhere or needs to be rebuilt before AIT goes back on. If the chain is gone, that is one more reason to merge the rebuild with v2 rather than restore-then-redesign.

### 9c. `ENTRY_TIME_WINDOW_ENABLED = False` but the rejection log message is hardcoded

[strategy_helpers.py:87](backend/strategy_helpers.py#L87) prints `"outside trade windows (9:45–10:45 AM / 1:15–2:15 PM ET)"` even when the windows are disabled. This is reachable only when the flag is True, so cosmetic — but if you re-enable windows with different times, the log message will lie.

### 9d. `ENTRY_ALLOW_PREV_BAR_CROSS = True` is harmful for direction correctness

[`config.py:136`](backend/config.py#L136). Recommend setting to `False` regardless of whether v2 is adopted. Trading a cross from one bar ago is a one-bar lag we cannot afford on 1-min options scalping. v2 explicitly does not consume this flag.

### 9e. TP/SL ratio is mathematically losing

[`config.py:239,243`](backend/config.py#L239) `TAKE_PROFIT_PCT = 0.25` and `STOP_LOSS_PCT = 0.50` are **dollar offsets on the option price** (`EXIT_TAKE_PROFIT_MODE = "price"`). Break-even win rate ≈ 67% before slippage. Even a perfect entry strategy cannot compensate; this needs revisiting once entry quality is fixed. **Out of scope per your instruction; flagging only.**

### 9f. Backtest reports a misleading 79% win rate

[`backend/tools/backtest_result.json`](backend/tools/backtest_result.json) shows `win_rate: 79.16%`, `avg_pnl_pct: 0.003%`. This backtest is computed on the **underlying SPY price**, not the option price ([backtest.py:309-319](backend/tools/backtest.py#L309-L319) treats `compute_tp_price` on the underlying). A $0.25 move on a $710 SPY share is ~0.04% — meaningless for a $7 option that needs ~3% to be a real win. Treat this number as directional only, not predictive.

### 9g. Two symbols in `WATCHLIST_SYMBOLS` but `SYMBOL = "TSLA"` only

[`config.py:69-87`](backend/config.py#L69-L87): both SPY and TSLA are flagged for live trading, but `SYMBOL = "TSLA"` and the AIT loop uses `SYMBOL` ([`main.py:103`](backend/main.py#L103)). The instance lock ([main.py:134-176](backend/main.py#L134-L176)) is per-process, so to run SPY+TSLA in parallel you would need two processes with different `SYMBOL` env overrides. Confirm intent.

### 9h. `volume_unavailable` correctly flagged but unused

[`rsi_analyer.py:540-564`](backend/rsi_analyer.py#L540-L564) correctly flags when IEX feed reports 0 volume. The current `determine_signal()` does not consult this. v2 explicitly handles it (see §3 Tier 3 — `volume_ratio ≥ 1.3 OR volume_unavailable = True`).

---

## 10. Implementation plan (when you give go-ahead)

Phased, smallest-blast-radius first. Each phase is independently testable.

| Phase | Change | Files | Validation |
|---|---|---|---|
| 0 | Re-enable all 13 filters with **per-filter rejection logging** (`info()` line for each filter that rejects). Run for one MT-paused session to capture which filters are doing real work and which never reject. No entry behavior change beyond turning filters back on. | `strategy_helpers.py`, optionally `config.py` | Read `trade.log`; rank filters by rejection count. This calibrates which existing filters survive into v2 Tier 3 vs. which are dead. |
| 1 | Add `classify_regime()` helper, log regime on every bar (no behavior change) | `strategy_helpers.py` | Inspect `trade.log` for one session — confirm regime classification matches your eyeballed read of the chart |
| 2 | Add Tier-3 confluence scoring helper, log score on every signal candidate (no gating yet) | `strategy_helpers.py` | Compare scores on past wins vs losses in MongoDB |
| 3 | Wire regime gate (Tier 1) into `determine_signal()` — block opposite-regime trades only | `strategy_helpers.py` | Wrong-direction trade rate should drop to near zero |
| 4 | Add Setup A (pullback) + Setup B (BB break); keep current RSI cross as fallback (Setup C) | new `strategy_pullback.py`, `strategy_bb_break.py`; `strategy_helpers.py` | Trade frequency drops, win rate rises |
| 5 | Enforce confluence ≥ 2 + hard vetoes | `strategy_helpers.py` | Final tuning |
| 6 | Re-enable `ENTRY_TIME_WINDOW_ENABLED`; fix log strings | `config.py`, `strategy_helpers.py` | Cosmetic / safety |
| 7 | (Recommended) Revisit TP/SL ratio for new entry quality — separate engagement | `config.py` | Out of current scope |

Phases 1–2 are pure observability — they ship without changing entry behavior, and let you confirm the model agrees with your read of the market before any trades change.

---

## 11. Open questions for you

1. **Symbol scope** — should v2 be designed identically for SPY and TSLA, or do you want symbol-specific tuning? TSLA is materially more volatile and may want looser BB-break thresholds.
2. **Data feed upgrade** — the current `STOCK_DATA_FEED = "iex"` returns 0 volume frequently. The volume confluence component is much stronger on SIP. Is upgrading the feed an option?
3. **5-minute confirmation** — would you like a 5-min EMA-trend overlay added to Tier 1 (slower regime check) for an extra direction-correctness margin? Adds latency to a fresh-trend entry but cuts wrong-direction further.
4. **Acceptable trade frequency** — what is the lower bound on trades/day before you'd consider the bot "too quiet"? This affects how strict Tier 3 should be.

Awaiting review. No code changes will be made until you confirm direction.
