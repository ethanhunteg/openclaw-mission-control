import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildSuppressionEntries,
  reconcilableTruthStates,
  validateReconciliationRows,
} from "./reconcile-orphaned-runs.mjs";

const args = { includeStale: true };
const execFileAsync = promisify(execFile);

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

test("malformed live-work rows fail closed before reconciliation", () => {
  const valid = {
    runId: "run-1",
    sessionKey: "agent:main:session-1",
    truthState: "orphaned",
    staleForMs: 90_000,
    startedAt: 1,
    lastProgressAt: 2,
  };
  for (const [field, value] of [
    ["row", null],
    ["runId", "  "],
    ["truthState", "invented"],
    ["staleForMs", Infinity],
    ["startedAt", -1],
    ["lastProgressAt", "2"],
  ]) {
    const candidate = field === "row" ? value : { ...valid, [field]: value };
    assert.throws(() => validateReconciliationRows([candidate]), /invalid|without a valid/);
  }
});

test("CLI writes only suppression truth and never synthetic terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-control-reconcile-"));
  const server = createServer((request, response) => {
    if (request.url !== "/api/live-work?includeSuppressed=1&limit=all") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      rows: [
        {
          runId: "orphan",
          sessionKey: "agent:main:orphan",
          truthState: "orphaned",
          staleForMs: 90 * 60 * 1000,
          startedAt: 1,
          lastProgressAt: 2,
        },
        {
          runId: "stale-running",
          sessionKey: "agent:main:stale",
          truthState: "stale",
          staleForMs: 90 * 60 * 1000,
          startedAt: 3,
          lastProgressAt: 4,
        },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const script = new URL("./reconcile-orphaned-runs.mjs", import.meta.url);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      script.pathname,
      "--write",
      "--terminalize",
      "--include-stale",
      "--min-age-hours",
      "1",
      "--base-url",
      `http://127.0.0.1:${address.port}`,
    ], { env: { ...process.env, OPENCLAW_HOME: join(root, "state.openclaw") } });
    const result = JSON.parse(stdout);
    assert.equal(result.terminalized, 0);
    assert.equal(result.terminalization.applied, false);
    assert.deepEqual(result.runIds, ["orphan"]);
    const output = JSON.parse(await readFile(join(root, "state.openclaw", "ui", "live-work-suppressions.json"), "utf8"));
    assert.deepEqual(output.entries.map((entry) => entry.runId), ["orphan"]);
    assert.equal("terminalized" in output, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciler has no generated OpenClaw bundle or synthetic audit dependency", async () => {
  const source = await readFile(new URL("./reconcile-orphaned-runs.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /openclaw\/dist\/|recordAuditEvent|terminalStatus/);
});
