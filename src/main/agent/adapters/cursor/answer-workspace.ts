/**
 * The answer home as a Cursor workspace: the search server, and the one
 * permission that lets ask mode call it.
 *
 * Both files are STATIC, written once and rewritten only when missing or
 * changed: the server's url and token header are `${env:...}` references
 * Cursor expands from the run's environment, so nothing secret lands on disk
 * and concurrent runs cannot overwrite each other's values.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliHomeDir, type CliPlace } from '../../shared/cli-target';
import type { KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { WSL_MCP_REQUEST_HEAD, WSL_MCP_TOKEN_ENV } from '../../shared/wsl-hook-transport';

export const CURSOR_MCP_URL_ENV = 'KANGENTIC_MCP_URL';
export const CURSOR_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';
/** The WSL hook transport's script, as the distro sees it, for the bridge entry. */
export const CURSOR_MCP_BRIDGE_SCRIPT_ENV = 'KANGENTIC_MCP_BRIDGE_SCRIPT';

/** Kangentic's entry for a Cursor that dials the server's URL itself. */
export const CURSOR_KANGENTIC_MCP_ENTRY = {
  url: `\${env:${CURSOR_MCP_URL_ENV}}`,
  headers: { 'X-Kangentic-Token': `\${env:${CURSOR_MCP_TOKEN_ENV}}` },
} as const;

/**
 * Kangentic's entry for a Cursor in a WSL distro on NAT networking, which
 * cannot reach this machine's loopback: the hook transport's stdio bridge
 * (`wslMcpServerLaunch`). Static like the URL entry. Cursor fills `${env:...}`
 * in a server's `command`, `args` and `env` as in its `url` and `headers`
 * (Cursor's MCP docs, "Config interpolation"), so the script path, the URL and
 * the token all come from the CLI's environment, and the token is handed to
 * the bridge in its own environment, never argv or disk.
 */
export const CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY = {
  command: 'sh',
  args: [`\${env:${CURSOR_MCP_BRIDGE_SCRIPT_ENV}}`, WSL_MCP_REQUEST_HEAD, `\${env:${CURSOR_MCP_URL_ENV}}`],
  env: { [WSL_MCP_TOKEN_ENV]: `\${env:${CURSOR_MCP_TOKEN_ENV}}` },
} as const;

export type CursorKangenticMcpEntry = typeof CURSOR_KANGENTIC_MCP_ENTRY | typeof CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY;

/** The entry that gives Cursor `server`. */
export function cursorKangenticMcpEntry(server: KangenticMcpServer): CursorKangenticMcpEntry {
  return server.kind === 'stdio' ? CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY : CURSOR_KANGENTIC_MCP_ENTRY;
}

/**
 * Ask mode refuses an MCP call it was not told to allow. This allows ours by
 * name and nothing else; the denies back up ask mode's own read-only rule.
 */
const PERMISSIONS = JSON.stringify({
  permissions: {
    allow: ['Mcp(kangentic:kangentic_search)'],
    deny: ['Shell(*)', 'Write(**)'],
  },
}, null, 2);

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  const existing = await fs.promises.readFile(filePath, 'utf-8').catch(() => null);
  if (existing === content) return;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

/**
 * The folder an answer run starts in. A Cursor in a WSL distro gets a stable
 * sibling of the shared answer home, one per distro, so its entry (the
 * bridge, on NAT networking) and the URL entry of a Cursor on this machine
 * each keep a file of their own instead of overwriting one another between
 * runs. A sibling, not a folder inside, in case Cursor looks for a workspace's
 * `.cursor` folder above the one it starts in: the home's would name an
 * unreachable URL under the same server name. A WSL target exists only on
 * Windows, whose temp folder is the user's own.
 */
export function cursorAnswerHome(answerHome: string, place: CliPlace | null): string {
  if (!place) return answerHome;
  return `${answerHome}-wsl-${place.distro.replace(/[^\w.-]/g, '_')}`;
}

export async function writeCursorAnswerWorkspace(
  answerHome: string,
  entry: CursorKangenticMcpEntry = CURSOR_KANGENTIC_MCP_ENTRY,
): Promise<void> {
  await writeIfChanged(path.join(answerHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { kangentic: entry } }, null, 2));
  await writeIfChanged(path.join(answerHome, '.cursor', 'cli.json'), PERMISSIONS);
}

/**
 * Remove one chat from `~/.cursor/chats/<workspace hash>/<chat id>`, in the
 * home of the place the CLI ran in. The workspace hash is Cursor's, so the
 * chat is found by its id rather than by recomputing the hash. Best-effort.
 */
export async function removeCursorChat(chatId: string, place: CliPlace | null = null): Promise<void> {
  // The id comes off the CLI's own output and becomes a path segment of a
  // recursive delete, so only a plain id is trusted: `..` would name the chats
  // folder itself, and an empty one a whole workspace.
  if (!/^[\w-]+$/.test(chatId)) return;
  const chatsRoot = path.join(place ? cliHomeDir(place) : os.homedir(), '.cursor', 'chats');
  const workspaces = await fs.promises.readdir(chatsRoot).catch(() => [] as string[]);
  for (const workspace of workspaces) {
    const chatDirectory = path.join(chatsRoot, workspace, chatId);
    if (fs.existsSync(chatDirectory)) {
      await fs.promises.rm(chatDirectory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  }
}
