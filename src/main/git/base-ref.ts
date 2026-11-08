import { execFileAsync } from '../utility-process/off-main-exec';
import { runGitWithTimeout } from './git-spawn';
import type { GitResolveRefResult } from '../../shared/types';

/** The same cap a base branch's fetch gets (`fetch-throttle.ts`). */
const TAG_FETCH_TIMEOUT_MS = 15_000;

/**
 * What a task's base names. A base is free text: the picker and the MCP
 * `baseBranch` field both take a branch, a tag or a commit, so every reader
 * of the base asks this module what it is rather than assuming a branch.
 *
 * - `branch`: `refs/heads/<base>` or `refs/remotes/origin/<base>` resolves.
 *   It moves, so it is fetched, cut from origin unless local is ahead, and
 *   can be updated from.
 * - `tag`: `refs/tags/<base>` resolves. A fixed point, never fetched as a
 *   branch and never updated from.
 * - `commit`: a full or short SHA (hex only) that names a commit. Also a
 *   fixed point. Any other expression git can resolve (`HEAD`, `main~1`,
 *   `origin/main`) is not one: it moves, so freezing it to the commit it
 *   names today would be wrong.
 * - `unresolved`: nothing above resolves, or the value is option-shaped.
 *
 * The order is fixed and is the only one: a branch named like a tag is a
 * branch, and a tag named like a SHA is a tag, at every reader.
 */
export type BaseRef =
  | { kind: 'branch'; localSha: string | null; remoteSha: string | null }
  | { kind: 'tag'; ref: string; sha: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'unresolved' };

/** The two kinds of base {@link isFixedBase} accepts. */
export type FixedBaseRef = Extract<BaseRef, { kind: 'tag' } | { kind: 'commit' }>;

/** A base that does not move: a tag or a commit. */
export function isFixedBase(baseRef: BaseRef): baseRef is FixedBaseRef {
  return baseRef.kind === 'tag' || baseRef.kind === 'commit';
}

/**
 * The ref a task cuts from for a fixed base: the tag's full ref, so a branch
 * of the same name cannot shadow it, or the commit's full SHA.
 */
export function fixedBaseStartPoint(baseRef: FixedBaseRef): string {
  return baseRef.kind === 'tag' ? baseRef.ref : baseRef.sha;
}

/**
 * A value git would read as an option rather than a revision. Every git verb
 * that takes a ref parses a leading dash as a flag (`--output=<path>` writes a
 * file), and `--` cannot fix it for `rev-parse` or `rev-list`, where it
 * separates revisions from paths. No branch, tag or SHA starts with a dash.
 */
export function isOptionShapedRef(value: string): boolean {
  return value.startsWith('-');
}

export const TAG_REF_PREFIX = 'refs/tags/';

/** What a commit base looks like: four or more hex digits, git's shortest abbreviation. */
const SHA_SHAPE = /^[0-9a-f]{4,64}$/i;

/**
 * A name that can be a branch or a tag, checked before it is built into a ref.
 * git reads revision syntax in any ref string it is handed, so without this
 * `main~1` would peel as `refs/heads/main~1` (the parent of main) and read as
 * the branch `main~1`, and `HEAD` would peel as `refs/remotes/origin/HEAD`. In
 * a fetch refspec a glob (`*`) would fetch every tag on origin. The rest are
 * characters `git check-ref-format` refuses anyway. `HEAD` and `@` are names
 * git keeps for itself and refuses as a branch.
 */
function isPlausibleRefName(name: string): boolean {
  if (!name || isOptionShapedRef(name)) return false;
  if (name === 'HEAD' || name === '@') return false;
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return true;
}

/**
 * The commit `ref` peels to, or null. `^{commit}` is what makes this a real
 * check: a bare `rev-parse --verify <40 hex>` exits 0 for an object that does
 * not exist, so without the peel any SHA-shaped string "verifies".
 */
export async function peelToCommit(projectPath: string, ref: string): Promise<string | null> {
  if (!ref || isOptionShapedRef(ref)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: projectPath,
      windowsHide: true,
    });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** Classify `base` against this repo's refs, without touching the network. */
export async function classifyBaseRef(projectPath: string, base: string): Promise<BaseRef> {
  return classifyBaseRefWith((ref) => peelToCommit(projectPath, ref), base);
}

/**
 * {@link classifyBaseRef} over a caller's own peel, for a reader that already
 * holds a git client (`task-changes.ts`). `peel` returns the commit a ref
 * peels to, or null; it is never handed an option-shaped value. The
 * precedence lives here only, so every reader classifies a name the same way.
 */
export async function classifyBaseRefWith(peel: (ref: string) => Promise<string | null>, base: string): Promise<BaseRef> {
  const trimmed = base.trim();
  // A SHA passes this too; anything that fails it is an expression, never a base.
  if (!isPlausibleRefName(trimmed)) return { kind: 'unresolved' };

  const [localSha, remoteSha] = await Promise.all([
    peel(`refs/heads/${trimmed}`),
    peel(`refs/remotes/origin/${trimmed}`),
  ]);
  if (localSha || remoteSha) return { kind: 'branch', localSha, remoteSha };

  const tagRef = `${TAG_REF_PREFIX}${trimmed}`;
  const tagSha = await peel(tagRef);
  if (tagSha) return { kind: 'tag', ref: tagRef, sha: tagSha };

  // Only a SHA is a commit base, and only when the commit it names is that
  // SHA: a hex string can also be read as some other ref's name.
  if (SHA_SHAPE.test(trimmed)) {
    const commitSha = await peel(trimmed);
    if (commitSha && commitSha.toLowerCase().startsWith(trimmed.toLowerCase())) return { kind: 'commit', sha: commitSha };
  }

  return { kind: 'unresolved' };
}

