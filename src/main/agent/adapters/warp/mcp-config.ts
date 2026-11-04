import fs from 'node:fs';
import path from 'node:path';
import { cliPathForTarget, type CliPlace } from '../../shared/cli-target';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import type { SpawnCommandOptions } from '../../agent-adapter';

/**
 * Kangentic's MCP server for one `oz agent run`, handed over as a file named by
 * `--mcp <path>`.
 *
 * Built from Warp's docs, not yet run against a real `oz`:
 * - https://docs.warp.dev/reference/cli/cli and
 *   https://docs.warp.dev/reference/cli/mcp-servers/ (last updated
 *   2026-11-03): `oz agent run --mcp <SPEC>` starts MCP servers before the
 *   run; SPEC is a JSON file path or inline JSON, and the file holds an object
 *   keyed by server name, with no `mcpServers` wrapper.
 * - https://docs.warp.dev/platform/mcp/ (last updated 2026-11-03): a server
 *   has exactly one transport, `url` (streamable HTTP or SSE) with optional
 *   `headers`, or `command` with `args` and `env`.
 * - `oz agent run --help` on Warp v0.2026.04.08.08.36.stable_02 lists
 *   `--mcp <SPEC>` as "A path to a JSON file containing MCP configuration".
 *
 * A file, never inline JSON, so the per-launch token stays off the command
 * line and out of shell quoting.
 */

/** The server's entry in Oz's documented shape. */
export function warpKangenticServerEntry(server: KangenticMcpServer): Record<string, unknown> {
  if (server.kind === 'stdio') {
    return { command: server.command, args: server.args, env: { [server.tokenEnv]: server.token } };
  }
  return { url: server.url, headers: { 'X-Kangentic-Token': server.token } };
}

/**
 * Write the session's `mcp.json` and return the `--mcp` argument (the path as
 * the CLI sees it), or null when Kangentic's MCP server is off or the build has
 * no session directory, which every production spawn path supplies.
 *
 * For an `oz` in a WSL distro on NAT networking, `kangenticMcpServer` prepares
 * the hook transport's bridge in the session directory; the spawn attaches its
 * relay for any distro session with an events file.
 */
export function writeWarpMcpConfig(options: SpawnCommandOptions): string | null {
  if (options.mcpServerEnabled === false || !options.mcpServerUrl || !options.mcpServerToken) return null;
  const sessionFile = options.statusOutputPath ?? options.eventsOutputPath;
  if (!sessionFile) {
    console.warn('[warp] MCP server enabled but no session directory to write mcp.json into - skipping MCP wiring');
    return null;
  }
  const place: CliPlace | null = options.cliTarget ?? null;
  const sessionDir = path.dirname(sessionFile);
  const server = kangenticMcpServer({ url: options.mcpServerUrl, token: options.mcpServerToken, place, directory: sessionDir });
  // sync-write-ok: this must throw, not degrade - the file below is named by
  // --mcp, so a swallowed failure would start oz pointed at a config that does
  // not exist. The spawn preamble reports and notifies (notifySpawnBlocked) on
  // any throw from buildCommand.
  fs.mkdirSync(sessionDir, { recursive: true });
  const mcpConfigPath = path.join(sessionDir, 'mcp.json');
  const mcpConfig = { kangentic: warpKangenticServerEntry(server) };
  // sync-write-ok: same reason as the mkdir above.
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  return place ? cliPathForTarget(mcpConfigPath, place) : mcpConfigPath;
}
