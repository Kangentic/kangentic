import * as fs from 'node:fs';
import { gitAt, type GitClient } from './git-client';
import { ProjectRepository } from '../db/repositories/project-repository';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { isSamePath } from '../../shared/paths';
import { agentPathsForProject, type AgentPaths } from '../remote/host-paths';
import type { Project, ProjectWorktrees, WorktreeRecord } from '../../shared/types';

/**
 * Enumerate worktrees across one project or every registered project.
 * Each worktree record carries its branch, dirty state, and commit delta
 * vs. the base branch its work is based on (falling back to its tracked
 * upstream only when no base is known) - enough for an agent to find a
 * task's branch, locate dirty work, or tell whether its tree is behind the
 * base it was cut from.
 *
 * The base is INJECTED (`resolveBaseRef`), not resolved here: it lives in
 * the task DB and the board/config defaults, and keeping those imports out
 * of this module is what lets its unit test run on a mocked git alone.
 *
 * Pure read-only. Never fetches; the counts are as current as the remote-
 * tracking refs, which the background fetch scheduler keeps refreshed for
 * the focused project.
 *
 * Git runs in the pty host (`gitAt`), never on main, where each start blocks
 * for its CreateProcess on Windows: in a dev build these walks pushed main's
 * worst 10 s window to 4.6 s, with a worktree creation overlapping it.
 * Each worktree takes four or five git runs, and the host starts them all on
 * one spawn worker thread, about 110 ms each on a busy machine. So worktrees are
 * read `WORKTREE_READ_CONCURRENCY` at a time: with every start queued at once, a
 * task's own git and an agent CLI run would wait behind the whole enumeration.
 *
 * Failure modes: if a project's path no longer exists on disk, that project
 * appears with an empty `worktrees` array. Individual worktrees that fail
 * to resolve (e.g. mid-rebase, broken HEAD) get a record with as much info
 * as we can salvage and `branch` / `dirty` set to `null` / `false`.
 *
 * A remote project's git runs on its host (`gitAt`), and prints the host's paths,
 * while the project row holds this computer's stand-in. Each entry is mapped back
 * before `gitAt`, which otherwise finds no such folder here, or on a computer laid
 * out like the host, runs this computer's git in an unrelated checkout. A host that
 * cannot answer is `error` on the project, never an empty list: it says nothing
 * about what the host holds. A worktree outside the project's folder (one a person
 * made by hand) has no stand-in, so only what git listed is known of it.
 */

interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  isMainCheckout: boolean;
}

/** One entry as this computer reads it, and as the agent is told it. */
interface MappedWorktree extends ParsedWorktree {
  /** The folder `gitAt` is given, or null when this computer has none for it. */
  gitDirectory: string | null;
  /** The stand-in, for a remote project. */
  localPath?: string;
}

/** Worktrees of one project read at once, and so git runs in flight at most. */
export const WORKTREE_READ_CONCURRENCY = 4;

/** What the base resolver is told about the worktree it is asked about. */
export interface WorktreeBaseRefInput {
  projectId: string;
  projectPath: string;
  worktreePath: string;
  /** Checked-out branch, or null for a detached HEAD. */
  branch: string | null;
  isMainCheckout: boolean;
}

export interface EnumerateWorktreesOptions {
  /** Limit to a single project. When omitted, enumerates every registered project. */
  projectId?: string;
  /**
   * The base branch a worktree's work is BASED ON (a task's base, else the
   * project default), or null when unknown. When absent or null the record
   * falls back to the branch's own upstream, which measures how current the
   * branch is with ITS remote, not with the base it was cut from: a branch
   * can be 0 behind its remote and 200 behind the base, and only the second
   * number answers "is my tree up to date". A throwing resolver counts as
   * null.
   */
  resolveBaseRef?: (input: WorktreeBaseRefInput) => string | null;
}

