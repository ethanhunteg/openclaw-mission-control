import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import {
  classifyLiveWork,
  collectAuditPages,
  filterSuppressedRows,
  findActiveRunCandidates,
  findActiveTool,
  mapWithConcurrency,
  prioritizeLiveRows,
  summarizeLiveRows,
  type AuditEvent,
  type ActiveRunCandidate,
} from "@/lib/live-work";
import { loadLiveWorkSuppressions } from "@/lib/live-work-suppressions";

export const dynamic = "force-dynamic";
const SUCCESS_CACHE_MS = 30_000;
let cachedSuccess: { expiresAt: number; body: Record<string, unknown> } | undefined;
type RefreshResult = { body: Record<string, unknown>; status: 200 | 503 };
let refreshInFlight: Promise<RefreshResult> | undefined;

type AuditListResult = { events?: AuditEvent[]; nextCursor?: string };
type SessionDescription = {
  session?: {
    key?: string;
    displayName?: string;
    groupChannel?: string;
    channel?: string;
    status?: string;
    startedAt?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    modelProvider?: string;
    model?: string;
    origin?: { label?: string; threadId?: string };
  };
};

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
  truthState: "running" | "stale" | "orphaned" | "unverified";
  lastProgressAt: number;
  staleForMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  isWorker: boolean;
  suppressed?: boolean;
};

async function describeCandidate(candidate: ActiveRunCandidate): Promise<LiveWorkRow | null> {
  let session: SessionDescription["session"];
  let describeFailed = false;
  try {
    const described = await gatewayCall<SessionDescription>(
      "sessions.describe",
      { key: candidate.sessionKey },
      6000,
    );
    session = described.session;
  } catch {
    describeFailed = true;
  }

  let tool: ReturnType<typeof findActiveTool> = null;
  try {
    const toolEvents = await gatewayCall<AuditListResult>(
      "audit.list",
      { kind: "tool_action", runId: candidate.runId, limit: 100 },
      6000,
    );
    tool = findActiveTool(toolEvents.events || []);
  } catch {
    // Run truth is still shown, but freshness falls back to the run event.
  }

  const truth = classifyLiveWork({
    candidate,
    sessionStatus: session?.status,
    lastProgressAt: tool?.startedAt,
    now: Date.now(),
    freshnessMs: 10 * 60 * 1000,
    describeFailed,
  });
  const provider = String(session?.modelProvider || "").trim();
  const modelName = String(session?.model || "unknown").trim();
  const model = modelName.includes("/") || !provider ? modelName : `${provider}/${modelName}`;
  const isWorker = candidate.sessionKey.includes(":subagent:");
  const title =
    String(session?.displayName || "").trim() ||
    String(session?.origin?.label || "").trim() ||
    candidate.sessionKey;

  return {
    runId: candidate.runId,
    sessionKey: candidate.sessionKey,
    sessionId: candidate.sessionId,
    title,
    channel: session?.channel || session?.groupChannel || null,
    agentId: candidate.agentId,
    model,
    state: tool ? "tool" : "model",
    stateLabel: truth.truthState === "running"
      ? (tool ? `Tool: ${tool.name}` : "Model call / agent reasoning")
      : truth.truthState,
    toolName: tool?.name || null,
    startedAt: Number(session?.startedAt || candidate.startedAt),
    stateStartedAt: tool?.startedAt || Number(session?.startedAt || candidate.startedAt),
    truthState: truth.truthState,
    lastProgressAt: truth.lastProgressAt,
    staleForMs: truth.staleForMs,
    inputTokens: Number(session?.inputTokens || 0),
    outputTokens: Number(session?.outputTokens || 0),
    totalTokens: Number(session?.totalTokens || 0),
    isWorker,
  };
}
async function refreshLiveWork(
  generatedAt: number,
  options: { includeSuppressed: boolean; limit: number },
): Promise<RefreshResult> {
  const warnings: string[] = [];
  try {
    const allRunEvents = await collectAuditPages((cursor) =>
      gatewayCall<AuditListResult>(
        "audit.list",
        { kind: "agent_run", limit: 500, ...(cursor ? { cursor } : {}) },
        8000,
      ),
    );
    const candidates = findActiveRunCandidates(allRunEvents);
    const settled = await mapWithConcurrency(candidates, 4, describeCandidate);
    const rows: LiveWorkRow[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (result.value) rows.push(result.value);
      } else {
        warnings.push("One active-run candidate could not be enriched.");
      }
    }
    const suppressions = await loadLiveWorkSuppressions();
    if (suppressions.warning) warnings.push(suppressions.warning);
    const rowsWithSuppression = rows.map((row) => ({
      ...row,
      suppressed: suppressions.entries.has(row.runId),
    }));
    const suppressibleRunIds = new Set(
      suppressions.stale
        ? []
        : rowsWithSuppression
          .filter((row) => row.suppressed && (row.truthState === "orphaned" || row.truthState === "unverified"))
          .map((row) => row.runId),
    );
    const suppressionResult = filterSuppressedRows(rowsWithSuppression, suppressibleRunIds, options.includeSuppressed);
    const visibleRows = prioritizeLiveRows(suppressionResult.rows);
    const displayedRows = options.limit === 0 ? visibleRows : visibleRows.slice(0, Math.max(1, options.limit));
    const body = {
      ok: true,
      generatedAt,
      rows: displayedRows,
      totalRows: visibleRows.length,
      summary: summarizeLiveRows(visibleRows, suppressionResult.suppressed),
      warnings: [...new Set(warnings)],
    };
    return { body, status: 200 };
  } catch (error) {
    return {
      status: 503,
      body: {
        ok: false,
        generatedAt,
        rows: [],
        summary: { active: 0, modelCalls: 0, toolCalls: 0, workers: 0, stale: 0, orphaned: 0, unverified: 0, suppressed: 0 },
        warnings,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeSuppressed = url.searchParams.get("includeSuppressed") === "1";
  const rawLimit = (url.searchParams.get("limit") || "12").trim().toLowerCase();
  const requestedLimit = rawLimit === "all" ? 0 : Number(rawLimit);
  const limit = requestedLimit === 0
    ? 0
    : Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 5000)
      : 12;
  const generatedAt = Date.now();
  const useDefaultCache = !includeSuppressed && limit === 12;
  if (useDefaultCache && cachedSuccess && cachedSuccess.expiresAt > generatedAt) {
    return NextResponse.json(cachedSuccess.body, {
      headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=25" },
    });
  }

  const activeRefresh = useDefaultCache
    ? (refreshInFlight ?? refreshLiveWork(generatedAt, { includeSuppressed, limit }))
    : refreshLiveWork(generatedAt, { includeSuppressed, limit });
  if (useDefaultCache) refreshInFlight = activeRefresh;
  let result: RefreshResult;
  try {
    result = await activeRefresh;
  } finally {
    if (useDefaultCache && refreshInFlight === activeRefresh) refreshInFlight = undefined;
  }
  if (useDefaultCache && result.status === 200) {
    cachedSuccess = { expiresAt: Date.now() + SUCCESS_CACHE_MS, body: result.body };
  }
  return NextResponse.json(result.body, {
    status: result.status,
    ...(result.status === 200
      ? { headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=25" } }
      : {}),
  });
}
