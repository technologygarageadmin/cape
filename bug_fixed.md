# Cape — Bug Fix & Monitoring Report

**Last updated**: 2026-05-08
**Scope**: `backend/monitoring.py`, `backend/config.py`, `backend/order_execution.py`, `backend/position_monitor_loop.py`, `frontend/OverallSummary.jsx`

---

## Status Summary

| Component | Status | Notes |
|---|---|---|
| Qty resolution (`monitoring.py`) | ✅ Fixed | `get_open_positions()` race → read direct from `_pos_record` |
| Ratchet calculation | ✅ Working | `sl_dynamic_pct` + `expected_stop_price` correct |
| Ratchet config — QP offset | ✅ Fixed | `$0.01 → $0.10`; trailing SL now has effect |
| Ratchet anchor — current bid → peak bid | ✅ Fixed | SL only advances on genuine new highs; spike ticks no longer lock stop |
| Broker SL placement & verification | ✅ Working | `match=True`; 0.005 tolerance enforced |
| SL replacement chain (11 fixes) | ✅ Fixed | See Pass 1–3 below |
| TP placement / TP-not-filling exit | ✅ Fixed | Condition 10 added; explicit `TP_PLACEMENT_FAILED_MARKET_EXIT` |
| Broker SL replace (post-exit re-entry) | ✅ Fixed | `exit_in_progress` guard blocks re-entry |
| Trade lifecycle cleanup | ✅ Fixed | `exit_in_progress` lock + `get_exiting_symbols` + `close_position` reset removed |
| MT/AIT/RECOVERY loop stuck after non-broker TP exit | ✅ Fixed | Market sell now fires for any exit reason that isn't a broker fill or `FORCED_EXIT_NO_SIGNAL` |
| History data refresh rate | ✅ Fixed | 30s → 5s; limit 200 → 500 |

---

## ✅ Fixed: qty validation false CRITICAL (`monitoring.py`)

**Symptom:** `[QTY CRITICAL] buy_order_id in registry but qty is invalid` fired even when `record_qty=1`.

**Root cause:** qty was resolved by iterating `get_open_positions()`, which filters `status != "CLOSED"`. When a second monitoring run started after the first had already closed the position, `get_open_positions()` returned nothing → `resolved_qty` stayed `None`. But `_id_present` was still `True` (key persists in `_positions` after close) → CRITICAL guard fired on valid data.

**Fix:** Read `qty` directly from `_pos_record` (already fetched from `_pos_registry` by key). No filtering, no race.

**Confirmed working:**
- `resolved_qty: 1, source: registry, id_present: True`
- `FINAL QTY USED: 1 <class 'int'>`

---

## ✅ Fixed: `CAPE_QP_OFFSET` too tight — trailing SL was dead code (`config.py`)

**Symptom:** SL placed at bid − $0.01, meaning any 1-cent bid fluctuation triggered the stop. `CAPE_TRAILING_SL_OFFSET = $0.25` had zero effect.

**Root cause:** In profit mode the ratchet computes:
```
qp_price     = bid − CAPE_QP_OFFSET         ($0.01)
trailing_sl  = bid − CAPE_TRAILING_SL_OFFSET ($0.25)
sl_candidate = max(existing_sl, qp_price, trailing_sl)
```
`qp_price > trailing_sl` always → `CAPE_TRAILING_SL_OFFSET` overridden every tick. Dead code in profit mode. Also: `_SL_MIN_PRICE_STEP = $0.02` with a $0.01 QP offset = ~46 broker replace calls per $1 move.

**Fix:** `CAPE_QP_OFFSET = 0.01 → 0.10`. SL sits $0.10 below bid, absorbing normal option spread noise.

**Design note — `max()` bias:**
The `max(qp, trailing)` architecture always picks the tightest stop. Correct for the current scalp strategy — intentionally biased toward aggressive exits. For future runner/trend-capture trades, a weighted or staged trailing mechanism would be needed (e.g., switch from QP-dominant to trailing-dominant after a profit threshold). Not needed yet.

