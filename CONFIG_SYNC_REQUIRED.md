# Config Sync Required on the Trading Machine

`backend/config.py` is **gitignored** — `git pull` does NOT update it. The values
below must be set by hand in `backend/config.py` on the machine that runs the bot,
then the backend restarted. Verify afterwards (see bottom).

Incident this addresses (2026-07-06 paper test): the trading machine ran with the
old `"price"` exit mode (+$0.25 / −$0.50 flat). On $3.40 SPY contracts −$0.50 is a
−15% stop, so a wrong-direction position sat at −3% for 15+ minutes with the stop
far out of reach and max-hold disabled — it had to be liquidated manually.

## Values to set (Strategy V3 + staged loss cut)

```python
# ─── Basic Exit Levels ───
TAKE_PROFIT_PCT = 0.08            # +8% of fill
STOP_LOSS_PCT = 0.04              # −4% of fill

EXIT_TAKE_PROFIT_MODE = "pct"     # was "price"
EXIT_STOP_LOSS_MODE = "pct"       # was "price"

# ─── Max Hold Time ───
EXIT_MAX_HOLD_ENABLED = True      # was False
EXIT_MAX_HOLD_SEC = 300
EXIT_MAX_HOLD_PNL_THRESHOLD_PCT = 1.0

# ─── Staged Loss Cut (new constants — add if missing) ───
EXIT_LOSS_CUT_ENABLED = True
EXIT_LOSS_CUT_PNL_PCT = -2.0
EXIT_LOSS_CUT_HOLD_SEC = 120

# ─── QP Tier 1 lock (was 0.0 = breakeven — DEAD: the buffer-zone guard
#     reverts any SL candidate in [0, 0.20], so Tier 1 never moved the stop) ───
QP_TIER_1_LOCK_PCT = 0.5
```

The new `EXIT_LOSS_CUT_*` constants are **required** — `monitoring.py` imports them
at module load and the backend will not start without them.

## Verify after restart

```powershell
cd backend
python -c "import config; print(config.EXIT_STOP_LOSS_MODE, config.EXIT_STOP_LOSS_VALUE, config.EXIT_MAX_HOLD_ENABLED, config.EXIT_LOSS_CUT_ENABLED)"
# expected: pct 0.04 True True
```

In `monitoring_debug.log`, a new entry should show `sl=-4.00%` (e.g. a $3.34 fill
gets `sl_price=3.2064`), not `sl=-14.97%`.

## Expected exit behavior for a wrong-direction position

1. **−4% broker stop** — primary exit, enforced at the venue.
2. **Staged loss cut** — PnL at/below −2% continuously for 120s → market exit
   (`LOSS_CUT_TIME_EXIT`). Timer resets if PnL recovers above −2%.
3. **Max hold** — any position below +1% PnL after 300s → market exit
   (`MAX_HOLD_TIME_EXIT`). Now also fires for negative PnL (previously 0..+1% only).
