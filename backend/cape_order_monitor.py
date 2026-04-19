"""
Cape Order Monitor
==================

Integration layer that monitors prices and executes orders using CapeOrderManager.
This replaces or enhances the existing monitoring loops for manual trades (MT) and
automated trades (AIT).

Usage:
    monitor = CapeOrderMonitor(trading_client, order_manager, order_executor)
    monitor.start_monitoring(buy_order_id, contract_symbol, qty, ep, tp, sl)
"""

import time
import threading
import queue
from datetime import datetime, timezone
from typing import Optional, Callable

from alpaca.data.live import CryptoDataStream, StockDataStream
from logger import debug, info
from cape_order_manager import CapeOrderManager, CapeOrderState
from cape_order_executor import CapeOrderExecutor


class CapeOrderMonitor:
    """Monitors price updates and manages order execution."""
    
    def __init__(
        self,
        trading_client,
        order_manager: CapeOrderManager,
        order_executor: CapeOrderExecutor,
        on_exit_callback: Optional[Callable] = None,
    ):
        """
        Initialize monitor.
        
        Args:
            trading_client: Alpaca trading client
            order_manager: CapeOrderManager instance
            order_executor: CapeOrderExecutor instance
            on_exit_callback: Function to call when position exits
                            Signature: on_exit_callback(buy_order_id, exit_reason, exit_price)
        """
        self.trading_client = trading_client
        self.order_manager = order_manager
        self.order_executor = order_executor
        self.on_exit_callback = on_exit_callback
        
        self._monitors: dict[str, dict] = {}
        self._monitor_lock = threading.Lock()
        self._price_queues: dict[str, queue.Queue] = {}
        self._ws_stop_events: dict[str, threading.Event] = {}
    
    def register_position(
        self,
        buy_order_id: str,
        symbol: str,
        contract_symbol: str,
        qty: int,
        ep: float,
        tp: float,
        sl: float,
    ) -> None:
        """Register a new position for monitoring."""
        self.order_manager.register_position(
            buy_order_id,
            symbol,
            contract_symbol,
            qty,
            ep,
        )
        
        # Place bracket orders (TP + SL)
        tp_order_id = self.order_executor.place_sell_limit(
            buy_order_id,
            contract_symbol,
            qty,
            tp,
        )
        sl_order_id = self.order_executor.place_sell_stop_limit(
            buy_order_id,
            contract_symbol,
            qty,
            sl,
            sl * (1 - 0.05),  # 5% buffer
        )
        
        if tp_order_id:
            self.order_manager.mark_order_placed(buy_order_id, 'TP_LIMIT', tp_order_id)
        if sl_order_id:
            self.order_manager.mark_order_placed(buy_order_id, 'SL_LIMIT', sl_order_id)
        
        with self._monitor_lock:
            self._monitors[buy_order_id] = {
                "buy_order_id": buy_order_id,
                "symbol": symbol,
                "contract_symbol": contract_symbol,
                "qty": qty,
                "ep": ep,
                "monitoring": True,
                "start_time": datetime.now(timezone.utc),
            }
            self._price_queues[buy_order_id] = queue.Queue()
            self._ws_stop_events[buy_order_id] = threading.Event()
        
        info(f"[CapeOrderMonitor] Registered {buy_order_id} for monitoring")
    
    def update_price(
        self,
        buy_order_id: str,
        current_price: float,
    ) -> None:
        """
        Update price for a monitored position.
        This should be called on every price tick from websocket or polling.
        """
        if buy_order_id not in self._monitors:
            return
        
        # Add to queue for async processing
        if buy_order_id in self._price_queues:
            try:
                self._price_queues[buy_order_id].put_nowait(current_price)
            except queue.Full:
                pass  # Skip if queue is full
    
    def start_monitoring_thread(self, buy_order_id: str) -> threading.Thread:
        """Start the monitoring thread for a position."""
        thread = threading.Thread(
            target=self._monitoring_loop,
            args=(buy_order_id,),
            daemon=True,
        )
        thread.start()
        return thread
    
    def _monitoring_loop(self, buy_order_id: str) -> None:
        """
        Main monitoring loop: process price updates and execute orders.
        Runs in dedicated thread per position.
        """
        if buy_order_id not in self._monitors:
            return
        
        monitor = self._monitors[buy_order_id]
        price_queue = self._price_queues[buy_order_id]
        stop_event = self._ws_stop_events[buy_order_id]
        
        last_update_time = time.time()
        order_update_interval = 1.0  # Update orders every second
        
        info(f"[CapeOrderMonitor] Started monitoring loop for {buy_order_id}")
        
        while monitor["monitoring"] and not stop_event.is_set():
            try:
                # Get latest price from queue (non-blocking)
                try:
                    current_price = price_queue.get_nowait()
                except queue.Empty:
                    current_price = None
                
                # If we got a price, process it
                if current_price and current_price > 0:
                    self._process_price_update(
                        buy_order_id,
                        current_price,
                        order_update_interval,
                    )
                
                time.sleep(0.1)  # Light polling
            
            except Exception as ex:
                info(f"[CapeOrderMonitor] Error in monitoring loop {buy_order_id}: {ex}")
                time.sleep(1)
        
        # Cleanup
        self._cleanup_position(buy_order_id)
        info(f"[CapeOrderMonitor] Stopped monitoring loop for {buy_order_id}")
    
    def _process_price_update(
        self,
        buy_order_id: str,
        current_price: float,
        update_interval: float,
    ) -> None:
        """Process a price update and execute order changes if needed."""
        state = self.order_manager.get_state(buy_order_id)
        if not state or state.is_closed:
            return
        
        monitor = self._monitors.get(buy_order_id)
        if not monitor:
            return
        
        # Update price in manager (calculates new SL/TP/QP)
        changes = self.order_manager.update_price(buy_order_id, current_price)
        
        # Check for exit conditions
        if self._check_exit_conditions(buy_order_id, state, current_price):
            return  # Position already closed
        
        # Execute order changes (cancel old, place new)
        if changes and (changes.get('orders_to_cancel') or changes.get('orders_to_place')):
            result = self.order_executor.execute_order_changes(
                buy_order_id,
                monitor['contract_symbol'],
                monitor['qty'],
                changes,
            )
            if result['placed'] or result['cancelled']:
                info(f"[CapeOrderMonitor] Order changes {buy_order_id}: {result}")
    
    def _check_exit_conditions(
        self,
        buy_order_id: str,
        state: CapeOrderState,
        current_price: float,
    ) -> bool:
        """
        Check if any exit condition is met.
        Returns True if position was closed, False otherwise.
        """
        monitor = self._monitors.get(buy_order_id)
        if not monitor:
            return False
        
        # Check TP hit
        if current_price >= state.current_tp:
            self._execute_exit(
                buy_order_id,
                "TP_HIT",
                current_price,
            )
            return True
        
        # Check SL hit
        if current_price <= state.current_sl:
            self._execute_exit(
                buy_order_id,
                "SL_HIT",
                current_price,
            )
            return True
        
        # Check QP hit (in PROFIT MODE)
        if state.qp_value and current_price <= state.qp_value:
            self._execute_exit(
                buy_order_id,
                "QP_HIT",
                current_price,
            )
            return True
        
        # Check for gap (price moved past SL too fast to execute)
        gap_pct = abs(state.current_price - current_price) / state.ep * 100
        if gap_pct > 0.5 and current_price < state.current_sl:  # 0.5% gap threshold
            self._execute_exit(
                buy_order_id,
                "GAP_FORCED",
                current_price,
            )
            return True
        
        return False
    
    def _execute_exit(
        self,
        buy_order_id: str,
        exit_reason: str,
        exit_price: Optional[float] = None,
    ) -> None:
        """Execute position exit."""
        monitor = self._monitors.get(buy_order_id)
        if not monitor:
            return
        
        # Place emergency market sell order if exit_price provided
        if exit_price:
            order_id = self.order_executor.place_sell_market(
                buy_order_id,
                monitor['contract_symbol'],
                monitor['qty'],
            )
            if order_id:
                info(f"[CapeOrderMonitor] Placed exit market order {buy_order_id} → {order_id}")
        
        # Mark position as closed in manager
        self.order_manager.mark_closed(buy_order_id, exit_reason, exit_price)
        
        # Update monitor state
        with self._monitor_lock:
            if buy_order_id in self._monitors:
                self._monitors[buy_order_id]["monitoring"] = False
                self._monitors[buy_order_id]["exit_reason"] = exit_reason
                self._monitors[buy_order_id]["exit_time"] = datetime.now(timezone.utc)
        
        # Trigger callback
        if self.on_exit_callback:
            try:
                self.on_exit_callback(buy_order_id, exit_reason, exit_price)
            except Exception as ex:
                info(f"[CapeOrderMonitor] Callback error: {ex}")
        
        info(f"[CapeOrderMonitor] Position closed: {buy_order_id} reason={exit_reason}")
    
    def _cleanup_position(self, buy_order_id: str) -> None:
        """Clean up monitoring resources for a position."""
        with self._monitor_lock:
            if buy_order_id in self._price_queues:
                del self._price_queues[buy_order_id]
            if buy_order_id in self._ws_stop_events:
                del self._ws_stop_events[buy_order_id]
            # Keep monitor record for audit trail
    
    def stop_monitoring(self, buy_order_id: str) -> None:
        """Stop monitoring a position."""
        if buy_order_id in self._ws_stop_events:
            self._ws_stop_events[buy_order_id].set()
        
        with self._monitor_lock:
            if buy_order_id in self._monitors:
                self._monitors[buy_order_id]["monitoring"] = False
    
    def get_position_summary(self, buy_order_id: str) -> Optional[dict]:
        """Get summary of monitored position."""
        state = self.order_manager.get_state(buy_order_id)
        monitor = self._monitors.get(buy_order_id)
        
        if not state or not monitor:
            return None
        
        return {
            "buy_order_id": buy_order_id,
            "symbol": monitor['symbol'],
            "qty": monitor['qty'],
            "entry_price": state.ep,
            "current_price": state.current_price,
            "pnl_pct": state.pnl_pct,
            "max_pnl_pct": state.max_pnl_pct,
            "tp": state.current_tp,
            "sl": state.current_sl,
            "qp": state.qp_value,
            "mode": "PROFIT" if state.is_in_profit else "LOSS",
            "is_closed": state.is_closed,
            "exit_reason": state.exit_reason,
        }
    
    def get_all_positions(self) -> list[dict]:
        """Get summary of all monitored positions."""
        results = []
        with self._monitor_lock:
            for buy_order_id in list(self._monitors.keys()):
                summary = self.get_position_summary(buy_order_id)
                if summary:
                    results.append(summary)
        return results