**Config after fix:**
```python
CAPE_QP_OFFSET          = 0.10   # SL = bid − $0.10
CAPE_TRAILING_SL_OFFSET = 0.25   # Trailing SL = bid − $0.25 (rarely wins vs QP now)
```

---

## ✅ Fixed: Ratchet anchored to current bid — spike ticks locked the stop (`monitoring.py`)

**Symptom:** A single tick of temporarily high bid permanently ratcheted the SL to bid − offset. Normal bid oscillation then triggered the broker stop immediately after, filling at a price below where the ratchet intended.

**Root cause:** In profit mode, `qp_price = current_bid − CAPE_QP_OFFSET` on every tick. Any momentary bid spike moved the SL up irreversibly. The SL was chasing the instantaneous bid, not the genuine price trend.

**Fix:** Track `peak_bid` (highest bid seen while in profit) in `exit_state`. Ratchet is now anchored to `peak_bid`:
```
peak_bid updated only when current_bid > peak_bid   ← one-way, genuine new high only
qp_price      = peak_bid − CAPE_QP_OFFSET ($0.10)
trailing_sl   = peak_bid − CAPE_TRAILING_SL_OFFSET ($0.25)
sl_candidate  = max(existing_sl, qp_price, trailing_sl)
```
`peak_bid` is initialized to `fill_price` at trade entry and only ever increases. In loss mode, `peak_bid` is not reset — the SL stays at its peak-anchored level while the loss-mode tighten logic runs separately.

**Visible in logs:** `[TICK] poll ... peak_bid=X.XXXX ...` now shows the ratchet anchor on every tick.

---

## ✅ Fixed: History data refresh too slow (`OverallSummary.jsx`)

**Symptom:** Trade history only updated every 30 seconds; felt stale.

**Fix:** Poll interval 30s → 5s (same as live positions). Trade limit 200 → 500.

---

## ✅ Fixed: Trade lifecycle cleanup — monitor loop re-enters after exit

**Symptom:** `[TRADE ENTRY] POLLING` repeated for the same `buy_order_id` after position already exited. Second monitor spawned, seeded fresh SL, attempted ratchet replace on a closing/closed position, received `42210000 intent mismatch` — loop repeated indefinitely.

**Root cause (three-part):**

1. `close_position()` in `order_execution.py` reset `is_closing = False` in `_live_exit_states` — removing the guard that should have blocked re-entry.
2. `_positions[id]["status"] = "CLOSED"` removed the position from `get_open_positions()`, so `managed_symbols` in `position_monitor_loop` no longer blocked spawning a generic monitor for the symbol — even though the broker position still showed up in Alpaca's `get_all_positions()` during settlement.
3. No registry-level flag existed to distinguish "actively being closed" from "never seen."

**Three-part fix:**

| Change | File | What |
|---|---|---|
| `exit_in_progress: False` added to `register_position()` initial state | `order_execution.py` | New field in `_positions` registry |
| `exit_in_progress = True` set in `mark_selling()` | `order_execution.py` | Set when first sell order submitted |
| Removed `live["is_closing"] = False` from `close_position()` | `order_execution.py` | Guard now persists through CLOSED state |
| Added `mark_exit_in_progress()`, `is_position_exiting()`, `get_exiting_symbols()` | `order_execution.py` | Helpers for monitor and position loop |
| `_mark_exit_in_progress(exit_state)` helper added | `monitoring.py` | Sets flag in both local state and registry |
| `_cancel_exit_orders` calls `_mark_exit_in_progress` | `monitoring.py` | All market-exit paths set flag before cancelling orders |
| Broker fill returns (`_check_tp_order_filled`, `_check_sl_order_filled`) call `_mark_exit_in_progress` | `monitoring.py` | Broker-fill exits also set flag |
| Entry guard at start of `monitor_with_polling` and `monitor_with_websocket` | `monitoring.py` | If `is_position_exiting(buy_order_id)` → return immediately without any broker calls |
| Loop-top guard in `monitor_with_polling` per tick | `monitoring.py` | If flag set mid-loop (e.g. concurrent thread), monitor exits cleanly |
| Early return in `on_quote` WS callback if `exit_in_progress` | `monitoring.py` | Async callback stops processing quotes after exit fires |
| `buy_order_id` stored in `exit_state["buy_order_id"]` | `monitoring.py` | Allows `_cancel_exit_orders` (no `buy_order_id` param) to reach registry |
| `managed_symbols \|= get_exiting_symbols()` | `position_monitor_loop.py` | Blocks generic monitor spawn during broker settlement window |

