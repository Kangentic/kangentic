import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { useSessionStore } from '../../../stores/session-store';
import { useToastStore } from '../../../stores/toast-store';
import { refreshGitWorkState, useGitWorkState } from '../../../hooks/useGitWorkState';
import { asSentence, ipcFailureToastFields } from '../../../lib/ipc-error';
import { automationAgentReady } from '../../../../shared/answer-agent';
import { isActive } from '../../../../shared/activity-state';
import {
  availableGitActions,
  gitNextStep,
  type GitActionResult,
  type GitActionsAvailable,
  type GitActionStep,
  type GitActionTarget,
  type GitNextStep,
  type GitWorkState,
} from '../../../../shared/git-work-state';
import type { Task } from '../../../../shared/types';
import { CommitDialog } from './CommitDialog';
import { CreatePullRequestDialog } from './CreatePullRequestDialog';

/** Folders with an action of ours running, so every surface of one checkout goes busy together. */
// Kept in `hot.data`, so an edit while an action runs neither frees the buttons early nor leaves them busy.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const busyFolders: Map<string, GitActionStep> = import.meta.hot?.data?.gitBusyFolders ?? new Map<string, GitActionStep>();
// @ts-expect-error -- Vite handles import.meta.hot
const busyListeners: Set<() => void> = import.meta.hot?.data?.gitBusyListeners ?? new Set<() => void>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.gitBusyFolders = busyFolders;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.gitBusyListeners = busyListeners;
}

function setBusy(folder: string, step: GitActionStep | null): void {
  if (step === null) busyFolders.delete(folder);
  else busyFolders.set(folder, step);
  for (const listener of busyListeners) listener();
}

function subscribeBusy(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => { busyListeners.delete(listener); };
}

export interface GitCheckout {
  target: GitActionTarget;
  projectId: string | null;
  projectPath: string;
  worktreePath?: string | null;
  baseBranch: string;
  task: Task | null;
  /** The task's or terminal's own agent session. */
  sessionId: string | null;
}

function folderOf(checkout: GitCheckout): string {
  return checkout.worktreePath ?? checkout.projectPath;
}

/** An open dialog and the checkout it was opened on, with what that checkout was like then. */
interface OpenDialog {
  kind: 'commit' | 'create-pull-request';
  checkout: GitCheckout;
  state: GitWorkState;
}

export interface GitActions {
  state: GitWorkState | null;
  available: GitActionsAvailable;
  nextStep: GitNextStep | null;
  /** The action running in this checkout now. */
  busy: GitActionStep | null;
  /** Why commit, push and create are off, or null when they are on. */
  disabledReason: string | null;
  /** Why commit alone is off (unresolved conflicts), or null. */
  commitDisabledReason: string | null;
  openCommit: () => void;
  push: () => void;
  openCreatePullRequest: () => void;
  /** The open dialog, for the host to render anywhere. */
  dialogs: ReactNode;
}

/** Whether a task already has a pull request. A closed one does not count: its branch can have another. */
function hasPullRequest(task: Task | null): boolean {
  return Boolean(task?.pr_url) && task?.pr_state !== 'closed';
}

/**
 * The git state of one checkout and the actions on it: the Changes button's
 * badge, the panel's line, and the window menu all read this, over one shared
 * read. `enabled` is whether the surface is on screen.
 */
