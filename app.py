import subprocess
import sys
import time
import urllib.request
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT, "backend")

TRADING_BACKEND_URL = "http://localhost:8001/api/config"
DISPLAY_BACKEND_URL = "http://localhost:8002/api/config"


def wait_for(url, label, timeout=120):
    print(f"      Waiting for {label} to be ready...", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            print(" ready!")
            return True
        except Exception:
            print(".", end="", flush=True)
            time.sleep(2)
    print(f"\n      ERROR: {label} did not start within {timeout}s")
    sys.exit(1)


print()
print("  ========================================")
print("   CAPE TRADING BOT - STARTING UP")
print("  ========================================")
print()

# ── Step 1: Start Backend ─────────────────────────────────────────────────────
print("[1/4] Starting trading backend (api_server_trading.py)...")
backend_trading = subprocess.Popen(
    [sys.executable, "api_server_trading.py"],
    cwd=BACKEND_DIR,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)
wait_for(TRADING_BACKEND_URL, "trading backend")
print(f"      Trading backend running  → http://localhost:8001")

# ── Step 2: Start Display Backend ────────────────────────────────────────────
print()
print("[2/4] Starting display backend (api_server_display.py)...")
backend_display = subprocess.Popen(
    [sys.executable, "api_server_display.py"],
    cwd=BACKEND_DIR,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)
wait_for(DISPLAY_BACKEND_URL, "display backend")
print(f"      Display backend running  → http://localhost:8002")

print()
print("  ========================================")
print("   ALL SERVICES RUNNING")
print("   Trading API : http://localhost:8001")
print("   Display API : http://localhost:8002")
print("  ========================================")
print()
print("  Press Ctrl+C to stop everything.")
print()

try:
    backend_trading.wait()
except KeyboardInterrupt:
    print("\n  Shutting down...")
    backend_trading.terminate()
    backend_display.terminate()
