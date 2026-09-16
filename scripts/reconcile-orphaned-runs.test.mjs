import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSuppressionEntries,
  reconcilableTruthStates,
} from "./reconcile-orphaned-runs.mjs";

const args = { includeStale: true };

test("reconciliation suppresses only unowned/unverified rows", () => {
  const rows = [
    { runId: "orphan", truthState: "orphaned", staleForMs: 90_000, startedAt: 1 },
    { runId: "unknown", truthState: "unverified", staleForMs: 90_000, startedAt: 2 },
    { runId: "stale-running", truthState: "stale", staleForMs: 90_000, startedAt: 3 },
    { runId: "young", truthState: "orphaned", staleForMs: 1, startedAt: 4 },
  ];
  const entries = buildSuppressionEntries(rows, args, 60_000, 100);
  assert.deepEqual(entries.map((entry) => entry.runId), ["unknown", "orphan"]);
  assert.equal(entries.every((entry) => entry.truthState !== "stale"), true);
});

test("stale rows are eligible for inspection but never treated as terminal truth", () => {
  assert.equal(reconcilableTruthStates(args).has("stale"), true);
  const entries = buildSuppressionEntries([
    { runId: "stale-running", truthState: "stale", staleForMs: 90_000, startedAt: 1 },
  ], args, 60_000, 100);
  assert.deepEqual(entries, []);
});

test("reconciler has no generated OpenClaw bundle or synthetic audit dependency", async () => {
  const source = await readFile(new URL("./reconcile-orphaned-runs.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /openclaw\/dist\/|recordAuditEvent|terminalStatus/);
});