export function useGitActions(checkout: GitCheckout | null, enabled: boolean): GitActions {
  const { t } = useLingui();
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const task = checkout?.task ?? null;
  const sessionId = checkout?.sessionId ?? null;
  const folder = checkout ? folderOf(checkout) : '';

  const onHost = useProjectStore((store) => store.projects.some((project) => project.id === checkout?.projectId && Boolean(project.remote)));
  const state = useGitWorkState(checkout ? {
    worktreePath: checkout.worktreePath,
    projectPath: checkout.projectPath,
    baseBranch: checkout.baseBranch,
    cutFromBranch: task?.resolved_base_branch ?? null,
    pushedBranch: task?.pushed_branch ?? null,
    prMerged: task?.pr_state === 'merged',
    sessionId,
    onHost,
  } : null, enabled);

  const agentList = useConfigStore((store) => store.agentList);
  const automationConfig = useConfigStore((store) => store.globalConfig.automation);
  const defaultBranch = useConfigStore((store) => store.config.git.defaultBaseBranch) || 'main';
  const canDraft = automationAgentReady(agentList, automationConfig, true);

  // Mid-turn: working, or stopped on a prompt of its own. An agent whose turn ended with only a
  // background shell left running is at its prompt. Main checks again, over every agent in the folder.
  const midTurn = useSessionStore((store) => {
    if (sessionId === null) return false;
    const reason = store.sessionActivityReason[sessionId]?.kind;
    if (reason === 'background-shell') return false;
    // activity-state-ok: granular, a prompt on screen is inside the turn though it waits on the user.
    return reason === 'permission' || isActive(store.sessionActivity[sessionId]);
  });
  const busy = useSyncExternalStore(subscribeBusy, () => busyFolders.get(folder) ?? null);

  const failureTitle = (step: GitActionStep): string => {
    switch (step) {
      case 'commit': return t`Couldn't commit`;
      case 'push': return t`Couldn't push`;
      case 'create-pull-request': return t`Couldn't create pull request`;
    }
  };

  /** Run one action on a checkout. True when it is over: done, or handed to an agent. */
  const run = async (step: GitActionStep, on: GitCheckout, action: () => Promise<GitActionResult>): Promise<boolean> => {
    const { addToast } = useToastStore.getState();
    const actionFolder = folderOf(on);
    setBusy(actionFolder, step);
    try {
      const result = await action();
      switch (result.outcome) {
        case 'done': {
          // The badge, the line and the task's PR chip show the rest. A terminal has no chip.
          const pullRequest = result.pullRequest;
          if (pullRequest && !on.task) {
            const number = pullRequest.number;
            addToast({
              title: t`Pull request created`,
              message: t`#${number} is open on its host.`,
              variant: 'success',
              onOpen: () => void window.electronAPI.shell.openExternal(pullRequest.url),
            });
          }
          return true;
        }
        // The message in its terminal is the confirmation (toast-shape.md).
        case 'sent-to-agent': return true;
        case 'held':
          addToast({
            title: t`Held for the next agent`,
            message: t`The next agent on this task gets the failure in its first message.`,
            variant: 'info',
          });
          return true;
        case 'failed':
          addToast({ title: failureTitle(result.step), message: asSentence(result.message), variant: 'error' });
          return false;
      }
    } catch (error) { // report-ok: main reports an unexpected rejection; a refusal is shown to the user
      addToast({ title: failureTitle(step), ...ipcFailureToastFields(error), variant: 'error' });
      return false;
    } finally {
      setBusy(actionFolder, null);
      refreshGitWorkState(actionFolder);
    }
  };

  const disabledReason = !checkout ? null
    : busy !== null ? t`A git action is running`
      : midTurn ? t`Available when the agent finishes its turn` : null;
  const commitDisabledReason = disabledReason ?? (state && state.conflictedFileCount > 0 ? t`Resolve the conflicts first` : null);

  const pullRequestExists = hasPullRequest(task);
  const openDialog = (kind: OpenDialog['kind']): void => {
    if (checkout && state) setOpen({ kind, checkout, state });
  };
  // On what it was opened on, and for as long as it is open: the state goes unknown while a window is
  // parked or a push changes what is read, and a dialog that left with it would take the user's text.
  const dialogState = !open ? null : state !== null && folderOf(open.checkout) === folder ? state : open.state;
  const dialog = !open || !dialogState ? null
    : open.kind === 'commit' ? (
      <CommitDialog
        target={open.checkout.target}
        projectId={open.checkout.projectId}
        state={dialogState}
        canDraft={canDraft}
        onCommit={(message, pushAfter) => run('commit', open.checkout, () => (
          window.electronAPI.git.commit(open.checkout.target, { message, pushAfter }, open.checkout.projectId)
        ))}
        onClose={() => setOpen(null)}
      />
    ) : (
      <CreatePullRequestDialog
        checkout={open.checkout}
        state={dialogState}
        defaultBranch={defaultBranch}
        canDraft={canDraft}
        onCreate={(input) => run('create-pull-request', open.checkout, () => (
          window.electronAPI.git.createPullRequest(open.checkout.target, input, open.checkout.projectId)
        ))}
        onClose={() => setOpen(null)}
      />
    );

  return {
    state,
    available: availableGitActions({ state, hasPullRequest: pullRequestExists }),
    nextStep: gitNextStep({ state, hasPullRequest: pullRequestExists }),
    busy,
    disabledReason,
    commitDisabledReason,
    openCommit: () => openDialog('commit'),
    push: () => {
      // Read live: a second click can land before the button repaints as busy.
      if (!checkout || busyFolders.has(folder)) return;
      void run('push', checkout, () => window.electronAPI.git.push(checkout.target, checkout.projectId));
    },
    openCreatePullRequest: () => openDialog('create-pull-request'),
    // To the body: the Command Terminal's panel is transformed, which would hold a fixed dialog inside it.
    dialogs: dialog ? createPortal(dialog, document.body) : null,
  };
}
