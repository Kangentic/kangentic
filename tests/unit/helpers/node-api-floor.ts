/**
 * Refuses to start the unit tier on a Node too old for better-sqlite3 13.
 *
 * 13 is built against Node-API 10, which Node 22 gained in 22.14.0. An older
 * Node does not report the mismatch: the first `new Database()` segfaults inside
 * `napi_module_register_by_symbol` (WiseLibs/better-sqlite3#1514), so every
 * suite that opens a database kills its worker with nothing on screen naming
 * the cause. This runs in vitest's main process before any worker starts, and
 * says it once.
 *
 * Registered in vitest.config.ts `test.globalSetup`.
 */

export const REQUIRED_NODE_API = 10;

/** Why this Node cannot run the unit tier, or null when it can. */
export function nodeApiFloorError(versions: { node: string; napi?: string }): string | null {
  const nodeApi = Number(versions.napi);
  if (Number.isFinite(nodeApi) && nodeApi >= REQUIRED_NODE_API) return null;
  return (
    `The unit tier needs Node-API ${REQUIRED_NODE_API} (Node 22.14+ or 24+), and this is Node ` +
    `${versions.node} with Node-API ${versions.napi ?? 'unknown'}. better-sqlite3 13 would ` +
    'segfault on the first database open here instead of reporting it.'
  );
}

export default function assertNodeApiFloor(): void {
  const error = nodeApiFloorError(process.versions);
  if (error) throw new Error(error);
}
