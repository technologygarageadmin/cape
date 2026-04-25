"""
Unit tests for the QP replacement failure guard (Condition 5) in
_detect_market_fallback_reason (monitoring.py).

No live broker, running server, or MongoDB connection is needed.
All heavy dependencies are stubbed before importing monitoring.
"""
import os
import sys
import time
import types
import unittest
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Stub every module that monitoring.py imports at the top level so we can
# import the module without an Alpaca key, Mongo, or any external service.
# ---------------------------------------------------------------------------
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


def _stub(name: str) -> MagicMock:
    m = MagicMock()
    sys.modules[name] = m
    return m


# alpaca sub-package hierarchy must be registered individually
for _mod in [
    "alpaca",
    "alpaca.data",
    "alpaca.data.historical",
    "alpaca.trading",
    "alpaca.trading.requests",
    "alpaca.trading.enums",
]:
    _stub(_mod)

for _mod in ["alpaca_helpers", "config", "logger", "order_execution", "rsi_analyer"]:
    _stub(_mod)

# config attributes accessed at monitoring module level must exist so that
# "from config import X" binds a real name (even if it's a MagicMock).
_config = sys.modules["config"]
for _attr in [
    "API_KEY", "SECRET_KEY", "SYMBOL",
    "CAPE_MAX_TIGHTEN_PCT", "CAPE_QP_OFFSET", "CAPE_TRAILING_SL_OFFSET",
    "EXIT_BRACKET_QP_ENABLED", "EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE",
    "EXIT_BAD_ENTRY_ENABLED", "EXIT_BAD_ENTRY_EXIT_THRESHOLD_PCT",
    "EXIT_BAD_ENTRY_MAX_PEAK_PCT", "EXIT_BAD_ENTRY_WINDOW_SEC",
    "EXIT_MAX_HOLD_ENABLED", "EXIT_MAX_HOLD_SEC", "EXIT_MAX_HOLD_PNL_THRESHOLD_PCT",
    "EXIT_MOMENTUM_STALL_ENABLED", "EXIT_MOMENTUM_STALL_MIN_AGE_SEC",
    "EXIT_MOMENTUM_STALL_PNL_THRESHOLD_PCT", "EXIT_SAME_CANDLE_MIN_PNL_PCT",
    "EXIT_SAME_CANDLE_USE_BID_PRICE", "EXIT_RSI_OPPOSITE_CROSS_ENABLED",
    "EXIT_TAKE_PROFIT_ENABLED", "EXIT_TRAILING_STOP_ENABLED",
    "EXIT_STOP_LOSS_ENABLED", "EXIT_TAKE_PROFIT_MODE", "EXIT_STOP_LOSS_MODE",
    "PRICE_POLL_SEC", "QP_GAP_PCT", "RSI_EXIT_CHECK_SEC",
    "SL_STOP_LIMIT_BUFFER_PCT", "SL_STOP_ORDERS_ENABLED",
    "TRAILING_MIN_PEAK_PCT", "TRAILING_SL_STOP_ORDERS_ENABLED",
    "WS_MAX_WAIT_SEC", "WS_ORDER_CHECK_SEC",
]:
    setattr(_config, _attr, MagicMock())

# Now it is safe to import the function under test.
from monitoring import _detect_market_fallback_reason  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tc():
    """A minimal trading-client mock.  get_order_by_id raises so that the SL
    order loop exits quickly when sl_order_ids is empty (default)."""
    return MagicMock()


def _base_state(**overrides) -> dict:
    """Exit state where QP has ratcheted to +49 % but broker SL is at +30 %."""
    state = {
        "fill_price": 1.00,
        "sl_dynamic_pct": 49.0,
        "sl_last_placed_pct": 30.0,
        "sl_broker_disabled": False,
        "sl_order_ids": [],      # empty → broker-fetch loop is skipped
        "is_closing": False,
    }
    state.update(overrides)
    return state


def _qp_trigger(state: dict) -> float:
    """Compute the price at which the QP guard should fire."""
    return float(state["fill_price"]) * (1.0 + float(state["sl_dynamic_pct"]) / 100.0)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestQPGuardFirstTick(unittest.TestCase):

    def test_no_fire_sets_timer(self):
        """First tick at QP trigger: returns (None, None) and seeds the timer."""
        state = _base_state()
        reason, detail = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)
        self.assertIsNone(detail)
        self.assertIn("qp_guard_trigger_seen_ts", state,
                      "Timer should be seeded on first in-trigger tick")

    def test_timer_value_is_recent(self):
        """Seeded timer should be close to now."""
        state = _base_state()
        before = time.time()
        _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        after = time.time()
        ts = state.get("qp_guard_trigger_seen_ts", 0)
        self.assertGreaterEqual(ts, before)
        self.assertLessEqual(ts, after)


