import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash } from '../../../../shared/paths';
import { isClaudeJsonLockError, withClaudeJsonLock } from './claude-json-lock';

// Every ~/.claude.json read-modify-write in this adapter runs under one lock:
// an in-process chain against our own writers, plus Claude's own
// `~/.claude.json.lock` against the CLI's writes. Lives in claude-json-lock.ts;
// re-exported so the other writers (diff-panel, project-relocation) keep their
// import.
export { withClaudeJsonLock };

const LOG_TAG = '[CLAUDE_TRUST]';

/**
 * Pre-populate Claude Code's trust entry for a worktree path so the
 * "Is this a project you trust?" prompt is skipped when spawning an agent.
 *
 * Claude Code stores per-directory trust in ~/.claude.json under
 * `projects[<resolved-path>].hasTrustDialogAccepted`.
 *
 * A lock that stays held past the budget skips the write (Claude's own policy
 * on a final ELOCKED): the session then shows one trust prompt, which costs
 * less than a write that could resurrect a withdrawn boot-canary record.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  try {
    await withClaudeJsonLock(() => ensureWorktreeTrustSync(worktreePath));
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the worktree trust write; ${error.message}`);
  }
}

function ensureWorktreeTrustSync(worktreePath: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const resolvedPath = toForwardSlash(path.resolve(worktreePath));

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch {
    data = {};
  }

  if (!data.projects || typeof data.projects !== 'object') {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;

  // Already trusted - nothing to do
  if (projects[resolvedPath]?.hasTrustDialogAccepted === true) {
    return;
  }

  // Copy MCP server approvals from the parent project entry if it exists.
  // The parent project is the repo root (worktree paths live under .kangentic/worktrees/).
  let parentMcpServers: string[] = [];
  const markerIdx = resolvedPath.indexOf('/.kangentic/worktrees/');
  if (markerIdx !== -1) {
    const parentPath = resolvedPath.substring(0, markerIdx);
    const parentEntry = projects[parentPath];
    if (parentEntry && Array.isArray(parentEntry.enabledMcpjsonServers)) {
      parentMcpServers = parentEntry.enabledMcpjsonServers as string[];
    }
  }

  projects[resolvedPath] = {
    allowedTools: [],
    enabledMcpjsonServers: parentMcpServers,
    disabledMcpjsonServers: [],
    ...(projects[resolvedPath] || {}),
    hasTrustDialogAccepted: true,
  };

  fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Ensure the "kangentic" MCP server is listed in enabledMcpjsonServers
 * for a project path so Claude Code auto-enables it without prompting.
 *
 * Called for all sessions (main repo and worktrees).
 */
export async function ensureMcpServerTrust(projectPath: string): Promise<void> {
  try {
    await withClaudeJsonLock(() => ensureMcpServerTrustSync(projectPath));
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the MCP server trust write; ${error.message}`);
  }
}

function ensureMcpServerTrustSync(projectPath: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const resolvedPath = toForwardSlash(path.resolve(projectPath));

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch {
    data = {};
  }

  if (!data.projects || typeof data.projects !== 'object') {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;

  if (!projects[resolvedPath]) {
    projects[resolvedPath] = {};
  }

  const entry = projects[resolvedPath];
  const enabledServers = Array.isArray(entry.enabledMcpjsonServers)
    ? entry.enabledMcpjsonServers as string[]
    : [];

  if (enabledServers.includes('kangentic')) {
    return; // Already trusted
  }

  entry.enabledMcpjsonServers = [...enabledServers, 'kangentic'];
  fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');
}
