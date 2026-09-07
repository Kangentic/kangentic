import { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchGitBranches } from '../utils/git-branches';
import { fetchProjectProbe } from '../utils/project-probe';
import type { ReactNode } from 'react';
import { computeBranchHint, resolveWorktreeBlocker, type WorktreeBlocker } from '../utils/worktree-placement';
import { isValidGitBranchName } from '../../shared/git-utils';
import { slugify, computeAutoBranchName } from '../../shared/slugify';
import type { ProjectPathProbe } from '../../shared/types';

export interface BranchSettingsInitial {
  baseBranch: string;
  customBranchName: string;
  /** Tri-state: null inherits the project's `worktreesEnabled`. */
  useWorktree: boolean | null;
}

export interface UseBranchSettingsOptions {
  /** Drives the auto-branch placeholder. */
  title: string;
  initial: BranchSettingsInitial;
  worktreesEnabled: boolean;
  defaultBaseBranch: string;
  /**
   * Whether the settings are still editable. While true the hook fetches the
   * branch list (for the exists check) and probes the project folder (for the
   * structural blockers); past To Do neither is needed.
   */
  active: boolean;
  /** The HOSTING project's path, never assumed to be the open board's. */
  projectPath: string | null;
  /** The resolved agent runs against a remote server directory. */
  remoteAgent: boolean;
}

/**
 * The Branch row's state and every derived value under it, shared by the New
 * Task dialog and the task-detail edit form so the two cannot drift (they
 * used to hold byte-identical copies of the hint, the placeholder, the
 * exists check, and the name validation). Store-free on purpose: the
 * task-detail host may be showing a task from a project that is not the open
 * board, so every project-scoped input arrives as an argument.
 */
export function useBranchSettings(options: UseBranchSettingsOptions) {
  const { title, initial, worktreesEnabled, defaultBaseBranch, active, projectPath, remoteAgent } = options;

  const [baseBranch, setBaseBranch] = useState(initial.baseBranch);
  const [customBranchName, setCustomBranchName] = useState(initial.customBranchName);
  const [useWorktree, setUseWorktree] = useState<boolean | null>(initial.useWorktree);
  const [knownBranches, setKnownBranches] = useState<Set<string>>(new Set());
  const [probe, setProbe] = useState<ProjectPathProbe | null>(null);

  const effectiveWorktree = useWorktree ?? worktreesEnabled;
  const effectiveBaseBranch = baseBranch.trim() || defaultBaseBranch || 'main';

  useEffect(() => {
    if (!active) return;
    fetchGitBranches()
      .then((branches) => setKnownBranches(new Set(branches)))
      .catch(() => setKnownBranches(new Set()));
  }, [active]);

  useEffect(() => {
    if (!active || !projectPath) return;
    let cancelled = false;
    fetchProjectProbe(projectPath)
      .then((result) => { if (!cancelled) setProbe(result); })
      .catch(() => { if (!cancelled) setProbe(null); });
    return () => { cancelled = true; };
  }, [active, projectPath]);

  const blocker = useMemo<WorktreeBlocker | null>(
    () => resolveWorktreeBlocker({ probe, remoteAgent }),
    [probe, remoteAgent],
  );

  const branchExists = useMemo(
    () => customBranchName.trim() ? knownBranches.has(customBranchName.trim()) : false,
    [customBranchName, knownBranches],
  );

  const branchNameError = useMemo(
    () => customBranchName.trim() && !isValidGitBranchName(customBranchName.trim())
      ? 'Invalid git branch name'
      : '',
    [customBranchName],
  );

  const branchPlaceholder = useMemo(() => {
    if (effectiveWorktree && !blocker) {
      const slug = slugify(title.trim()) || 'task-title';
      return computeAutoBranchName(effectiveBaseBranch, defaultBaseBranch || 'main', slug, 'ab12cd34');
    }
    return effectiveBaseBranch;
  }, [effectiveWorktree, blocker, title, effectiveBaseBranch, defaultBaseBranch]);

  const branchHint = useMemo<ReactNode>(() => computeBranchHint({
    customBranchName,
    branchExists,
    effectiveWorktree,
    effectiveBaseBranch,
    baseBranchPinned: baseBranch.trim() !== '',
    currentBranch: probe?.currentBranch ?? null,
    blocker,
  }), [customBranchName, branchExists, effectiveWorktree, effectiveBaseBranch, baseBranch, probe, blocker]);

  const reset = useCallback((next: BranchSettingsInitial) => {
    setBaseBranch(next.baseBranch);
    setCustomBranchName(next.customBranchName);
    setUseWorktree(next.useWorktree);
  }, []);

  return {
    baseBranch,
    setBaseBranch,
    customBranchName,
    setCustomBranchName,
    useWorktree,
    setUseWorktree,
    effectiveWorktree,
    effectiveBaseBranch,
    defaultBaseBranch,
    branchPlaceholder,
    branchHint,
    branchExists,
    branchNameError,
    blocker,
    reset,
  };
}

export type BranchSettingsState = ReturnType<typeof useBranchSettings>;
