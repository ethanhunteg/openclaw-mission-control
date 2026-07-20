import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import {
  findActiveRunCandidates,
  findActiveTool,
  type AuditEvent,
  type ActiveRunCandidate,
} from "@/lib/live-work";

export const dynamic = "force-dynamic";

type AuditListResult = { events?: AuditEvent[] };
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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  isWorker: boolean;
};

async function describeCandidate(candidate: ActiveRunCandidate): Promise<LiveWorkRow | null> {
  const described = await gatewayCall<SessionDescription>(
    "sessions.describe",
    { key: candidate.sessionKey },
    6000,
  );
  const session = described.session;
  if (!session || session.status !== "running") return null;

  let tool: ReturnType<typeof findActiveTool> = null;
  try {
    const toolEvents = await gatewayCall<AuditListResult>(
      "audit.list",
      { kind: "tool_action", runId: candidate.runId, limit: 100 },
      6000,
    );
    tool = findActiveTool(toolEvents.events || []);
  } catch {
    // The run is still useful even when tool-state enrichment times out.
  }

  const provider = String(session.modelProvider || "").trim();
  const modelName = String(session.model || "unknown").trim();
  const model = modelName.includes("/") || !provider ? modelName : `${provider}/${modelName}`;
  const isWorker = candidate.sessionKey.includes(":subagent:");
  const title =
    String(session.displayName || "").trim() ||
    String(session.origin?.label || "").trim() ||
    candidate.sessionKey;

  return {
    runId: candidate.runId,
    sessionKey: candidate.sessionKey,
    sessionId: candidate.sessionId,
    title,
    channel: session.channel || session.groupChannel || null,
    agentId: candidate.agentId,
    model,
    state: tool ? "tool" : "model",
    stateLabel: tool ? `Tool: ${tool.name}` : "Model call / agent reasoning",
    toolName: tool?.name || null,
    startedAt: Number(session.startedAt || candidate.startedAt),
    stateStartedAt: tool?.startedAt || Number(session.startedAt || candidate.startedAt),
    inputTokens: Number(session.inputTokens || 0),
    outputTokens: Number(session.outputTokens || 0),
    totalTokens: Number(session.totalTokens || 0),
    isWorker,
  };
}
export async function GET() {
  const generatedAt = Date.now();
  const warnings: string[] = [];
  try {
    const runEvents = await gatewayCall<AuditListResult>(
      "audit.list",
      { kind: "agent_run", after: generatedAt - 24 * 60 * 60 * 1000, limit: 500 },
      8000,
    );
    const candidates = findActiveRunCandidates(runEvents.events || []).slice(0, 12);
    const settled = await Promise.allSettled(candidates.map(describeCandidate));
    const rows: LiveWorkRow[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (result.value) rows.push(result.value);
      } else {
        warnings.push("One active-run candidate could not be enriched.");
      }
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return NextResponse.json({
      ok: true,
      generatedAt,
      rows,
      summary: {
        active: rows.length,
        modelCalls: rows.filter((row) => row.state === "model").length,
        toolCalls: rows.filter((row) => row.state === "tool").length,
        workers: rows.filter((row) => row.isWorker).length,
      },
      warnings: [...new Set(warnings)],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        generatedAt,
        rows: [],
        summary: { active: 0, modelCalls: 0, toolCalls: 0, workers: 0 },
        warnings,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
