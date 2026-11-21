import React from "react";
import { createRoot } from "react-dom/client";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";

const roots = new WeakMap();

function getThemePalette(theme) {
  const isDark = theme === "dark";
  return {
    grid: isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(15, 23, 42, 0.07)",
    tick: isDark ? "#64748b" : "#94a3b8",
    memStroke: isDark ? "#60a5fa" : "#2563eb",
    heapStroke: isDark ? "#a78bfa" : "#7c3aed",
    tpsStroke: isDark ? "#4ade80" : "#16a34a",
    warnLine: isDark ? "rgba(251, 191, 36, 0.45)" : "rgba(217, 119, 6, 0.45)",
    tooltipBg: isDark ? "#151a24" : "#ffffff",
    tooltipBorder: isDark ? "rgba(255, 255, 255, 0.14)" : "rgba(15, 23, 42, 0.12)",
    tooltipTitle: isDark ? "#f1f5f9" : "#0f172a",
    tooltipLabel: isDark ? "#94a3b8" : "#475569",
  };
}

function MemTooltip({ active, payload, label, palette }) {
  if (!active || !payload || !payload.length) return null;
  const pt = payload[0]?.payload || {};
  return (
    <div
      style={{
        background: palette.tooltipBg,
        border: `1px solid ${palette.tooltipBorder}`,
        borderRadius: 8,
        padding: "8px 11px",
        fontSize: 11.5,
        boxShadow: "0 10px 24px -8px rgba(15,23,42,0.22)",
        fontVariantNumeric: "tabular-nums",
        minWidth: 168,
      }}
    >
      <div style={{ fontWeight: 600, color: palette.tooltipTitle, marginBottom: 5, fontFamily: "var(--mono)" }}>
        {label || pt.time || "--:--:--"}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel, marginBottom: 2 }}>
        <span>系统内存</span>
        <strong style={{ color: palette.memStroke }}>{Number(pt.mem_pct || 0).toFixed(1)}%</strong>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel, marginBottom: 2 }}>
        <span>已用 / 总计</span>
        <span style={{ color: palette.tooltipTitle, fontFamily: "var(--mono)" }}>
          {Math.round(pt.mem_used_mb || 0)} / {Math.round(pt.mem_total_mb || 0)} MB
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel, marginBottom: 2 }}>
        <span>Node RSS</span>
        <span style={{ color: palette.tooltipTitle, fontFamily: "var(--mono)" }}>{Number(pt.proc_rss_mb || 0).toFixed(1)} MB</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel }}>
        <span>V8 堆内存</span>
        <span style={{ color: palette.heapStroke, fontFamily: "var(--mono)" }}>
          {Number(pt.heap_used_mb || 0).toFixed(1)} MB ({Number(pt.heap_pct || 0).toFixed(0)}%)
        </span>
      </div>
    </div>
  );
}

function TpsTooltip({ active, payload, label, palette }) {
  if (!active || !payload || !payload.length) return null;
  const pt = payload[0]?.payload || {};
  return (
    <div
      style={{
        background: palette.tooltipBg,
        border: `1px solid ${palette.tooltipBorder}`,
        borderRadius: 8,
        padding: "8px 11px",
        fontSize: 11.5,
        boxShadow: "0 10px 24px -8px rgba(15,23,42,0.22)",
        fontVariantNumeric: "tabular-nums",
        minWidth: 160,
      }}
    >
      <div style={{ fontWeight: 600, color: palette.tooltipTitle, marginBottom: 5, fontFamily: "var(--mono)" }}>
        {label || pt.time || "--:--:--"}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel, marginBottom: 2 }}>
        <span>Token 速度</span>
        <strong style={{ color: palette.tpsStroke }}>{Number(pt.tps || 0).toFixed(1)} tok/s</strong>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel, marginBottom: 2 }}>
        <span>首字延迟</span>
        <span style={{ color: palette.tooltipTitle, fontFamily: "var(--mono)" }}>
          {pt.ttft_ms ? `${Math.round(pt.ttft_ms)} ms` : "--"}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, color: palette.tooltipLabel }}>
        <span>活跃推理</span>
        <span style={{ color: palette.tooltipTitle, fontFamily: "var(--mono)" }}>{Number(pt.active_turns || 0)} 路</span>
      </div>
    </div>
  );
}