**Guard sequence (correct ordering):**
```
1. _mark_exit_in_progress(exit_state)   ← FIRST: set flag in registry + local state
2. _cancel_exit_orders(tc, exit_state)  ← cancel TP/SL broker orders
3. return exit_reason, price, exit_state ← monitor function returns

Concurrent/subsequent monitor call:
  → is_position_exiting(buy_order_id) = True → return None immediately
  → _cancel_exit_orders (if somehow reached) → _mark_exit_in_progress is idempotent
```

---

---

# Monitoring Module — Detailed Fix Report

**Date**: 2026-05-08
**Scope**: `backend/monitoring.py` — SL replacement chain, TP placement, QP ratchet, exit-state lifecycle
**Mode**: Paper-trading session (`PAPER_TRADING = True`)

Three change passes were applied to `monitoring.py`:

1. **Pass 1 — SL-replacement audit** — 5 fixes (1 medium-severity bug, 4 robustness)
2. **Pass 2 — TP / TP-lock / QP audit** — 6 fixes (1 medium crash bug, 2 medium correctness, 1 medium race, 2 low cleanup)
3. **Pass 3 — TP-not-filling / TP-not-available market-exit** — 2 enhancements (1 new fallback condition, 1 TP-placement hardening)

Total: **13 changes** + CLAUDE.md doc sync. No live trading was active during these changes.

---

## Pass 1 — SL Replacement Chain

### Fix 1.1 — Tighten `_verify_sl_order` tolerance

**Severity**: Medium | **Type**: Correctness

**Root cause:** `_verify_sl_order` accepted broker `stop_price` within $0.02 of expected as "verified." QP ratchets in `CAPE_QP_OFFSET` steps. A broker stop reported 1.5¢ stale (within 0.02 but outside the ratchet step) would advance `sl_last_placed_pct` against incorrect broker state.

**Fix:** Tolerance tightened to `< 0.005` (half the old QP step of $0.01).

| Aspect | Before | After |
|---|---|---|
| Verification slack | $0.02 | $0.005 |
| Risk of trusting stale broker stop | Yes | No — drift > 0.005 → unverified |
| Retry on mismatch | Suppressed | Triggers next-tick retry |

---

### Fix 1.2 — `_wait_for_cancel` helper for cancel-then-fresh paths

**Severity**: Medium | **Type**: Robustness

**Root cause:** After cancelling a broker SL, code slept fixed 0.3s/0.8s then submitted fresh stop. Fixed sleep could be too short → fresh submit lands while prior order still open → re-triggers `40310000`.

**Fix:** New `_wait_for_cancel(tc, order_id, timeout_sec=1.5)` polls order status until non-open or 404. Replaces fixed sleeps in `held_for_orders` and catch-all branches.

| Aspect | Before | After |
|---|---|---|
| Cancel-confirm wait | Fixed sleep | Poll-until-cancelled (≤ 1.5s) |
| Risk of double-open during fresh submit | Real on slow broker | Eliminated within 1.5s |
| New log signal | None | `[SL CANCEL WAIT] Timeout ... last_status=...` |

---

### Fix 1.3 — Preserve TP in `held_for_orders` cancel path

**Severity**: Medium | **Type**: Correctness

**Root cause:** On `held_for_orders`, recovery cancelled every open SELL for the symbol — including the bracket TP child (a limit), leaving the position with neither SL nor TP during recovery.

**Fix:** Filter cancellations by `order_type` containing `"stop"`. Limit orders (bracket TP child) are preserved.

| Aspect | Before | After |
|---|---|---|
| Bracket TP child after held_for_orders | Cancelled | Preserved |
| Upside capture during recovery | Lost | Retained |

---

### Fix 1.4 — Throttle unverified replace retries