class TestQPGuardFires(unittest.TestCase):

    def test_fires_after_grace_period(self):
        """Pre-seeded timer 3 s ago: guard fires with correct reason."""
        state = _base_state()
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, detail = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertEqual(reason, "QP_SL_REPLACE_FAILED_MARKET_EXIT")
        self.assertIn("qp_sl_not_replaced", detail)

    def test_detail_contains_key_fields(self):
        """Detail string must include sellable price, trigger, and pct values."""
        state = _base_state()
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        _, detail = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        for keyword in ("sellable=", "qp_trigger=", "sl_dynamic=", "sl_last_placed=", "waited="):
            self.assertIn(keyword, detail, f"Expected '{keyword}' in detail: {detail}")

    def test_does_not_fire_within_grace_period(self):
        """Timer 1 s old: guard sees the timer but does not fire yet."""
        state = _base_state()
        state["qp_guard_trigger_seen_ts"] = time.time() - 1.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)

    def test_partial_ratchet_fires(self):
        """Partial replacement (+10 % placed, +30 % failed): fires at +30 % trigger."""
        state = _base_state(
            fill_price=2.00,
            sl_dynamic_pct=30.0,
            sl_last_placed_pct=10.0,
        )
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        trigger = _qp_trigger(state)            # 2.00 * 1.30 = 2.60
        reason, detail = _detect_market_fallback_reason(_tc(), state, trigger)
        self.assertEqual(reason, "QP_SL_REPLACE_FAILED_MARKET_EXIT")


class TestQPGuardTimerResets(unittest.TestCase):

    def test_timer_clears_when_price_recovers(self):
        """Price rises above QP trigger: timer is removed from exit_state."""
        state = _base_state()
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        above_trigger = _qp_trigger(state) + 0.01
        reason, _ = _detect_market_fallback_reason(_tc(), state, above_trigger)
        self.assertIsNone(reason)
        self.assertNotIn("qp_guard_trigger_seen_ts", state,
                         "Timer must be cleared when price recovers")

    def test_timer_clears_when_broker_sl_catches_up(self):
        """sl_last_placed_pct == sl_dynamic_pct: gap closed, timer cleared."""
        state = _base_state(sl_last_placed_pct=49.0)  # caught up
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)
        self.assertNotIn("qp_guard_trigger_seen_ts", state,
                         "Timer must be cleared when broker SL catches up")

    def test_timer_clears_when_broker_sl_ahead(self):
        """sl_last_placed_pct > sl_dynamic_pct: no gap, timer cleared."""
        state = _base_state(sl_last_placed_pct=55.0)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)
        self.assertNotIn("qp_guard_trigger_seen_ts", state)


class TestQPGuardDisabled(unittest.TestCase):

    def test_no_fire_when_sl_broker_disabled(self):
        """sl_broker_disabled=True: entire guard block skipped."""
        state = _base_state(sl_broker_disabled=True)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)

    def test_no_fire_when_sl_dynamic_not_in_profit(self):
        """sl_dynamic_pct <= 0: QP not ratcheted into profit, guard inactive."""
        state = _base_state(sl_dynamic_pct=-50.0, sl_last_placed_pct=-50.0)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, 0.50)
        self.assertIsNone(reason)

    def test_no_fire_when_sl_dynamic_zero(self):
        """sl_dynamic_pct == 0.0: boundary — guard should not fire."""
        state = _base_state(sl_dynamic_pct=0.0, sl_last_placed_pct=0.0)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, 1.00)
        self.assertIsNone(reason)

    def test_no_fire_when_sl_last_placed_is_none(self):
        """sl_last_placed_pct=None: no broker SL ever placed, guard skipped."""
        state = _base_state(sl_last_placed_pct=None)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)

    def test_no_fire_when_fill_price_zero(self):
        """fill_price=0: cannot compute trigger, guard inactive."""
        state = _base_state(fill_price=0.0)
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, 0.0)
        self.assertIsNone(reason)

    def test_no_fire_when_tc_is_none(self):
        """tc=None triggers early return before the guard is even reached."""
        state = _base_state()
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(None, state, _qp_trigger(state))
        self.assertIsNone(reason)

    def test_no_fire_when_is_closing(self):
        """is_closing=True triggers early return before the guard is reached."""
        state = _base_state()
        state["is_closing"] = True
        state["qp_guard_trigger_seen_ts"] = time.time() - 3.0
        reason, _ = _detect_market_fallback_reason(_tc(), state, _qp_trigger(state))
        self.assertIsNone(reason)

    def test_no_timer_set_when_price_above_trigger(self):
        """Price above trigger on fresh state: no timer seeded at all."""
        state = _base_state()
        above_trigger = _qp_trigger(state) + 0.01
        _detect_market_fallback_reason(_tc(), state, above_trigger)
        self.assertNotIn("qp_guard_trigger_seen_ts", state)


if __name__ == "__main__":
    unittest.main(verbosity=2)
