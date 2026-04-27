import React, { useLayoutEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
} from "lightweight-charts";

// ── RSI calculation ──────────────────────────────────────────────────────────
function calcRSISeries(bars, period = 14) {
  if (bars.length <= period) return [];
  const closes = bars.map((b) => b.close);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum += Math.abs(d);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const result = [];
  result.push({
    time: bars[period].time,
    value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  });
  for (let i = period + 1; i < bars.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push({
      time: bars[i].time,
      value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
    });
  }
  return result;
}

function calcMASeries(rsiPoints, period = 9) {
  if (rsiPoints.length < period) return [];
  const result = [];
  for (let i = period - 1; i < rsiPoints.length; i++) {
    const avg =
      rsiPoints.slice(i - period + 1, i + 1).reduce((s, p) => s + p.value, 0) /
      period;
    result.push({ time: rsiPoints[i].time, value: avg });
  }
  return result;
}

// Utility: Calculate EMA
function calcEMA(data, period) {
  if (!Array.isArray(data) || data.length < period) return [];
  const k = 2 / (period + 1);
  let emaPrev = data.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  const result = [{ time: data[period - 1].time, value: emaPrev }];
  for (let i = period; i < data.length; i++) {
    const price = data[i].close;
    emaPrev = price * k + emaPrev * (1 - k);
    result.push({ time: data[i].time, value: emaPrev });
  }
  return result;
}

