/**
 * Shared MCP tool annotations for the Kangentic in-process MCP server.
 *
 * Every tool registered under `mcp-http/*-tools.ts` declares one of these two
 * constants as its `annotations`. They are the single audit point for which
 * kangentic tools are read-only versus mutating, so classification stays
 * honest and auditable (a mutation must never be silently marked read-only).
 *
 * Why the annotations matter:
 *
 * 1. Plan mode. Claude Code auto-approves tools annotated `readOnlyHint: true`
 *    in plan mode without a permission prompt, while everything else prompts.
 *    Allow rules do NOT punch through the plan-mode gate. Verified empirically
 *    2026-07-01 (annotated `kangentic_get_process_metrics` ran with no prompt,
 *    unannotated `kangentic_query_db` prompted on every call, both with the
 *    same `mcp__kangentic` allow rule). This behavior is undocumented for the
 *    Claude Code CLI, so the empirical result is the authoritative evidence.
 * 2. Speculative / parallel calls. `readOnlyHint` lets the model treat a tool
 *    as safe to call speculatively (parallel reads, retries on transient
 *    errors). MCP spec: https://modelcontextprotocol.io/specification/server/tools
 *
 * `MUTATING_ANNOTATIONS` is the explicit honest opposite: a mutating tool
 * carries `readOnlyHint: false` so it can never be auto-approved in plan mode.
 * In default mode an allow rule still auto-approves it (a `readOnlyHint: false`
 * annotation does not defeat an allow rule), so this does not add prompts to
 * the normal working modes.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
} as const;

export const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
} as const;
