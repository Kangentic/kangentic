/**
 * The task-detail surface, hosted inside a managed window (the replacement for
 * the old centered `TaskDetailDialog` modal). It owns the same logic the modal
 * did - the session-state, attachment, branch, action, and copy-id hooks; the
 * edit form; the four confirm dialogs - but renders into the window frame
 * instead of a `BaseDialog`:
 *
 *  - The header (view) or an edit-mode bar IS the window title bar: a drag
 *    handle (pointer-down forwarded from `WindowFrame`) plus maximize / close
 *    wired to the window store. Double-clicking it toggles maximize.
 *  - Close routes through the unsaved-changes guard, then the frame's animated
 *    `requestClose`. Escape (pointer outside the PTY) and `panel.close` do the
 *    same; keybindings are gated on `isFocused` so only the focused window reacts.
 *  - The confirms and image preview render as fixed overlays (above the window),
 *    never as an early return, so the window never collapses to just a confirm.
 *
 * Maximize state is the window's own state (not the session store's
 * `maximizedTasks`); the frame sizes itself from geometry, so all of the modal's
 * sizing math is gone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Pencil, Trash2, X } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { resolveShortcutCommand } from '../../../shared/template-vars';
import { useKeybinding } from '../../hooks/useKeybinding';
import { PriorityBadge } from '../../components/backlog/PriorityBadge';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import {
  TaskDetailHeader,
  TaskDetailEditForm,
  TaskDetailBody,
  ImagePreviewOverlay,
  useAttachments,
  useBranchConfig,
  useCopyDisplayId,
  useTaskSessionState,
  useTaskActions,
  taskHasDescriptionContent,
} from '../../components/dialogs/task-detail';
import { useLayerStore } from '../context';
import { registerWindowCloser, unregisterWindowCloser } from '../store/window-close-registry';
import { classifySnapZone, nextSnap } from '../dnd/snap-zones';
import type { SnapDirection } from '../dnd/snap-zones';
import type { Task, ShortcutConfig } from '../../../shared/types';

interface TaskDetailWindowProps {
  task: Task;
  windowId: string;
  /** This window is the focused one (keybindings/Escape only fire here). */
  isFocused: boolean;
  /** Window is maximized (drives the header maximize icon). */
  isMaximized: boolean;
  /** Open directly in edit mode (context-menu Edit, To Do task with no session). */
  initialEdit?: boolean;
  /** Pointer-down on the title bar starts the window drag (owned by WindowFrame). */
  titleBarPointerDown: (event: React.PointerEvent) => void;
  /** Animated, guard-aware window close (overlay-phase exit -> closeWindow). */
  requestClose: () => void;
}

// Controls whose own click/double-click must win over a window drag or maximize
// toggle. Mirrors MaximizeOnDoubleClick's selector so buttons, pills (rendered as
// <button>), inputs, and the kebab never start a drag.
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

function isInteractiveTarget(event: React.PointerEvent | React.MouseEvent): boolean {
  const interactive = (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR);
  return !!interactive && (event.currentTarget as HTMLElement).contains(interactive);
}