const CandleChart = ({
  data = [],
  obrLines = [],
  rsiPoints = [],
  rsiMaPoints = [],
  rsiMarkers = [],
  emaLines = [], // [{period: 9, color: '#F5C518', data: [...]}, ...]
  emaCrossMarkers = [], // [{time, type: 'buy'|'sell'}]
  rsiMeanReversionMarkers = [], // [{time, type: 'buy'|'sell'}]
  onPointHover,
  onPointLeave,
  fitKey,
  livePrice,
  barDurationSec = 60,
}) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const obrLinesRef = useRef([]);
  const rsiSeriesRef = useRef(null);
  const rsiMaSeriesRef = useRef(null);
  const crossoverMarkersRef = useRef(null);
  const emaSeriesRefs = useRef([]); // For EMA lines
  const emaMarkersRef = useRef(null);
  const rsiMeanReversionMarkersRef = useRef(null);
  const prevFitKeyRef = useRef(null);
  const [hoveredBar, setHoveredBar] = useState(null);

  // Initialize chart on mount
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    try {
      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 400,
        layout: {
          attributionLogo: false,
          background: { color: "#ffffff" },
          textColor: "#555555",
        },
        grid: {
          vertLines: { color: "rgba(0,0,0,0.05)" },
          horzLines: { color: "rgba(0,0,0,0.05)" },
        },
        localization: {
          timeFormatter: (time) => {
            const date = new Date(time * 1000);
            return date.toLocaleString('en-US', {
              timeZone: 'America/Chicago',
              month: 'short', day: 'numeric', year: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false,
            });
          },
        },
        rightPriceScale: { borderColor: 'rgba(0,0,0,0.08)' },
        timeScale: {
          borderColor: 'rgba(0,0,0,0.08)',
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: false,
          tickMarkFormatter: (time) => {
            const date = new Date(time * 1000);
            // Display in CDT (America/Chicago)
            const parts = date.toLocaleTimeString('en-US', {
              timeZone: 'America/Chicago',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
            return parts;
          },
        },
      });

      chartRef.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#16a34a",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#16a34a",
        wickDownColor: "#ef4444",
      });

      candleSeriesRef.current = candleSeries;

      // EMA lines will be added/updated by a separate effect (prevents chart re-creation flicker)

      // Shrink candle area to top 65% so RSI pane fits below
      chart.priceScale('right').applyOptions({
        scaleMargins: { top: 0.02, bottom: 0.33 },
      });

      // Volume series on a separate price scale
      const volumeSeries = chart.addSeries(HistogramSeries, {
        color: 'rgba(201,162,39,0.35)',
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.54, bottom: 0.33 },
      });
      volumeSeriesRef.current = volumeSeries;

      // ── RSI line (bottom 27% of the chart) ───────────────────────────────
      const rsiSeries = chart.addSeries(LineSeries, {
        color: '#7e58c0',
        lineWidth: 1.5,
        priceScaleId: 'rsi',
        title: 'RSI(14)',
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(1) },
      });
      chart.priceScale('rsi').applyOptions({
        scaleMargins: { top: 0.73, bottom: 0.02 },
        borderVisible: false,
        visible: true,
        drawTicks: true,
      });
      // Reference lines at 70 / 50 / 30
      rsiSeries.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.55)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '70' });
      rsiSeries.createPriceLine({ price: 50, color: 'rgba(120,120,120,0.3)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' });
      rsiSeries.createPriceLine({ price: 30, color: 'rgba(22,163,74,0.55)', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: '30' });
      rsiSeriesRef.current = rsiSeries;

      // ── RSI MA line (same RSI price scale) ───────────────────────────────
      const rsiMaSeries = chart.addSeries(LineSeries, {
        color: '#fcd744',
        lineWidth: 1.5,
        priceScaleId: 'rsi',
        title: 'RSI MA(9)',
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(1) },
      });
      rsiMaSeriesRef.current = rsiMaSeries;

      // EMA crossover markers (BUY/SELL)
      // EMA crossover markers will be added/updated by a separate effect (prevents chart re-creation flicker)
      chart.subscribeCrosshairMove((param) => {
        if (!param || !param.time || !param.seriesData) {
          setHoveredBar(null);
          return;
        }
        const bar = param.seriesData.get(candleSeries);
        if (!bar) { setHoveredBar(null); return; }
        const rsiBar   = rsiSeries   ? param.seriesData.get(rsiSeries)   : null;
        const rsiMaBar = rsiMaSeries ? param.seriesData.get(rsiMaSeries) : null;
        const date = new Date(param.time * 1000);
        const timeLabel = date.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          month: 'short', day: 'numeric', year: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        });
        setHoveredBar({
          open: bar.open, high: bar.high, low: bar.low, close: bar.close, time: timeLabel,
          rsi:   rsiBar   != null ? rsiBar.value   : null,
          rsiMa: rsiMaBar != null ? rsiMaBar.value : null,
        });
      });

      const handleResize = () => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({
            width: containerRef.current.clientWidth,
          });
        }
      };

      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);
        if (crossoverMarkersRef.current) {
          crossoverMarkersRef.current.detach();
          crossoverMarkersRef.current = null;
        }
        if (emaMarkersRef.current) {
          try { emaMarkersRef.current.detach(); } catch (_) {}
          emaMarkersRef.current = null;
        }
        if (rsiMeanReversionMarkersRef.current) {
          try { rsiMeanReversionMarkersRef.current.detach(); } catch (_) {}
          rsiMeanReversionMarkersRef.current = null;
        }
        chart.remove();
      };
    } catch (error) {
      console.error("CandleChart: Error initializing chart", error);
    }
  }, []);

  // Update EMA lines and crossover markers without recreating the chart
  useLayoutEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;
    try {
      // remove old EMA series
      if (emaSeriesRefs.current && emaSeriesRefs.current.length) {
        emaSeriesRefs.current.forEach(s => { try { chartRef.current.removeSeries(s); } catch (_) {} });
        emaSeriesRefs.current = [];
      }

      // add new EMA lines
      if (Array.isArray(emaLines) && emaLines.length > 0) {
        emaLines.forEach(ema => {
          const s = chartRef.current.addSeries(LineSeries, {
            color: ema.color,
            lineWidth: 2,
            priceScaleId: 'right',
            title: `EMA${ema.period}`,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceFormat: { type: 'custom', formatter: v => v.toFixed(2) },
          });
          s.setData(ema.data || []);
          emaSeriesRefs.current.push(s);
        });
      }

      // update ema crossover markers
      if (emaMarkersRef.current) {
        try { emaMarkersRef.current.detach(); } catch (_) {}
        emaMarkersRef.current = null;
      }
      if (Array.isArray(emaCrossMarkers) && emaCrossMarkers.length > 0) {
        const markers = emaCrossMarkers.map(m => ({
          time: typeof m.time === 'number' ? m.time : Math.floor(new Date(m.time).getTime() / 1000),
          position: m.type === 'buy' ? 'belowBar' : 'aboveBar',
          color: m.type === 'buy' ? '#16a34a' : '#ef4444',
          shape: m.type === 'buy' ? 'arrowUp' : 'arrowDown',
          size: 2,
          text: m.type === 'buy' ? 'BUY' : 'SELL',
        }));
        emaMarkersRef.current = createSeriesMarkers(candleSeriesRef.current, markers);
      }
    } catch (err) {
      console.warn('CandleChart: failed updating EMAs', err);
    }
  }, [emaLines, emaCrossMarkers]);

  // Update RSI Mean Reversion markers without recreating the chart
  useLayoutEffect(() => {
    if (!candleSeriesRef.current) return;
    try {
      if (rsiMeanReversionMarkersRef.current) {
        try { rsiMeanReversionMarkersRef.current.detach(); } catch (_) {}
        rsiMeanReversionMarkersRef.current = null;
      }

      if (Array.isArray(rsiMeanReversionMarkers) && rsiMeanReversionMarkers.length > 0) {
        const markers = rsiMeanReversionMarkers.map(m => ({
          time: typeof m.time === 'number' ? m.time : Math.floor(new Date(m.time).getTime() / 1000),
          position: m.type === 'buy' ? 'belowBar' : 'aboveBar',
          color: m.type === 'buy' ? '#10b981' : '#dc2626',
          shape: m.type === 'buy' ? 'arrowUp' : 'arrowDown',
          size: 1,
          text: m.type === 'buy' ? 'RSI MR BUY' : 'RSI MR SELL',
        }));
        rsiMeanReversionMarkersRef.current = createSeriesMarkers(candleSeriesRef.current, markers);
      }
    } catch (err) {
      console.warn('CandleChart: failed updating RSI MR markers', err);
    }
  }, [rsiMeanReversionMarkers]);

  // Update chart data when it changes
  useLayoutEffect(() => {
    
    if (!candleSeriesRef.current) {
      
      return;
    }

    if (!data || !data.length) {
      
      return;
    }

    try {
      
      const candleSeries = candleSeriesRef.current;

      // Transform price data to candlestick format if needed
      const chartData = data.map((item, idx) => {
        // Parse time string to preserve full timestamp for intraday data
        let timeStr = item.time;
        let unixTime = timeStr;

        if (typeof timeStr === 'string') {
          // Convert to Unix timestamp, preserving the full time (not just date)
          const dateObj = new Date(timeStr);
          unixTime = Math.floor(dateObj.getTime() / 1000);
        }

        // Use OHLC data from backend (real candlestick data)
        if (item.open !== undefined && item.high !== undefined && item.low !== undefined && item.close !== undefined) {
          const validOpen = parseFloat(item.open);
          const validHigh = parseFloat(item.high);
          const validLow = parseFloat(item.low);
          const validClose = parseFloat(item.close);

          if (!isNaN(validOpen) && !isNaN(validHigh) && !isNaN(validLow) && !isNaN(validClose)) {
            return {
              time: unixTime,
              open: validOpen,
              high: validHigh,
              low: validLow,
              close: validClose,
            };
          }
        }

        // Fallback: Convert single price point to candlestick
        if (item.price !== undefined) {
          const price = parseFloat(item.price);
          if (!isNaN(price)) {
            return {
              time: unixTime,
              open: price,
              high: price,
              low: price,
              close: price,
            };
          }
        }

        // Skip invalid data
        return null;
      }).filter(item => item !== null);


      if (chartData.length === 0) {
        return () => chart.remove();
      }

      // Deduplicate bars by timestamp - keep only the last bar for each unique time
      const timeMap = new Map();
      for (const item of chartData) {
        const timeKey = typeof item.time === 'number' ? item.time : Math.floor(new Date(item.time).getTime() / 1000);
        timeMap.set(timeKey, item);
      }
      
      // Sort by time and convert back to array
      const uniqueData = Array.from(timeMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([_, item]) => item);
      
      candleSeries.setData(uniqueData);

      // Volume data
      if (volumeSeriesRef.current) {
        const volData = uniqueData.map(bar => ({
          time: bar.time,
          value: bar.volume || 0,
          color: bar.close >= bar.open ? 'rgba(22,163,74,0.4)' : 'rgba(239,68,68,0.4)',
        }))
        volumeSeriesRef.current.setData(volData)
      }

      // Remove old OBR lines before adding new ones
      obrLinesRef.current.forEach(pl => { try { candleSeries.removePriceLine(pl) } catch (_) {} })
      obrLinesRef.current = []

      if (obrLines && obrLines.length > 0) {
        obrLines.forEach(line => {
          const pl = candleSeries.createPriceLine({
            price: line.price,
            color: line.color,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: line.label,
          })
          obrLinesRef.current.push(pl)
        })
      }

      const toUnixTime = (v) => {
        if (typeof v === 'number') return v;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
      };

      // ── RSI + RSI MA (prefer backend payload) ────────────────────────────
      if (rsiSeriesRef.current && rsiMaSeriesRef.current) {
        const backendRsiPoints = Array.isArray(rsiPoints)
          ? rsiPoints
            .map(p => ({ time: toUnixTime(p.timestamp ?? p.time), value: Number(p.value) }))
            .filter(p => p.time != null && Number.isFinite(p.value))
          : [];

        const backendMaPoints = Array.isArray(rsiMaPoints)
          ? rsiMaPoints
            .map(p => ({ time: toUnixTime(p.timestamp ?? p.time), value: Number(p.value) }))
            .filter(p => p.time != null && Number.isFinite(p.value))
          : [];

        const chartRsiPoints = backendRsiPoints.length > 0 ? backendRsiPoints : calcRSISeries(uniqueData, 14);
        const chartMaPoints = backendMaPoints.length > 0 ? backendMaPoints : calcMASeries(chartRsiPoints, 9);

        rsiSeriesRef.current.setData(chartRsiPoints);
        rsiMaSeriesRef.current.setData(chartMaPoints);

        // ── RSI markers from backend (fallback to local calc) ─────────────
        const backendMarkers = Array.isArray(rsiMarkers)
          ? rsiMarkers
            .map(m => {
              const t = toUnixTime(m.timestamp ?? m.time);
              if (t == null) return null;
              const down = String(m.direction || '').toLowerCase() === 'down' || String(m.signal || '').toUpperCase() === 'PUT';
              return {
                time: t,
                position: down ? 'aboveBar' : 'belowBar',
                color: down ? '#ef4444' : '#16a34a',
                shape: down ? 'arrowDown' : 'arrowUp',
                size: 1,
              };
            })
            .filter(Boolean)
          : [];

        const crossovers = backendMarkers;
        if (crossoverMarkersRef.current) {
          crossoverMarkersRef.current.setMarkers(crossovers);
        } else {
          crossoverMarkersRef.current = createSeriesMarkers(candleSeries, crossovers);
        }
      }

      if (chartRef.current && uniqueData.length > 0 && prevFitKeyRef.current !== fitKey) {
        prevFitKeyRef.current = fitKey;
        const timeScale = chartRef.current.timeScale();

        // Calculate visible range — show all bars with minimal right padding
        // (1–2 bar widths only so no future empty space appears on the x-axis)
        const lastTime  = uniqueData[uniqueData.length - 1].time;
        const firstTime = uniqueData[0].time;
        const barSpan   = uniqueData.length > 1
          ? (lastTime - firstTime) / (uniqueData.length - 1)
          : 300; // default 5 min in seconds

        const leftPad  = barSpan * 2;
        const rightPad = barSpan * 3; // only 3 bars of padding on the right

        timeScale.setVisibleRange({
          from: firstTime - leftPad,
          to:   lastTime  + rightPad,
        });
      }
    } catch (error) {
      console.error("CandleChart Error:", error);
    }
  }, [data, obrLines, rsiPoints, rsiMaPoints, rsiMarkers]);

  // ── Live price tick: update last candle's close/high/low in real time ──────
  useLayoutEffect(() => {
    if (!candleSeriesRef.current || livePrice == null || !data || !data.length) return
    const lastBar = data[data.length - 1]
    if (!lastBar) return
    const lastTime = typeof lastBar.time === 'string'
      ? Math.floor(new Date(lastBar.time).getTime() / 1000)
      : lastBar.time
    if (!lastTime) return
    const price = Number(livePrice)
    if (!isFinite(price) || price <= 0) return

    // Only inject the live price into the bar that is still OPEN (within its period).
    // If the last bar in data is a completed historical bar (older than 2 bar periods),
    // skip the update — injecting a stale live price would create a spike candle and
    // distort the Y-axis, making the chart freeze on scroll.
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec - lastTime > barDurationSec * 2) return

    try {
      candleSeriesRef.current.update({
        time: lastTime,
        open:  Number(lastBar.open),
        high:  Math.max(Number(lastBar.high), price),
        low:   Math.min(Number(lastBar.low), price),
        close: price,
      })
    } catch (_) {}
  }, [livePrice]) // eslint-disable-line react-hooks/exhaustive-deps

  const fmtP = (v) => v?.toFixed(2) ?? '—';
  const isUp = hoveredBar ? hoveredBar.close >= hoveredBar.open : true;

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "visible", position: 'relative' }}>
      {/* OHLC Overlay */}
      {hoveredBar && (
        <div style={{
          position: 'absolute', top: '10px', left: '12px', zIndex: 10,
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          background: 'rgba(255,255,255,0.92)',
          border: '1px solid rgba(0,0,0,0.07)',
          borderRadius: '8px',
          padding: '5px 12px',
          fontSize: '0.75rem',
          fontWeight: 700,
          pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          backdropFilter: 'blur(4px)',
        }}>
          <span style={{ color: '#999', fontWeight: 500, fontSize: '0.68rem' }}>{hoveredBar.time}</span>
          {[
            { label: 'O', value: fmtP(hoveredBar.open),  color: isUp ? '#16a34a' : '#ef4444' },
            { label: 'H', value: fmtP(hoveredBar.high),  color: '#16a34a' },
            { label: 'L', value: fmtP(hoveredBar.low),   color: '#ef4444' },
            { label: 'C', value: fmtP(hoveredBar.close), color: isUp ? '#16a34a' : '#ef4444' },
          ].map(({ label, value, color }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
              <span style={{ color: '#bbb', fontWeight: 600, fontSize: '0.65rem' }}>{label}</span>
              <span style={{ color }}>{value}</span>
            </span>
          ))}
          {/* Divider */}
          <span style={{ width: '1px', height: '14px', background: 'rgba(0,0,0,0.1)', display: 'inline-block' }} />
          {hoveredBar.rsi != null && (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
              <span style={{ color: '#bbb', fontWeight: 600, fontSize: '0.65rem' }}>RSI</span>
              <span style={{
                color: hoveredBar.rsi >= 70 ? '#ef4444' : hoveredBar.rsi <= 30 ? '#16a34a' : '#C9A227',
                fontWeight: 800,
              }}>{hoveredBar.rsi.toFixed(1)}</span>
            </span>
          )}
          {hoveredBar.rsiMa != null && (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
              <span style={{ color: '#bbb', fontWeight: 600, fontSize: '0.65rem' }}>MA</span>
              <span style={{ color: '#2563eb', fontWeight: 800 }}>{hoveredBar.rsiMa.toFixed(1)}</span>
            </span>
          )}
        </div>
      )}
      {/* Chart Container */}
      <div
        ref={containerRef}
        style={{ width: "100%", minHeight: "400px", flex: 1, overflow: "visible" }}
      />
    </div>
  );
};

export default CandleChart;
