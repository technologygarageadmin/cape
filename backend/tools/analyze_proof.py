"""Trade analysis - evidence for entry/exit improvements."""
import json
from collections import Counter, defaultdict
from pymongo import MongoClient

def main():
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=5000)
    db = client["cape"]
    col = db["options_log"]
    
    rows = list(col.find().sort("created_at", -1))
    trades = []
    for r in rows:
        trades.append({
            "symbol": r.get("symbol"),
            "contractName": r.get("contract_name"),
            "optionType": r.get("option_type"),
            "qty": r.get("qty", 1),
            "buyPrice": r.get("buy_price", 0),
            "sellPrice": r.get("sell_price", 0),
            "pnl": r.get("pnl", 0),
            "result": r.get("result"),
            "exitReason": r.get("exit_reason", ""),
            "tradeType": r.get("trade_type", ""),
            "pnlPct": r.get("pnl_pct"),
            "peakPnlPct": r.get("peak_pnl_pct"),
            "tradeDurationSec": r.get("trade_duration_sec"),
            "entryRsi": r.get("entry_rsi"),
            "entryRsiMa": r.get("entry_rsi_ma"),
            "entryRsiMaGap": r.get("entry_rsi_ma_gap"),
            "entryEmaBullish": r.get("entry_ema_bullish"),
            "entryVolumeRatio": r.get("entry_volume_ratio"),
            "entryBodyRatio": r.get("entry_body_ratio"),
            "entryPullbackPct": r.get("entry_pullback_pct"),
            "entryFiltersPassed": r.get("entry_filters_passed"),
            "exitSlPct": r.get("exit_sl_pct"),
            "exitQpPct": r.get("exit_qp_pct"),
            "exitTpPct": r.get("exit_tp_pct"),
            "entryTime": r.get("entry_time"),
            "exitTime": r.get("exit_time"),
        })
    print(f"Loaded {len(trades)} trades from MongoDB")
    
    # Filter out straddle
    non_straddle = [t for t in trades if str(t.get("tradeType","")).upper() != "STRADDLE"]
    print(f"Total trades: {len(trades)} (non-straddle: {len(non_straddle)})")
    
    trades = non_straddle
    wins = [t for t in trades if t.get("result") == "WIN"]
    losses = [t for t in trades if t.get("result") == "LOSS"]
    
    print(f"Wins: {len(wins)}, Losses: {len(losses)}")
    if trades:
        print(f"Win rate: {len(wins)/len(trades)*100:.1f}%")
    
    total_pnl = sum(float(t.get("pnl", 0) or 0) for t in trades)
    avg_win = sum(float(t.get("pnl", 0) or 0) for t in wins) / max(len(wins),1)
    avg_loss = sum(float(t.get("pnl", 0) or 0) for t in losses) / max(len(losses),1)
    
    print(f"Net PnL: ${total_pnl:.2f}")
    print(f"Avg Win: ${avg_win:.2f}, Avg Loss: ${avg_loss:.2f}")
    if avg_loss != 0:
        print(f"R:R ratio: {abs(avg_win/avg_loss):.2f}")
    
    # ── EXIT REASON ANALYSIS ──
    print("\n" + "="*90)
    print("EXIT REASON BREAKDOWN (non-straddle)")
    print("="*90)
    
    exit_map = defaultdict(list)
    for t in trades:
        reason = str(t.get("exitReason") or t.get("exit_reason") or "UNKNOWN").strip()
        exit_map[reason].append(t)
    
    for reason, subset in sorted(exit_map.items(), key=lambda x: -len(x[1])):
        w = sum(1 for t in subset if t.get("result") == "WIN")
        l = sum(1 for t in subset if t.get("result") == "LOSS")
        pnl = sum(float(t.get("pnl",0) or 0) for t in subset)
        avg = pnl / len(subset)
        pcts = [float(t.get("pnlPct",0) or 0) for t in subset]
        avg_pct = sum(pcts)/len(pcts) if pcts else 0
        print(f"  {reason:50s} | N={len(subset):3d} | W:{w:3d} L:{l:3d} | PnL ${pnl:9.2f} | Avg ${avg:7.2f} | Avg% {avg_pct:+.2f}%")
    
    # ── PNL DISTRIBUTION ──
    print("\n" + "="*90)
    print("PNL % DISTRIBUTION")
    print("="*90)
    
    buckets = {"< -5%": 0, "-5 to -3%": 0, "-3 to -1%": 0, "-1 to 0%": 0,
               "0 to +1%": 0, "+1 to +2%": 0, "+2 to +3%": 0, "+3 to +5%": 0, "> +5%": 0}
    for t in trades:
        pct = float(t.get("pnlPct", 0) or 0)
        if pct < -5: buckets["< -5%"] += 1
        elif pct < -3: buckets["-5 to -3%"] += 1
        elif pct < -1: buckets["-3 to -1%"] += 1
        elif pct < 0: buckets["-1 to 0%"] += 1
        elif pct < 1: buckets["0 to +1%"] += 1
        elif pct < 2: buckets["+1 to +2%"] += 1
        elif pct < 3: buckets["+2 to +3%"] += 1
        elif pct < 5: buckets["+3 to +5%"] += 1
        else: buckets["> +5%"] += 1
    
    for label, count in buckets.items():
        bar = "█" * (count * 2)
        print(f"  {label:14s} | {count:3d} | {bar}")
    
    # ── QUICK PROFIT ANALYSIS - are we leaving money on table? ──
    print("\n" + "="*90)
    print("QUICK PROFIT (QP) EXIT ANALYSIS - leaving money on table?")
    print("="*90)
    
    qp_trades = [t for t in trades if "QUICK_PROFIT" in str(t.get("exitReason") or t.get("exit_reason") or "").upper() or "QP" in str(t.get("exitReason") or t.get("exit_reason") or "").upper()]
    if qp_trades:
        qp_pnls = [float(t.get("pnl",0) or 0) for t in qp_trades]
        qp_pcts = [float(t.get("pnlPct",0) or 0) for t in qp_trades]
        peaks = [float(t.get("peakPnlPct",0) or 0) for t in qp_trades if t.get("peakPnlPct") is not None]
        print(f"  QP exits: {len(qp_trades)}")
        print(f"  Total PnL from QP: ${sum(qp_pnls):.2f}")
        print(f"  Avg exit PnL%: {sum(qp_pcts)/len(qp_pcts):.2f}%")
        if peaks:
            print(f"  Avg peak before QP exit: {sum(peaks)/len(peaks):.2f}%")
            # How many had peak > 3% but exited at QP (~1.5%)
            high_peak_qp = [p for p in peaks if p > 3]
            print(f"  Trades that peaked >3% but QP exited early: {len(high_peak_qp)} / {len(peaks)}")
    
    # ── STOP LOSS ANALYSIS ──
    print("\n" + "="*90)
    print("STOP LOSS (SL) EXIT ANALYSIS")
    print("="*90)
    
    sl_trades = [t for t in trades if "STOP" in str(t.get("exitReason") or t.get("exit_reason") or "").upper() or "SL" in str(t.get("exitReason") or t.get("exit_reason") or "").upper()]
    if sl_trades:
        sl_pnls = [float(t.get("pnl",0) or 0) for t in sl_trades]
        sl_pcts = [float(t.get("pnlPct",0) or 0) for t in sl_trades]
        print(f"  SL exits: {len(sl_trades)}")
        print(f"  Total loss from SL: ${sum(sl_pnls):.2f}")
        print(f"  Avg SL exit PnL%: {sum(sl_pcts)/len(sl_pcts):.2f}%")
        # How much would tighter SL save?
        # Simulate: if SL was at -3% instead of -5%
        for sim_sl in [-3, -4]:
            saved = 0
            for t in sl_trades:
                actual = float(t.get("pnlPct",0) or 0)
                if actual < sim_sl:
                    saved += abs(actual - sim_sl)  # pct points saved
            print(f"  If SL was {sim_sl}% instead of -5%: would save ~{saved:.1f} pct points total across {len(sl_trades)} trades")
    
    # ── BAD ENTRY ANALYSIS ──
    print("\n" + "="*90)
    print("BAD ENTRY EXIT ANALYSIS")
    print("="*90)
    
    bad_entry = [t for t in trades if "BAD_ENTRY" in str(t.get("exitReason") or t.get("exit_reason") or "").upper()]
    if bad_entry:
        be_pnls = [float(t.get("pnl",0) or 0) for t in bad_entry]
        be_pcts = [float(t.get("pnlPct",0) or 0) for t in bad_entry]
        print(f"  Bad entry exits: {len(bad_entry)}")
        print(f"  Total PnL from bad entry: ${sum(be_pnls):.2f}")
        print(f"  Avg exit PnL%: {sum(be_pcts)/len(be_pcts):.2f}%")
        # How many would have been wins if held?
        peaks = [float(t.get("peakPnlPct",0) or 0) for t in bad_entry if t.get("peakPnlPct") is not None]
        if peaks:
            would_win = [p for p in peaks if p > 1.5]
            print(f"  Of those, {len(would_win)}/{len(peaks)} peaked above +1.5% (would have been profitable)")
    
    # ── TRAILING STOP ANALYSIS ──
    print("\n" + "="*90)
    print("TRAILING STOP ANALYSIS")
    print("="*90)
    
    trail_trades = [t for t in trades if "TRAILING" in str(t.get("exitReason") or t.get("exit_reason") or "").upper() or "TRAIL" in str(t.get("exitReason") or t.get("exit_reason") or "").upper()]
    if trail_trades:
        tr_pnls = [float(t.get("pnl",0) or 0) for t in trail_trades]
        tr_pcts = [float(t.get("pnlPct",0) or 0) for t in trail_trades]
        peaks = [float(t.get("peakPnlPct",0) or 0) for t in trail_trades if t.get("peakPnlPct") is not None]
        print(f"  Trailing exits: {len(trail_trades)}")
        print(f"  Total PnL: ${sum(tr_pnls):.2f}")
        print(f"  Avg exit PnL%: {sum(tr_pcts)/len(tr_pcts):.2f}%")
        if peaks:
            print(f"  Avg peak before trailing exit: {sum(peaks)/len(peaks):.2f}%")
            giveback = [p - float(t.get("pnlPct",0) or 0) for t, p in zip(trail_trades, peaks)]
            print(f"  Avg giveback from peak: {sum(giveback)/len(giveback):.2f}% points")
    
    # ── ENTRY FILTER EFFECTIVENESS ──
    print("\n" + "="*90)
    print("ENTRY FILTER EFFECTIVENESS")
    print("="*90)
    
    filter_stats = defaultdict(lambda: {"win": 0, "loss": 0, "pnl": 0})
    for t in trades:
        filters = t.get("entryFiltersPassed") or []
        result = t.get("result", "")
        pnl = float(t.get("pnl", 0) or 0)
        for f in filters:
            filter_stats[f]["pnl"] += pnl
            if result == "WIN": filter_stats[f]["win"] += 1
            elif result == "LOSS": filter_stats[f]["loss"] += 1
    
    for f, s in sorted(filter_stats.items(), key=lambda x: -x[1]["pnl"]):
        total = s["win"] + s["loss"]
        wr = s["win"]/total*100 if total > 0 else 0
        print(f"  {f:25s} | N={total:3d} | WR: {wr:5.1f}% | PnL: ${s['pnl']:9.2f}")
    
    # ── FILTER COUNT vs WIN RATE ──
    print("\n" + "="*90)
    print("FILTER COUNT vs WIN RATE (more filters = better entry?)")
    print("="*90)
    
    fc_stats = defaultdict(lambda: {"win": 0, "loss": 0, "pnl": 0})
    for t in trades:
        fc = len(t.get("entryFiltersPassed") or [])
        result = t.get("result", "")
        pnl = float(t.get("pnl", 0) or 0)
        fc_stats[fc]["pnl"] += pnl
        if result == "WIN": fc_stats[fc]["win"] += 1
        elif result == "LOSS": fc_stats[fc]["loss"] += 1
    
    for fc in sorted(fc_stats.keys()):
        s = fc_stats[fc]
        total = s["win"] + s["loss"]
        wr = s["win"]/total*100 if total > 0 else 0
        print(f"  {fc} filters | N={total:3d} | WR: {wr:5.1f}% | PnL: ${s['pnl']:9.2f}")
    
    # ── CALL vs PUT PERFORMANCE ──
    print("\n" + "="*90)
    print("CALL vs PUT PERFORMANCE")
    print("="*90)
    
    for opt_type in ["CALL", "PUT", "call", "put"]:
        subset = [t for t in trades if str(t.get("optionType","")).upper() == opt_type.upper()]
        if not subset:
            continue
        w = sum(1 for t in subset if t.get("result") == "WIN")
        l = sum(1 for t in subset if t.get("result") == "LOSS")
        pnl = sum(float(t.get("pnl",0) or 0) for t in subset)
        total = w + l
        wr = w/total*100 if total > 0 else 0
        print(f"  {opt_type.upper():5s} | N={total:3d} | WR: {wr:5.1f}% | PnL: ${pnl:9.2f}")
    
    # ── DURATION vs OUTCOME ──
    print("\n" + "="*90)
    print("TRADE DURATION vs OUTCOME")
    print("="*90)
    
    dur_buckets = {"<30s": [], "30s-2m": [], "2m-5m": [], "5m-15m": [], ">15m": []}
    for t in trades:
        dur = t.get("tradeDurationSec")
        if dur is None: continue
        dur = float(dur)
        if dur < 30: dur_buckets["<30s"].append(t)
        elif dur < 120: dur_buckets["30s-2m"].append(t)
        elif dur < 300: dur_buckets["2m-5m"].append(t)
        elif dur < 900: dur_buckets["5m-15m"].append(t)
        else: dur_buckets[">15m"].append(t)
    
    for label, subset in dur_buckets.items():
        if not subset: continue
        w = sum(1 for t in subset if t.get("result") == "WIN")
        l = sum(1 for t in subset if t.get("result") == "LOSS")
        pnl = sum(float(t.get("pnl",0) or 0) for t in subset)
        total = w + l
        wr = w/total*100 if total > 0 else 0
        print(f"  {label:10s} | N={total:3d} | WR: {wr:5.1f}% | PnL: ${pnl:9.2f}")
    
    # ── RSI AT ENTRY vs OUTCOME ──
    print("\n" + "="*90)
    print("ENTRY RSI vs OUTCOME")
    print("="*90)
    
    rsi_buckets = {"30-40": [], "40-50": [], "50-55": [], "55-60": [], "60-70": []}
    for t in trades:
        rsi = t.get("entryRsi")
        if rsi is None: continue
        rsi = float(rsi)
        if rsi < 40: rsi_buckets["30-40"].append(t)
        elif rsi < 50: rsi_buckets["40-50"].append(t)
        elif rsi < 55: rsi_buckets["50-55"].append(t)
        elif rsi < 60: rsi_buckets["55-60"].append(t)
        else: rsi_buckets["60-70"].append(t)
    
    for label, subset in rsi_buckets.items():
        if not subset: continue
        w = sum(1 for t in subset if t.get("result") == "WIN")
        l = sum(1 for t in subset if t.get("result") == "LOSS")
        pnl = sum(float(t.get("pnl",0) or 0) for t in subset)
        total = w + l
        wr = w/total*100 if total > 0 else 0
        avg = pnl/total if total > 0 else 0
        print(f"  RSI {label:6s} | N={total:3d} | WR: {wr:5.1f}% | PnL: ${pnl:9.2f} | Avg: ${avg:6.2f}")
    
    # ── SLIPPAGE ANALYSIS ──
    print("\n" + "="*90)
    print("SLIPPAGE ANALYSIS (profit-intent exit → loss result)")
    print("="*90)
    
    slippage_trades = []
    for t in trades:
        exit_r = str(t.get("exitReason") or t.get("exit_reason") or "").upper()
        profit_intent = any(k in exit_r for k in ["PROFIT", "QP", "MONITOR_EXIT"])
        if profit_intent and t.get("result") == "LOSS":
            slippage_trades.append(t)
    
    if slippage_trades:
        slip_pnls = [float(t.get("pnl",0) or 0) for t in slippage_trades]
        print(f"  Slippage trades: {len(slippage_trades)}")
        print(f"  Total slippage loss: ${sum(slip_pnls):.2f}")
        print(f"  Avg slippage loss: ${sum(slip_pnls)/len(slip_pnls):.2f}")
    else:
        print("  No slippage trades found")
    
    # ── SYMBOL PERFORMANCE ──
    print("\n" + "="*90)
    print("SYMBOL PERFORMANCE")
    print("="*90)
    
    sym_stats = defaultdict(lambda: {"win": 0, "loss": 0, "pnl": 0})
    for t in trades:
        sym = t.get("symbol", "?")
        result = t.get("result", "")
        pnl = float(t.get("pnl", 0) or 0)
        sym_stats[sym]["pnl"] += pnl
        if result == "WIN": sym_stats[sym]["win"] += 1
        elif result == "LOSS": sym_stats[sym]["loss"] += 1
    
    for sym, s in sorted(sym_stats.items(), key=lambda x: -x[1]["pnl"]):
        total = s["win"] + s["loss"]
        wr = s["win"]/total*100 if total > 0 else 0
        print(f"  {sym:8s} | N={total:3d} | WR: {wr:5.1f}% | PnL: ${s['pnl']:9.2f}")

if __name__ == "__main__":
    main()
