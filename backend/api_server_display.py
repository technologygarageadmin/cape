"""
Cape Display API Server (Display lane)

This process proxies display/read endpoints to the trading server so request
and response contracts stay identical while allowing frontend traffic split.
Use port 8002 for chart/history/summary traffic.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware


TRADING_BASE = "http://127.0.0.1:8001"

DISPLAY_ALLOWLIST = {
    "/health",
    "/api/bars",
    "/api/quotes",
    "/api/account",
    "/api/positions",
    "/api/live-positions",
    "/api/orders/history",
    "/api/orders/{order_id}/status",
    "/api/options/price",
    "/api/options-log",
    "/api/manual-trades",
    "/api/config",
    "/api/config/trading-modes",
    "/api/strategies",
    "/api/strategies/toggle",
    "/api/symbol/mode",
    "/api/symbol/modes",
    "/api/signal-readiness",
    "/api/straddle/trades",
}

# Persistent async client — shared across all requests, reuses TCP connections.
_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    _client = httpx.AsyncClient(base_url=TRADING_BASE, timeout=30.0)
    yield
    await _client.aclose()
    _client = None


app = FastAPI(title="Cape Display Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _forward(
    method: str,
    path: str,
    query: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> Response:
    assert _client is not None, "httpx client not initialised"
    try:
        if method == "GET":
            r = await _client.get(path, params=query)
        elif method == "POST":
            r = await _client.post(path, params=query, json=payload)
        else:
            raise HTTPException(status_code=405, detail=f"Method not allowed: {method}")
    except httpx.RequestError as ex:
        raise HTTPException(status_code=502, detail=f"Display proxy failed: {str(ex)}") from ex

    content_type = r.headers.get("content-type", "application/json")
    return Response(content=r.content, status_code=r.status_code, media_type=content_type)


@app.middleware("http")
async def _request_log(request: Request, call_next):
    response = await call_next(request)
    print(f"[DISPLAY-API] {request.method} {request.url.path} -> {response.status_code}")
    return response


@app.get("/health")
async def health() -> Response:
    return await _forward("GET", "/health")


@app.get("/api/bars")
async def get_bars(request: Request) -> Response:
    return await _forward("GET", "/api/bars", query=dict(request.query_params))


@app.get("/api/quotes")
async def get_quotes(request: Request) -> Response:
    return await _forward("GET", "/api/quotes", query=dict(request.query_params))


@app.get("/api/account")
async def get_account(request: Request) -> Response:
    return await _forward("GET", "/api/account", query=dict(request.query_params))


@app.get("/api/positions")
async def get_positions(request: Request) -> Response:
    return await _forward("GET", "/api/positions", query=dict(request.query_params))


@app.get("/api/live-positions")
async def get_live_positions(request: Request) -> Response:
    return await _forward("GET", "/api/live-positions", query=dict(request.query_params))


@app.get("/api/orders/history")
async def get_orders_history(request: Request) -> Response:
    return await _forward("GET", "/api/orders/history", query=dict(request.query_params))


@app.get("/api/orders/{order_id}/status")
async def get_order_status(order_id: str, request: Request) -> Response:
    return await _forward("GET", f"/api/orders/{order_id}/status", query=dict(request.query_params))


@app.get("/api/options/price")
async def get_option_price(request: Request) -> Response:
    return await _forward("GET", "/api/options/price", query=dict(request.query_params))


@app.get("/api/options-log")
async def get_options_log(request: Request) -> Response:
    return await _forward("GET", "/api/options-log", query=dict(request.query_params))


@app.get("/api/manual-trades")
async def get_manual_trades(request: Request) -> Response:
    return await _forward("GET", "/api/manual-trades", query=dict(request.query_params))


@app.post("/api/manual-trades")
async def post_manual_trades(request: Request) -> Response:
    body = await request.json()
    return await _forward("POST", "/api/manual-trades", query=dict(request.query_params), payload=body)


@app.post("/api/positions/{symbol}/close")
async def post_close_position(symbol: str, request: Request) -> Response:
    """Forward position close requests to the trading backend so the UI's
    Liquidate button works when the display server is fronting traffic.
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    return await _forward("POST", f"/api/positions/{symbol}/close", query=dict(request.query_params), payload=body)


@app.get("/api/config")
async def get_config(request: Request) -> Response:
    return await _forward("GET", "/api/config", query=dict(request.query_params))


@app.get("/api/config/trading-modes")
async def get_trading_modes(request: Request) -> Response:
    return await _forward("GET", "/api/config/trading-modes", query=dict(request.query_params))


@app.get("/api/strategies")
async def get_entry_strategies(request: Request) -> Response:
    return await _forward("GET", "/api/strategies", query=dict(request.query_params))


@app.post("/api/strategies/toggle")
async def toggle_entry_strategy(request: Request) -> Response:
    body = await request.json()
    return await _forward("POST", "/api/strategies/toggle", query=dict(request.query_params), payload=body)


@app.get("/api/symbol/mode")
async def get_symbol_mode(request: Request) -> Response:
    return await _forward("GET", "/api/symbol/mode", query=dict(request.query_params))


@app.get("/api/symbol/modes")
async def get_symbol_modes(request: Request) -> Response:
    return await _forward("GET", "/api/symbol/modes", query=dict(request.query_params))


@app.post("/api/symbol/mode")
async def set_symbol_mode(request: Request) -> Response:
    body = await request.json()
    return await _forward("POST", "/api/symbol/mode", query=dict(request.query_params), payload=body)


@app.get("/api/signal-readiness")
async def get_signal_readiness(request: Request) -> Response:
    return await _forward("GET", "/api/signal-readiness", query=dict(request.query_params))


@app.get("/api/straddle/trades")
async def get_straddle_trades(request: Request) -> Response:
    return await _forward("GET", "/api/straddle/trades", query=dict(request.query_params))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api_server_display:app", host="0.0.0.0", port=8002, reload=True)
