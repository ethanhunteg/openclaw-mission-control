#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {
    write: false,
    terminalize: false,
    includeStale: false,
    baseUrl: "http://127.0.0.1:18790",
    minAgeHours: 24,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--terminalize") args.terminalize = true;
    else if (arg === "--include-stale") args.includeStale = true;
    else if (arg === "--base-url" && argv[index + 1]) args.baseUrl = argv[++index];
    else if (arg === "--min-age-hours" && argv[index + 1]) args.minAgeHours = Number(argv[++index]);
    else if (arg === "--terminal-status" && argv[index + 1]) index += 1;
    else if (arg === "--actor-id" && argv[index + 1]) index += 1;
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

export function reconcilableTruthStates(args) {
  return new Set(args.includeStale ? ["orphaned", "unverified", "stale"] : ["orphaned", "unverified"]);
}

export function buildReconciliationReason(row, minAgeMs) {
  const ageHours = Math.round(minAgeMs / 3600000);
  if (row.truthState === "stale") return `Observed after ${ageHours}h without fresh progress despite a still-running session key; canonical state remains authoritative`;
  return `Observed after ${ageHours}h without a live session owner; canonical state remains authoritative`;
}

export function buildSuppressionEntries(rows, args, minAgeMs, now) {
  const eligibleTruthStates = reconcilableTruthStates(args);
  return rows
    .filter((row) => eligibleTruthStates.has(row.truthState) && Number(row.staleForMs || 0) >= minAgeMs)
    // A still-running stale row is ambiguous and must remain visible. The
    // canonical session/task state, not this local band-aid, owns its truth.
    .filter((row) => row.truthState === "orphaned" || row.truthState === "unverified")
    .map((row) => ({
      runId: row.runId,
      sessionKey: row.sessionKey,
      truthState: row.truthState,
      suppressedAt: now,
      firstObservedAt: Number(row.startedAt || 0),
      lastProgressAt: Number(row.lastProgressAt || 0),
      staleForMs: Number(row.staleForMs || 0),
      reason: buildReconciliationReason(row, minAgeMs),
    }))
    .sort((left, right) => right.firstObservedAt - left.firstObservedAt);
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
  const candidateRows = payload.rows
    .filter((row) => eligibleTruthStates.has(row.truthState) && Number(row.staleForMs || 0) >= minAgeMs)
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
  const entries = buildSuppressionEntries(payload.rows, args, minAgeMs, now);

  const output = {
    version: 1,
    updatedAt: now,
    minAgeMs,
    entries,
    terminalization: {
      requested: args.terminalize,
      applied: false,
      reason: "Synthetic OpenClaw audit writes are retired; canonical session/task state remains authoritative.",
    },
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
    terminalized: 0,
    terminalization: output.terminalization,
    ambiguousStaleRows: candidateRows.filter((row) => row.truthState === "stale").length,
    runIds: entries.map((entry) => entry.runId),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
