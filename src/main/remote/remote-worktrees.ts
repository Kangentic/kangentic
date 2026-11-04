/**
 * A task's git worktree on an SSH host (#913). The repository of a remote project is on the host, so the
 * worktree is made there, with the host's own git, by one short `sh` script the helper runs. Nothing about
 * it touches this computer's git: this computer holds an empty stand-in folder for the worktree at the same
 * path under the project's shell folder (`<shell>/.kangentic/worktrees/<n>`), which is what the task row
 * records. `isUnderLocalRoot` and `localPathToHost` then map it to the host's folder, so every place that
 * turns a task's folder into the agent's working directory works as it does for a local task, and a check
 * that the folder exists finds it.
 *
 * What it does on the host, in order: check the folder is the top of a plain repository with a commit,
 * fetch the base branch (best effort, never prompting), pick the start point the way a local task does
 * (`origin/<base>` when the fetch landed it, else the local branch, else the remote one), clear a husk at the
 * path, and `git worktree add`. A branch the task already has is attached, not recreated. The branch is kept
 * when the worktree is removed, as a local Done move keeps it.
 *
 * Not done on a host: the sparse checkout that leaves `.claude/commands/` out, the node_modules link, the
 * files copied from the project root, and the Post-Worktree Script. The last is shell text for this
 * computer, so it never runs here (`WorktreeManager.runWorktreeInitScript`).
 *
 * Imports nothing of electron.
 */

import * as fs from 'node:fs/promises';
import { localPathToHost, type SshCliPlace } from '../agent/shared/cli-target';
import { computeAutoBranchName, slugify } from '../../shared/slugify';
import { storedWorktreeChoice, taskUsesWorktree } from '../../shared/worktree-choice';
import { taskWorktreeFolderFor, taskWorktreePathFor } from '../git/task-worktree-folder';
import type { RemoteWorktreeBackend, RemoteWorktreeResolver, RemoteWorktreeTask } from '../git/remote-worktree';
import type { EnsureWorktreeResult } from '../git/worktree-manager';
import type { HostCommandRequest, HostCommandResult } from './protocol/messages';

const CREATE_TIMEOUT_MS = 240_000;
const REMOVE_TIMEOUT_MS = 60_000;
const LINE_PREFIX = 'KG:';

/** Arguments are `repo worktree branch explicit candidates...`. Output is `KG:` lines, and a failure is `KG:error:`. */
const CREATE_SCRIPT = `
fail() { printf 'KG:error:%s\\n' "$(printf '%s' "$1" | tr '\\n\\r' '  ')"; exit 3; }
repo=$1; worktree=$2; branch=$3; explicit=$4; shift 4
first=$1
cd "$repo" 2>/dev/null || fail "The folder $repo does not exist on this host."
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || { echo KG:skip:not-a-repo; exit 0; }
[ -z "$(git rev-parse --show-prefix 2>/dev/null)" ] || { echo KG:skip:not-a-repo; exit 0; }
[ "$(git rev-parse --git-dir 2>/dev/null)" = "$(git rev-parse --git-common-dir 2>/dev/null)" ] || { echo KG:skip:nested-worktree; exit 0; }
git rev-parse --verify --quiet HEAD >/dev/null 2>&1 || { echo KG:skip:no-commits; exit 0; }
fetched=0
if git remote get-url origin >/dev/null 2>&1; then
  GIT_TERMINAL_PROMPT=0 git fetch --quiet origin "$first" >/dev/null 2>&1 && fetched=1
fi
resolves() { git rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1; }
start=; basename=
for candidate in "$@"; do
  if [ "$candidate" = "$first" ] && [ "$fetched" = 1 ] && resolves "refs/remotes/origin/$candidate"; then start="origin/$candidate"; basename=$candidate; break; fi
  if resolves "refs/heads/$candidate"; then start=$candidate; basename=$candidate; break; fi
  if resolves "refs/remotes/origin/$candidate"; then start="origin/$candidate"; basename=$candidate; break; fi
done
if [ -z "$start" ]; then
  [ "$explicit" = 1 ] && fail "The base branch $first does not exist in the repository on this host."
  start=HEAD; basename=$(git symbolic-ref --short -q HEAD 2>/dev/null)
fi
branch_exists=0
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 && branch_exists=1
mkdir -p "\${worktree%/*}" || fail "Could not make the folder for $worktree on this host."
if [ -e "$worktree" ]; then git worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"; fi
git worktree prune >/dev/null 2>&1
if [ "$branch_exists" = 1 ]; then
  out=$(git worktree add "$worktree" "$branch" 2>&1) || fail "$out"
  cut=0
else
  out=$(git worktree add -b "$branch" "$worktree" "$start" 2>&1) || fail "$out"
  cut=1
fi
echo KG:created
echo "KG:branch:$branch"
if [ "$cut" = 1 ]; then echo "KG:base:$basename"; echo "KG:sha:$(git rev-parse "$branch" 2>/dev/null)"; fi
`.trim();

