# scripts/debug/

Ad-hoc diagnostic harnesses that are **not** part of the production build or
the test suite. Safe to run locally; they write all output under
`debug-traces/` (gitignored) and never touch source.

## `verify-copilot-cursor-stall.js`

Proves end-to-end that the Copilot and Cursor stream parsers populate
`SessionUsage.model` in real PTY sessions within a few seconds of spawn --
which is the exact condition `ContextBar.tsx:62` checks before replacing
the "Starting agent..." spinner with the real model pill.

**Run from the worktree root**:

```
node scripts/debug/verify-copilot-cursor-stall.js
```

Requires `copilot` (GitHub Copilot CLI) and `agent` (Cursor CLI) on PATH.
Bundles the two parsers on the fly via `esbuild`, spawns each CLI under
`node-pty`, and prints one summary row per agent with `firstOutputMs`,
`firstUsageMs`, and the captured model display name. Exits non-zero if
either agent fails to surface a model within the timeout.

Use this script when:

- Upgrading Copilot or Cursor CLI -- confirms the model-label regexes and
  NDJSON event shapes still match what the new binaries emit.
- Debugging a "loading agent" spinner that never clears -- compares the
  parser's view of PTY output against the saved `debug-traces/post-fix/*.log`
  files to isolate whether the issue is upstream (CLI output changed) or
  downstream (session-manager / renderer wiring).
