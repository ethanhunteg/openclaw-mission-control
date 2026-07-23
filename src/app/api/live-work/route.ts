import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import {
  classifyLiveWork,
  collectAuditPages,
  findActiveRunCandidates,
  findActiveTool,
  mapWithConcurrency,
  prioritizeLiveRows,
  type AuditEvent,
  type ActiveRunCandidate,
} from "@/lib/live-work";

export const dynamic = "force-dynamic";

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
export async function GET() {
  const generatedAt = Date.now();
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
    const displayedRows = prioritizeLiveRows(rows).slice(0, 12);
    return NextResponse.json({
      ok: true,
      generatedAt,
      rows: displayedRows,
      summary: {
        active: rows.filter((row) => row.truthState === "running").length,
        modelCalls: rows.filter((row) => row.truthState === "running" && row.state === "model").length,
        toolCalls: rows.filter((row) => row.truthState === "running" && row.state === "tool").length,
        workers: rows.filter((row) => row.truthState === "running" && row.isWorker).length,
        stale: rows.filter((row) => row.truthState === "stale").length,
        orphaned: rows.filter((row) => row.truthState === "orphaned").length,
        unverified: rows.filter((row) => row.truthState === "unverified").length,
      },
      warnings: [...new Set(warnings)],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        generatedAt,
        rows: [],
        summary: { active: 0, modelCalls: 0, toolCalls: 0, workers: 0, stale: 0, orphaned: 0, unverified: 0 },
        warnings,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