export function TaskDetailWindow({
  task,
  windowId,
  isFocused,
  isMaximized,
  initialEdit,
  titleBarPointerDown,
  requestClose,
}: TaskDetailWindowProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const moveTask = useBoardStore((s) => s.moveTask);
  const unarchiveTask = useBoardStore((s) => s.unarchiveTask);
  const archiveTask = useBoardStore((s) => s.archiveTask);
  const updateAttachmentCount = useBoardStore((s) => s.updateAttachmentCount);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const killSession = useSessionStore((s) => s.killSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[task.id] ?? null);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const browserEnabledConfig = useConfigStore((s) => s.config.browser?.enabled);

  const useStore = useLayerStore();
  const toggleMaximizeWindow = useStore((s) => s.toggleMaximizeWindow);
  const dockWindow = useStore((s) => s.dockWindow);
  const applyTilePreset = useStore((s) => s.applyTilePreset);
  const windowCount = useStore((s) => Object.keys(s.windows).length);
  const maximizeWindow = useStore((s) => s.maximizeWindow);
  const restoreWindow = useStore((s) => s.restoreWindow);
  const setGeometry = useStore((s) => s.setGeometry);
  const snapWindow = useStore((s) => s.snapWindow);
  const untileWindow = useStore((s) => s.untileWindow);
  const isTiled = useStore((s) => s.windows[windowId]?.state === 'tiled');

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prUrl, setPrUrl] = useState(task.pr_url ?? '');
  const [labels, setLabels] = useState<string[]>(task.labels ?? []);
  const [priority, setPriority] = useState(task.priority ?? 0);
  const [agentOverride, setAgentOverride] = useState(task.agent_override ?? '');
  const [modelOverride, setModelOverride] = useState(task.model_override ?? '');
  const [effortOverride, setEffortOverride] = useState(task.effort_override ?? '');
  const [isEditing, setIsEditing] = useState(!!initialEdit);
  const [descriptionPeekOpen, setDescriptionPeekOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(task.id));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);
  const browserOpen = useSessionStore((s) => s.browserOpenTasks.has(task.id));
  const toggleBrowserOpen = useSessionStore((s) => s.toggleBrowserOpen);

  const isArchived = task.archived_at !== null;
  const currentSwimlane = swimlanes.find((s) => s.id === task.swimlane_id);
  const isInTodo = currentSwimlane?.role === 'todo';

  const attachments = useAttachments(task.id, updateAttachmentCount);
  const branchConfig = useBranchConfig(task, title, isInTodo);

  const sessionState = useTaskSessionState({
    task,
    isEditing,
    isArchived,
    isInTodo: isInTodo ?? false,
    currentSwimlaneRole: currentSwimlane?.role,
  });

  const actions = useTaskActions({
    task,
    onClose: requestClose,
    initialEdit,
    title,
    description,
    prUrl,
    labels,
    priority,
    agentOverride,
    modelOverride,
    effortOverride,
    setTitle,
    setDescription,
    setPrUrl,
    setLabels,
    setPriority,
    setAgentOverride,
    setModelOverride,
    setEffortOverride,
    setIsEditing,
    branchConfig,
    session: sessionState.session,
    isSessionActive: sessionState.isSessionActive,
    hasSessionContext: sessionState.hasSessionContext,
    isSuspended: sessionState.isSuspended,
    canToggle: sessionState.canToggle,
    displayState: sessionState.displayState,
    isArchived,
    isInTodo: isInTodo ?? false,
    swimlanes,
    updateTask,
    deleteTask,
    moveTask,
    unarchiveTask,
    archiveTask,
    loadBoard,
    killSession,
    suspendSession,
    resumeSession,
    skipDeleteConfirm,
    updateConfig,
  });

  const hasSessionContext = sessionState.hasSessionContext || actions.toggling;

  const hasDescriptionContent = taskHasDescriptionContent(task, attachments.savedAttachments.length);
  // Gate the peek affordance (kebab item + hotkey) on exactly the states whose
  // body branch renders the description panel, so the toggle is never dead AND
  // the panel can never get stuck open after the affordance disappears:
  //   - Exclude 'none' (no session context; the body shows the in-body
  //     descriptionBar, which is not driven by descriptionPeekOpen). Read
  //     displayState.kind directly rather than the toggling-boosted
  //     `hasSessionContext` above, since an in-flight pause / resume can leave
  //     `toggling` true while kind is 'none' (no session), a state whose body
  //     branch also ignores the flag.
  //   - Exclude 'queued' and 'suspended' (their body branches render a
  //     placeholder / resume prompt and also ignore the flag).
  //   - INCLUDE 'exited': the active-terminal body branch still renders once the
  //     agent finishes (the session record and its id persist), so the peek stays
  //     meaningful beside the finished terminal. This mirrors canShowBrowser,
  //     which likewise stays available on exit; excluding 'exited' here would
  //     strand an open peek with no in-dialog control to close it.
  // Unlike canShowBrowser we do NOT require a live session?.id, because the
  // pre-session 'preparing' branch renders the peek too (the description is
  // meaningful before the PTY exists), and preparing has no session yet.
  const canShowDescription = !isArchived
    && hasDescriptionContent
    && sessionState.displayState.kind !== 'none'
    && sessionState.displayState.kind !== 'queued'
    && sessionState.displayState.kind !== 'suspended';

  // Unsaved-changes detection for edit mode: any editable field differing from
  // the persisted task counts as dirty (mirrors handleCancel's reverts).
  const isEditDirty = useMemo(() => (
    title !== task.title
    || description !== task.description
    || prUrl !== (task.pr_url ?? '')
    || priority !== (task.priority ?? 0)
    || agentOverride !== (task.agent_override ?? '')
    || modelOverride !== (task.model_override ?? '')
    || effortOverride !== (task.effort_override ?? '')
    || JSON.stringify(labels) !== JSON.stringify(task.labels ?? [])
    || branchConfig.baseBranch !== (task.base_branch || '')
    || branchConfig.customBranchName !== (task.branch_name || '')
    || branchConfig.useWorktree !== (task.use_worktree != null ? Boolean(task.use_worktree) : null)
  ), [title, description, prUrl, priority, agentOverride, modelOverride, effortOverride, labels, branchConfig.baseBranch, branchConfig.customBranchName, branchConfig.useWorktree, task]);

  // Guard close gestures (header X, Escape, panel.close) while editing with
  // unsaved changes: ask before discarding. Returns true to let the caller
  // proceed with the close, false when a confirm was shown instead.
  const handleCloseAttempt = useCallback(() => {
    if (confirmDiscard) return false;
    if (isEditing && isEditDirty) { setConfirmDiscard(true); return false; }
    return true;
  }, [confirmDiscard, isEditing, isEditDirty]);

  // The single guarded close used by every close affordance. Proceeds through
  // the frame's animated exit unless the discard guard intercepts.
  const closeWithGuard = useCallback(() => {
    if (handleCloseAttempt()) requestClose();
  }, [handleCloseAttempt, requestClose]);

  const handleToggleMaximized = useCallback(() => toggleMaximizeWindow(windowId), [toggleMaximizeWindow, windowId]);
  const handleUndock = useCallback(() => untileWindow(windowId), [untileWindow, windowId]);
  // Pop the window back to floating from whatever docked state it is in
  // (maximized / snapped / tiled) - the "down" restore step.
  const popToFloat = useCallback(() => {
    const target = useStore.getState().windows[windowId];
    if (!target) return;
    if (target.state === 'maximized') restoreWindow(windowId);
    else if (target.state === 'snapped') setGeometry(windowId, target.restoreGeometry ?? target.geometry);
    else if (target.state === 'tiled') untileWindow(windowId);
  }, [windowId, restoreWindow, setGeometry, untileWindow, useStore]);

  // Win11-style stateful snap: the result depends on the window's current zone,
  // read from its RENDERED rect (a tiled pane's stored geometry is its pre-tile
  // float, not where it renders). Halves dock (pair); corners are lone snaps; a
  // tiled pane cannot slide within its pair horizontally. See snap-zones.ts.
  const handleSnapDirection = useCallback((direction: SnapDirection) => {
    const target = useStore.getState().windows[windowId];
    if (!target) return;
    const frameElement = document.querySelector(`[data-testid="window-frame-${windowId}"]`);
    const overlayElement = document.querySelector('[data-testid="window-overlay"]');
    if (!(frameElement instanceof HTMLElement) || !(overlayElement instanceof HTMLElement)) return;
    const frameRect = frameElement.getBoundingClientRect();
    const overlayRect = overlayElement.getBoundingClientRect();
    if (overlayRect.width === 0 || overlayRect.height === 0) return;
    const zone = classifySnapZone({
      x: (frameRect.left - overlayRect.left) / overlayRect.width,
      y: (frameRect.top - overlayRect.top) / overlayRect.height,
      w: frameRect.width / overlayRect.width,
      h: frameRect.height / overlayRect.height,
    });
    // A tiled (paired) pane cannot slide within its pair horizontally.
    if (target.state === 'tiled' && (direction === 'left' || direction === 'right')) return;
    const action = nextSnap(zone, direction);
    if (action.kind === 'maximize') maximizeWindow(windowId);
    else if (action.kind === 'restore') popToFloat();
    else if (action.kind === 'dock') {
      if (target.state === 'tiled') untileWindow(windowId);
      dockWindow(windowId, action.edge);
    } else if (action.kind === 'snap') {
      if (target.state === 'tiled') untileWindow(windowId);
      snapWindow(windowId, action.geometry);
    }
  }, [windowId, maximizeWindow, dockWindow, snapWindow, untileWindow, popToFloat, useStore]);

  // The three right-panel views (Browser / Changes / Description peek) are
  // mutually exclusive and share the terminal split: opening one closes the
  // other two. The close is computed before the open (never inside a setState
  // updater, which React can double-invoke in StrictMode).
  const handleToggleDescription = useCallback(() => {
    const opening = !descriptionPeekOpen;
    if (opening) {
      if (browserOpen) toggleBrowserOpen(task.id);
      if (changesOpen) toggleChangesOpen(task.id);
    }
    setDescriptionPeekOpen(opening);
  }, [descriptionPeekOpen, browserOpen, changesOpen, toggleBrowserOpen, toggleChangesOpen, task.id]);

  const handleToggleBrowser = useCallback(() => {
    if (!browserOpen) {
      if (changesOpen) toggleChangesOpen(task.id);
      if (descriptionPeekOpen) setDescriptionPeekOpen(false);
    }
    toggleBrowserOpen(task.id);
  }, [browserOpen, changesOpen, descriptionPeekOpen, toggleBrowserOpen, toggleChangesOpen, task.id]);

  const handleToggleChanges = useCallback(() => {
    if (!changesOpen) {
      if (browserOpen) toggleBrowserOpen(task.id);
      if (descriptionPeekOpen) setDescriptionPeekOpen(false);
    }
    toggleChangesOpen(task.id);
  }, [browserOpen, changesOpen, descriptionPeekOpen, toggleBrowserOpen, toggleChangesOpen, task.id]);

  const browserEnabled = browserEnabledConfig !== false;
  const canShowBrowser = browserEnabled
    && !!sessionState.session?.id
    && sessionState.displayState.kind !== 'queued'
    && sessionState.displayState.kind !== 'suspended';

  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);

  const moveTargets = useMemo(() =>
    swimlanes.filter((candidate) => {
      if (candidate.id === task.swimlane_id) return false;
      if (isArchived && candidate.role === 'done') return false;
      return true;
    }),
    [swimlanes, task.swimlane_id, isArchived],
  );

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  const executeShortcut = useCallback((action: ShortcutConfig) => {
    const cwd = task.worktree_path ?? projectPath ?? '';
    const resolved = resolveShortcutCommand(action.command, {
      cwd,
      branchName: task.branch_name ?? '',
      taskTitle: task.title,
      projectPath: projectPath ?? '',
    });
    window.electronAPI.shell.exec(resolved, cwd);
  }, [task, projectPath]);

  // This window's title bar, used to scope the middle-click close binding to a
  // pointer event that lands on this window (not another open window's header).
  const titleBarRef = useRef<HTMLDivElement>(null);

  // Auto-save and exit edit mode when a session appears.
  const hadSessionContext = useRef(hasSessionContext);
  const editingRef = useRef(isEditing);
  const titleRef = useRef(title);
  const descriptionRef = useRef(description);
  const labelsRef = useRef(labels);
  const priorityRef = useRef(priority);
  editingRef.current = isEditing;
  titleRef.current = title;
  descriptionRef.current = description;
  labelsRef.current = labels;
  priorityRef.current = priority;
  useEffect(() => {
    if (!hadSessionContext.current && hasSessionContext && editingRef.current) {
      updateTask({
        id: task.id,
        title: titleRef.current,
        description: descriptionRef.current,
        labels: labelsRef.current,
        priority: priorityRef.current,
      });
      setIsEditing(false);
    }
    hadSessionContext.current = hasSessionContext;
  }, [hasSessionContext, task.id, updateTask]);

  // Task-detail hotkeys (capture phase so they intercept before the embedded
  // xterm consumes the Ctrl-letter control chars). Gated on `isFocused` so only
  // the focused window reacts when several are open.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true, enabled: isFocused });
  useKeybinding('panel.close', closeWithGuard, { capture: true, enabled: isFocused });
  // Close on a header click with the bound mouse button (default middle). Routed
  // through `closeWithGuard` so an unsaved edit still prompts to discard. The
  // `when` scopes the mouse path to THIS window's title bar; a keyboard rebind
  // (no `button`) fires for the focused window regardless of pointer position.
  useKeybinding('panel.closeViaHeaderClick', closeWithGuard, {
    capture: true,
    enabled: isFocused,
    when: (event) =>
      !('button' in event) || (titleBarRef.current?.contains(event.target as Node) ?? false),
  });
  // The panel-toggle hotkeys stay inert while editing: edit mode swaps in the
  // edit form (not TaskDetailBody) and a kebab-less title bar, so firing one
  // would silently flip hidden state and, being capture-phase, swallow the
  // keystroke with no visible effect until edit is left.
  useKeybinding('taskDetail.toggleBrowser', handleToggleBrowser, { capture: true, enabled: isFocused && canShowBrowser && !isEditing });
  useKeybinding('taskDetail.toggleChanges', handleToggleChanges, { capture: true, enabled: isFocused && sessionState.canShowChanges && !isEditing });
  useKeybinding('taskDetail.toggleDescription', handleToggleDescription, { capture: true, enabled: isFocused && canShowDescription && !isEditing });
  useKeybinding('window.snapLeft', () => handleSnapDirection('left'), { capture: true, enabled: isFocused });
  useKeybinding('window.snapRight', () => handleSnapDirection('right'), { capture: true, enabled: isFocused });
  useKeybinding('window.snapUp', () => handleSnapDirection('up'), { capture: true, enabled: isFocused });
  useKeybinding('window.snapDown', () => handleSnapDirection('down'), { capture: true, enabled: isFocused });

  // Escape closes the focused window through the discard guard. Structural
  // dialog Escape (keybindings-registry exception, like BaseDialog): a
  // bubble-phase listener so the embedded terminal, when the pointer is over the
  // PTY, consumes Escape itself (reaching the agent's TUI) and this never sees
  // it; with the pointer elsewhere Escape bubbles here and closes.
  useEffect(() => {
    if (!isFocused) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeWithGuard();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFocused, closeWithGuard]);

  // Expose this window's guarded close to the central click-outside dismiss hook
  // (`useClickOutsideToClose`), so a board-background click routes through the
  // same unsaved-edits guard as Escape and the X. Keyed on `closeWithGuard` so a
  // re-memo re-registers the fresh closure; mirrors the Escape effect lifecycle.
  useEffect(() => {
    registerWindowCloser(windowId, closeWithGuard);
    return () => unregisterWindowCloser(windowId);
  }, [windowId, closeWithGuard]);

  // Restore keyboard focus to this window's terminal after a maximize/restore
  // toggle, so the next keystroke lands in the terminal instead of the maximize
  // button (the button takes DOM focus when clicked; the panel.maximize keybinding
  // and the header double-click also flip `isMaximized`). The task-detail surface
  // does not own the xterm's focus(), so focus the frame's textarea directly - the
  // same idiom WindowFrame and useWindowFocusReconcile use. Skips the initial mount
  // (acts only on an actual toggle) so it never pulls focus from the edit form or a
  // freshly opened window; a no-op when there is no terminal (edit mode / To Do).
  const wasMaximizedRef = useRef(isMaximized);
  useEffect(() => {
    if (wasMaximizedRef.current === isMaximized) return;
    wasMaximizedRef.current = isMaximized;
    const frame = document.querySelector(`[data-testid="window-frame-${windowId}"]`);
    const textarea = frame?.querySelector('.xterm-helper-textarea');
    if (textarea instanceof HTMLElement) textarea.focus();
  }, [isMaximized, windowId]);

  const onTitleBarPointerDown = useCallback((event: React.PointerEvent) => {
    // Only the primary button starts a window drag. Non-primary buttons (e.g. the
    // middle-click close, bound via `panel.closeViaHeaderClick`) are handled by
    // their keybinding's capture-phase listener, not here.
    if (event.button !== 0 || isInteractiveTarget(event)) return;
    titleBarPointerDown(event);
  }, [titleBarPointerDown]);

  const onTitleBarDoubleClick = useCallback((event: React.MouseEvent) => {
    if (isInteractiveTarget(event)) return;
    handleToggleMaximized();
  }, [handleToggleMaximized]);

  // Title bar (view header, or the edit-mode bar)

  const viewTitleBar = (
    <TaskDetailHeader
      task={task}
      onClose={closeWithGuard}
      isEditing={isEditing}
      setIsEditing={setIsEditing}
      canToggle={sessionState.canToggle}
      isSessionActive={sessionState.isSessionActive}
      isQueued={sessionState.isQueued}
      isThinking={sessionState.isThinking}
      isIdle={sessionState.isIdle}
      isArchived={isArchived}
      isIsolated={currentSwimlane?.session_target === 'isolated'}
      toggling={actions.toggling}
      onToggle={actions.handleToggle}
      onCommandSelect={actions.handleCommandSelect}
      onArchive={actions.handleArchive}
      onSendToBacklog={actions.handleSendToBacklog}
      onDelete={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
      onMoveTo={actions.handleMoveTo}
      moveTargets={moveTargets}
      headerShortcuts={headerShortcuts}
      menuShortcuts={menuShortcuts}
      executeShortcut={executeShortcut}
      projectPath={projectPath}
      canShowChanges={sessionState.canShowChanges}
      changesOpen={changesOpen}
      onToggleChanges={handleToggleChanges}
      canShowBrowser={canShowBrowser}
      browserOpen={browserOpen}
      onToggleBrowser={handleToggleBrowser}
      canShowDescription={canShowDescription}
      descriptionPeekOpen={descriptionPeekOpen}
      onToggleDescription={handleToggleDescription}
      isMaximized={isMaximized}
      onToggleMaximized={handleToggleMaximized}
      onUndock={isTiled ? handleUndock : undefined}
      onApplyTilePreset={applyTilePreset}
      canTileMultiple={windowCount >= 2}
    />
  );

  const editTitleBar = (
    <div className="flex items-center gap-3 px-4 py-3 min-w-0">
      <Pencil size={14} className="text-fg-muted flex-shrink-0" />
      <h3 className="text-sm font-semibold text-fg flex items-center gap-2 min-w-0">
        <span className="flex-shrink-0">Edit Task</span>
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-mono text-fg-muted hover:text-fg-secondary transition-colors font-normal"
          title={`Click to copy: ${task.display_id}`}
          data-testid="task-display-id"
          onClick={copyDisplayId}
        >
          {displayIdCopied
            ? <Check size={12} className="text-green-400" />
            : <Copy size={12} className="text-fg-disabled" />
          }
          #{task.display_id}
        </button>
        <PriorityBadge priority={task.priority ?? 0} />
      </h3>
      <div className="flex-1" />
      <MaximizeToggleButton
        isMaximized={isMaximized}
        onToggle={handleToggleMaximized}
        testId="task-detail-maximize"
      />
      <button
        type="button"
        onClick={closeWithGuard}
        data-testid="task-detail-close"
        aria-label="Close window"
        title="Close"
        className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
      >
        <X size={16} />
      </button>
    </div>
  );

  return (
    <>
      <div className="flex h-full w-full flex-col overflow-hidden" data-testid="task-detail-dialog">
        <div
          ref={titleBarRef}
          className="border-b border-edge flex-shrink-0 select-none"
          data-testid="task-detail-titlebar"
          onPointerDown={onTitleBarPointerDown}
          onDoubleClick={onTitleBarDoubleClick}
        >
          {isEditing ? editTitleBar : viewTitleBar}
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {isEditing ? (
            <>
              <div className="px-4 py-4 flex-1 flex flex-col min-h-0 overflow-y-auto">
                <TaskDetailEditForm
                  task={task}
                  title={title}
                  setTitle={setTitle}
                  description={description}
                  setDescription={setDescription}
                  prUrl={prUrl}
                  setPrUrl={setPrUrl}
                  labels={labels}
                  setLabels={setLabels}
                  priority={priority}
                  setPriority={setPriority}
                  agentOverride={agentOverride}
                  setAgentOverride={setAgentOverride}
                  modelOverride={modelOverride}
                  setModelOverride={setModelOverride}
                  effortOverride={effortOverride}
                  setEffortOverride={setEffortOverride}
                  attachments={attachments}
                  branchConfig={branchConfig}
                  isSessionActive={sessionState.isSessionActive}
                  isArchived={isArchived}
                  isInTodo={isInTodo}
                />
              </div>
              <div className="px-4 py-3 border-t border-edge flex-shrink-0">
                <div className={`flex ${isInTodo ? 'justify-between' : 'justify-end'} items-center`}>
                  {isInTodo && (
                    <button
                      onClick={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-faint hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={actions.handleCancel}
                      className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={actions.handleSave}
                      disabled={!!branchConfig.branchNameError || actions.saving}
                      className={`px-3 py-1.5 text-xs rounded transition-colors ${
                        branchConfig.branchNameError || actions.saving
                          ? 'bg-accent-emphasis/50 text-accent-on/50 cursor-not-allowed'
                          : 'bg-accent-emphasis hover:bg-accent text-accent-on'
                      }`}
                    >
                      {actions.saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <TaskDetailBody
              task={task}
              isFocused={isFocused}
              isArchived={isArchived}
              isInTodo={isInTodo}
              hasSessionContext={hasSessionContext}
              sessionId={sessionState.session?.id ?? null}
              displayKind={sessionState.displayState.kind}
              isSuspended={sessionState.isSuspended}
              toggling={actions.toggling}
              pendingAction={actions.pendingAction}
              pendingCommandLabel={pendingCommandLabel}
              savedAttachments={attachments.savedAttachments}
              handlePreview={attachments.handlePreview}
              handleOpenExternal={attachments.handleOpenExternal}
              removeAttachment={attachments.removeAttachment}
              handleToggle={actions.handleToggle}
              changesOpen={changesOpen}
              projectPath={projectPath ?? ''}
              resumeFailed={actions.resumeFailed}
              resumeError={actions.resumeError}
              onResetSession={actions.handleResetSession}
              browserOpen={browserOpen}
              descriptionPeekOpen={descriptionPeekOpen}
            />
          )}
        </div>
      </div>

      {/* Overlays (fixed, above the window). Rendered as siblings, never as an
          early return, so the window body never collapses to just a confirm. */}
      {actions.confirmSendToBacklog && (
        <ConfirmDialog
          title="Send to Backlog"
          message={<>
            <p>This will move &quot;{task.title}&quot; to the backlog and clean up its session and worktree.</p>
            <p className="text-fg-muted mt-1">You can move it back to the board later.</p>
          </>}
          confirmLabel="Send to Backlog"
          showDontAskAgain
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
            actions.executeSendToBacklog();
          }}
          onCancel={() => actions.setConfirmSendToBacklog(false)}
        />
      )}

      {actions.confirmDelete && (
        <ConfirmDialog
          title="Delete task"
          message={<>
            <p>This will permanently delete the task, its session history, and any associated worktree.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={actions.handleDelete}
          onCancel={() => actions.setConfirmDelete(false)}
        />
      )}

      {/* Discard-unsaved-changes confirm. */}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          variant="warning"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          message="Closing now will discard your unsaved edits to this task."
          onConfirm={() => { setConfirmDiscard(false); requestClose(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}

      {/* Enable worktree confirmation. */}
      {actions.showEnableWorktreeConfirm && (
        <ConfirmDialog
          title="Enable worktree?"
          message="This will create an isolated worktree for this task. Your session history will be preserved and the agent will continue from where it left off in the new worktree."
          confirmLabel="Enable"
          variant="default"
          onConfirm={async () => {
            actions.setShowEnableWorktreeConfirm(false);
            if (actions.pendingSaveRef.current) {
              await actions.pendingSaveRef.current();
              actions.pendingSaveRef.current = null;
            }
          }}
          onCancel={() => {
            actions.setShowEnableWorktreeConfirm(false);
            actions.pendingSaveRef.current = null;
          }}
        />
      )}

      {/* Full-size image preview overlay. */}
      {attachments.previewAttachment && (
        <ImagePreviewOverlay
          url={attachments.previewAttachment.url}
          filename={attachments.previewAttachment.filename}
          onClose={attachments.closePreview}
        />
      )}
    </>
  );
}