/** Arguments are `repo worktree`. Removes the worktree and git's record of it, and keeps the branch. */
const REMOVE_SCRIPT = `
fail() { printf 'KG:error:%s\\n' "$(printf '%s' "$1" | tr '\\n\\r' '  ')"; exit 3; }
repo=$1; worktree=$2
cd "$repo" 2>/dev/null || fail "The folder $repo does not exist on this host."
if [ -e "$worktree" ]; then git worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"; fi
git worktree prune >/dev/null 2>&1
[ ! -e "$worktree" ] || fail "Could not remove $worktree."
echo KG:removed
`.trim();

/** Argument is `worktree`. Counts what a removal would destroy. */
const PENDING_SCRIPT = `
worktree=$1
cd "$worktree" 2>/dev/null || { printf 'KG:error:%s\\n' "The worktree $worktree is not on this host."; exit 3; }
echo "KG:uncommitted:$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
echo "KG:branch:$(git symbolic-ref --short -q HEAD 2>/dev/null)"
`.trim();

export interface HostWorktreeDeps {
  /** The project's folder on the host. */
  hostRepoPath: string;
  /** The project's shell folder on this computer, where the stand-ins live. */
  shellFolder: string;
  runCommand(request: HostCommandRequest): Promise<HostCommandResult>;
  pathPresence(paths: string[]): Promise<Array<'present' | 'absent'>>;
  log?: (line: string) => void;
}

interface ScriptOutput {
  lines: string[];
  error: string | null;
}

function runScriptRequest(script: string, args: string[], cwd: string, timeoutMs: number): HostCommandRequest {
  return { file: 'sh', args: ['-c', script, 'kangentic-worktree', ...args], cwd, timeoutMs };
}

function readScriptOutput(result: HostCommandResult): ScriptOutput {
  if (result.error) return { lines: [], error: result.error };
  if (result.timedOut) return { lines: [], error: 'Git on the host took too long, so the worktree was not made.' };
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(LINE_PREFIX)).map((line) => line.slice(LINE_PREFIX.length));
  const failure = lines.find((line) => line.startsWith('error:'));
  if (failure) return { lines, error: failure.slice('error:'.length) };
  if (result.code !== 0) return { lines, error: result.stderr.trim() || `The host's shell exited with ${String(result.code)}.` };
  return { lines, error: null };
}

/**
 * The host path of a worktree stand-in, only when it is exactly one folder below the project's worktrees
 * folder on the host. The removal script deletes it, so nothing else may reach it.
 */
export function hostWorktreePathFor(localWorktreePath: string, shellFolder: string, hostRepoPath: string): string {
  const roots: SshCliPlace['roots'] = [{ local: shellFolder, host: hostRepoPath }];
  const hostPath = localPathToHost(localWorktreePath, roots);
  const prefix = `${hostRepoPath.replace(/\/+$/, '')}/.kangentic/worktrees/`;
  const rest = hostPath.startsWith(prefix) ? hostPath.slice(prefix.length) : '';
  if (rest === '' || rest.includes('/') || rest === '.' || rest === '..') {
    throw new Error(`Refusing to touch ${hostPath} on the host: it is not a worktree folder of this project.`);
  }
  return hostPath;
}

/** Base branch candidates in the order a task is cut from them. A base the task names is the only one. */
function baseCandidates(task: RemoteWorktreeTask, defaultBaseBranch: string): { candidates: string[]; explicit: boolean } {
  const named = task.base_branch?.trim();
  if (named) return { candidates: [named], explicit: true };
  const ordered = [defaultBaseBranch.trim() || 'main', 'main', 'master'];
  return { candidates: [...new Set(ordered)], explicit: false };
}

export class HostWorktrees implements RemoteWorktreeBackend {
  constructor(private readonly deps: HostWorktreeDeps) {}