/**
 * Which of a branch's two forms a task cuts from: `remote` unless the local
 * branch contains it and has more commits (a merge not pushed yet), in which
 * case `local`. A stale local branch never wins, and unpushed local work is
 * never dropped. Every cut and the Changes panel's base (`task-changes.ts`)
 * decide through this one rule. `isAncestor` is the caller's own check, so a
 * reader holding a git client does not spawn another way. Null when neither
 * form resolves.
 */
export async function chooseBranchForm(
  localSha: string | null,
  remoteSha: string | null,
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<'local' | 'remote' | null> {
  if (!remoteSha) return localSha ? 'local' : null;
  if (!localSha || localSha === remoteSha) return 'remote';
  return await isAncestor(remoteSha, localSha) ? 'local' : 'remote';
}

/** True when `ancestor` is reachable from `descendant`. Any git failure reads as false. */
async function isAncestor(projectPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: projectPath,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The start point a branch base cuts from, by {@link chooseBranchForm}:
 * `origin/<name>`, or the full `refs/heads/<name>` (git reads a bare name
 * tag-first, so a tag of the same name would otherwise take the cut). Returns
 * null when neither form resolves.
 *
 * `known` carries shas the caller already peeled, so they are not peeled
 * again: a classification's both, or after a fetch only the local one (the
 * fetch can move origin, never the local branch).
 */
export async function preferredBranchStartPoint(
  projectPath: string,
  name: string,
  known?: { localSha?: string | null; remoteSha?: string | null },
): Promise<string | null> {
  const localRef = `refs/heads/${name}`;
  const [localSha, remoteSha] = await Promise.all([
    known?.localSha !== undefined ? known.localSha : peelToCommit(projectPath, localRef),
    known?.remoteSha !== undefined ? known.remoteSha : peelToCommit(projectPath, `refs/remotes/origin/${name}`),
  ]);
  const form = await chooseBranchForm(localSha, remoteSha, (ancestor, descendant) => isAncestor(projectPath, ancestor, descendant));
  if (form === 'local') return localRef;
  if (form === 'remote') return `origin/${name}`;
  return null;
}

/**
 * Bring a tag that exists only on origin into this repo, as `refs/tags/<name>`.
 * A bare `git fetch origin <tag>` writes FETCH_HEAD only, so the refspec names
 * the destination. A name that cannot be a tag is not fetched. Returns whether
 * the tag resolves afterwards. Never throws.
 */
export async function fetchTagFromOrigin(projectPath: string, name: string, options?: { signal?: AbortSignal }): Promise<boolean> {
  if (!isPlausibleRefName(name)) return false;
  const tagRef = `${TAG_REF_PREFIX}${name}`;
  try {
    // --no-auto-gc for the reason fetchIfStale gives: a due gc on Windows runs
    // inside the fetch.
    await runGitWithTimeout(projectPath, ['fetch', '--no-auto-gc', '--no-tags', 'origin', `${tagRef}:${tagRef}`], {
      timeoutMs: TAG_FETCH_TIMEOUT_MS,
      signal: options?.signal,
    });
  } catch {
    return false;
  }
  return (await peelToCommit(projectPath, tagRef)) !== null;
}

/** The commit a branch base cuts from, by the same rule as every cut. */
async function branchDisplaySha(projectPath: string, localSha: string | null, remoteSha: string | null): Promise<string | null> {
  const form = await chooseBranchForm(localSha, remoteSha, (ancestor, descendant) => isAncestor(projectPath, ancestor, descendant));
  return form === 'local' ? localSha : form === 'remote' ? remoteSha : null;
}

/**
 * Resolve a ref the user typed into the base picker. Reads local refs only,
 * unless `fetchTag` is set: then a value that resolves to nothing here is
 * first tried as a tag on origin, the one fetch worktree creation would also
 * make (`resolveWorktreeBase`). Only the picker's typed Use row sets it; the
 * passive readers (a header, a badge) never reach the network.
 *
 * On a miss, `error` is git's own stderr from `rev-parse --verify
 * <ref>^{commit}` (no `--quiet`), so an ambiguous short SHA and a missing ref
 * each read in git's words. The other misses carry a `reason` the renderer
 * words, and `error` holds the same in English for logs.
 */
export async function resolveRefForDisplay(projectPath: string, ref: string, options?: { fetchTag?: boolean }): Promise<GitResolveRefResult> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, reason: 'empty', error: 'Type a branch, tag or commit.' };
  if (isOptionShapedRef(trimmed)) {
    return { ok: false, reason: 'option-shaped', error: `'${trimmed}' starts with a dash, so git would read it as an option.` };
  }

  let classified = await classifyBaseRef(projectPath, trimmed);
  if (classified.kind === 'unresolved' && options?.fetchTag && await fetchTagFromOrigin(projectPath, trimmed)) {
    classified = await classifyBaseRef(projectPath, trimmed);
  }
  if (classified.kind === 'branch') {
    const sha = await branchDisplaySha(projectPath, classified.localSha, classified.remoteSha);
    if (sha) return { ok: true, kind: 'branch', sha };
  }
  if (isFixedBase(classified)) return { ok: true, kind: classified.kind, sha: classified.sha };

  try {
    await execFileAsync('git', ['rev-parse', '--verify', `${trimmed}^{commit}`], { cwd: projectPath, windowsHide: true });
    // Git resolves it, but it is not a branch, tag or SHA (`HEAD`, `main~1`,
    // `origin/main`): a base that moves under a name that is not a branch.
    return { ok: false, reason: 'not-a-base', error: `'${trimmed}' is not a branch, tag or commit SHA.` };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === 'string' && stderr.trim()
      ? stderr.trim()
      : error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'git', error: text };
  }
}
