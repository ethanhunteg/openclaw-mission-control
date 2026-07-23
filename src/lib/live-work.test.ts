import assert from "node:assert/strict";
import test from "node:test";
import { classifyLiveWork, findActiveRunCandidates, findActiveTool, type AuditEvent } from "./live-work.ts";

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
