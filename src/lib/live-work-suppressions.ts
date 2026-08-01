import { readFile } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";

export type LiveWorkSuppressionEntry = {
  runId: string;
  sessionKey?: string;
  truthState?: "orphaned" | "unverified";
  suppressedAt: number;
  firstObservedAt?: number;
  lastProgressAt?: number;
  staleForMs?: number;
  reason?: string;
};

type SuppressionFile = {
  version?: number;
  updatedAt?: number;
  minAgeMs?: number;
  entries?: LiveWorkSuppressionEntry[];
};

export type LoadedLiveWorkSuppressions = {
  entries: Map<string, LiveWorkSuppressionEntry>;
  updatedAt: number | null;
  stale: boolean;
  warning?: string;
};

export function liveWorkSuppressionsPath(): string {
  return join(getOpenClawHome(), "ui", "live-work-suppressions.json");
}

export async function loadLiveWorkSuppressions(
  maxAgeMs = 2 * 60 * 60 * 1000,
): Promise<LoadedLiveWorkSuppressions> {
  try {
    const raw = await readFile(liveWorkSuppressionsPath(), "utf-8");
    const parsed = JSON.parse(raw) as SuppressionFile;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
    const stale = updatedAt == null || Date.now() - updatedAt > maxAgeMs;
    return {
      updatedAt,
      stale,
      ...(stale ? { warning: "Live Work suppressions are stale; ignoring the local reconciliation ledger until it refreshes." } : {}),
      entries: new Map(
        entries
          .filter((entry) => entry && typeof entry.runId === "string" && entry.runId.trim())
          .map((entry) => [entry.runId.trim(), entry]),
      ),
    };
  } catch (error) {
    return {
      entries: new Map(),
      updatedAt: null,
      stale: true,
      warning: `Live Work suppressions could not be read; ignoring the local reconciliation ledger (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}
