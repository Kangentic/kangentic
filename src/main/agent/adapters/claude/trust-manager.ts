import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash } from '../../../../shared/paths';

// Module-level promise chain serializing all ~/.claude.json access.
// Both ensureWorktreeTrust and ensureMcpServerTrust target the same file,
// so one lock covers both. Prevents concurrent read-modify-write races
// when multiple tasks are spawned simultaneously.
let claudeJsonLock: Promise<unknown> = Promise.resolve();

function withClaudeJsonLock<T>(operation: () => T): Promise<T> {
  const previous = claudeJsonLock;
  const result = previous.then(operation, () => operation());
  claudeJsonLock = result.catch(() => {});
  return result;
}

/**
 * Pre-populate Claude Code's trust entry for a worktree path so the
 * "Is this a project you trust?" prompt is skipped when spawning an agent.
 *
 * Claude Code stores per-directory trust in ~/.claude.json under
 * `projects[<resolved-path>].hasTrustDialogAccepted`.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  return withClaudeJsonLock(() => ensureWorktreeTrustSync(worktreePath));
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
  return withClaudeJsonLock(() => ensureMcpServerTrustSync(projectPath));
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
