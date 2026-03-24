import { useState, useEffect, useMemo } from 'react';
import { useConfigStore } from '../../../stores/config-store';
import { isValidGitBranchName } from '../../../../shared/git-utils';
import { slugify } from '../../../../shared/slugify';
import type { Task } from '../../../../shared/types';

export function useBranchConfig(task: Task, title: string, isInTodo: boolean) {
  const worktreesEnabled = useConfigStore((s) => s.config.git.worktreesEnabled);
  const defaultBaseBranch = useConfigStore((s) => s.config.git.defaultBaseBranch);

  const [baseBranch, setBaseBranch] = useState(task.base_branch || '');
  const [customBranchName, setCustomBranchName] = useState(task.branch_name || '');
  const [useWorktree, setUseWorktree] = useState<boolean | null>(
    task.use_worktree != null ? Boolean(task.use_worktree) : null,
  );
  const [knownBranches, setKnownBranches] = useState<Set<string>>(new Set());

  const effectiveWorktree = useWorktree ?? worktreesEnabled;
  const effectiveBaseBranch = baseBranch.trim() || defaultBaseBranch || 'main';

  useEffect(() => {
    if (isInTodo) {
      window.electronAPI.git.listBranches()
        .then(branches => setKnownBranches(new Set(branches)))
        .catch(() => setKnownBranches(new Set()));
    }
  }, [isInTodo]);

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
    if (effectiveWorktree) {
      const slug = slugify(title.trim()) || 'task-title';
      return `${slug}-ab12cd34`;
    }
    return effectiveBaseBranch;
  }, [effectiveWorktree, title, effectiveBaseBranch]);

  const branchHint = useMemo(() => {
    const pill = (text: string) => (
      <span className="font-mono text-fg-faint">{text}</span>
    );
    const branch = customBranchName.trim();
    if (branch) {
      if (branchExists) {
        if (effectiveWorktree) {
          return <>{pill(branch)} exists and will be checked out in a new worktree</>;
        }
        return <>{pill(branch)} exists and will be checked out</>;
      }
      if (effectiveWorktree) {
        return <>{pill(branch)} will be created from {pill(effectiveBaseBranch)} in a new worktree</>;
      }
      return <>{pill(branch)} will be created from {pill(effectiveBaseBranch)}</>;
    }
    if (effectiveWorktree) {
      return <>Auto-generated branch will be created from {pill(effectiveBaseBranch)} in a new worktree</>;
    }
    return <>Agent will work directly on {pill(effectiveBaseBranch)}</>;
  }, [customBranchName, branchExists, effectiveWorktree, effectiveBaseBranch]);

  const resetToTask = () => {
    setBaseBranch(task.base_branch || '');
    setCustomBranchName(task.branch_name || '');
    setUseWorktree(task.use_worktree != null ? Boolean(task.use_worktree) : null);
  };

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
    resetToTask,
  };
}

export type BranchConfigState = ReturnType<typeof useBranchConfig>;
