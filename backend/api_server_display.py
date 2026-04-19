"""
Cape Display API Server (Display lane)

This process proxies display/read endpoints to the trading server so request
and response contracts stay identical while allowing frontend traffic split.
Use port 8002 for chart/history/summary traffic.
"""

from __future__ import annotations

from typing import Any

import requests
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
    "/api/symbol/mode",
    "/api/symbol/modes",
    "/api/signal-readiness",
    "/api/straddle/trades",
}


app = FastAPI(title="Cape Display Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _forward(
    method: str,
    path: str,
    query: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> Response:
    url = f"{TRADING_BASE}{path}"
    try:
        if method == "GET":
            r = requests.get(url, params=query, timeout=30)
        elif method == "POST":
            r = requests.post(url, params=query, json=payload, timeout=30)
        else:
            raise HTTPException(status_code=405, detail=f"Method not allowed: {method}")
    except requests.RequestException as ex:
        raise HTTPException(status_code=502, detail=f"Display proxy failed: {str(ex)}") from ex

    content_type = r.headers.get("content-type", "application/json")
    return Response(content=r.content, status_code=r.status_code, media_type=content_type)


@app.middleware("http")
async def _request_log(request: Request, call_next):
    response = await call_next(request)
    print(f"[DISPLAY-API] {request.method} {request.url.path} -> {response.status_code}")
    return response


@app.get("/health")
def health() -> Response:
    return _forward("GET", "/health")


@app.get("/api/bars")
def get_bars(request: Request) -> Response:
    return _forward("GET", "/api/bars", query=dict(request.query_params))


@app.get("/api/quotes")
def get_quotes(request: Request) -> Response:
    return _forward("GET", "/api/quotes", query=dict(request.query_params))


@app.get("/api/account")
def get_account(request: Request) -> Response:
    return _forward("GET", "/api/account", query=dict(request.query_params))


@app.get("/api/positions")
def get_positions(request: Request) -> Response:
    return _forward("GET", "/api/positions", query=dict(request.query_params))


@app.get("/api/live-positions")
def get_live_positions(request: Request) -> Response:
    return _forward("GET", "/api/live-positions", query=dict(request.query_params))


@app.get("/api/orders/history")
def get_orders_history(request: Request) -> Response:
    return _forward("GET", "/api/orders/history", query=dict(request.query_params))


@app.get("/api/orders/{order_id}/status")
def get_order_status(order_id: str, request: Request) -> Response:
    return _forward("GET", f"/api/orders/{order_id}/status", query=dict(request.query_params))


@app.get("/api/options/price")
def get_option_price(request: Request) -> Response:
    return _forward("GET", "/api/options/price", query=dict(request.query_params))


@app.get("/api/options-log")
def get_options_log(request: Request) -> Response:
    return _forward("GET", "/api/options-log", query=dict(request.query_params))


@app.get("/api/manual-trades")
def get_manual_trades(request: Request) -> Response:
    return _forward("GET", "/api/manual-trades", query=dict(request.query_params))


@app.post("/api/manual-trades")
async def post_manual_trades(request: Request) -> Response:
    body = await request.json()
    return _forward("POST", "/api/manual-trades", query=dict(request.query_params), payload=body)


@app.get("/api/config")
def get_config(request: Request) -> Response:
    return _forward("GET", "/api/config", query=dict(request.query_params))


@app.get("/api/config/trading-modes")
def get_trading_modes(request: Request) -> Response:
    return _forward("GET", "/api/config/trading-modes", query=dict(request.query_params))


@app.get("/api/symbol/mode")
def get_symbol_mode(request: Request) -> Response:
    return _forward("GET", "/api/symbol/mode", query=dict(request.query_params))


@app.get("/api/symbol/modes")
def get_symbol_modes(request: Request) -> Response:
    return _forward("GET", "/api/symbol/modes", query=dict(request.query_params))


@app.post("/api/symbol/mode")
async def set_symbol_mode(request: Request) -> Response:
    body = await request.json()
    return _forward("POST", "/api/symbol/mode", query=dict(request.query_params), payload=body)


@app.get("/api/signal-readiness")
def get_signal_readiness(request: Request) -> Response:
    return _forward("GET", "/api/signal-readiness", query=dict(request.query_params))


@app.get("/api/straddle/trades")
def get_straddle_trades(request: Request) -> Response:
    return _forward("GET", "/api/straddle/trades", query=dict(request.query_params))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api_server_display:app", host="0.0.0.0", port=8002, reload=True)
