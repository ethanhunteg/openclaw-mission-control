# Live-work reconciliation

`/api/live-work` is the source of truth for the Mission Control Live Work view.
It derives active-run candidates from Gateway audit events and enriches them
with current session state. The reconciler in
`scripts/reconcile-orphaned-runs.mjs` is only a display-suppression helper:

- it validates the API payload before acting;
- it records aged `orphaned` and `unverified` rows in the local suppression
  file;
- it never converts a still-running `stale` row into terminal state;
- `--terminalize` is retained as a compatibility flag but performs no
  OpenClaw audit writes.

The suppression file is not canonical task or session state. It is ignored by
the dashboard when stale, malformed, or unavailable. A live reconciler run
therefore requires an authenticated Mission Control API context with the
Gateway scope needed by `/api/live-work`; a scheduler must not be enabled
against an unauthenticated endpoint.
