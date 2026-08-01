#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const args = { write: false, baseUrl: "http://127.0.0.1:18790", minAgeHours: 24 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--base-url" && argv[index + 1]) args.baseUrl = argv[++index];
    else if (arg === "--min-age-hours" && argv[index + 1]) args.minAgeHours = Number(argv[++index]);
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
  const entries = payload.rows
    .filter((row) => (row.truthState === "orphaned" || row.truthState === "unverified") && Number(row.staleForMs || 0) >= minAgeMs)
    .map((row) => ({
      runId: row.runId,
      sessionKey: row.sessionKey,
      truthState: row.truthState,
      suppressedAt: now,
      firstObservedAt: Number(row.startedAt || 0),
      lastProgressAt: Number(row.lastProgressAt || 0),
      staleForMs: Number(row.staleForMs || 0),
      reason: `Auto-acknowledged after ${Math.round(minAgeMs / 3600000)}h without a live session owner`,
    }))
    .sort((left, right) => right.firstObservedAt - left.firstObservedAt);

  const output = {
    version: 1,
    updatedAt: now,
    minAgeMs,
    entries,
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
    baseUrl: args.baseUrl,
    minAgeMs,
    suppressed: entries.length,
    runIds: entries.map((entry) => entry.runId),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
