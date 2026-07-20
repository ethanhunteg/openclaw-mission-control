"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Activity, Bot, BrainCircuit, RefreshCw, Terminal, Users } from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { cn } from "@/lib/utils";

type LiveWorkRow = {
  runId: string;
  sessionKey: string;
  sessionId: string | null;
  title: string;
  channel: string | null;
  agentId: string;
  model: string;
  state: "model" | "tool" | "queued";
  stateLabel: string;
  toolName: string | null;
  startedAt: number;
  stateStartedAt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  isWorker: boolean;
  tokenDelta?: number;
};

type LiveWorkResponse = {
  ok: boolean;
  generatedAt: number;
  rows: LiveWorkRow[];
  summary: { active: number; modelCalls: number; toolCalls: number; workers: number };
  warnings?: string[];
  error?: string;
};

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function LiveWorkView() {
  const [data, setData] = useState<LiveWorkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const previousTokens = useRef(new Map<string, number>());

  const fetchLiveWork = useCallback(async () => {
    try {
      const response = await fetch("/api/live-work", { cache: "no-store" });
      const payload = (await response.json()) as LiveWorkResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      payload.rows = payload.rows.map((row) => {
        const previous = previousTokens.current.get(row.runId);
        previousTokens.current.set(row.runId, row.totalTokens);
        return { ...row, tokenDelta: previous === undefined ? 0 : Math.max(0, row.totalTokens - previous) };
      });
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useSmartPoll(fetchLiveWork, { intervalMs: 5_000 });
  const now = Date.now();
  const rows = data?.rows || [];
  const stats = useMemo(
    () => {
      const summary = data?.summary || { active: 0, modelCalls: 0, toolCalls: 0, workers: 0 };
      return [
        { label: "Active runs", value: summary.active, icon: Activity },
        { label: "Model / reasoning", value: summary.modelCalls, icon: BrainCircuit },
        { label: "Tools", value: summary.toolCalls, icon: Terminal },
        { label: "Workers", value: summary.workers, icon: Users },
      ];
    },
    [data?.summary],
  );

  return (
    <SectionLayout>
      <SectionHeader
        title="Live Work"
        description="What is executing now — model calls, tool work, and spawned workers."
        meta="Token totals update when the provider reports usage; run state refreshes every 5 seconds."
        actions={
          <button onClick={() => void fetchLiveWork()} className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600 hover:bg-stone-100 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9]">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />
      <SectionBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
              <div className="flex items-center justify-between text-stone-500 dark:text-[#8d98a5]"><span className="text-xs font-medium">{label}</span><Icon className="h-4 w-4" /></div>
              <p className="mt-2 text-2xl font-bold text-stone-900 dark:text-[#f5f7fa]">{value}</p>
            </div>
          ))}
        </div>

        {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">Live telemetry unavailable: {error}</div>}
        {data?.warnings?.map((warning) => <div key={warning} className="mt-3 text-xs text-amber-600 dark:text-amber-300">{warning}</div>)}

        <div className="mt-6 space-y-3">
          {loading && !data ? (
            <div className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500 dark:border-[#2c343d] dark:bg-[#171a1d]">Reading live Gateway state…</div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-stone-200 bg-white p-8 text-center dark:border-[#2c343d] dark:bg-[#171a1d]">
              <p className="text-sm font-semibold text-stone-800 dark:text-[#e6ebf0]">No work is executing right now</p>
              <p className="mt-1 text-xs text-stone-500 dark:text-[#8d98a5]">Queued and completed sessions are intentionally excluded.</p>
            </div>
          ) : rows.map((row) => (
            <div key={row.runId} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 animate-pulse rounded-full", row.state === "model" ? "bg-violet-500" : "bg-emerald-500")} />
                    <h2 className="truncate text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">{row.title}</h2>
                    {row.isWorker && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">worker</span>}
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-stone-400 dark:text-[#7a8591]">{row.sessionKey}</p>
                </div>
                <div className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", row.state === "model" ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300")}>
                  {row.stateLabel}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <div><p className="text-stone-400">Agent</p><p className="mt-1 font-semibold text-stone-700 dark:text-[#d6dde5]"><Bot className="mr-1 inline h-3.5 w-3.5" />{row.agentId}</p></div>
                <div><p className="text-stone-400">Model</p><p className="mt-1 truncate font-semibold text-stone-700 dark:text-[#d6dde5]">{row.model}</p></div>
                <div><p className="text-stone-400">Run time</p><p className="mt-1 font-semibold text-stone-700 dark:text-[#d6dde5]">{elapsed(row.startedAt, now)}</p></div>
                <div><p className="text-stone-400">Input</p><p className="mt-1 font-semibold text-stone-700 dark:text-[#d6dde5]">{formatTokens(row.inputTokens)}</p></div>
                <div><p className="text-stone-400">Output</p><p className="mt-1 font-semibold text-stone-700 dark:text-[#d6dde5]">{formatTokens(row.outputTokens)}</p></div>
                <div><p className="text-stone-400">Reported total</p><p className="mt-1 font-semibold text-stone-700 dark:text-[#d6dde5]">{formatTokens(row.totalTokens)}{row.tokenDelta ? <span className="ml-1 text-emerald-600">+{formatTokens(row.tokenDelta)}</span> : null}</p></div>
              </div>
            </div>
          ))}
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