function PerfChartsApp({ history = [], current = {}, summary = {}, theme = "light" }) {
  const palette = getThemePalette(theme);
  const series = Array.isArray(history) && history.length > 0
    ? history
    : [{
      time: current.time || "--:--:--",
      mem_pct: Number(current.mem_pct || 0),
      heap_pct: Number(current.heap_pct || 0),
      mem_used_mb: Number(current.mem_used_mb || 0),
      mem_total_mb: Number(current.mem_total_mb || 0),
      proc_rss_mb: Number(current.proc_rss_mb || 0),
      heap_used_mb: Number(current.heap_used_mb || 0),
      tps: Number(current.tps || 0),
      ttft_ms: Number(current.ttft_ms || 0),
      active_turns: Number(current.active_turns || 0),
    }];

  const maxTps = Math.max(20, ...series.map((p) => Number(p.tps || 0)));
  const tpsCeiling = Math.ceil((maxTps * 1.25) / 10) * 10;

  return (
    <div className="perf-charts-grid">
      <div className="perf-chart-card">
        <div className="perf-chart-head">
          <div>
            <div className="perf-chart-title">实时内存使用率</div>
            <div className="perf-chart-sub">系统物理内存占比与 Node V8 堆利用率</div>
          </div>
          <div className="perf-chart-legend">
            <span className="perf-legend-item">
              <i className="perf-legend-dot" style={{ background: palette.memStroke }} />
              系统 {Number(current.mem_pct || 0).toFixed(1)}%
            </span>
            <span className="perf-legend-item">
              <i className="perf-legend-dot" style={{ background: palette.heapStroke }} />
              V8 堆 {Number(current.heap_pct || 0).toFixed(0)}%
            </span>
          </div>
        </div>
        <div className="perf-chart-canvas" data-chart="memory">
          <ResponsiveContainer width="100%" height={184}>
            <AreaChart data={series} margin={{ top: 8, right: 10, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="afMemGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={palette.memStroke} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={palette.memStroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10.5, fill: palette.tick, fontFamily: "var(--mono)" }}
                tickLine={false}
                axisLine={{ stroke: palette.grid }}
                minTickGap={28}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10.5, fill: palette.tick, fontFamily: "var(--mono)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip content={<MemTooltip palette={palette} />} />
              <ReferenceLine y={80} stroke={palette.warnLine} strokeDasharray="4 4" />
              <Area
                type="monotone"
                dataKey="mem_pct"
                name="系统内存"
                stroke={palette.memStroke}
                strokeWidth={2}
                fill="url(#afMemGrad)"
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: palette.memStroke }}
              />
              <Area
                type="monotone"
                dataKey="heap_pct"
                name="V8 堆内存"
                stroke={palette.heapStroke}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                fill="none"
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0, fill: palette.heapStroke }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="perf-chart-card">
        <div className="perf-chart-head">
          <div>
            <div className="perf-chart-title">Token 处理速度</div>
            <div className="perf-chart-sub">实时流式吞吐与历史峰值（tok/s）</div>
          </div>
          <div className="perf-chart-legend">
            <span className="perf-legend-item">
              <i className="perf-legend-dot" style={{ background: palette.tpsStroke }} />
              当前 {Number(current.tps || 0).toFixed(1)} tok/s
            </span>
            <span className="perf-legend-item is-muted">
              峰值 {Number(summary.peak_tps || 0).toFixed(1)}
            </span>
          </div>
        </div>
        <div className="perf-chart-canvas" data-chart="tps">
          <ResponsiveContainer width="100%" height={184}>
            <AreaChart data={series} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="afTpsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={palette.tpsStroke} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={palette.tpsStroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10.5, fill: palette.tick, fontFamily: "var(--mono)" }}
                tickLine={false}
                axisLine={{ stroke: palette.grid }}
                minTickGap={28}
              />
              <YAxis
                domain={[0, tpsCeiling]}
                tick={{ fontSize: 10.5, fill: palette.tick, fontFamily: "var(--mono)" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<TpsTooltip palette={palette} />} />
              <Area
                type="monotone"
                dataKey="tps"
                name="Token 速率"
                stroke={palette.tpsStroke}
                strokeWidth={2}
                fill="url(#afTpsGrad)"
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: palette.tpsStroke }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

export function mountPerfCharts(container, props = {}) {
  if (!container) return;
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(<PerfChartsApp {...props} />);
}

export function unmountPerfCharts(container) {
  if (!container) return;
  const root = roots.get(container);
  if (root) {
    try { root.unmount(); } catch { /* ignore */ }
    roots.delete(container);
  }
}