export async function enumerateWorktrees(
  options: EnumerateWorktreesOptions = {},
): Promise<ProjectWorktrees[]> {
  const repository = new ProjectRepository();
  const projects = options.projectId
    ? [repository.getById(options.projectId)].filter((p) => p !== undefined)
    : repository.list();

  const results: ProjectWorktrees[] = [];
  for (const project of projects) {
    if (!project) continue;
    const paths = agentPathsForProject(project);
    const shape = {
      projectId: project.id,
      projectName: project.name,
      projectPath: paths.projectFolder,
      location: paths.location,
      ...(paths.location === 'host' ? { shellFolder: paths.shellFolder } : {}),
    };
    // host-value-ok: the shell folder, which exists while the project does
    if (!fs.existsSync(project.path)) {
      results.push({ ...shape, worktrees: [] });
      continue;
    }

    let parsed: ParsedWorktree[];
    try {
      // host-value-ok: gitAt maps this folder to the host
      parsed = await parseWorktreeList(project.path, paths);
    } catch (error) {
      results.push({ ...shape, worktrees: [], error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const records = await mapWithConcurrency(
      mapToThisComputer(parsed, project, paths),
      WORKTREE_READ_CONCURRENCY,
      // host-value-ok: the row's form, which the base lookup compares against
      (entry) => buildRecord(entry, project.id, project.path, paths, options.resolveBaseRef),
    );
    results.push({ ...shape, worktrees: records });
  }
  return results;
}

/**
 * Where each entry is on this computer. Git prints real paths and a project's row keeps the path the user added, so
 * a host whose home is a symlink spells the project's folder differently from `remote.path`. Git lists the main
 * worktree first, so the entries are mapped from its spelling.
 */
function mapToThisComputer(parsed: readonly ParsedWorktree[], project: Project, paths: AgentPaths): MappedWorktree[] {
  if (!project.remote) return parsed.map((entry) => ({ ...entry, gitDirectory: entry.path }));
  const main = parsed.find((entry) => entry.isMainCheckout);
  const onGitSpelling = main && project.remote.path !== main.path
    // host-value-ok: this is the map, from the local side
    ? agentPathsForProject({ path: project.path, remote: { hostId: project.remote.hostId, path: main.path } })
    : paths;
  return parsed.map((entry) => {
    if (!onGitSpelling.isHostPath(entry.path)) return { ...entry, gitDirectory: null };
    const localPath = onGitSpelling.fromAgent(entry.path);
    return { ...entry, gitDirectory: localPath, localPath };
  });
}

/** A remote project's main worktree, which git lists first: only the entry for its own folder when one matches exactly. */
function isHostMainCheckout(entryPath: string, index: number, entries: readonly { path: string }[], paths: AgentPaths): boolean {
  const named = entries.some((entry) => entry.path === paths.projectFolder);
  return named ? entryPath === paths.projectFolder : index === 0;
}

async function parseWorktreeList(projectPath: string, paths: AgentPaths): Promise<ParsedWorktree[]> {
  let raw: string;
  try {
    raw = await gitAt(projectPath).raw(['worktree', 'list', '--porcelain']);
  } catch (error) {
    if (paths.location === 'host') throw new Error(`The host could not list this project's worktrees: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    return [];
  }
  // Porcelain output is paragraphs separated by blank lines, each starting
  // with `worktree <path>` and followed by `HEAD <sha>`, `branch <ref>`,
  // and optional `bare` / `detached` markers.
  const blocks = raw.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  const parsed: ParsedWorktree[] = [];
  for (const block of blocks) {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        // `refs/heads/<name>` -> `<name>`
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    if (worktreePath) {
      parsed.push({
        path: worktreePath,
        head,
        branch,
        // Compared as resolved paths: the porcelain listing prints forward
        // slashes while the project row was written by Node, so on Windows a
        // plain string compare never matched and every main checkout read as
        // a worktree.
        isMainCheckout: isSamePath(worktreePath, projectPath),
      });
    }
  }
  // A host's path never matches the row's stand-in, and on Windows `isSamePath` resolves it onto a drive.
  if (paths.location === 'host') {
    return parsed.map((entry, index) => ({ ...entry, isMainCheckout: isHostMainCheckout(entry.path, index, parsed, paths) }));
  }
  return parsed;
}

/**
 * `git rev-list --left-right --count <ref>...HEAD` returns `<behind>\t<ahead>`
 * (left = reachable from `ref` only, right = from HEAD only). null when the
 * ref does not exist (no remote, base never fetched) or the output is not two
 * integers, so a caller can try the next candidate.
 */
async function countLeftRight(git: GitClient, ref: string): Promise<{ behind: number; ahead: number } | null> {
  try {
    const counts = (await git.raw(['rev-list', '--left-right', '--count', `${ref}...HEAD`])).trim();
    const [behindText, aheadText] = counts.split(/\s+/);
    const behind = Number.parseInt(behindText ?? '', 10);
    const ahead = Number.parseInt(aheadText ?? '', 10);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
    return { behind, ahead };
  } catch {
    return null;
  }
}

/** `gitAt` throws at once for a folder that does not exist; a worktree removed under us is no error. */
function gitAtOrNull(directory: string): GitClient | null {
  try {
    return gitAt(directory);
  } catch {
    return null;
  }
}

async function buildRecord(
  entry: MappedWorktree,
  projectId: string,
  projectPath: string,
  paths: AgentPaths,
  resolveBaseRef: EnumerateWorktreesOptions['resolveBaseRef'],
): Promise<WorktreeRecord> {
  const baseRecord: WorktreeRecord = {
    path: entry.path,
    location: paths.location,
    ...(entry.localPath ? { localPath: entry.localPath } : {}),
    branch: entry.branch,
    baseRef: null,
    dirty: false,
    commitsAhead: null,
    commitsBehind: null,
    lastCommitTs: null,
    isMainCheckout: entry.isMainCheckout,
  };

  // Worktree may have been removed externally between `worktree list` and now.
  if (entry.gitDirectory === null) return baseRecord;
  const worktreeGit = gitAtOrNull(entry.gitDirectory);
  if (!worktreeGit) return baseRecord;

  // Dirty status. status() throws on a half-broken worktree (mid-rebase,
  // missing HEAD); we treat those as "unknown" rather than fail.
  let dirty: boolean;
  try {
    const status = await worktreeGit.status();
    dirty = status.files.length > 0;
  } catch {
    dirty = false;
  }

  // Last commit timestamp on the current branch.
  let lastCommitTs: string | null;
  try {
    const isoTimestamp = (await worktreeGit.raw(['log', '-1', '--format=%cI'])).trim();
    lastCommitTs = isoTimestamp || null;
  } catch {
    lastCommitTs = null;
  }

  // Ahead/behind, against the BASE the work is based on when one is known:
  // `origin/<base>` first (the local ref may be stale), then the local
  // `<base>`, the same order branch-summary.ts and diff-service.ts use. Only
  // when no base resolves does it fall back to the branch's own upstream. The
  // two answer different questions: a branch current with its remote can be
  // far behind the base it was cut from, and reporting the first as "0 behind"
  // is exactly the false reassurance an agent takes at face value.
  let baseRef: string | null = null;
  let commitsAhead: number | null = null;
  let commitsBehind: number | null = null;
  let baseBranch: string | null;
  try {
    baseBranch = resolveBaseRef?.({
      projectId,
      projectPath,
      // The form the task row holds, which is the stand-in for a remote project.
      worktreePath: entry.gitDirectory,
      branch: entry.branch,
      isMainCheckout: entry.isMainCheckout,
    }) ?? null;
  } catch {
    baseBranch = null;
  }
  if (baseBranch) {
    for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
      const counts = await countLeftRight(worktreeGit, candidate);
      if (!counts) continue;
      baseRef = baseBranch;
      commitsBehind = counts.behind;
      commitsAhead = counts.ahead;
      break;
    }
  }
  if (baseRef === null) {
    try {
      const upstream = (
        await worktreeGit.raw(['rev-parse', '--abbrev-ref', '@{upstream}'])
      ).trim();
      if (upstream) {
        const counts = await countLeftRight(worktreeGit, upstream);
        if (counts) {
          commitsBehind = counts.behind;
          commitsAhead = counts.ahead;
        }
      }
    } catch {
      // No upstream configured (common for fresh task worktrees) - leave as null.
    }
  }

  return {
    ...baseRecord,
    baseRef,
    dirty,
    lastCommitTs,
    commitsAhead,
    commitsBehind,
  };
}
