@echo off
title Cape Trading Bot

echo.
echo  ========================================
echo   CAPE TRADING BOT - STARTING UP
echo  ========================================
echo.

:: ── Step 1: Start Backend ────────────────────────────────────────────────────
echo [1/3] Starting backend (api_server.py)...
start "Cape Backend" cmd /k "cd /d "%~dp0backend" && echo Backend starting... && python api_server.py"

:: Wait for backend to come up on port 8000
echo       Waiting for backend to be ready...
:wait_backend
timeout /t 2 /nobreak > nul
curl -s http://localhost:8000/api/config > nul 2>&1
if errorlevel 1 (
    echo       Backend not ready yet, retrying...
    goto wait_backend
)
echo       Backend is ready on http://localhost:8000

:: ── Step 2: Start Frontend ───────────────────────────────────────────────────
echo.
echo [2/3] Starting frontend (npm run dev)...
start "Cape Frontend" cmd /k "cd /d "%~dp0" && echo Frontend starting... && npm run dev"

:: Wait for Vite to come up on port 5173
echo       Waiting for frontend to be ready...
:wait_frontend
timeout /t 2 /nobreak > nul
curl -s http://localhost:5173 > nul 2>&1
if errorlevel 1 (
    echo       Frontend not ready yet, retrying...
    goto wait_frontend
)
echo       Frontend is ready on http://localhost:5173

:: ── Step 3: Open Browser ─────────────────────────────────────────────────────
echo.
echo [3/3] Opening browser...
start "" "http://localhost:5173"

echo.
echo  ========================================
echo   ALL SERVICES RUNNING
echo   Backend  : http://localhost:8000
echo   Frontend : http://localhost:5173
echo  ========================================
echo.
echo  Close this window to stop watching.
echo  (Backend and Frontend windows stay open)
echo.
pause
