import assert from "node:assert/strict";
import test from "node:test";
import { selectDocuments, type DocumentInfo } from "./document-selection.ts";

function document(name: string, mtime: string): DocumentInfo {
  return {
    path: `workspace/${name}`,
    name,
    mtime,
    size: 1,
    tag: "Other",
    workspace: "workspace",
    ext: ".md",
  };
}

test("preserves all bootstrap files when newer documents exceed the limit", () => {
  const bootstrap = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
  ].map((name) => document(name, "2020-01-01T00:00:00.000Z"));
  const newerDocuments = Array.from({ length: 210 }, (_, index) =>
    document(
      `newer-${index}.md`,
      `2026-09-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`
    )
  );

  const selected = selectDocuments([...bootstrap, ...newerDocuments], 200);

  assert.equal(selected.docs.length, 200);
  assert.equal(selected.truncated, true);
  assert.equal(selected.omittedCount, 16);
  assert.deepEqual(
    new Set(selected.preservedBootstrapPaths),
    new Set(bootstrap.map((doc) => doc.path))
  );
  assert.equal(
    selected.docs.filter((doc) => doc.name.startsWith("newer-")).length,
    194
  );
});
