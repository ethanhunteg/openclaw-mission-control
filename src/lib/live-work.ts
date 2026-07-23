export type AuditActor = { type?: string; id?: string };

export type AuditEvent = {
  eventId?: string;
  occurredAt?: number;
  kind?: "agent_run" | "tool_action";
  action?: string;
  status?: string;
  actor?: AuditActor;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
};

export type ActiveRunCandidate = {
  runId: string;
  sessionKey: string;
  sessionId: string | null;
  agentId: string;
  startedAt: number;
  lastEventAt: number;
};

export type LiveTruthState = "running" | "stale" | "orphaned" | "unverified";

export async function collectAuditPages(
  fetchPage: (cursor?: string) => Promise<{ events?: AuditEvent[]; nextCursor?: string }>,
  maxPages = 100,
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    events.push(...(result.events || []));
    cursor = result.nextCursor;
    if (!cursor) return events;
  }
  throw new Error("Audit history exceeded the bounded pagination limit; active-work totals are not safe to report.");
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
]);

export function findActiveRunCandidates(events: AuditEvent[]): ActiveRunCandidate[] {
  const latestByRun = new Map<string, AuditEvent>();
  const startedByRun = new Map<string, AuditEvent>();

  for (const event of events) {
    if (event.kind !== "agent_run" || !event.runId) continue;
    const previous = latestByRun.get(event.runId);
    if (!previous || Number(event.occurredAt || 0) > Number(previous.occurredAt || 0)) {
      latestByRun.set(event.runId, event);
    }
    if (event.status === "started") {
      const previousStart = startedByRun.get(event.runId);
      if (!previousStart || Number(event.occurredAt || 0) < Number(previousStart.occurredAt || 0)) {
        startedByRun.set(event.runId, event);
      }
    }
  }

  const candidates: ActiveRunCandidate[] = [];
  for (const [runId, latest] of latestByRun) {
    if (TERMINAL_RUN_STATUSES.has(String(latest.status || ""))) continue;
    const start = startedByRun.get(runId);
    if (!start?.sessionKey) continue;
    candidates.push({
      runId,
      sessionKey: start.sessionKey,
      sessionId: start.sessionId || null,
      agentId: start.agentId || start.actor?.id || "unknown",
      startedAt: Number(start.occurredAt || 0),
      lastEventAt: Number(latest.occurredAt || start.occurredAt || 0),
    });
  }

  return candidates.sort((a, b) => b.startedAt - a.startedAt);
}

export function classifyLiveWork(params: {
  candidate: ActiveRunCandidate;
  sessionStatus?: string;
  lastProgressAt?: number;
  now: number;
  freshnessMs: number;
  describeFailed?: boolean;
}): { truthState: LiveTruthState; lastProgressAt: number; staleForMs: number } {
  const lastProgressAt = Math.max(
    Number(params.candidate.lastEventAt || 0),
    Number(params.lastProgressAt || 0),
  );
  const staleForMs = Math.max(0, params.now - lastProgressAt);
  if (params.describeFailed) return { truthState: "unverified", lastProgressAt, staleForMs };
  if (params.sessionStatus !== "running") return { truthState: "orphaned", lastProgressAt, staleForMs };
  if (!lastProgressAt || staleForMs > params.freshnessMs) return { truthState: "stale", lastProgressAt, staleForMs };
  return { truthState: "running", lastProgressAt, staleForMs };
}
export function findActiveTool(events: AuditEvent[]): { name: string; startedAt: number } | null {
  const latestByCall = new Map<string, AuditEvent>();
  for (const event of events) {
    if (event.kind !== "tool_action" || !event.toolCallId) continue;
    const previous = latestByCall.get(event.toolCallId);
    if (!previous || Number(event.occurredAt || 0) > Number(previous.occurredAt || 0)) {
      latestByCall.set(event.toolCallId, event);
    }
  }
  const active = [...latestByCall.values()]
    .filter((event) => event.status === "started")
    .sort((a, b) => Number(b.occurredAt || 0) - Number(a.occurredAt || 0))[0];
  if (!active) return null;
  return {
    name: active.toolName || "tool",
    startedAt: Number(active.occurredAt || 0),
  };
}
