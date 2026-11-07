import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { cliPathForTarget, type SshCliPlace } from '../../shared/cli-target';
import type { JsonPatchOp } from '../../../remote/protocol/messages';

const LOG_TAG = '[CLAUDE_REMOTE_TRUST]';

/**
 * What a Claude spawn needs from the host's files when the CLI runs on a remote host (#913), the
 * counterpart of `ensureClaudeSpawnConfig` and of the local reads the command builder does:
 *
 * - The host's `~/.claude.json` gets the same changes the local one does (the directory trusted, the
 *   `kangentic` MCP server enabled for it, the diff panel kept closed), but applied by the helper, on
 *   the host, under Claude's own `~/.claude.json.lock`, since the app cannot do a read-modify-write
 *   across the link. The edit is declarative (`json-patch.ts`), so the helper knows nothing of Claude.
 * - The host's project settings, `settings.local.json` and the user's `~/.claude/settings.json` are
 *   copied into the folders the command builder reads on this computer, so the session's merged
 *   settings carry the project's own hooks and permissions. A file the host does not have removes the
 *   copy, so a deleted setting does not linger.
 */

/** The edit that trusts a directory on the host and lists the kangentic MCP server for it. */
export function remoteClaudeSpawnPatch(directoryOnHost: string): JsonPatchOp[] {
  const markerIndex = directoryOnHost.indexOf('/.kangentic/worktrees/');
  const entry = ['projects', directoryOnHost];
  const ops: JsonPatchOp[] = [
    // A worktree starts with its repository's approvals, as the local trust write copies them.
    {
      op: 'copyIfAbsent',
      from: markerIndex === -1 ? [...entry, 'enabledMcpjsonServers'] : ['projects', directoryOnHost.slice(0, markerIndex), 'enabledMcpjsonServers'],
      at: [...entry, 'enabledMcpjsonServers'],
      fallback: [],
    },
    { op: 'setDefault', at: [...entry, 'allowedTools'], value: [] },
    { op: 'setDefault', at: [...entry, 'disabledMcpjsonServers'], value: [] },
    { op: 'set', at: [...entry, 'hasTrustDialogAccepted'], value: true },
    { op: 'addToArray', at: [...entry, 'enabledMcpjsonServers'], value: 'kangentic' },
    { op: 'set', at: ['diffSidebarOpen'], value: false },
  ];
  return ops;
}

/** Trust the working directory on the host, then pull the settings the builder reads. */
export async function ensureRemoteClaudeSpawnConfig(workingDirectory: string, place: SshCliPlace): Promise<void> {
  const files = place.files;
  if (!files) throw new Error('This host has no connection to edit its Claude files through.');

  const directoryOnHost = cliPathForTarget(path.resolve(workingDirectory), place);
  const patched = files.jsonPatch({
    path: `${place.home}/.claude.json`,
    lockDirectory: `${place.home}/.claude.json.lock`,
    ops: remoteClaudeSpawnPatch(directoryOnHost),
  });

  // Each pull is its own round trip to the host and none depends on another or on the patch, so they
  // run together: one round trip's wait per spawn instead of five or more in a row.
  const pulls: Array<{ hostPath: string; localPath: string }> = [
    { hostPath: `${place.home}/.claude/settings.json`, localPath: path.join(place.localHome, '.claude', 'settings.json') },
  ];
  for (const root of place.roots) {
    pulls.push({ hostPath: `${root.host}/.claude/settings.json`, localPath: path.join(root.local, '.claude', 'settings.json') });
    pulls.push({ hostPath: `${root.host}/.claude/settings.local.json`, localPath: path.join(root.local, '.claude', 'settings.local.json') });
  }
  // A worktree keeps its own "always allow" grants, which the merged settings carry on resume.
  const worktreeLocal = path.join(path.resolve(workingDirectory), '.claude', 'settings.local.json');
  if (!pulls.some((pull) => pull.localPath === worktreeLocal)) {
    pulls.push({ hostPath: cliPathForTarget(worktreeLocal, place), localPath: worktreeLocal });
  }
  const [result] = await Promise.all([patched, ...pulls.map((pull) => pullFile(place, pull.hostPath, pull.localPath))]);
  if (!result.applied) {
    if (result.reason === 'bad-patch') throw new Error(`The host's Claude settings could not be edited: ${result.reason}.`);
    // The CLI's own policy on a lock that stays held, and on a file that is not what it should be: skip,
    // and the session shows one trust prompt, which costs less than a write that could lose the user's state.
    console.warn(`${LOG_TAG} Skipping the trust edit on host ${place.hostId}: ${result.reason}`);
  }
}

/** Copy one host file to a local path, or remove the local copy when the host has none. */
async function pullFile(place: SshCliPlace, hostPath: string, localPath: string): Promise<void> {
  const files = place.files;
  if (!files) return;
  const answer = await files.readFile(hostPath);
  if (!answer.exists || answer.content === null) {
    await fs.rm(localPath, { force: true });
    return;
  }
  // An unchanged copy is not rewritten, so its modification time keeps meaning something to a watcher.
  const existing = await fs.readFile(localPath, 'utf8').catch(() => null);
  if (existing === answer.content) return;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, answer.content, 'utf8');
}
