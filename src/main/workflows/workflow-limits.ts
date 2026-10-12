/**
 * The most tasks one workflow plans, a sanity bound, not a design limit. 100
 * is what the canvas is measured at (the drag-perf run at 30 and 100 cards).
 *
 * Its own module, with no imports, so the MCP tool schema can share it with
 * the workflow service without pulling the service's whole graph (task moves,
 * the IPC handlers, dev tooling) into the MCP server.
 */
export const MAX_WORKFLOW_TASKS = 100;
