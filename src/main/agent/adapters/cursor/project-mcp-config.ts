/**
 * Kangentic's MCP server in a Cursor session's working folder, so a task,
 * Command Terminal or workflow agent on Cursor can call Kangentic's tools.
 *
 * Cursor's CLI reads a project's `.cursor/mcp.json` as the editor does, and
 * resolves `${env:NAME}` in a server's `url` and `headers` (Cursor's MCP docs,
 * and measured by the Knowledge Graph's answer path, `answer-workspace.ts`).
 * So the entry is STATIC: its url and token are env references, and each
 * session's own values ride its environment (`buildEnv`). Two sessions sharing
 * the folder write the same entry and each reads its own URL, which keeps a
 * caller-scoped URL (a workflow agent's) its own. The user's other servers in
 * the file stay as they are. A Cursor in a WSL distro on NAT networking gets
 * the bridge entry instead, as static (`CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY`).
 * The CLI path is the project's, so the sessions in one folder share a place,
 * and with it an entry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { CURSOR_KANGENTIC_MCP_ENTRY, type CursorKangenticMcpEntry } from './answer-workspace';

export { CURSOR_KANGENTIC_MCP_ENTRY };

type JsonObject = Record<string, unknown>;

/**
 * What a folder's `.cursor/mcp.json` holds: no file, a file Kangentic can merge
 * into, or one it cannot (not JSON it parses, such as one with comments, or a
 * shape other than an object with an object `mcpServers`). An unusable file is
 * never rewritten, since a rewrite would drop every server the user keeps there.
 */
type ProjectMcpConfig =
  | { kind: 'absent' }
  | { kind: 'usable'; config: JsonObject; servers: JsonObject }
  | { kind: 'unusable' };

function configPathOf(directory: string): string {
  return path.join(directory, '.cursor', 'mcp.json');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfig(configPath: string): ProjectMcpConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unusable' };
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
 * Add Kangentic's entry to `<directory>/.cursor/mcp.json`, keeping the user's
 * servers, and report whether the entry is there. A file that already holds
 * the entry is left untouched, and so is one Kangentic cannot read. A file
 * Kangentic creates is kept out of `git status` (the local exclude, as the
 * other project-file adapters do). Never throws: a failed write leaves the
 * session without Kangentic's tools, as an MCP server that failed to start
 * would.
 */
export function writeCursorProjectMcpConfig(
  directory: string,
  entry: CursorKangenticMcpEntry = CURSOR_KANGENTIC_MCP_ENTRY,
): boolean {
  const configPath = configPathOf(directory);
  const current = readConfig(configPath);
  if (current.kind === 'unusable') {
    console.warn(`[cursor] Left ${configPath} as it is: it is not JSON Kangentic can merge its server into.`);
    return false;
  }
  if (current.kind === 'usable' && JSON.stringify(current.servers.kangentic) === JSON.stringify(entry)) {
    return true;
  }
  const existing = current.kind === 'usable' ? current : { config: {}, servers: {} };
  const merged = {
    ...existing.config,
    mcpServers: { ...existing.servers, kangentic: entry },
  };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  } catch (error) {
    console.error(`[cursor] Failed to write MCP config: ${configPath}`, error);
    return false;
  }
  if (current.kind === 'absent') ensureLocalGitExcludes(directory, ['.cursor/mcp.json']);
  return true;
}

/**
 * Why `writeCursorProjectMcpConfig` would leave `<directory>` without
 * Kangentic's entry, or null when it would not: the folder's `.cursor/mcp.json`
 * is one Kangentic cannot merge into.
 */
export function cursorProjectMcpConfigProblem(directory: string): string | null {
  const configPath = configPathOf(directory);
  return readConfig(configPath).kind === 'unusable'
    ? `${configPath} is not JSON Kangentic can add its server to`
    : null;
}

/**
 * Remove Kangentic's entry from `<directory>/.cursor/mcp.json`, leaving the
 * user's servers, and the file itself only when nothing else is in it.
 */
export function removeCursorProjectMcpConfig(directory: string): void {
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
    console.error(`[cursor] Failed to clean up MCP config: ${configPath}`, error);
  }
}
