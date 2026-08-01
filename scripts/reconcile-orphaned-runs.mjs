#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { r as recordAuditEvent } from "/usr/lib/node_modules/openclaw/dist/audit-event-store-D1P32Q4Y.js";

function parseArgs(argv) {
  const args = {
    write: false,
    terminalize: false,
    includeStale: false,
    baseUrl: "http://127.0.0.1:18790",
    minAgeHours: 24,
    terminalStatus: "cancelled",
    actorId: "mission-control-live-work-reconcile",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--terminalize") args.terminalize = true;
    else if (arg === "--include-stale") args.includeStale = true;
    else if (arg === "--base-url" && argv[index + 1]) args.baseUrl = argv[++index];
    else if (arg === "--min-age-hours" && argv[index + 1]) args.minAgeHours = Number(argv[++index]);
    else if (arg === "--terminal-status" && argv[index + 1]) args.terminalStatus = String(argv[++index]).trim().toLowerCase();
    else if (arg === "--actor-id" && argv[index + 1]) args.actorId = String(argv[++index]).trim();
  }
  return args;
}

function getOpenClawHome() {
  const explicit = process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR;
  return explicit ? (explicit.endsWith(".openclaw") ? explicit : join(explicit, ".openclaw")) : join(homedir(), ".openclaw");
}

function suppressionsPath() {
  return join(getOpenClawHome(), "ui", "live-work-suppressions.json");
}

function normalizeTerminalStatus(value) {
  return new Set(["cancelled", "failed", "blocked", "timed_out"]).has(value) ? value : "cancelled";
}

function terminalErrorCode(status) {
  if (status === "timed_out") return "run_timed_out";
  if (status === "blocked") return "run_blocked";
  if (status === "failed") return "run_failed";
  return "run_cancelled";
}

function syntheticTerminalOccurredAt(row, now) {
  return Math.max(
    now,
    Number(row.lastProgressAt || 0) + 1,
    Number(row.startedAt || 0) + 1,
  );
}

function syntheticSourceSequence(row, occurredAt) {
  const lastProgressAt = Math.max(0, Number(row.lastProgressAt || 0));
  const startedAt = Math.max(0, Number(row.startedAt || 0));
  return Math.max(occurredAt, lastProgressAt, startedAt) + 1;
}

function reconcilableTruthStates(args) {
  return new Set(args.includeStale ? ["orphaned", "unverified", "stale"] : ["orphaned", "unverified"]);
}

function buildReconciliationReason(row, minAgeMs) {
  const ageHours = Math.round(minAgeMs / 3600000);
  if (row.truthState === "stale") return `Auto-closed after ${ageHours}h without fresh progress despite a still-running session key`;
  return `Auto-closed after ${ageHours}h without a live session owner`;
}

function writeSyntheticTerminalEvent(row, options) {
  const occurredAt = syntheticTerminalOccurredAt(row, Date.now());
  const status = normalizeTerminalStatus(options.terminalStatus);
  recordAuditEvent({
    sourceSequence: syntheticSourceSequence(row, occurredAt),
    occurredAt,
    kind: "agent_run",
    action: "agent.run.finished",
    status,
    errorCode: terminalErrorCode(status),
    actorType: "system",
    actorId: options.actorId || "mission-control-live-work-reconcile",
    agentId: typeof row.agentId === "string" && row.agentId.trim() ? row.agentId.trim() : "unknown",
    ...(typeof row.sessionKey === "string" && row.sessionKey.trim() ? { sessionKey: row.sessionKey.trim() } : {}),
    ...(typeof row.sessionId === "string" && row.sessionId.trim() ? { sessionId: row.sessionId.trim() } : {}),
    runId: row.runId,
  }, { env: process.env });
  return {
    runId: row.runId,
    status,
    occurredAt,
    sourceSequence: syntheticSourceSequence(row, occurredAt),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const minAgeMs = Math.max(1, Number.isFinite(args.minAgeHours) ? args.minAgeHours : 24) * 60 * 60 * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/api/live-work?includeSuppressed=1&limit=all`, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!response.ok) throw new Error(`live-work API returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.rows)) throw new Error("live-work API returned an invalid payload");

  const now = Date.now();
  const eligibleTruthStates = reconcilableTruthStates(args);
  const entries = payload.rows
    .filter((row) => eligibleTruthStates.has(row.truthState) && Number(row.staleForMs || 0) >= minAgeMs)
    .map((row) => ({
      runId: row.runId,
      sessionKey: row.sessionKey,
      truthState: row.truthState,
      suppressedAt: now,
      firstObservedAt: Number(row.startedAt || 0),
      lastProgressAt: Number(row.lastProgressAt || 0),
      staleForMs: Number(row.staleForMs || 0),
      reason: buildReconciliationReason(row, minAgeMs),
      ...(args.terminalize ? {
        terminalStatus: normalizeTerminalStatus(args.terminalStatus),
        terminalizationRequestedAt: now,
      } : {}),
    }))
    .sort((left, right) => right.firstObservedAt - left.firstObservedAt);

  const candidateRows = payload.rows
    .filter((row) => eligibleTruthStates.has(row.truthState) && Number(row.staleForMs || 0) >= minAgeMs)
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));

  const terminalized = [];
  if (args.write && args.terminalize) {
    for (const row of candidateRows) {
      terminalized.push(writeSyntheticTerminalEvent(row, args));
    }
  }

  const output = {
    version: 1,
    updatedAt: now,
    minAgeMs,
    entries,
    ...(terminalized.length > 0 ? {
      terminalizedAt: now,
      terminalized,
    } : {}),
  };

  if (args.write) {
    const path = suppressionsPath();
    const tempPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
    await rename(tempPath, path);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    write: args.write,
    terminalize: args.terminalize,
    includeStale: args.includeStale,
    baseUrl: args.baseUrl,
    minAgeMs,
    suppressed: entries.length,
    terminalized: terminalized.length,
    runIds: entries.map((entry) => entry.runId),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