**Severity**: Medium | **Type**: Robustness

**Root cause:** When `_verify_sl_order` failed, `sl_last_placed_pct` was not advanced → next profit tick called `replace_order_by_id` again immediately. Sustained failures → many ticks back-to-back, each blocking.

**Fix:** Added `sl_replace_failed_ts`. Gate at function entry returns `{"operation": "throttled"}` if prior failure was within 1 second. Cleared on every verified success.

| Aspect | Before | After |
|---|---|---|
| Retry rate after verification failure | Every tick | Min 1s between attempts |
| API rate-limit risk | High under sustained failure | Bounded |
| New log signal | None | `{"operation": "throttled", "elapsed_sec": ...}` |

---

### Fix 1.5 — 30s deadline + market-exit escalation for `42210000`

**Severity**: Medium | **Type**: Safety net

**Root cause:** On `42210000` ("position intent mismatch"), code returned `{"operation": "retry"}` indefinitely. Broker never making position visible → position sat unprotected with no escalation.

**Fix:** `POSITION_NOT_READY_DEADLINE_SEC = 30.0`. After 30s continuous retries: `position_not_ready_escalated = True` + new **Condition 9** (`POSITION_NOT_READY_TIMEOUT_MARKET_EXIT`) fires market exit.

| Aspect | Before | After |
|---|---|---|
| Worst-case unprotected hold on broker outage | Indefinite | 30s |
| Log signal at deadline | Indistinguishable from normal | `[CRITICAL] Position not ready ... escalating` |
| Fallback at deadline | None | Market exit attempt |

---

## Pass 2 — TP / TP-lock / QP Audit

### Fix 2.1 — TP fill detection crashes on missing `filled_avg_price`

**Severity**: Medium (crash bug) | **Type**: Defect

**Root cause:** `info(f"[TP] Order {filled_id} filled at {filled_price:.4f}")` raises `TypeError` when `filled_price is None`. State already mutated and SL cancelled before the format string is evaluated → crash after irreversible side effects, `True` return never reached.

**Fix:** `_fp_str = f"{filled_price:.4f}" if filled_price is not None else "unknown"`.

| Aspect | Before | After |
|---|---|---|
| TP fill where broker omits `filled_avg_price` | TypeError → monitor crashes | Logs `unknown` → returns True normally |
| Recovery | Inconsistent state; needs intervention | Clean exit |

---

### Fix 2.2 — `_seed_bracket_exit_orders` capture `confirmed_sl_price` + leg completeness

**Severity**: Medium | **Type**: Correctness

**Root cause (two bugs):**
- **(a)** Idempotency guard returned early if **either** `tp_order_ids` or `sl_order_ids` was non-empty. SL leg arriving before TP leg (race) → TP child never tracked.
- **(b)** `confirmed_sl_price` discarded even though the broker's actual `stop_price` was read — so fallback-detector early-out was disabled until first verified replacement.

**Fix:** Both-legs gate: `if (tp_order_ids and sl_order_ids): return`. SL leg stores `(id, stop_price)` tuple; `confirmed_sl_price` set on first seed.

| Aspect | Before | After |
|---|---|---|
| Partial-leg race | TP child untracked indefinitely | Loop waits for both; re-seed allowed |
| `confirmed_sl_price` after seeding | `None` until first replacement | Set immediately |
| Fallback-detector early-out | Disabled until first replace | Active from tick zero |

---

### Fix 2.3 — SL fill check before TP retry cancel

**Severity**: Medium | **Type**: Race fix

**Root cause:** `_attempt_place_tp_limit` second attempt cancels SL → submits TP. Between first attempt and cancel, SL could have filled at broker. `_cancel_sl_orders` returns silently, clears `sl_order_ids`. Fill never detected → position leaks into `get_open_positions()`.

**Fix:** Snapshot `sl_order_ids` before cancel. Call `_check_sl_order_filled` on those IDs. If True → bail out; caller picks up fill next tick.