  async ensureWorktree(
    task: RemoteWorktreeTask,
    gitConfig: { worktreesEnabled: boolean; defaultBaseBranch: string },
    options?: { onProgress?: (phase: string) => void; signal?: AbortSignal },
  ): Promise<EnsureWorktreeResult> {
    if (!taskUsesWorktree(gitConfig.worktreesEnabled, storedWorktreeChoice(task.use_worktree))) return { skipped: true, reason: 'disabled' };

    const localPath = taskWorktreePathFor(task, this.deps.shellFolder);
    const hostPath = hostWorktreePathFor(localPath, this.deps.shellFolder, this.deps.hostRepoPath);
    // A worktree the task already has is kept. Only the host can say it is there: a link that is down is an
    // error here, never "absent", so a task is not given a second worktree for want of an answer.
    if (task.worktree_path) {
      const [git] = await this.deps.pathPresence([`${hostPath}/.git`]);
      if (git === 'present') return { skipped: true, reason: 'reused' };
    }

    options?.onProgress?.('creating-worktree');
    options?.signal?.throwIfAborted();
    const branchName = task.branch_name ?? computeAutoBranchName(slugify(task.title) || 'task', task.id.slice(0, 8));
    const { candidates, explicit } = baseCandidates(task, gitConfig.defaultBaseBranch);
    const result = await this.deps.runCommand(runScriptRequest(
      CREATE_SCRIPT,
      [this.deps.hostRepoPath, hostPath, branchName, explicit ? '1' : '0', ...candidates],
      this.deps.hostRepoPath,
      CREATE_TIMEOUT_MS,
    ));
    options?.signal?.throwIfAborted();
    const output = readScriptOutput(result);
    if (output.error) throw new Error(`Could not make the worktree on the host: ${output.error}`);

    const skip = output.lines.find((line) => line.startsWith('skip:'));
    if (skip) {
      const reason = skip.slice('skip:'.length);
      if (reason === 'not-a-repo' || reason === 'nested-worktree' || reason === 'no-commits') return { skipped: true, reason };
      throw new Error(`The host's git answered with an unknown reason: ${reason}`);
    }
    if (!output.lines.includes('created')) throw new Error('The host did not say the worktree was made, so it was not recorded.');

    // The stand-in, so the folder exists here as it does for a worktree on this computer.
    await fs.mkdir(localPath, { recursive: true });
    const valueOf = (key: string): string | null => {
      const line = output.lines.find((candidate) => candidate.startsWith(`${key}:`));
      const value = line ? line.slice(key.length + 1).trim() : '';
      return value === '' ? null : value;
    };
    return {
      worktreePath: localPath,
      branchName: valueOf('branch') ?? branchName,
      worktreeFolder: taskWorktreeFolderFor(task),
      baseBranch: valueOf('base'),
      forkPointSha: valueOf('sha'),
    };
  }

  async pendingChanges(worktreePath: string): Promise<{ uncommittedFileCount: number; currentBranch: string | null }> {
    const hostPath = hostWorktreePathFor(worktreePath, this.deps.shellFolder, this.deps.hostRepoPath);
    const result = await this.deps.runCommand(runScriptRequest(PENDING_SCRIPT, [hostPath], this.deps.hostRepoPath, REMOVE_TIMEOUT_MS));
    const output = readScriptOutput(result);
    if (output.error) throw new Error(output.error);
    const value = (key: string): string => output.lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';
    // A count that cannot be read is an error, never zero: zero says the tree is clean (and `Number('')` is 0).
    if (!/^\d+$/.test(value('uncommitted'))) throw new Error('The host did not say how many files are changed.');
    return { uncommittedFileCount: Number(value('uncommitted')), currentBranch: value('branch') || null };
  }

  async removeWorktree(worktreePath: string): Promise<boolean> {
    let hostPath: string;
    try {
      hostPath = hostWorktreePathFor(worktreePath, this.deps.shellFolder, this.deps.hostRepoPath);
    } catch (error) {
      this.deps.log?.(`[WORKTREE] ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    try {
      const result = await this.deps.runCommand(runScriptRequest(REMOVE_SCRIPT, [this.deps.hostRepoPath, hostPath], this.deps.hostRepoPath, REMOVE_TIMEOUT_MS));
      const output = readScriptOutput(result);
      if (output.error || !output.lines.includes('removed')) {
        this.deps.log?.(`[WORKTREE] could not remove ${hostPath} on the host: ${output.error ?? 'the host did not confirm it'}`);
        return false;
      }
    } catch (error) {
      // A host out of reach leaves the worktree where it is, and the task keeps its path to retry with.
      this.deps.log?.(`[WORKTREE] could not reach the host to remove ${hostPath}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
    return true;
  }
}

export interface RemoteWorktreeResolverDeps {
  /** The host and folder a project's shell folder stands for, or null when the path is not a remote project's. */
  remoteOfProjectPath(projectPath: string): { hostId: string; path: string } | null;
  runCommand(hostId: string, request: HostCommandRequest): Promise<HostCommandResult>;
  pathPresence(hostId: string, paths: string[]): Promise<Array<'present' | 'absent'>>;
  log?: (line: string) => void;
}

export function createRemoteWorktreeResolver(deps: RemoteWorktreeResolverDeps): RemoteWorktreeResolver {
  return (projectPath) => {
    const remote = deps.remoteOfProjectPath(projectPath);
    if (!remote) return null;
    return new HostWorktrees({
      hostRepoPath: remote.path,
      shellFolder: projectPath,
      runCommand: (request) => deps.runCommand(remote.hostId, request),
      pathPresence: (paths) => deps.pathPresence(remote.hostId, paths),
      ...(deps.log ? { log: deps.log } : {}),
    });
  };
}
