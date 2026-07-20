import assert from "node:assert/strict";
import test from "node:test";
import { findActiveRunCandidates, findActiveTool, type AuditEvent } from "./live-work.ts";

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
