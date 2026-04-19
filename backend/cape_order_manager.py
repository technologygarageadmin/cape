"""
Cape Order Manager
==================

Sophisticated order management system with dynamic trailing stops and profit-based exits.

Core Logic:
1. Place BUY LIMIT at Entry Price (EP)
2. Once filled, place bracket orders (TP + SL)
3. On every price update:
   - PROFIT MODE: Calculate QP, trailing SL, update orders
   - LOSS MODE: Tighten SL based on drawdown, disable QP
4. Execute when price >= TP or price <= SL
5. Fallback: Force market exit if SL missed (gap)

Order Changes are logged to MongoDB for audit trail.
SL only moves upward (never downward).
QP is fast trailing exit; Cape_SL is slower protection.
"""

import time
import threading
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
from typing import Optional
from alpaca.trading.requests import (
    LimitOrderRequest,
    StopLimitOrderRequest,
    MarketOrderRequest,
    ReplaceOrderRequest,
)
from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus
from logger import debug, info
from pymongo import MongoClient


@dataclass
class CapeOrderState:
    """Current order state for one position."""
    buy_order_id: str
    symbol: str
    contract_symbol: str
    qty: int
    ep: float  # Entry Price
    current_price: float
    max_price: float  # Running max for profit tracking
    
    # Order IDs
    tp_order_id: Optional[str] = None
    sl_order_id: Optional[str] = None
    current_sl: float = 0.0  # Last placed SL price
    current_tp: float = 0.0  # Last placed TP price
    
    # State tracking
    is_in_profit: bool = False
    pnl_pct: float = 0.0
    max_pnl_pct: float = 0.0
    
    # Cape internal values
    qp_value: Optional[float] = None  # Quick profit exit level
    cape_sl: float = 0.0  # Internal SL calculation
    cape_tp: float = 0.0  # Internal TP calculation
    
    # Order timestamps
    entry_time: Optional[str] = None
    last_order_update: Optional[str] = None
    exit_time: Optional[str] = None
    
    # Exit status
    exit_reason: Optional[str] = None  # TP_HIT | SL_HIT | QP_HIT | GAP_FORCED
    is_closed: bool = False
    
    # Tick tracking
    tick_count: int = 0  # How many price ticks processed


