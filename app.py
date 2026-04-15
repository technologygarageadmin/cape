import subprocess
import sys
import time
import webbrowser
import urllib.request
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT, "backend")

BACKEND_URL = "http://localhost:8000/api/config"
FRONTEND_URL = "http://localhost:5173"


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
print("[1/3] Starting backend (api_server.py)...")
backend = subprocess.Popen(
    [sys.executable, "api_server.py"],
    cwd=BACKEND_DIR,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)
wait_for(BACKEND_URL, "backend")
print(f"      Backend running  → http://localhost:8000")

# ── Step 2: Start Frontend ────────────────────────────────────────────────────
print()
print("[2/3] Starting frontend (npm run dev)...")
frontend = subprocess.Popen(
    ["npm", "run", "dev"],
    cwd=ROOT,
    shell=True,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)
wait_for(FRONTEND_URL, "frontend")
print(f"      Frontend running → http://localhost:5173")

# ── Step 3: Open Browser ──────────────────────────────────────────────────────
print()
print("[3/3] Opening browser...")
webbrowser.open(FRONTEND_URL)

print()
print("  ========================================")
print("   ALL SERVICES RUNNING")
print("   Backend  : http://localhost:8000")
print("   Frontend : http://localhost:5173")
print("  ========================================")
print()
print("  Press Ctrl+C to stop everything.")
print()

try:
    backend.wait()
except KeyboardInterrupt:
    print("\n  Shutting down...")
    backend.terminate()
    frontend.terminate()
