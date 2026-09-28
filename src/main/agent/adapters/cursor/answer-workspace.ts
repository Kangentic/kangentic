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

export const CURSOR_MCP_URL_ENV = 'KANGENTIC_MCP_URL';
export const CURSOR_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    kangentic: {
      url: `\${env:${CURSOR_MCP_URL_ENV}}`,
      headers: { 'X-Kangentic-Token': `\${env:${CURSOR_MCP_TOKEN_ENV}}` },
    },
  },
}, null, 2);

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

export async function writeCursorAnswerWorkspace(answerHome: string): Promise<void> {
  await writeIfChanged(path.join(answerHome, '.cursor', 'mcp.json'), MCP_CONFIG);
  await writeIfChanged(path.join(answerHome, '.cursor', 'cli.json'), PERMISSIONS);
}

/**
 * Remove one chat from `~/.cursor/chats/<workspace hash>/<chat id>`. The
 * workspace hash is Cursor's, so the chat is found by its id rather than by
 * recomputing the hash. Best-effort.
 */
export async function removeCursorChat(chatId: string): Promise<void> {
  const chatsRoot = path.join(os.homedir(), '.cursor', 'chats');
  const workspaces = await fs.promises.readdir(chatsRoot).catch(() => [] as string[]);
  for (const workspace of workspaces) {
    const chatDirectory = path.join(chatsRoot, workspace, chatId);
    if (fs.existsSync(chatDirectory)) {
      await fs.promises.rm(chatDirectory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  }
}