class CapeOrderManager:
    """Manages order lifecycle with dynamic trailing logic."""
    
    def __init__(
        self,
        mongo_uri: str,
        mongo_db: str,
        ep_offset: float = 0.0,
        tp_offset: float = 0.0,
        sl_offset: float = 0.0,
        qp_offset: float = 0.0,
        trailing_sl_offset: float = 0.0,
        trailing_tp_offset: float = 0.0,
        max_tighten: float = 0.0,
        detailed_logging: bool = True,
    ):
        """
        Initialize order manager with config values.
        
        Args:
            mongo_uri: MongoDB connection string
            mongo_db: Database name for logging
            ep_offset: Entry price offset for limit orders (%)
            tp_offset: Take-profit offset from EP (%)
            sl_offset: Stop-loss offset from EP (%)
            qp_offset: Quick-profit offset from current price (%)
            trailing_sl_offset: Trailing SL offset from current price (%)
            trailing_tp_offset: Trailing TP offset from current price (%)
            max_tighten: Maximum SL tightening on drawdown (%)
            detailed_logging: If True, log every price tick
        """
        self.mongo_uri = mongo_uri
        self.mongo_db = mongo_db
        self.ep_offset = ep_offset
        self.tp_offset = tp_offset
        self.sl_offset = sl_offset
        self.qp_offset = qp_offset
        self.trailing_sl_offset = trailing_sl_offset
        self.trailing_tp_offset = trailing_tp_offset
        self.max_tighten = max_tighten
        self.detailed_logging = detailed_logging
        
        self._states: dict[str, CapeOrderState] = {}
        self._lock = threading.Lock()
        self._mongo_client: Optional[MongoClient] = None
        
        self._init_mongo()
    
    def _init_mongo(self) -> None:
        """Initialize MongoDB connection for order logging."""
        try:
            self._mongo_client = MongoClient(
                self.mongo_uri, 
                serverSelectionTimeoutMS=5000
            )
            self._mongo_client.server_info()
            info("[CapeOrderManager] MongoDB connected for order logging")
        except Exception as ex:
            info(f"[CapeOrderManager] MongoDB unavailable: {ex}")
            self._mongo_client = None
    
    def register_position(
        self,
        buy_order_id: str,
        symbol: str,
        contract_symbol: str,
        qty: int,
        fill_price: float,
    ) -> None:
        """Register a newly filled buy order."""
        with self._lock:
            self._states[buy_order_id] = CapeOrderState(
                buy_order_id=buy_order_id,
                symbol=symbol,
                contract_symbol=contract_symbol,
                qty=qty,
                ep=fill_price,
                current_price=fill_price,
                max_price=fill_price,
                cape_sl=fill_price - (self.sl_offset * fill_price / 100.0),
                cape_tp=fill_price + (self.tp_offset * fill_price / 100.0),
                entry_time=datetime.now(timezone.utc).isoformat(),
            )
        info(f"[CapeOrderManager] Registered {buy_order_id} @ ${fill_price}")
    
    def get_state(self, buy_order_id: str) -> Optional[CapeOrderState]:
        """Get current order state."""
        with self._lock:
            return self._states.get(buy_order_id)
    
    def update_price(
        self,
        buy_order_id: str,
        current_price: float,
    ) -> dict:
        """
        Update on every price tick. Calculate new SL/TP and return order changes needed.
        
        Returns:
            {
                'new_sl': float or None,
                'new_tp': float or None,
                'qp_value': float or None,
                'mode': 'PROFIT' | 'LOSS',
                'orders_to_place': list of order specs,
                'orders_to_cancel': list of order IDs,
            }
        """
        state = self.get_state(buy_order_id)
        if not state or state.is_closed:
            return {}
        
        with self._lock:
            # Increment tick counter
            state.tick_count += 1
            tick_num = state.tick_count
            
            # Update tracking values
            state.current_price = current_price
            state.pnl_pct = ((current_price / state.ep) - 1.0) * 100.0
            
            if current_price > state.max_price:
                state.max_price = current_price
            
            state.max_pnl_pct = ((state.max_price / state.ep) - 1.0) * 100.0
            state.is_in_profit = current_price > state.ep
            
            # Determine mode and calculate new thresholds
            if state.is_in_profit:
                result = self._profit_mode(state)
            else:
                result = self._loss_mode(state)
            
            # Add tick number and state to result
            result['tick_number'] = tick_num
            result['state'] = state
            
            # Log detailed tick info
            if self.detailed_logging:
                self._log_price_tick(state, result)
            
            # Log any order changes
            if result.get('orders_to_place') or result.get('orders_to_cancel'):
                self._log_order_change(state, result)
            
            return result
    
    def _profit_mode(self, state: CapeOrderState) -> dict:
        """PROFIT MODE: price > EP"""
        # Calculate QP (quick profit)
        qp_value = state.current_price - (self.qp_offset * state.current_price / 100.0)
        state.qp_value = qp_value
        
        # Calculate trailing SL
        cape_sl = state.current_price - (self.trailing_sl_offset * state.current_price / 100.0)
        
        # Static TP or trailing TP (optional)
        cape_tp = state.ep + (self.tp_offset * state.ep / 100.0)
        # Optional: apply trailing TP after confirmation
        # cape_tp = state.current_price - (self.trailing_tp_offset * state.current_price / 100.0)
        
        # Final SL decision: max(existing SL, calculated SL, QP)
        new_sl = max(state.current_sl, cape_sl, qp_value)
        state.cape_sl = cape_sl
        state.cape_tp = cape_tp
        
        orders_to_place = []
        orders_to_cancel = []
        
        # If new SL is higher, update it
        if new_sl > state.current_sl:
            if state.sl_order_id:
                orders_to_cancel.append(state.sl_order_id)
            orders_to_place.append({
                'type': 'SL_LIMIT',
                'stop_price': round(new_sl, 4),
                'limit_price': round(new_sl * (1 - 0.05), 4),  # 5% buffer
            })
            state.current_sl = new_sl
        
        # If current price > TP, optionally update TP
        if state.current_price > state.current_tp:
            # Optional trailing TP logic
            pass
        
        return {
            'mode': 'PROFIT',
            'new_sl': new_sl,
            'new_tp': state.current_tp,
            'qp_value': qp_value,
            'orders_to_place': orders_to_place,
            'orders_to_cancel': orders_to_cancel,
        }
    
    def _loss_mode(self, state: CapeOrderState) -> dict:
        """LOSS MODE: price <= EP"""
        # Disable QP
        state.qp_value = None
        
        # Calculate tightened SL
        drawdown = state.ep - state.current_price
        tighten = min(drawdown, self.max_tighten)
        cape_sl = state.ep - (self.sl_offset - tighten)
        
        # TP unchanged
        cape_tp = state.ep + (self.tp_offset * state.ep / 100.0)
        
        # Final SL decision
        new_sl = max(state.current_sl, cape_sl)
        state.cape_sl = cape_sl
        state.cape_tp = cape_tp
        
        orders_to_place = []
        orders_to_cancel = []
        
        # If new SL is higher, update it
        if new_sl > state.current_sl:
            if state.sl_order_id:
                orders_to_cancel.append(state.sl_order_id)
            orders_to_place.append({
                'type': 'SL_LIMIT',
                'stop_price': round(new_sl, 4),
                'limit_price': round(new_sl * (1 - 0.05), 4),
            })
            state.current_sl = new_sl
        
        return {
            'mode': 'LOSS',
            'new_sl': new_sl,
            'new_tp': state.current_tp,
            'qp_value': None,
            'orders_to_place': orders_to_place,
            'orders_to_cancel': orders_to_cancel,
        }
    
    def mark_order_placed(
        self,
        buy_order_id: str,
        order_type: str,  # 'SL_LIMIT' | 'TP_LIMIT'
        order_id: str,
    ) -> None:
        """Record that an order was placed."""
        state = self.get_state(buy_order_id)
        if not state:
            return
        
        with self._lock:
            if order_type == 'SL_LIMIT':
                state.sl_order_id = order_id
            elif order_type == 'TP_LIMIT':
                state.tp_order_id = order_id
            state.last_order_update = datetime.now(timezone.utc).isoformat()
    
    def mark_closed(
        self,
        buy_order_id: str,
        exit_reason: str,
        exit_price: Optional[float] = None,
    ) -> None:
        """Mark position as closed."""
        state = self.get_state(buy_order_id)
        if not state:
            return
        
        with self._lock:
            state.is_closed = True
            state.exit_reason = exit_reason
            state.exit_time = datetime.now(timezone.utc).isoformat()
            
            if exit_price:
                state.pnl_pct = ((exit_price / state.ep) - 1.0) * 100.0
        
        self._log_position_closed(state, exit_price)
        info(f"[CapeOrderManager] {buy_order_id} closed: {exit_reason}")
    
    def _log_price_tick(self, state: CapeOrderState, calculation: dict) -> None:
        """Log detailed price tick with all calculations to MongoDB."""
        if not self._mongo_client:
            return
        
        try:
            db = self._mongo_client[self.mongo_db]
            collection = db["price_ticks"]
            
            doc = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "buy_order_id": state.buy_order_id,
                "symbol": state.symbol,
                "contract_symbol": state.contract_symbol,
                "tick_number": calculation.get('tick_number'),
                
                # Current market data
                "current_price": round(state.current_price, 4),
                "max_price": round(state.max_price, 4),
                "entry_price": round(state.ep, 4),
                
                # P&L tracking
                "pnl_pct": round(state.pnl_pct, 4),
                "max_pnl_pct": round(state.max_pnl_pct, 4),
                
                # Mode and calculations
                "mode": calculation.get('mode'),
                "is_in_profit": state.is_in_profit,
                
                # Internal calculations (PROFIT mode)
                "qp_calculated": round(state.qp_value, 4) if state.qp_value else None,
                "cape_sl_calculated": round(state.cape_sl, 4),
                "cape_tp_calculated": round(state.cape_tp, 4),
                
                # Final SL/TP decision
                "sl_current": round(state.current_sl, 4),
                "tp_current": round(state.current_tp, 4),
                "sl_new": round(calculation.get('new_sl', state.current_sl), 4),
                
                # Order actions
                "order_updated": bool(calculation.get('orders_to_place') or calculation.get('orders_to_cancel')),
                "orders_cancelled": calculation.get('orders_to_cancel', []),
                "orders_placed": calculation.get('orders_to_place', []),
                
                # Status flags
                "qp_armed": state.qp_value is not None,
                "qp_value": round(state.qp_value, 4) if state.qp_value else None,
            }
            collection.insert_one(doc)
        except Exception as ex:
            debug(f"[CapeOrderManager] Price tick logging failed: {ex}")
    
    def _log_order_change(self, state: CapeOrderState, change: dict) -> None:
        """Log order changes to MongoDB."""
        if not self._mongo_client:
            return
        
        try:
            db = self._mongo_client[self.mongo_db]
            collection = db["order_changes"]
            
            doc = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "buy_order_id": state.buy_order_id,
                "symbol": state.symbol,
                "contract_symbol": state.contract_symbol,
                "current_price": state.current_price,
                "pnl_pct": state.pnl_pct,
                "mode": change.get('mode'),
                "orders_to_cancel": change.get('orders_to_cancel'),
                "orders_to_place": change.get('orders_to_place'),
                "new_sl": change.get('new_sl'),
                "new_tp": change.get('new_tp'),
                "qp_value": change.get('qp_value'),
            }
            collection.insert_one(doc)
        except Exception as ex:
            debug(f"[CapeOrderManager] MongoDB log failed: {ex}")
    
    def _log_position_closed(self, state: CapeOrderState, exit_price: Optional[float]) -> None:
        """Log position closure to MongoDB."""
        if not self._mongo_client:
            return
        
        try:
            db = self._mongo_client[self.mongo_db]
            collection = db["position_exits"]
            
            doc = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "buy_order_id": state.buy_order_id,
                "symbol": state.symbol,
                "contract_symbol": state.contract_symbol,
                "entry_price": state.ep,
                "exit_price": exit_price,
                "exit_reason": state.exit_reason,
                "entry_time": state.entry_time,
                "exit_time": state.exit_time,
                "pnl_pct": state.pnl_pct,
                "max_pnl_pct": state.max_pnl_pct,
                "max_price": state.max_price,
            }
            collection.insert_one(doc)
        except Exception as ex:
            debug(f"[CapeOrderManager] MongoDB exit log failed: {ex}")
