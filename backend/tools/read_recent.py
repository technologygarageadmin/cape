"""Read last 30 trades from MongoDB — quick diagnostic."""
from pymongo import MongoClient
from config import MONGO_URI, MONGO_DB_NAME

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[MONGO_DB_NAME]
col = db["options_log"]

trades = list(col.find().sort("created_at", -1).limit(30))
print(f"Last {len(trades)} trades:\n")

total_pnl = 0
wins = 0
losses = 0
for i, t in enumerate(trades, 1):
    sym = t.get("symbol", "?")
    d = t.get("direction", "?")
    bp = float(t.get("buy_price", 0) or 0)
    sp = float(t.get("sell_price", 0) or 0)
    pnl = float(t.get("pnl", 0) or 0)
    total_pnl += pnl
    pk = float(t.get("peak_pnl_pct", 0) or 0)
    r = t.get("exit_reason", "?")
    res = t.get("result", "?")
    tt = t.get("trade_type", "?")
    ct = t.get("created_at", "?")
    entry = t.get("entry_time", "?")
    exit_t = t.get("exit_time", "?")
    contract = t.get("contract_name", "?")
    
    if res == "WIN": wins += 1
    elif res == "LOSS": losses += 1
    
    # Duration
    dur = ""
    try:
        from datetime import datetime
        et = datetime.fromisoformat(str(entry))
        xt = datetime.fromisoformat(str(exit_t))
        s = int((xt - et).total_seconds())
        dur = f"{s//60}m{s%60}s"
    except: dur = "?"

    pnl_pct = ((sp - bp) / bp * 100) if bp > 0 else 0
    
    print(f"{i:2}. {sym:5} {d:4} | Buy:{bp:.4f} Sell:{sp:.4f} | PnL: ${pnl:+.2f} ({pnl_pct:+.2f}%) | Peak:{pk:+.2f}% | {r:30} | {res:4} | {tt:8} | Dur:{dur:>7} | {entry}")

print(f"\n{'='*100}")
print(f"Summary: {wins}W / {losses}L | Win Rate: {wins/(wins+losses)*100:.0f}% | Total PnL: ${total_pnl:+.2f}")

# Group by exit reason
from collections import Counter
by_reason = Counter()
pnl_by_reason = {}
for t in trades:
    r = t.get("exit_reason", "UNKNOWN")
    by_reason[r] += 1
    pnl_by_reason.setdefault(r, []).append(float(t.get("pnl", 0) or 0))

print(f"\nBy Exit Reason:")
for reason, count in by_reason.most_common():
    pnls = pnl_by_reason[reason]
    avg = sum(pnls) / len(pnls)
    total = sum(pnls)
    w = sum(1 for p in pnls if p > 0)
    l = sum(1 for p in pnls if p < 0)
    print(f"  {reason:35} {count:3}x | {w}W/{l}L | Avg: ${avg:+.2f} | Total: ${total:+.2f}")

# Group by symbol
by_sym = Counter()
pnl_by_sym = {}
for t in trades:
    s = t.get("symbol", "?")
    by_sym[s] += 1
    pnl_by_sym.setdefault(s, []).append(float(t.get("pnl", 0) or 0))

print(f"\nBy Symbol:")
for sym, count in by_sym.most_common():
    pnls = pnl_by_sym[sym]
    total = sum(pnls)
    w = sum(1 for p in pnls if p > 0)
    l = sum(1 for p in pnls if p < 0)
    print(f"  {sym:6} {count:3}x | {w}W/{l}L | Total PnL: ${total:+.2f}")
