# Cape — Bug Fixes · 2026-05-22

---

## 1. Backend — 42210000 "position intent mismatch" profit-zone cancel+fresh fix
**File:** `backend/monitoring.py`

### Problem
`replace_order_by_id` always fails with Alpaca error 42210000 ("position intent mismatch") when
`stop_price > fill_price` (i.e. the new SL is in profit territory). This caused the SL ratchet to
stall: every tick retried the same replace, got 42210000 again, and `sl_last_placed_pct` never
advanced. The broker SL stayed at the initial loss level while `sl_dynamic_pct` ratcheted up,
leaving confirmed profit-zone protection unenforceable.

Observed in May 21 log: Trade 1 had 10x 42210000 errors in 34 seconds, SL never moved above
fill price → exited via Condition 3 (triggered-not-filled) at only +0.59% instead of the +2.82%
peak. Trade 2 had 4x 42210000 errors, SL unconfirmed in profit zone → exited at −3.25%.

### Fix
When `is_intent_mismatch` and `sl_dynamic_pct > 0` (profit zone), cancel the existing SL order
and clear `sl_order_ids`. The next tick will place a fresh `StopOrderRequest` (instead of
retrying `replace_order_by_id`) at the profit-level stop price. Bounded at 2 cancel+fresh
attempts before falling back to plain retry to avoid an infinite cancel loop.

Counter `sl_42_cancel_attempts` resets to 0 on any successful SL placement.

**Key code added** inside `_place_sl_stop_order` → `is_intent_mismatch` branch:
```python
if existing_id and sl_dynamic_pct > 0:
    _cf_count = int(exit_state.get("sl_42_cancel_attempts", 0))
    if _cf_count < 2:
        exit_state["sl_42_cancel_attempts"] = _cf_count + 1
        tc.cancel_order_by_id(existing_id)
        exit_state["sl_order_ids"] = []
        # next tick: fresh StopOrderRequest at stop_price
    else:
        exit_state["sl_42_cancel_attempts"] = 0
        # revert to plain retry
```

Counter reset added to success path:
```python
exit_state["sl_42_cancel_attempts"] = 0
```

### Log markers to watch
- `[SL STOP] 42210000 profit-zone cancel: <id> cancelled — fresh stop at <price> queued for next tick (attempt N/2)`
- `[SL STOP] 42210000 cancel+fresh exhausted for <symbol> — reverting to plain retry`

---

## 2. Backend — Clamp regression fix
**File:** `backend/monitoring.py` · `_place_sl_stop_order`

### Problem
When price drops fast and the clamp fires (`stop_price = current_price − $0.05`), the clamped
stop can land BELOW the already-confirmed broker SL (`confirmed_sl_price`). Placing this would
downgrade the stop, contradicting the "SL only moves up" invariant and potentially creating a
looser stop than what the broker already holds.

### Fix
Before replacing, check: if `stop_price < confirmed_sl_price`, skip the replacement entirely.

```python
_confirmed_sl = float(exit_state.get("confirmed_sl_price") or 0.0)
if _confirmed_sl > 0.0 and stop_price < _confirmed_sl:
    return {"operation": "no_change", "reason": "clamped_below_confirmed"}
```

Verified working in May 21 log: `confirmed_sl_price` moved strictly forward ($6.54 → $6.55),
never backwards.

---

## 3. Frontend — Page scroll reset every 5 seconds
**File:** `Frontend/src/pages/OverallSummary.jsx`

### Problem
Every 5 seconds, `fetchHistory(true)` called `setAitTrades(all)`, `setManualTrades(manual)`,
`setPositions(rows)` unconditionally — always creating new array references. React re-rendered
the component on every poll even when data was identical. This reset the scroll position of the
inner trade-cards scroll container, forcing users to re-scroll to their reading position.

Secondary bug: on a failed background poll, `setAitTrades([])` and `setManualTrades([])` were
called — wiping all displayed trade data.

### Fixes applied

**a) Smart setState comparison** — skip re-render when data unchanged:
```javascript
setAitTrades(prev =>
  prev.length === all.length && JSON.stringify(prev) === JSON.stringify(all) ? prev : all
)
```
Same pattern applied to `setManualTrades`, `setPositions`, and `setLivePositions`.

**b) No data wipe on failed background poll:**
```javascript
} else if (!silent) {
  setAitTrades([])   // only on explicit (non-background) failure
}
```

**c) Scroll pause during background polls** — when user has scrolled and a background poll
arrives, skip list setState calls entirely:
```javascript
const skipListUpdates = silent && userScrolledRef.current
```
`userScrolledRef` is set by a passive `window` scroll listener (`scrollY > 300`).

**d) Inner scroll position save/restore** — added `ref` + `onScroll` handler to the trade cards
div to capture `scrollTop`. `useLayoutEffect` restores it synchronously after every `sorted`
re-render, so the position never jumps even when data genuinely changes:
```javascript
useLayoutEffect(() => {
  if (tradeCardsRef.current) {
    tradeCardsRef.current.scrollTop = tradeCardsScrollRef.current
  }
}, [sorted])
```