| Aspect | Before | After |
|---|---|---|
| SL fill during TP-retry window | Silently lost | Detected; retry bails |
| Position-registry leak | Real (rare race) | Eliminated |
| New log signal | None | `[TP LIMIT] SL filled at broker during TP retry window` |

---

### Fix 2.4 — `_wait_for_cancel` instead of fixed sleep in TP retry

**Severity**: Low | **Type**: Robustness

**Fix:** Replace fixed `time.sleep(0.3)` after `_cancel_sl_orders` in TP retry with `_wait_for_cancel` polling per cancelled SL ID (consistent with Fix 1.2).

---

### Fix 2.5 — Set `is_closing=True` in `_check_tp_order_filled`

**Severity**: Low | **Type**: Defensive ordering

**Root cause:** `_check_tp_order_filled` called `_cancel_sl_orders` without first setting `is_closing = True`. Any concurrent caller racing into `_update_dynamic_thresholds` could attempt SL placement on a position already closed at the broker.

**Fix:** Set `is_closing = True` **before** the SL cancel inside `_check_tp_order_filled`.

---

### Fix 2.6 — Reset SL tracking fields on `_cancel_sl_orders`

**Severity**: Low | **Type**: State hygiene

**Root cause:** `_cancel_sl_orders` cleared `sl_order_ids = []` but left `sl_last_placed_pct`, `confirmed_sl_price`, `sl_replace_failed_ts` at pre-cancel values. Next SL placement gated on a stale `sl_last_placed_pct` no longer corresponding to any live order.

**Fix:** Reset all three fields inside `_cancel_sl_orders` so subsequent placement takes the fresh-placement path.

| Aspect | Before | After |
|---|---|---|
| `sl_last_placed_pct` after SL cancel | Stale | Reset to `None` |
| `confirmed_sl_price` after SL cancel | Stale | Reset to `None` |
| `sl_replace_failed_ts` after SL cancel | Stale failure window | Reset to `0.0` |

---

## Pass 3 — TP-not-filling / TP-not-available Market Exit

### Fix 3.1 — Condition 10: TP limit at broker but not filling

**Severity**: Enhancement | **Type**: Safety net

**Gap:** TP child exists at broker, price reaches `tp_price`, but limit doesn't fill (wide spread, thin liquidity). Position held at TP for unbounded duration — QP ratchet eventually moves SL up but TP-level profit not actively captured.

**Fix:** New **Condition 10** (`TP_LIMIT_NOT_FILLING_MARKET_EXIT`) in `_detect_market_fallback_reason`:
- Fires when `tp_price > 0`, `tp_order_filled = False`, `tp_order_ids` non-empty, `sellable_price >= tp_price`
- 2-second grace timer (`tp_not_filling_seen_ts`) — filters transient quote spikes
- Placed before `confirmed_sl_price` early-out
- Grace timer resets when price retreats below TP, TP fills, or TP child cancelled

| Aspect | Before | After |
|---|---|---|
| TP child exists, price ≥ TP, not filling | No bound | 2-second grace → market exit |
| New log signal | None | `[FALLBACK TRIGGER] reason=TP_LIMIT_NOT_FILLING_MARKET_EXIT` |

---

### Fix 3.2 — TP placement try/catch hardening + explicit market-exit routing

**Severity**: Enhancement | **Type**: Robustness + observability

**Gap:** `_attempt_place_tp_limit` returned `None` on failure → caller fell through with `exit_reason = "TAKE_PROFIT_EXIT"` even though no TP fill occurred. Several inner try/catch blocks could propagate exceptions and bypass the failure-flag.

**Fix:**
- `_flag_unavailable(reason)` helper — sets `tp_placement_failed = True`, `tp_placement_failed_reason`, `tp_placement_failed_ts` on every failure path
- All inner operations (SL pre-check, cancel, wait-for-cancel) wrapped in own try/catch
- Callers override `exit_reason` to `TP_PLACEMENT_FAILED_MARKET_EXIT` when `_attempt_place_tp_limit` returns None and `tp_placement_failed = True`

| Aspect | Before | After |
|---|---|---|
| Exit reason on TP placement failure | Misleading `TAKE_PROFIT_EXIT` | Explicit `TP_PLACEMENT_FAILED_MARKET_EXIT` |
| Inner exceptions in retry path | Could propagate | Each in own try/catch; flag always set |

