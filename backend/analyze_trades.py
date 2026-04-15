"""Analyze recent trades from MongoDB to find loss patterns."""
from pymongo import MongoClient
from config import MONGO_URI, MONGO_DB_NAME
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from collections import Counter

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[MONGO_DB_NAME]
col = db["options_log"]

CDT = ZoneInfo("America/Chicago")
seven_days_ago = datetime.now(CDT) - timedelta(days=7)
trades = list(col.find({"created_at": {"$gte": seven_days_ago}}).sort("created_at", -1).limit(200))

if not trades:
    # Try without date filter
    trades = list(col.find().sort("created_at", -1).limit(200))
    print(f"No trades in last 7 days. Showing last {len(trades)} trades from all time.")

print(f"TOTAL TRADES: {len(trades)}")
wins = [t for t in trades if t.get("result") == "WIN"]
losses = [t for t in trades if t.get("result") == "LOSS"]
total = len(wins) + len(losses)
if total > 0:
    print(f"WINS: {len(wins)} | LOSSES: {len(losses)} | Win Rate: {len(wins)/total*100:.0f}%")
    print(f"Total PnL: ${sum(t.get('pnl', 0) for t in trades):.2f}")
    print(f"Avg Win: ${sum(t.get('pnl',0) for t in wins)/max(len(wins),1):.2f}")
    print(f"Avg Loss: ${sum(t.get('pnl',0) for t in losses)/max(len(losses),1):.2f}")
print()

print("=== TRADE-BY-TRADE ===")
for i, t in enumerate(trades[:50], 1):
    sym = t.get("symbol", "?")
    d = t.get("direction", "?")
    bp = t.get("buy_price", 0)
    sp = t.get("sell_price", 0)
    pnl = t.get("pnl", 0)
    pk = t.get("peak_pnl_pct", 0)
    sl = t.get("exit_sl_pct", 0)
    qp = t.get("exit_qp_pct", 0)
    r = t.get("exit_reason", "?")
    res = "W" if t.get("result") == "WIN" else "L"
    tt = t.get("trade_type", "?")
    dur = ""
    try:
        et = datetime.fromisoformat(str(t.get("entry_time", "")))
        xt = datetime.fromisoformat(str(t.get("exit_time", "")))
        s = int((xt - et).total_seconds())
        dur = f"{s//60}m{s%60}s"
    except:
        pass
    ets = ""
    try:
        ets = datetime.fromisoformat(str(t.get("entry_time", ""))).strftime("%m/%d %H:%M")
    except:
        pass
    pnl_pct = (sp - bp) / bp * 100 if bp > 0 else 0
    print(
        f"{i:>2}|{sym:>5}|{d:>4}|{tt:>8}|buy={bp:.2f}|sell={sp:.2f}"
        f"|pnl=${pnl:+.0f}({pnl_pct:+.1f}%)|peak={pk:+.1f}%"
        f"|sl={sl:+.1f}%|qp={qp:+.1f}%|{r}|{dur}|{ets}|{res}"
    )

print()
print("=== EXIT REASON BREAKDOWN ===")
for reason, cnt in Counter(t.get("exit_reason", "?") for t in trades).most_common():
    sub = [t for t in trades if t.get("exit_reason") == reason]
    avg_pnl = sum(t.get("pnl", 0) for t in sub) / len(sub)
    avg_pk = sum(t.get("peak_pnl_pct", 0) for t in sub) / len(sub)
    w = sum(1 for t in sub if t.get("result") == "WIN")
    l = sum(1 for t in sub if t.get("result") == "LOSS")
    print(f"  {reason}: {cnt}x  W={w} L={l}  avg_pnl=${avg_pnl:+.1f}  avg_peak={avg_pk:+.1f}%")

print()
print("=== LOSS DEEP-DIVE ===")
for t in losses[:30]:
    sym = t.get("symbol", "?")
    d = t.get("direction", "?")
    bp = t.get("buy_price", 0)
    sp = t.get("sell_price", 0)
    pnl = t.get("pnl", 0)
    pk = t.get("peak_pnl_pct", 0)
    r = t.get("exit_reason", "?")
    dur = ""
    try:
        et = datetime.fromisoformat(str(t.get("entry_time", "")))
        xt = datetime.fromisoformat(str(t.get("exit_time", "")))
        s = int((xt - et).total_seconds())
        dur = f"{s}s"
    except:
        pass
    pnl_pct = (sp - bp) / bp * 100 if bp > 0 else 0
    print(
        f"  {sym} {d}: ${bp:.2f}->${sp:.2f} pnl=${pnl:+.0f}({pnl_pct:+.1f}%)"
        f" peak={pk:+.1f}% exit={r} dur={dur}"
    )

# Pattern analysis
print()
print("=== PATTERN ANALYSIS ===")
sl_losses = [t for t in losses if "STOP_LOSS" in str(t.get("exit_reason", ""))]
qp_losses = [t for t in losses if "QUICK_PROFIT" in str(t.get("exit_reason", ""))]
same_candle = [t for t in trades if "SAME_CANDLE" in str(t.get("exit_reason", ""))]
immediate_sl = [t for t in sl_losses if t.get("peak_pnl_pct", 0) <= 0.5]

print(f"Stop Loss exits: {len(sl_losses)} (avg peak before SL: {sum(t.get('peak_pnl_pct',0) for t in sl_losses)/max(len(sl_losses),1):+.1f}%)")
print(f"  - Immediate SL (peak < 0.5%): {len(immediate_sl)}")
print(f"  - Had positive peak before SL: {len(sl_losses) - len(immediate_sl)}")
print(f"QP exits that were losses: {len(qp_losses)}")
print(f"Same-candle exits: {len(same_candle)}")

# Duration analysis
print()
print("=== DURATION ANALYSIS ===")
for bucket_name, bucket_trades in [("WINS", wins), ("LOSSES", losses)]:
    durations = []
    for t in bucket_trades:
        try:
            et = datetime.fromisoformat(str(t.get("entry_time", "")))
            xt = datetime.fromisoformat(str(t.get("exit_time", "")))
            durations.append(int((xt - et).total_seconds()))
        except:
            pass
    if durations:
        print(f"  {bucket_name}: avg={sum(durations)/len(durations):.0f}s min={min(durations)}s max={max(durations)}s")

# Per-symbol breakdown
print()
print("=== PER-SYMBOL SUMMARY ===")
symbols = set(t.get("symbol") for t in trades)
for sym in sorted(symbols):
    st = [t for t in trades if t.get("symbol") == sym]
    sw = sum(1 for t in st if t.get("result") == "WIN")
    sl2 = sum(1 for t in st if t.get("result") == "LOSS")
    spnl = sum(t.get("pnl", 0) for t in st)
    print(f"  {sym}: {len(st)} trades  W={sw} L={sl2}  pnl=${spnl:+.1f}")
