# Monitoring Module Bug-Fix Report

**Date**: 2026-05-08
**Scope**: `backend/monitoring.py` — SL replacement chain, TP placement, QP ratchet, exit-state lifecycle
**Mode**: Paper-trading session (`PAPER_TRADING = True`)

---

## Executive summary

Three change passes were applied to `monitoring.py`:

1. **SL-replacement audit** — 5 issues fixed (1 medium-severity bug, 4 robustness issues)
2. **TP / TP-lock / QP audit** — 6 issues fixed (1 medium crash bug, 2 medium correctness bugs, 1 medium race, 2 low cleanup)
3. **TP-not-filling / TP-not-available market-exit** — 2 enhancements (1 new fallback condition, 1 hardening of TP-placement try/catch with explicit market-exit routing)

Total: **13 changes** + **CLAUDE.md doc sync** to match current code. No live trading was active during these changes. SL logic was deliberately not modified in Pass 3 per scope.

A "before/after impact" entry below describes what each fix changes in observable system behavior.

---

## Pass 1 — SL replacement chain

### Fix 1.1 — Tighten `_verify_sl_order` tolerance

**Location**: [monitoring.py:2281](backend/monitoring.py#L2281)
**Severity**: Medium
**Type**: Correctness

**Root cause**
`_verify_sl_order` accepted a broker-stored `stop_price` within $0.02 of the expected value as "verified." The QP ratchet steps in `CAPE_QP_OFFSET = $0.01` increments. A broker stop could be reported 1.5¢ stale (within 0.02 tolerance but outside the 0.01 ratchet step), and the verifier would advance `sl_last_placed_pct` against an incorrect broker state.

**Fix**
Tightened tolerance to `< 0.005`, half the QP step. Stale broker stops cannot now satisfy verification.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Verification slack | $0.02 (2× QP step) | $0.005 (½ QP step) |
| Risk of trusting stale broker stop | Yes — 1.5¢ drift acknowledged as success | No — drift > 0.005 → unverified |
| Retry on actual mismatch | Suppressed by loose tolerance | Triggers next-tick retry |
| Spurious "[SL VERIFY] match=False" logs | Rare | Slightly more common; expected when broker propagation is slow |

---

### Fix 1.2 — `_wait_for_cancel` helper for cancel-then-fresh paths

**Location**: New helper at [monitoring.py:2268](backend/monitoring.py#L2268); applied at [monitoring.py:1373-1375](backend/monitoring.py#L1373-L1375), [monitoring.py:1273-1275](backend/monitoring.py#L1273-L1275)
**Severity**: Medium
**Type**: Robustness

**Root cause**
After cancelling a broker SL, the code slept a fixed 0.3s or 0.8s then submitted a fresh stop. The fixed sleep could be too short on a slow broker round-trip, causing the fresh submit to land while the prior order was still open — re-triggering Alpaca's `40310000` "uncovered" rejection.

**Fix**
New `_wait_for_cancel(tc, order_id, timeout_sec=1.5)` polls the order's status until non-open or 404 is received, with a hard timeout. Replaces fixed sleeps in both held_for_orders and unrecognized-error catch-all branches.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Cancel-confirm wait | Fixed sleep (0.3s / 0.8s) | Poll-until-cancelled (≤ 1.5s) |
| Risk of double-open during fresh submit | Real on slow broker links | Eliminated within 1.5s window |
| Worst-case wait when broker is slow | Truncated by fixed sleep — error follows | Up to 1.5s, then logged warning + continues |
| New log signal | None | `[SL CANCEL WAIT] Timeout ... last_status=...` |

---

### Fix 1.3 — Preserve TP in `held_for_orders` cancel path

**Location**: [monitoring.py:1258-1283](backend/monitoring.py#L1258-L1283)
**Severity**: Medium
**Type**: Correctness

**Root cause**
On `held_for_orders`, the recovery branch cancelled **every open SELL order** for the symbol. The bracket TP child (a limit) was wiped along with whatever stop was holding the qty, leaving the position with neither SL nor TP between cancel and the fresh-SL submit.

**Fix**
Filter cancellations by `order_type` containing `"stop"`. Limit orders (bracket TP child) are preserved.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Bracket TP child after held_for_orders | Cancelled along with holding stop | Preserved |
| Upside capture during recovery window | Lost — falls back to bracket TP backstop (market exit at price ≥ tp_price) | Retained — limit fill protection still active |
| Slippage from market exit fallback | Variable; option spreads can be wide | Avoided when bracket TP holds |

---

### Fix 1.4 — Throttle unverified replace retries

**Location**: New gate at [monitoring.py:709-720](backend/monitoring.py#L709-L720); set/clear at ~10 sites in `_place_sl_stop_order`
**Severity**: Medium
**Type**: Robustness

**Root cause**
When `_verify_sl_order` failed (broker-stored stop didn't match within tolerance), `sl_last_placed_pct` was not advanced, so the next profit tick — which arrives every `PRICE_POLL_SEC` (5s) or every WS quote — would call `replace_order_by_id` again immediately. With `_verify_sl_order` itself blocking up to ~1s on retries, sustained failures meant many ticks back-to-back, each blocking and re-replacing.

**Fix**
Added `sl_replace_failed_ts` to exit_state. Function-entry gate returns `{"operation": "throttled"}` if the prior failure was within 1 second. Set on every unverified-success and exception-failure return; cleared on every verified success and successful adoption.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Retry rate after verification failure | Every tick (5s polling) or every WS quote | Min 1s between attempts |
| API rate-limit risk under sustained failure | High | Bounded |
| Time blocked in `_verify_sl_order` per minute | Up to 60× ~1s under WS bursts | At most 60× 1s = same — but only when not throttled; typical case is dramatically lower |
| Recovery latency on transient failure | Same as retry rate | Same — first profit tick after 1s gap fires |
| New log signal | None | `{"operation": "throttled", "elapsed_sec": ...}` returns |

---

### Fix 1.5 — 30s deadline + market-exit escalation for `42210000`

**Location**: New constant at [monitoring.py:74-79](backend/monitoring.py#L74-L79); deadline tracking at [monitoring.py:833-851](backend/monitoring.py#L833-L851), [monitoring.py:1110-1126](backend/monitoring.py#L1110-L1126); fallback Condition 9 at [monitoring.py:1574-1589](backend/monitoring.py#L1574-L1589)
**Severity**: Medium
**Type**: Safety net

**Root cause**
On `42210000` ("position intent mismatch"), the code returned `{"operation": "retry"}` indefinitely. If the broker never made the position visible (data outage, broker bug, bracket weirdness), the position sat unprotected with no escalation path beyond a 1-line/sec log.

**Fix**
- Module constant `POSITION_NOT_READY_DEADLINE_SEC = 30.0`.
- Both retry sites (pre-flight check and exception handler) track `position_not_ready_first_ts`.
- After 30s of continuous retries, set `position_not_ready_escalated = True` and log `[CRITICAL]`.
- New fallback condition `POSITION_NOT_READY_TIMEOUT_MARKET_EXIT` (Condition 9) at the top of `_detect_market_fallback_reason` fires the market exit when escalated.
- Both flags auto-clear when SL placement progresses past the position-not-ready gate.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Worst-case unprotected hold on broker outage | Indefinite (until manual intervention) | 30s |
| Log signal at deadline | One info line per second, indistinguishable from normal | `[CRITICAL] Position not ready ... escalating` |
| Fallback action at deadline | None | Market exit attempt (may surface `42210000` itself, but no worse than continuing to retry) |
| Auto-recovery if broker recovers | Same — silent | Same — flags cleared on next successful gate-pass |

---

## Pass 2 — TP / TP-lock / QP audit

### Fix 2.1 — TP fill detection crashes on missing `filled_avg_price`

**Location**: [monitoring.py:678-690](backend/monitoring.py#L678-L690)
**Severity**: Medium (crash bug, narrow trigger)
**Type**: Defect

**Root cause**
```python
fp = float(getattr(order, "filled_avg_price", 0) or 0)
filled_price = fp if fp > 0 else None
...
exit_state["tp_order_filled"] = True   # ← state mutated
_cancel_sl_orders(tc, exit_state)      # ← SL cancelled
info(f"[TP] Order {filled_id} filled at {filled_price:.4f}")  # ← TypeError if None
return True                            # ← never reached
```
Format `:.4f` on `None` raises `TypeError`. State already mutated and SL cancelled before the format string is evaluated, so the function crashes after irreversible side effects. The `True` return is never produced — the caller monitor exception-bubbles up.

**Fix**
Compute the format string conditionally:
```python
_fp_str = f"{filled_price:.4f}" if filled_price is not None else "unknown"
info(f"[TP] Order {filled_id} filled at {_fp_str}")
```
Also moved `is_closing = True` to **before** the SL cancel for defensive ordering (see Fix 2.5).

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| TP fill where broker omits `filled_avg_price` | TypeError → monitor loop crashes after state-mutation but before return | Logs `unknown` → returns True normally |
| Recovery from crash | Position state inconsistent; needs intervention | Clean exit; caller proceeds with `tp_order_fill_price=None`, falls back to `sellable_price` |
| Crash likelihood | Low (Alpaca normally populates) | Eliminated |

---

### Fix 2.2 — `_seed_bracket_exit_orders` capture `confirmed_sl_price` + leg completeness

**Location**: [monitoring.py:333-360](backend/monitoring.py#L333-L360), [monitoring.py:370-407](backend/monitoring.py#L370-L407)
**Severity**: Medium
**Type**: Correctness

**Root cause**
Two separate bugs in the same function:

**(a)** Idempotency guard returned early as soon as **either** `tp_order_ids` or `sl_order_ids` was non-empty. If Alpaca propagated the SL leg before the TP leg (race), partial-seed state was preserved and the TP leg was never re-fetched.

**(b)** When the SL leg was captured, only the order ID was stored. `confirmed_sl_price` (the broker's actual `stop_price`) was discarded, even though the function read it at line 377. This meant `_detect_market_fallback_reason`'s early-out gate `if _confirmed_sl > 0 and sellable_price > _confirmed_sl + 0.01: return None, None` was bypassed for every tick until the first verified replacement populated `confirmed_sl_price`.

**Fix**
- Idempotency now requires **both** legs: `if (tp_order_ids and sl_order_ids): return`.
- Loop break-condition tightened to `_has_stop and _has_limit` instead of `if legs:`. The 3×0.4s retry budget is now used to wait for both leg types, not just any leg.
- SL leg list changed to `list[tuple[str, float]]` so `stop_price` is captured. Stored as `confirmed_sl_price` on first seed.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Partial-leg race (TP leg arrives late) | TP child never tracked; only fires via market-exit backstop at `price ≥ tp_price` | Loop waits for both legs; if still partial, idempotency allows re-seed on subsequent calls |
| `confirmed_sl_price` after seeding | `None` until first verified replacement | Set to broker's actual stop_price immediately |
| Fallback-detector early-out | Skipped (≈ extra processing every tick before first replacement) | Active from tick zero |
| Limit-fill protection on TP | Lost on race; market exit instead | Retained |

---

### Fix 2.3 — SL fill check before TP retry cancel

**Location**: [monitoring.py:1969-1996](backend/monitoring.py#L1969-L1996)
**Severity**: Medium
**Type**: Race fix

**Root cause**
`_attempt_place_tp_limit` first attempt fails with `held_for_orders` → second attempt cancels the SL → submits TP. Between the first attempt and our cancel call, the SL could have **filled at the broker**. `_cancel_sl_orders` (with the broken cancel) returns silently, then clears `sl_order_ids = []`. We never run `_check_sl_order_filled` against those IDs again. Position closed at broker; our state still tracks the position as open. Position leaks into `get_open_positions()`.

**Fix**
- Snapshot `sl_order_ids` before the cancel.
- Call `_check_sl_order_filled` on those IDs. If True (SL filled), bail out — caller monitor will pick up the fill on the next tick.
- Otherwise proceed with cancel + retry.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Broker-side SL fill during TP-retry window | Silently lost; IDs wiped; monitor unaware | Detected; function returns None; caller picks up fill |
| Position-registry leak risk | Real (rare race) | Eliminated for this path |
| New log signal | None | `[TP LIMIT] SL filled at broker during TP retry window — skipping TP retry` |
| Wait for cancel propagation | Fixed `time.sleep(0.3)` | Per-ID `_wait_for_cancel(timeout=1.5s)` (Fix 2.4) |

---

### Fix 2.4 — `_wait_for_cancel` instead of fixed sleep in TP retry

**Location**: [monitoring.py:1995-1996](backend/monitoring.py#L1995-L1996)
**Severity**: Low
**Type**: Robustness (consistency with Fix 1.2)

**Root cause**
Same pattern as the SL cancel-then-fresh paths fixed in Pass 1: a fixed `time.sleep(0.3)` after `_cancel_sl_orders` doesn't always cover broker settle time.

**Fix**
Replace fixed sleep with `_wait_for_cancel` polling per cancelled SL ID.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Wait after SL cancel in TP retry | Fixed 0.3s | Poll-until-cancelled (≤ 1.5s) |
| Risk of submitting TP while SL still open | Real on slow broker | Eliminated within 1.5s |
| Logging on cancel timeout | None | `[SL CANCEL WAIT] Timeout` |

---

### Fix 2.5 — Set `is_closing=True` in `_check_tp_order_filled`

**Location**: [monitoring.py:680-684](backend/monitoring.py#L680-L684)
**Severity**: Low
**Type**: Defensive ordering

**Root cause**
After detecting a TP fill, the function called `_cancel_sl_orders` but did **not** set `is_closing = True`. `_update_dynamic_thresholds` early-outs on `is_closing` at line 2030. Sequential flow in current monitors made this safe in practice — but any future caller racing into `_update_dynamic_thresholds` between TP fill and the caller's exit handling could attempt an SL placement on a position that's already closed at the broker.

**Fix**
Set `is_closing = True` **before** the SL cancel inside `_check_tp_order_filled`. Removes the latent race.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| `is_closing` after TP fill detection | False until caller enters `_cancel_exit_orders` | True immediately |
| `_update_dynamic_thresholds` post-TP-fill behavior | Could attempt SL placement (today: doesn't, due to sequential flow) | Hard early-out via `is_closing` guard |
| Latent race exposure | Yes — depends on caller ordering | Eliminated by invariant |

---

### Fix 2.6 — Reset SL tracking fields on `_cancel_sl_orders`

**Location**: [monitoring.py:1515-1530](backend/monitoring.py#L1515-L1530)
**Severity**: Low
**Type**: State hygiene

**Root cause**
`_cancel_sl_orders` cleared `sl_order_ids = []` but left `sl_last_placed_pct`, `confirmed_sl_price`, and `sl_replace_failed_ts` at their pre-cancel values. After `_attempt_place_tp_limit` cancelled the SL mid-life, the next SL placement attempt would gate on a stale `sl_last_placed_pct` that no longer corresponded to any live broker order.

**Fix**
Reset all three fields inside `_cancel_sl_orders` so any subsequent SL placement takes the fresh-placement path. Comment block explains why all three callers (`_check_tp_order_filled`, `_cancel_exit_orders`, `_attempt_place_tp_limit` retry) are safe with the reset.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| `sl_last_placed_pct` after SL cancel | Stale value persists | Reset to `None` → fresh path on next placement |
| `confirmed_sl_price` after SL cancel | Stale value persists | Reset to `None` |
| `sl_replace_failed_ts` after SL cancel | Stale failure window persists | Reset to `0.0` — next placement not throttled |
| Risk of mis-gating next replacement | Real on TP-retry SL-cancel path | Eliminated |

---

---

## Pass 3 — TP-not-filling / TP-not-available market-exit

Scope-limited per request: SL logic untouched. Only TP placement and TP-fill behavior modified.

### Fix 3.1 — Condition 10: TP limit at broker but not filling

**Location**: New fallback condition at [monitoring.py:1622-1655](backend/monitoring.py#L1622-L1655)
**Severity**: Enhancement (closes a previously-uncovered gap)
**Type**: Safety net

**Root cause / gap**
Two related TP-failure modes were unevenly covered:
- **Scenario A**: TP child exists at the broker, price reaches `tp_price`, but the limit doesn't fill — wide option spread, thin liquidity, or partial venue routing. Previous behavior: position holds at TP for an unbounded duration, with the QP ratchet eventually moving SL up. The TP-level profit was not actively captured.
- **Scenario B**: TP child never placed or was lost (held_for_orders / cancellation race) AND price reaches `tp_price`. Previous behavior: existing bracket-mode immediate backstop fires market exit at line 2638. This path was already correct.

Pass 3 adds an explicit guard for Scenario A.

**Fix**
New `Condition 10 — TP_LIMIT_NOT_FILLING_MARKET_EXIT` in `_detect_market_fallback_reason`:

- Fires when `tp_price > 0`, `tp_order_filled = False`, `tp_order_ids` is non-empty (TP child exists), and `sellable_price >= tp_price`.
- 2-second grace timer (`tp_not_filling_seen_ts`) — filters transient quote spikes where one ask print at TP immediately reverts.
- Placed **before** the `confirmed_sl_price` early-out so the guard fires when price is well above the SL.
- Grace timer resets when price retreats below TP, when TP fills, or when the TP child is cancelled.
- Independent from the existing Scenario-B immediate backstop at the bracket-mode block; both coexist.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Scenario A — TP child exists, not filling at TP | No active capture; position held until QP ratchet or SL fires | 2-second grace → forced market exit at TP-level price |
| Scenario B — no TP child, price ≥ TP | Immediate market exit (existing bracket backstop) | Unchanged — same immediate backstop fires |
| Worst-case "stuck at TP" duration | Unbounded (until reversal triggers QP/SL) | Bounded to 2 seconds |
| New log signal | None | `[FALLBACK TRIGGER] reason=TP_LIMIT_NOT_FILLING_MARKET_EXIT` with detail `tp_limit_not_filling:sellable=...:tp_price=...:tp_ids=...:waited=Xs` |
| Risk of double-cancel race when TP about to fill | N/A | TP cancel may race with broker fill; broker enforces qty so no double-sell. Caught by `_cancel_exit_orders` silent error swallow. |

### Fix 3.2 — TP placement try/catch hardening + explicit market-exit routing

**Location**: [monitoring.py:1976-2080](backend/monitoring.py#L1976-L2080), caller updates at [monitoring.py:2861-2870](backend/monitoring.py#L2861-L2870), [monitoring.py:3351-3360](backend/monitoring.py#L3351-L3360)
**Severity**: Enhancement
**Type**: Robustness + observability

**Root cause / gap**
`_attempt_place_tp_limit` previously returned `None` on failure, leaving the caller to fall through to the regular exit handler with `exit_reason = "TAKE_PROFIT_EXIT"`. The downstream market sell did happen — but the exit reason was misleading, since no TP fill ever occurred.

Additionally, several try/catch blocks could raise unhandled exceptions:
- The `_check_sl_order_filled` call inside the retry path (no surrounding try/catch).
- `_cancel_sl_orders` + `_wait_for_cancel` loop (no try/catch).

These would propagate exceptions out of the function, bypassing the failure-flag mechanism entirely.

**Fix**
- Added inner helper `_flag_unavailable(reason)` that sets `tp_placement_failed = True`, `tp_placement_failed_reason = <broker error>`, and `tp_placement_failed_ts = time.time()`.
- Every failure return path now calls `_flag_unavailable` before returning None: first-attempt non-held error, no-order-id from broker on either attempt, retry-already-attempted gate, retry-block exception.
- SL pre-check, cancel, and wait-for-cancel are each wrapped in their own try/catch with continue-on-error semantics. A pre-check exception logs and proceeds with the retry rather than aborting silently.
- Successful placement (verified order id) clears `tp_placement_failed = False`.
- **Caller sides** (`monitor_with_polling` line 2861, `monitor_with_websocket` line 3351): when `_attempt_place_tp_limit` returns None and `tp_placement_failed = True`, override `exit_reason` to `TP_PLACEMENT_FAILED_MARKET_EXIT` and let the standard exit-reason fall-through proceed. The downstream market sell carries the explicit reason.

**Before / after impact**

| Aspect | Before | After |
|---|---|---|
| Exit reason when TP placement fails | `TAKE_PROFIT_EXIT` (misleading — no TP fill happened) | `TP_PLACEMENT_FAILED_MARKET_EXIT` (explicit) |
| Audit trail / log clarity | Difficult to distinguish "TP limit filled" from "TP placement failed → market exit" | Clear separation in logs and exit_reason |
| Broker `tp_placement_failed_reason` retention | Lost (just logged) | Stored on exit_state, available to UI/registry |
| SL pre-check exception during TP retry | Propagates out of function | Caught, logged, retry proceeds |
| `_cancel_sl_orders` / `_wait_for_cancel` exception | Propagates out of function | Caught, logged, retry placement still attempted |
| `tp_placement_failed` flag reset | Never set, never reset | Set on every failure path, cleared on every successful placement |
| New log signals | None | `[TP LIMIT] Broker returned no order id ... — flagging unavailable`, `[TP LIMIT] Retry returned no order id ... — flagging unavailable`, `[TP LIMIT] Retry also failed ... — flagging unavailable, caller will market-exit`, `[TP LIMIT] SL fill pre-check failed ... — proceeding with retry`, `[TP LIMIT] SL cancel/wait failed ... — proceeding with retry`, `TP_PLACEMENT_FAILED_MARKET_EXIT - TP limit unavailable ... falling through to market exit` |

### Combined behavior of Pass 3

| User scenario | Coverage path | Latency to market exit |
|---|---|---|
| TP limit at broker, price reaches TP, not filling | Condition 10 | 2 seconds (grace) |
| TP limit fails to be placed by `_attempt_place_tp_limit` (non-held broker error) | First-attempt try/catch → `_flag_unavailable` → caller routes to `TP_PLACEMENT_FAILED_MARKET_EXIT` | Immediate (same tick) |
| TP limit fails to be placed after held_for_orders retry | Second-attempt try/catch → `_flag_unavailable` → caller routes to `TP_PLACEMENT_FAILED_MARKET_EXIT` | Immediate (same tick) |
| Bracket TP child never created or cancelled, price reaches TP | Existing bracket-mode immediate backstop (Scenario B) | Immediate (same tick) |
| TP limit fills normally at the broker | `_check_tp_order_filled` returns True | N/A (limit fill, no market exit) |

---

## Documentation sync

**Location**: [CLAUDE.md](CLAUDE.md)

The CLAUDE.md authoritative spec was updated to match current code:
- "Stop-limit" wording corrected to "stop-market" — `StopOrderRequest` is the actual replacement order type, not `StopLimitOrderRequest`.
- Replacement chain rewritten to reflect the actual error-dispatch order, the verification gate, and the new throttle.
- Fallback conditions section expanded from 5 to **9** documented conditions (Conditions 6, 7, 8 were referenced in code but undocumented; Condition 9 is new from Fix 1.5).
- Invariants updated to reflect: verified-only `sl_last_placed_pct` advancement, TP-preserving `held_for_orders` handling, and `_wait_for_cancel` replacing fixed sleeps.

---

## Aggregate impact summary

| Failure mode | Before | After |
|---|---|---|
| Stale broker stop accepted as ratchet | Within 0.02 tolerance ✅ accepted | Only within 0.005 tolerance accepted |
| Cancel-then-fresh races into 40310000 | Real on slow broker | Eliminated within 1.5s wait |
| TP cancelled by held_for_orders | Yes — market exit fallback | TP preserved |
| Sustained verification failure | Up to 12 retries/min, each ~1s blocking | Throttled to ≤ 1/sec |
| 42210000 indefinite retry | No upper bound | 30s deadline → market exit |
| TP fill with no `filled_avg_price` | Monitor crash post state-mutation | Logs `unknown`, returns True |
| Partial bracket leg seeding | TP child untracked indefinitely | Both-legs gate + re-seed-allowed |
| Fallback-detector early-out before first replace | Disabled (no `confirmed_sl_price`) | Active from tick zero |
| SL fill during TP-retry window | Silently lost | Detected; retry bails |
| `is_closing` race after TP fill | Latent | Eliminated |
| Stale `sl_last_placed_pct` after SL cancel | Persists | Reset on cancel |
| TP at broker, price ≥ TP, not filling | No bound — held until QP/SL fires | 2-second grace → market exit |
| TP placement failure exit reason | Misleading `TAKE_PROFIT_EXIT` | Explicit `TP_PLACEMENT_FAILED_MARKET_EXIT` |
| TP retry inner exceptions (SL fill check, cancel, wait) | Could propagate and bypass failure-flag | Each in own try/catch; flag always set |

## Files changed

- `backend/monitoring.py` — all 11 code fixes
- `CLAUDE.md` — documentation sync

## Recommended paper-trading verification

1. **Run a multi-position paper session.** Watch `logs/trade.log` for:
   - `[SL VERIFY] match=False` — should be rare; sustained appearance means broker is reporting stale prices.
   - `[SL CANCEL WAIT] Timeout` — cancel didn't propagate within 1.5s; investigate broker latency.
   - `{"operation": "throttled"}` returns from `_place_sl_stop_order` — should appear only after a verification failure within the last 1s.
   - `[CRITICAL] Position not ready ... escalating` — should NEVER appear in normal paper trading; if it does, capture surrounding 30s of logs.
   - `[FALLBACK TRIGGER] reason=POSITION_NOT_READY_TIMEOUT_MARKET_EXIT` — Condition 9 firing.
   - `[FALLBACK TRIGGER] reason=TP_LIMIT_NOT_FILLING_MARKET_EXIT` — Condition 10 firing (TP at broker, price ≥ TP, not filling within 2s).
   - `[TP] Order ... filled at unknown` — Fix 2.1 saved the loop on a `filled_avg_price`-missing edge case.
   - `[TP LIMIT] SL filled at broker during TP retry window` — Fix 2.3 caught the race.
   - `[TP LIMIT] ... — flagging unavailable, caller will market-exit` — Fix 3.2 fired; TP placement failed.
   - `TP_PLACEMENT_FAILED_MARKET_EXIT` exit reason — Fix 3.2 routed to market exit explicitly.
   - `[BRACKET] Seeded parent=... tp=1 sl=1` — both legs captured (the common case).

2. **Verify QP ratchet** by letting a position move through several `$0.01` profit increments. Each tick should show:
   - `sl_dynamic_pct` advancing
   - `sl_last_placed_pct` advancing **only** on verified placements
   - `confirmed_sl_price` matching broker stop_price within 0.005

3. **Force-test `held_for_orders`** if possible (would require a broker setup that hits this path). Confirm the bracket TP child is preserved through SL cancel-and-replace.

## Known limitations / not fixed

- `qp_arm_*` snapshot fields reset on every loss-mode entry ([monitoring.py:2103-2104](backend/monitoring.py#L2103-L2104)) — design choice, leaves UI-displayed "QP first armed at" timestamp transient if price oscillates around fill.
- Dead bracket-mode block at [monitoring.py:3251-3269](backend/monitoring.py#L3251-L3269) in `monitor_with_websocket` — unreachable due to early return at [monitoring.py:3134](backend/monitoring.py#L3134); pure cleanup, no behavior change.
- `_SL_PLACEMENT_LOCK` is module-level — serializes SL placements across all positions in the same process. Bottleneck if multi-symbol concurrent monitoring is ever added; not an issue under current single-symbol-per-process design.
- `_verify_sl_order` blocks the monitor thread up to 3 × 0.35s = 1.05s on retries. Throttle (Fix 1.4) bounds the storm but each individual call still blocks. Acceptable tradeoff for verification correctness.
