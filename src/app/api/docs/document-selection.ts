export type DocumentInfo = {
  path: string;
  name: string;
  mtime: string;
  size: number;
  tag: string;
  workspace: string;
  ext: string;
};

const BOOTSTRAP_DOCUMENT_NAMES = new Set([
  "AGENTS.MD",
  "SOUL.MD",
  "TOOLS.MD",
  "IDENTITY.MD",
  "USER.MD",
  "HEARTBEAT.MD",
]);

export function selectDocuments(allDocs: DocumentInfo[], limit: number): {
  docs: DocumentInfo[];
  truncated: boolean;
  omittedCount: number;
  preservedBootstrapPaths: string[];
} {
  const sorted = [...allDocs].sort(
    (a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime()
  );
  const bootstrap = sorted.filter((doc) =>
    BOOTSTRAP_DOCUMENT_NAMES.has(doc.name.toUpperCase())
  );
  const bootstrapPaths = new Set(bootstrap.map((doc) => doc.path));
  const remaining = sorted.filter((doc) => !bootstrapPaths.has(doc.path));
  const docs = [...bootstrap, ...remaining].slice(0, limit);
  return {
    docs,
    truncated: allDocs.length > docs.length,
    omittedCount: Math.max(0, allDocs.length - docs.length),
    preservedBootstrapPaths: docs
      .filter((doc) => bootstrapPaths.has(doc.path))
      .map((doc) => doc.path),
  };
}