---

## Aggregate Impact Summary

| Failure mode | Before | After |
|---|---|---|
| Stale broker stop accepted as ratchet | Within $0.02 tolerance | Only within $0.005 accepted |
| Cancel-then-fresh races into 40310000 | Real on slow broker | Eliminated within 1.5s |
| TP cancelled by held_for_orders | TP wiped → market exit fallback | TP preserved |
| Sustained verification failure | Up to 12 retries/min, each ~1s blocking | Throttled to ≤ 1/sec |
| 42210000 indefinite retry | No upper bound | 30s deadline → market exit |
| TP fill with no `filled_avg_price` | Monitor crash post state-mutation | Logs `unknown`, returns True |
| Partial bracket leg seeding | TP child untracked indefinitely | Both-legs gate + re-seed allowed |
| Fallback-detector early-out before first replace | Disabled | Active from tick zero |
| SL fill during TP-retry window | Silently lost | Detected; retry bails |
| `is_closing` race after TP fill | Latent | Eliminated |
| Stale `sl_last_placed_pct` after SL cancel | Persists | Reset on cancel |
| TP at broker, price ≥ TP, not filling | No bound | 2-second grace → market exit |
| TP placement failure exit reason | Misleading `TAKE_PROFIT_EXIT` | Explicit `TP_PLACEMENT_FAILED_MARKET_EXIT` |
| QP offset too tight (1 cent) | ~46 broker calls per $1 move; trailing SL dead | 10 cents; trailing SL active; ~5 calls per $1 move |

---

## Files Changed

| File | Changes |
|---|---|
| `backend/monitoring.py` | 11 code fixes (Pass 1–3) |
| `backend/config.py` | `CAPE_QP_OFFSET` 0.01 → 0.10 |
| `frontend/src/pages/OverallSummary.jsx` | History poll 30s → 5s; limit 200 → 500 |
| `CLAUDE.md` | Doc sync — stop-market wording, replacement chain, conditions 6–9 documented, Condition 10 added |

---

## Known Limitations (Not Fixed)

- `qp_arm_*` snapshot fields reset on every loss-mode entry — design choice; UI-displayed "QP first armed at" timestamp is transient if price oscillates around fill.
- Dead bracket-mode block in `monitor_with_websocket` — unreachable due to early return; pure cleanup, no behavior change.
- `_SL_PLACEMENT_LOCK` is module-level — serialises SL placements across all positions in the same process. Bottleneck if multi-symbol concurrent monitoring is ever added; not an issue under current single-symbol-per-process design.
- `_verify_sl_order` blocks monitor thread up to 3 × 0.35s = 1.05s on retries. Throttle (Fix 1.4) bounds the storm but each individual call still blocks. Acceptable tradeoff for verification correctness.

---

## Paper-Trading Verification Checklist

Watch `logs/trade.log` for:

| Signal | Meaning |
|---|---|
| `[SL VERIFY] match=False` | Rare OK; sustained = broker reporting stale prices |
| `[SL CANCEL WAIT] Timeout` | Cancel didn't propagate within 1.5s; investigate broker latency |
| `{"operation": "throttled"}` | Expected only after verification failure within last 1s |
| `[CRITICAL] Position not ready ... escalating` | Should NEVER appear in normal paper trading |
| `[FALLBACK TRIGGER] reason=POSITION_NOT_READY_TIMEOUT_MARKET_EXIT` | Condition 9 fired |
| `[FALLBACK TRIGGER] reason=TP_LIMIT_NOT_FILLING_MARKET_EXIT` | Condition 10 fired |
| `[TP] Order ... filled at unknown` | Fix 2.1 saved the loop |
| `[TP LIMIT] SL filled at broker during TP retry window` | Fix 2.3 caught the race |
| `TP_PLACEMENT_FAILED_MARKET_EXIT` | Fix 3.2 routed to market exit explicitly |
| `[BRACKET] Seeded parent=... tp=1 sl=1` | Both legs captured (common case) |
