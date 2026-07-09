"""
Cape Trading API Server (Trading lane)

This process runs the full trading engine and exposes all API routes.
Use port 8001 for trading-priority operations.
"""

from api_server import app


if __name__ == "__main__":
    import os
    import uvicorn

    # Auto-reload is OFF by default. This process hosts the stateful AIT bot and
    # the in-memory position registry — a reload on any .py save restarts the bot
    # mid-trade, wipes the registry (orphaning live positions), and drops in-flight
    # requests (surfacing as 502s at the display proxy). Opt in explicitly with
    # CAPE_RELOAD=1 only for local API-only development.
    reload = os.getenv("CAPE_RELOAD", "0") == "1"
    uvicorn.run("api_server_trading:app", host="0.0.0.0", port=8001, reload=reload)
