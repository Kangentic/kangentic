import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash } from '../../shared/paths';

/**
 * Pre-populate Claude Code's trust entry for a worktree path so the
 * "Is this a project you trust?" prompt is skipped when spawning an agent.
 *
 * Claude Code stores per-directory trust in ~/.claude.json under
 * `projects[<resolved-path>].hasTrustDialogAccepted`.
 */
export function ensureWorktreeTrust(worktreePath: string): void {
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

  // Already trusted — nothing to do
  if (projects[resolvedPath]?.hasTrustDialogAccepted === true) {
    return;
  }

  // Copy MCP server approvals from the parent project entry if it exists.
  // The parent project is the repo root (worktree paths live under .worktrees/).
  let parentMcpServers: string[] = [];
  const markerIdx = resolvedPath.indexOf('/.worktrees/');
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
