"""
Cape Trading API Server (Trading lane)

This process runs the full trading engine and exposes all API routes.
Use port 8001 for trading-priority operations.
"""

from api_server import app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api_server_trading:app", host="0.0.0.0", port=8001, reload=True)
