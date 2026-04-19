"""
Cape Order Executor
===================

Handles actual Alpaca order placement, cancellation, and updates
based on CapeOrderManager state changes.
"""

import threading
from typing import Optional
from alpaca.trading.requests import (
    LimitOrderRequest,
    StopLimitOrderRequest,
    MarketOrderRequest,
)
from alpaca.trading.enums import OrderSide, TimeInForce
from logger import debug, info


class CapeOrderExecutor:
    """Executes orders on Alpaca based on manager decisions."""
    
    def __init__(self, trading_client):
        """Initialize with Alpaca trading client."""
        self.trading_client = trading_client
        self._lock = threading.Lock()
        self._placed_orders: dict[str, dict] = {}  # track by buy_order_id
    
    def place_buy_limit(
        self,
        buy_order_id: str,
        symbol: str,
        qty: int,
        limit_price: float,
        time_in_force: str = "day",
    ) -> Optional[str]:
        """
        Place BUY LIMIT order at entry price.
        
        Returns order ID if successful, None otherwise.
        """
        if not self.trading_client:
            debug("[CapeOrderExecutor] No trading client available")
            return None
        
        try:
            request = LimitOrderRequest(
                symbol=symbol,
                qty=qty,
                side=OrderSide.BUY,
                time_in_force=TimeInForce[time_in_force.upper()],
                limit_price=round(limit_price, 4),
            )
            order = self.trading_client.submit_order(request)
            order_id = str(order.id)
            
            with self._lock:
                self._placed_orders[buy_order_id] = {
                    "buy_order_id": buy_order_id,
                    "symbol": symbol,
                    "order_id": order_id,
                    "type": "BUY_LIMIT",
                    "qty": qty,
                    "limit_price": limit_price,
                }
            
            info(f"[CapeOrderExecutor] Placed BUY LIMIT {buy_order_id} → {order_id} @ ${limit_price}")
            return order_id
        except Exception as ex:
            info(f"[CapeOrderExecutor] Failed to place BUY LIMIT: {ex}")
            return None
    
    def place_sell_limit(
        self,
        buy_order_id: str,
        symbol: str,
        qty: int,
        limit_price: float,
        time_in_force: str = "day",
    ) -> Optional[str]:
        """Place SELL LIMIT order (for take-profit)."""
        if not self.trading_client:
            return None
        
        try:
            request = LimitOrderRequest(
                symbol=symbol,
                qty=qty,
                side=OrderSide.SELL,
                time_in_force=TimeInForce[time_in_force.upper()],
                limit_price=round(limit_price, 4),
            )
            order = self.trading_client.submit_order(request)
            order_id = str(order.id)
            
            with self._lock:
                if buy_order_id not in self._placed_orders:
                    self._placed_orders[buy_order_id] = {}
                self._placed_orders[buy_order_id]["tp_order_id"] = order_id
                self._placed_orders[buy_order_id]["tp_limit_price"] = limit_price
            
            info(f"[CapeOrderExecutor] Placed SELL LIMIT (TP) {buy_order_id} → {order_id} @ ${limit_price}")
            return order_id
        except Exception as ex:
            info(f"[CapeOrderExecutor] Failed to place SELL LIMIT (TP): {ex}")
            return None
    
    def place_sell_stop_limit(
        self,
        buy_order_id: str,
        symbol: str,
        qty: int,
        stop_price: float,
        limit_price: float,
        time_in_force: str = "day",
    ) -> Optional[str]:
        """Place SELL STOP-LIMIT order (for stop-loss)."""
        if not self.trading_client:
            return None
        
        try:
            request = StopLimitOrderRequest(
                symbol=symbol,
                qty=qty,
                side=OrderSide.SELL,
                time_in_force=TimeInForce[time_in_force.upper()],
                stop_price=round(stop_price, 4),
                limit_price=round(limit_price, 4),
            )
            order = self.trading_client.submit_order(request)
            order_id = str(order.id)
            
            with self._lock:
                if buy_order_id not in self._placed_orders:
                    self._placed_orders[buy_order_id] = {}
                self._placed_orders[buy_order_id]["sl_order_id"] = order_id
                self._placed_orders[buy_order_id]["sl_stop_price"] = stop_price
                self._placed_orders[buy_order_id]["sl_limit_price"] = limit_price
            
            info(f"[CapeOrderExecutor] Placed SELL SL {buy_order_id} → {order_id} stop=${stop_price} limit=${limit_price}")
            return order_id
        except Exception as ex:
            info(f"[CapeOrderExecutor] Failed to place SELL SL: {ex}")
            return None
    
    def place_sell_market(
        self,
        buy_order_id: str,
        symbol: str,
        qty: int,
    ) -> Optional[str]:
        """Place emergency SELL MARKET order (gap/force exit)."""
        if not self.trading_client:
            return None
        
        try:
            request = MarketOrderRequest(
                symbol=symbol,
                qty=qty,
                side=OrderSide.SELL,
            )
            order = self.trading_client.submit_order(request)
            order_id = str(order.id)
            
            info(f"[CapeOrderExecutor] Placed SELL MARKET (EMERGENCY) {buy_order_id} → {order_id}")
            return order_id
        except Exception as ex:
            info(f"[CapeOrderExecutor] Failed to place SELL MARKET: {ex}")
            return None
    
    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order."""
        if not self.trading_client or not order_id:
            return False
        
        try:
            self.trading_client.cancel_order_by_id(order_id)
            info(f"[CapeOrderExecutor] Cancelled order {order_id}")
            return True
        except Exception as ex:
            debug(f"[CapeOrderExecutor] Failed to cancel {order_id}: {ex}")
            return False
    
    def replace_order(
        self,
        order_id: str,
        new_limit_price: Optional[float] = None,
        new_stop_price: Optional[float] = None,
    ) -> bool:
        """Replace (update) an open order."""
        if not self.trading_client or not order_id:
            return False
        
        try:
            from alpaca.trading.requests import ReplaceOrderRequest
            
            replace_kwargs = {}
            if new_limit_price is not None:
                replace_kwargs['limit_price'] = round(new_limit_price, 4)
            if new_stop_price is not None:
                replace_kwargs['stop_price'] = round(new_stop_price, 4)
            
            if not replace_kwargs:
                return False
            
            request = ReplaceOrderRequest(**replace_kwargs)
            self.trading_client.replace_order_by_id(order_id, request)
            info(f"[CapeOrderExecutor] Replaced order {order_id} with {replace_kwargs}")
            return True
        except Exception as ex:
            debug(f"[CapeOrderExecutor] Failed to replace {order_id}: {ex}")
            return False
    
    def get_order_status(self, order_id: str) -> Optional[dict]:
        """Get current order status from Alpaca."""
        if not self.trading_client or not order_id:
            return None
        
        try:
            order = self.trading_client.get_order_by_id(order_id)
            return {
                "order_id": str(order.id),
                "status": str(order.status),
                "filled_qty": order.filled_qty,
                "filled_avg_price": order.filled_avg_price,
                "created_at": order.created_at,
                "updated_at": order.updated_at,
            }
        except Exception as ex:
            debug(f"[CapeOrderExecutor] Failed to get order status {order_id}: {ex}")
            return None
    
    def execute_order_changes(
        self,
        buy_order_id: str,
        symbol: str,
        qty: int,
        changes: dict,
    ) -> dict:
        """
        Execute the order changes suggested by CapeOrderManager.
        
        Args:
            buy_order_id: Position ID
            symbol: Stock/option symbol
            qty: Position quantity
            changes: Dict with 'orders_to_cancel' and 'orders_to_place'
        
        Returns:
            Execution result dict
        """
        result = {
            "cancelled": [],
            "placed": [],
            "failed": [],
        }
        
        # Cancel orders
        for order_id in changes.get('orders_to_cancel', []):
            if self.cancel_order(order_id):
                result['cancelled'].append(order_id)
            else:
                result['failed'].append(f"cancel:{order_id}")
        
        # Place new orders
        for order_spec in changes.get('orders_to_place', []):
            order_type = order_spec.get('type')
            
            if order_type == 'SL_LIMIT':
                order_id = self.place_sell_stop_limit(
                    buy_order_id,
                    symbol,
                    qty,
                    order_spec['stop_price'],
                    order_spec['limit_price'],
                )
                if order_id:
                    result['placed'].append({
                        'type': 'SL_LIMIT',
                        'order_id': order_id,
                        'stop_price': order_spec['stop_price'],
                    })
                else:
                    result['failed'].append(f"place:SL_LIMIT")
            
            elif order_type == 'TP_LIMIT':
                order_id = self.place_sell_limit(
                    buy_order_id,
                    symbol,
                    qty,
                    order_spec['limit_price'],
                )
                if order_id:
                    result['placed'].append({
                        'type': 'TP_LIMIT',
                        'order_id': order_id,
                        'limit_price': order_spec['limit_price'],
                    })
                else:
                    result['failed'].append(f"place:TP_LIMIT")
        
        return result
