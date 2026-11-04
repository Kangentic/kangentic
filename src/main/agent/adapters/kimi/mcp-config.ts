import fs from 'node:fs';
import path from 'node:path';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { kangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { WSL_MCP_TOKEN_ENV } from '../../shared/wsl-hook-transport';
import type { CliPlace } from '../../shared/cli-target';

/**
 * Kangentic's MCP server in a Kimi Code session's working folder.
 *
 * Kimi Code CLI has no MCP flag or env var for one session. It reads
 * `~/.kimi-code/mcp.json` and the project's `<cwd>/.kimi-code/mcp.json`, and
 * loads a project file's servers once the folder is trusted
 * (`en/customization/mcp.md`, Kimi Code CLI 2.4.1, read 2026-11-03).
 * "Entries with a `url` field and no `transport` are HTTP servers", with
 * `headers` sent on every request; "entries with a `command` field are stdio
 * servers", with `env` for the child. `bearerTokenEnvVar` names an environment
 * variable holding a bearer token (the same doc), and a local stdio server
 * inherits the CLI's environment (`mergeStdioEnv` in
 * `packages/agent-core-v2/src/mcpCore/client-stdio.ts`), so the token stays in
 * the session's environment (`buildEnv`) and off disk either way. The docs
 * name no `${VAR}` expansion, so the URL is literal: every session in a folder
 * shares it, the last to start decides it (`kangenticMcp: 'shared-folder'`),
 * and a file Kangentic creates is kept out of `git status`.
 * Built from the docs, not yet checked against a real run.
 *
 * A file Kangentic cannot read as JSON with an object `mcpServers` is never
 * rewritten, since a rewrite would drop every server the user keeps there.
 */
const KIMI_PROJECT_MCP_FILE = path.join('.kimi-code', 'mcp.json');

type JsonObject = Record<string, unknown>;

type ProjectMcpConfig =
  | { kind: 'absent' }
  | { kind: 'usable'; config: JsonObject; servers: JsonObject }
  | { kind: 'unusable' };

function configPathOf(directory: string): string {
  return path.join(directory, KIMI_PROJECT_MCP_FILE);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A file where the `.kimi-code` folder would go, which a write could not get past. */
function folderIsAFile(configPath: string): boolean {
  try {
    return fs.statSync(path.dirname(configPath)).isFile();
  } catch {
    return false;
  }
}

function readConfig(configPath: string): ProjectMcpConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    // POSIX reads that file as ENOTDIR and Windows as ENOENT, so it is asked directly.
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT' && !folderIsAFile(configPath);
    return absent ? { kind: 'absent' } : { kind: 'unusable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unusable' };
  }
  if (!isJsonObject(parsed)) return { kind: 'unusable' };
  const servers = parsed.mcpServers ?? {};
  if (!isJsonObject(servers)) return { kind: 'unusable' };
  return { kind: 'usable', config: parsed, servers };
}

/**
 * Kangentic's entry for one session. An HTTP server for a CLI on this machine,
 * or in a distro whose loopback is this machine's; the WSL hook transport's
 * stdio bridge for a distro on NAT networking, prepared in the session's own
 * directory. Neither holds the token: the CLI reads `WSL_MCP_TOKEN_ENV` from
 * the session's environment, and the bridge inherits it.
 */
export function kimiKangenticMcpEntry(input: {
  url: string;
  token: string;
  place: CliPlace | null;
  sessionDirectory: string;
}): JsonObject {
  const server = kangenticMcpServer({ url: input.url, token: input.token, place: input.place, directory: input.sessionDirectory });
  if (server.kind === 'stdio') return { command: server.command, args: server.args };
  return { url: server.url, bearerTokenEnvVar: WSL_MCP_TOKEN_ENV };
}

/**
 * Add Kangentic's entry to `<directory>/.kimi-code/mcp.json`, keeping the
 * user's servers, and report whether it is there. Throws when the write
 * fails: the builder's caller reports a failed spawn, as for any adapter whose
 * MCP config the CLI reads at start.
 */
export function writeKimiProjectMcpConfig(directory: string, entry: JsonObject): boolean {
  const configPath = configPathOf(directory);
  const current = readConfig(configPath);
  if (current.kind === 'unusable') {
    console.warn(`[kimi] Left ${configPath} as it is: it is not JSON Kangentic can merge its server into.`);
    return false;
  }
  if (current.kind === 'usable' && JSON.stringify(current.servers.kangentic) === JSON.stringify(entry)) return true;
  // Excluded before the write, so the check sees the user's file, not ours.
  if (current.kind === 'absent') ensureLocalGitExcludes(directory, ['.kimi-code/mcp.json']);
  const existing = current.kind === 'usable' ? current : { config: {}, servers: {} };
  const merged = { ...existing.config, mcpServers: { ...existing.servers, kangentic: entry } };
  // sync-write-ok: the CLI reads this file at start and nothing else carries
  // Kangentic's server to it; a throw reaches the spawn preamble, which
  // reports and notifies (notifySpawnBlocked).
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // sync-write-ok: see the mkdir above.
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return true;
}

/**
 * Why `writeKimiProjectMcpConfig` would leave `<directory>` without
 * Kangentic's entry, or null when it would not.
 */
export function kimiProjectMcpConfigProblem(directory: string): string | null {
  const configPath = configPathOf(directory);
  return readConfig(configPath).kind === 'unusable'
    ? `${configPath} is not JSON Kangentic can add its server to`
    : null;
}

/**
 * Remove Kangentic's entry from `<directory>/.kimi-code/mcp.json`, leaving the
 * user's servers, and the file itself only when nothing else is in it.
 */
export function removeKimiProjectMcpConfig(directory: string): void {
  const configPath = configPathOf(directory);
  const current = readConfig(configPath);
  if (current.kind !== 'usable' || !('kangentic' in current.servers)) return;
  const userServers: JsonObject = { ...current.servers };
  delete userServers.kangentic;
  const remaining: JsonObject = { ...current.config };
  if (Object.keys(userServers).length > 0) remaining.mcpServers = userServers;
  else delete remaining.mcpServers;
  try {
    if (Object.keys(remaining).length === 0) {
      fs.rmSync(configPath, { force: true });
      return;
    }
    fs.writeFileSync(configPath, JSON.stringify(remaining, null, 2));
  } catch (error) {
    console.error(`[kimi] Failed to clean up MCP config: ${configPath}`, error);
  }
}
