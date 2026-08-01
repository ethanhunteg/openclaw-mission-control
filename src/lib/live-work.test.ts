import assert from "node:assert/strict";
import test from "node:test";
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
} from "./live-work.ts";

test("findActiveRunCandidates keeps unfinished runs and drops terminal runs", () => {
  const events: AuditEvent[] = [
    { kind: "agent_run", runId: "active", sessionKey: "agent:main:discord:channel:1", agentId: "main", occurredAt: 10, status: "started" },
    { kind: "agent_run", runId: "done", sessionKey: "agent:main:discord:channel:2", agentId: "main", occurredAt: 20, status: "started" },
    { kind: "agent_run", runId: "done", sessionKey: "agent:main:discord:channel:2", agentId: "main", occurredAt: 30, status: "succeeded" },
  ];
  assert.deepEqual(findActiveRunCandidates(events).map((row) => row.runId), ["active"]);
});
test("findActiveTool returns only a tool call without a later terminal event", () => {
  const events: AuditEvent[] = [
    { kind: "tool_action", runId: "run", toolCallId: "finished", toolName: "read", occurredAt: 10, status: "started" },
    { kind: "tool_action", runId: "run", toolCallId: "finished", toolName: "read", occurredAt: 20, status: "succeeded" },
    { kind: "tool_action", runId: "run", toolCallId: "active", toolName: "bash", occurredAt: 30, status: "started" },
  ];
  assert.deepEqual(findActiveTool(events), { name: "bash", startedAt: 30 });
});

test("classifyLiveWork requires a running session and fresh progress evidence", () => {
  const candidate = {
    runId: "run",
    sessionKey: "agent:main:discord:channel:1",
    sessionId: "session",
    agentId: "main",
    startedAt: 1_000,
    lastEventAt: 9_000,
  };
  assert.equal(classifyLiveWork({ candidate, sessionStatus: "running", now: 10_000, freshnessMs: 5_000 }).truthState, "running");
  assert.equal(classifyLiveWork({ candidate, sessionStatus: "running", now: 20_000, freshnessMs: 5_000 }).truthState, "stale");
  assert.equal(classifyLiveWork({ candidate, sessionStatus: "idle", now: 10_000, freshnessMs: 5_000 }).truthState, "orphaned");
  assert.equal(classifyLiveWork({ candidate, describeFailed: true, now: 10_000, freshnessMs: 5_000 }).truthState, "unverified");
});

test("active tool evidence advances last progress time", () => {
  const candidate = {
    runId: "run",
    sessionKey: "agent:main:discord:channel:1",
    sessionId: null,
    agentId: "main",
    startedAt: 1_000,
    lastEventAt: 2_000,
  };
  const result = classifyLiveWork({
    candidate,
    sessionStatus: "running",
    lastProgressAt: 9_000,
    now: 10_000,
    freshnessMs: 5_000,
  });
  assert.equal(result.truthState, "running");
  assert.equal(result.lastProgressAt, 9_000);
});

test("collectAuditPages follows cursors so older live runs are not truncated", async () => {
  const requested: Array<string | undefined> = [];
  const events = await collectAuditPages(async (cursor) => {
    requested.push(cursor);
    if (!cursor) {
      return {
        events: [{ kind: "agent_run", runId: "new", occurredAt: 20, status: "started" }],
        nextCursor: "2",
      };
    }
    return { events: [{ kind: "agent_run", runId: "old-live", occurredAt: 10, status: "started" }] };
  });
  assert.deepEqual(requested, [undefined, "2"]);
  assert.deepEqual(events.map((event) => event.runId), ["new", "old-live"]);
});

test("collectAuditPages fails closed instead of reporting partial active totals", async () => {
  await assert.rejects(
    collectAuditPages(async () => ({ events: [], nextCursor: "more" }), 2),
    /active-work totals are not safe to report/,
  );
});

test("mapWithConcurrency strictly bounds simultaneous enrichment", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((result) => result.status === "fulfilled" ? result.value : null), [2, 4, 6, 8, 10, 12]);
});

test("visible live rows prioritize verified running work over newer stale records", () => {
  const rows = [
    { truthState: "stale" as const, startedAt: 30, id: "new-stale" },
    { truthState: "running" as const, startedAt: 10, id: "old-running" },
    { truthState: "orphaned" as const, startedAt: 40, id: "new-orphan" },
  ];
  assert.deepEqual(prioritizeLiveRows(rows).map((row) => row.id), ["old-running", "new-stale", "new-orphan"]);
});

test("filterSuppressedRows removes acknowledged run ids unless requested", () => {
  const rows = [
    { runId: "keep", truthState: "running" as const },
    { runId: "hide", truthState: "orphaned" as const },
  ];
  assert.deepEqual(
    filterSuppressedRows(rows, new Set(["hide"]), false),
    { rows: [{ runId: "keep", truthState: "running" }], suppressed: 1 },
  );
  assert.equal(filterSuppressedRows(rows, new Set(["hide"]), true).rows.length, 2);
});

test("summarizeLiveRows reports suppressed rows separately from visible truth states", () => {
  const summary = summarizeLiveRows([
    { runId: "a", truthState: "running", state: "model", isWorker: false },
    { runId: "b", truthState: "orphaned", state: "tool", isWorker: false },
  ], 3);
  assert.equal(summary.active, 1);
  assert.equal(summary.modelCalls, 1);
  assert.equal(summary.orphaned, 1);
  assert.equal(summary.suppressed, 3);
});
