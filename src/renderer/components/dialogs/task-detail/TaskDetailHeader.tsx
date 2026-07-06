import { useState, useRef, useMemo, useEffect, type ReactNode } from 'react';
import { useCopyDisplayId } from './useCopyDisplayId';
import { X, Trash2, Pencil, Loader2, Circle, FolderGit2, FolderGit, GitPullRequest, GitCompare, ArrowRightLeft, ChevronRight, ChevronLeft, CirclePause, CirclePlay, Clock, SquareChevronRight, Zap, Archive, Inbox, Copy, Check, Globe, RefreshCw, PictureInPicture2, MessageSquare, AlignLeft } from 'lucide-react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { useFormattedCombo } from '../../../hooks/useKeybinding';
import { getSwimlaneIcon } from '../../../utils/swimlane-icons';
import { ICON_REGISTRY } from '../../../utils/swimlane-icons';
import { HeaderActionButton } from '../../HeaderActionButton';
import { PrLink } from '../../PrLink';
import { IsolatedBadge } from '../../IsolatedBadge';
import { KebabMenu, KebabMenuItem, KebabMenuDivider } from '../../KebabMenu';
import { CommandSearchList } from './CommandSearchList';
import { useHeaderPillOverflow, type HeaderPillSpec } from './useHeaderPillOverflow';
import { MaximizeToggleButton } from '../dialog-maximize';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import { useToastStore } from '../../../stores/toast-store';
import { useProjectStore } from '../../../stores/project-store';
import { useSessionStore } from '../../../stores/session-store';
import type { Task, AgentCommand, ShortcutConfig, Swimlane } from '../../../../shared/types';
import { type TilePreset } from '../../../window-manager/tiling/presets';
import { WindowLayoutMenu } from '../WindowLayoutMenu';

/**
 * The centered pause: two short, thin upright bars overlaid on the ring.
 * Drawn as solid `bg-*` bars (not the stroked lucide `Pause`, which renders
 * ragged at this size) and sized to match the CirclePause proportions, so the
 * bars stay crisp and the icon reads cleanly at ~20px. `colorClass` is a
 * `bg-*` utility matching the ring (attention for idle, active for working).
 */
function PauseBars({ colorClass }: { colorClass: string }): ReactNode {
  return (
    <span data-testid="pause-bars" className="col-start-1 row-start-1 flex items-center gap-[2px]">
      <span className={`w-[2px] h-[8px] rounded-full ${colorClass}`} />
      <span className={`w-[2px] h-[8px] rounded-full ${colorClass}`} />
    </span>
  );
}

/**
 * The pause/resume button glyph. The pause stays centered and visible for a
 * running session; activity is encoded by the surrounding ring (the button
 * itself never changes its icon on hover). Branches in evaluation order:
 *   - toggling: a muted grey spinner (brief, sub-5s).
 *   - active (thinking): a spinning active ring around the pause.
 *   - idle/permission:   a static attention ring around the pause.
 *   - queued: the clock.
 *   - launching (preparing/initializing): a muted grey spinner (matching the
 *     board card) - the agent has not started yet, so it is NOT active-green; it flips
 *     to the active ring once the session is running.
 *   - suspended: the resume control.
 */
function PauseButtonIcon({
  toggling,
  isQueued,
  isThinking,
  isIdle,
  isSessionActive,
}: {
  toggling: boolean;
  isQueued: boolean;
  isThinking: boolean;
  isIdle: boolean;
  isSessionActive: boolean;
}): ReactNode {
  if (toggling) return <Loader2 size={18} className="animate-spin" />;

  // Active: the SAME Circle as idle (identical radius/size - lucide's Loader2 is
  // radius 9 vs Circle's 10, which rendered ~10% smaller) but active-green, spinning,
  // and dashed so the spin reads as a loading arc. The pause shares the grid cell
  // (place-items-center) so it sits dead-center in the 20px ring.
  if (isThinking) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-active animate-spin [stroke-dasharray:47_16]" />
        <PauseBars colorClass="bg-active" />
      </span>
    );
  }

  // Idle/permission: the same ring + pause as active, but an attention static ring
  // (a full circle, no spin) so the two states share one visual language and
  // differ only by color and motion.
  if (isIdle) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-attention" />
        <PauseBars colorClass="bg-attention" />
      </span>
    );
  }

  if (isQueued) return <Clock size={18} />;
  // Launching (preparing/initializing): a muted grey spinner matching the board
  // card's loading indicator. The agent has not started yet, so it is NOT active-green;
  // once the session is running the engine seeds 'thinking' and this flips to the
  // active ring. Suspended -> the resume control.
  if (isSessionActive) {
    return <Loader2 size={18} className="animate-spin text-fg-muted" />;
  }
  return <CirclePlay size={18} />;
}

interface TaskDetailHeaderProps {
  task: Task;
  onClose: () => void;
  setIsEditing: (editing: boolean) => void;
  canToggle: boolean;
  isSessionActive: boolean;
  isQueued: boolean;
  /** Running and the agent is working on its own - active spinner rest face. */
  isThinking: boolean;
  /** Running and the agent needs the user - attention envelope rest face. */
  isIdle: boolean;
  isArchived: boolean;
  isIsolated: boolean;
  toggling: boolean;
  onToggle: () => void;
  onCommandSelect: (command: AgentCommand) => void;
  onArchive: () => void;
  onSendToBacklog: () => void;
  onDelete: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  moveTargets: Swimlane[];
  headerShortcuts: ShortcutConfig[];
  menuShortcuts: ShortcutConfig[];
  executeShortcut: (action: ShortcutConfig) => void;
  projectPath: string | null;
  canShowChanges: boolean;
  changesOpen: boolean;
  onToggleChanges: () => void;
  canShowBrowser: boolean;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  canShowDescription?: boolean;
  descriptionPeekOpen?: boolean;
  onToggleDescription?: () => void;
  isMaximized: boolean;
  onToggleMaximized: () => void;
  /** When provided (the window is tiled), render a "pop out" control that floats
   *  this pane out of the tiling - the only reliable undock in a full layout. */
  onUndock?: () => void;
  /** Apply a one-shot tiling preset to the open windows (window mode only). When
   *  omitted, the tile-layout control is hidden. */
  onApplyTilePreset?: (preset: TilePreset) => void;
  /** Whether 2+ windows are open, so the columns / grid presets are usable. */
  canTileMultiple?: boolean;
}

/**
 * Open the conversation viewer for this task. The anchor session id only
 * resolves WHICH task to show (`transcripts.get` always returns that task's
 * entire lifecycle regardless of which of its sessions is passed), so any
 * valid session id works - prefer the live one (readily available), otherwise
 * resolve the newest via listSessions. Shared by the header's Conversation
 * pill and the kebab "View conversation" item.
 */
async function openTaskConversation(taskId: string): Promise<void> {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  let sessionId = useSessionStore.getState()._sessionByTaskId.get(taskId)?.id ?? null;
  if (!sessionId) {
    try {
      const list = await window.electronAPI.transcripts.listSessions(taskId, projectId);
      const newest = [...list].sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0];
      sessionId = newest?.sessionId ?? null;
    } catch {
      sessionId = null;
    }
  }
  if (sessionId) {
    useSessionStore.getState().setConversationSessionId(sessionId);
  } else {
    useToastStore.getState().addToast({ message: 'No conversation history for this task yet', variant: 'info' });
  }
}

export function TaskDetailHeader({
  task,
  onClose,
  setIsEditing,
  canToggle,
  isSessionActive,
  isQueued,
  isThinking,
  isIdle,
  isArchived,
  isIsolated,
  toggling,
  onToggle,
  onCommandSelect,
  onArchive,
  onSendToBacklog,
  onDelete,
  onMoveTo,
  moveTargets,
  headerShortcuts,
  menuShortcuts,
  executeShortcut,
  projectPath,
  canShowChanges,
  changesOpen,
  onToggleChanges,
  canShowBrowser,
  browserOpen,
  onToggleBrowser,
  canShowDescription = false,
  descriptionPeekOpen = false,
  onToggleDescription,
  isMaximized,
  onToggleMaximized,
  onUndock,
  onApplyTilePreset,
  canTileMultiple,
}: TaskDetailHeaderProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const titleSpanRef = useRef<HTMLSpanElement>(null);
  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);
  const closeCombo = useFormattedCombo('panel.close');
  const browserCombo = useFormattedCombo('taskDetail.toggleBrowser');
  const changesCombo = useFormattedCombo('taskDetail.toggleChanges');

  // Conversation availability, for disabling the pill/kebab item rather than
  // letting a click resolve to nothing. A live session (any state, not just
  // running) means history is already known synchronously; otherwise a
  // session may still exist from a prior run, so check once per task.
  const liveSessionId = useSessionStore((state) => state._sessionByTaskId.get(task.id)?.id ?? null);
  const [historicalConversationAvailable, setHistoricalConversationAvailable] = useState(false);
  useEffect(() => {
    if (liveSessionId) {
      setHistoricalConversationAvailable(false);
      return;
    }
    let cancelled = false;
    setHistoricalConversationAvailable(false);
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    window.electronAPI.transcripts
      .listSessions(task.id, projectId)
      .then((list) => { if (!cancelled) setHistoricalConversationAvailable(list.length > 0); })
      .catch(() => { if (!cancelled) setHistoricalConversationAvailable(false); });
    return () => { cancelled = true; };
  }, [task.id, liveSessionId]);
  const conversationAvailable = Boolean(liveSessionId) || historicalConversationAvailable;

  // Quick-access pills, highest priority collapses LAST. The title is reserved only
  // up to a ~50ch floor (useHeaderPillOverflow); these compete for whatever is left
  // above the floor. Among the built-in defaults the order is Conversation ->
  // Browser -> PR -> Changes -> Folder (Conversation drops first). Custom header
  // shortcuts rank LOWEST (priority 10), so they fold BEFORE any built-in default -
  // an unbounded number of shortcuts can never bury the defaults. A folded pill /
  // header shortcut that is not already a menu item folds into the kebab (Commands,
  // Open folder, and View conversation all have kebab entries). Commands is
  // kebab-only (no header pill) - it is a menu, not a one-tap toggle.
  const pillSpecs = useMemo<HeaderPillSpec[]>(() => {
    const specs: HeaderPillSpec[] = [];
    if (task.worktree_path || projectPath) specs.push({ id: 'folder', priority: 40 });
    if (canShowChanges) specs.push({ id: 'changes', priority: 30 });
    if (task.pr_url) specs.push({ id: 'pr', priority: 25 });
    if (canShowBrowser) specs.push({ id: 'browser', priority: 20 });
    specs.push({ id: 'conversation', priority: 18 });
    for (const action of headerShortcuts) {
      specs.push({ id: `shortcut:${action.id ?? action.label}`, priority: 10 });
    }
    return specs;
  }, [task.worktree_path, task.pr_url, projectPath, canShowChanges, canShowBrowser, headerShortcuts]);

  const hiddenPillIds = useHeaderPillOverflow(headerRef, leadingRef, trailingRef, titleSpanRef, pillsRef, pillSpecs);
  const showPill = (id: string) => !hiddenPillIds.has(id);

  // A header-only shortcut that collapsed must surface in the kebab so the overflow
  // stays the complete action set. Built-in pills are always in the kebab already;
  // a 'both'-display shortcut is already a menu shortcut, so it is skipped here.
  const overflowMenuShortcuts = useMemo(
    () => [
      ...menuShortcuts,
      ...headerShortcuts.filter(
        (action) =>
          hiddenPillIds.has(`shortcut:${action.id ?? action.label}`)
          && !menuShortcuts.some((menuAction) => (menuAction.id ?? menuAction.label) === (action.id ?? action.label)),
      ),
    ],
    [menuShortcuts, headerShortcuts, hiddenPillIds],
  );

  return (
    <div ref={headerRef} className="flex items-center gap-3 px-4 h-[54px] min-w-0">
      {/* Leading cluster: pause / id / priority. flex-shrink-0 so the priority
          badge never compresses, and so it measures as one unit for the overflow calc. */}
      <div ref={leadingRef} className="flex items-center gap-3 flex-shrink-0">
      {/* Pause / Resume toggle */}
      {canToggle && (
        <button
          onClick={onToggle}
          disabled={toggling}
          className={`inline-flex items-center justify-center p-1 rounded-full transition-colors flex-shrink-0 disabled:cursor-not-allowed ${
            toggling
              ? 'text-fg-muted'
              : isQueued
                ? 'text-fg-muted hover:bg-surface-hover'
                : isSessionActive
                  ? 'text-active hover:bg-surface-hover'
                  : 'text-fg-faint hover:bg-surface-hover hover:text-fg-tertiary'
          }`}
          title={toggling ? 'Working...' : isQueued ? 'Queued (click to pause)' : isSessionActive ? 'Pause session' : 'Resume session'}
        >
          <PauseButtonIcon
            toggling={toggling}
            isQueued={isQueued}
            isThinking={isThinking}
            isIdle={isIdle}
            isSessionActive={isSessionActive}
          />
        </button>
      )}

      {/* Display ID - clickable to copy */}
      <button
        type="button"
        className="group/copyid flex items-center gap-1 text-sm font-mono text-fg-muted hover:text-fg-secondary transition-colors flex-shrink-0"
        title={`Click to copy: ${task.display_id}`}
        data-testid="task-display-id"
        onClick={copyDisplayId}
      >
        {displayIdCopied
          ? <Check size={12} className="text-green-400" />
          : <Copy size={12} className="text-fg-disabled group-hover/copyid:text-fg-secondary transition-colors" />
        }
        #{task.display_id}
      </button>

      {/* Priority badge (hidden when priority is 0) */}
      <PriorityBadge priority={task.priority ?? 0} />
      </div>

      {/* Title - the overflow calc reserves only a ~50ch floor (not the full
          width), so quick-action pills reclaim the space above the floor. Because
          this h2 is flex-1, on a wide window the title shows in FULL and only
          truncates toward the floor once the pills need the room. The hard
          min-w-[64px] keeps it from fully vanishing in a tiny tiled pane. The
          inner span is content-sized, so its scrollWidth is the title's natural
          width (read by useHeaderPillOverflow). */}
      <h2
        className="text-base font-semibold text-fg truncate flex-1 min-w-[64px] flex items-center gap-2"
        title={task.title}
      >
        <span ref={titleSpanRef} className="truncate" data-testid="task-title-text">{task.title}</span>
        {isArchived && (
          <span
            className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-fg-disabled bg-surface-hover/60 border border-edge/40 rounded px-1.5 py-0.5"
            title="This task is archived. It does not appear on the board."
          >
            Archived
          </span>
        )}
        {isIsolated && <IsolatedBadge data-testid="task-detail-isolated-badge" />}
      </h2>

      {/* Quick-access pills - progressively fold into the kebab as the window
          narrows (useHeaderPillOverflow). Hidden for archived tasks; the title then
          fills the row. Each pill is wrapped so the overflow calc can measure it via
          `data-pill-id`. */}
      {!isArchived && (
        <div ref={pillsRef} className="flex items-center gap-3 flex-shrink-0">
          {/* Open folder pill - icon-only. The FolderGit2 (worktree) vs FolderGit
              (no worktree) glyph signals worktree-vs-project at a glance; the
              tooltip names the action, not the branch it's based on (that's a
              Changes-panel concern). (Commands is kebab-only - it is a menu,
              not a one-tap toggle, so it does not earn a header slot.) */}
          {showPill('folder') && (task.worktree_path || projectPath) && (
            <div data-pill-id="folder" className="flex-shrink-0">
              <HeaderActionButton
                icon={task.worktree_path ? FolderGit2 : FolderGit}
                onClick={() => window.electronAPI.shell.openPath(task.worktree_path ?? projectPath!)}
                title={task.worktree_path ? 'Open Worktree' : 'Open Folder'}
                ariaLabel={task.worktree_path ? 'Open worktree folder' : 'Open project folder'}
                testId="branch-pill"
              />
            </div>
          )}

          {/* PR pill */}
          {showPill('pr') && task.pr_url && (
            <div data-pill-id="pr" className="flex-shrink-0">
              <PrLink
                prUrl={task.pr_url}
                prNumber={task.pr_number}
                prState={task.pr_state}
                testId="pr-pill"
              />
            </div>
          )}

          {/* Changes toggle pill */}
          {showPill('changes') && canShowChanges && (
            <div data-pill-id="changes" className="flex-shrink-0">
              <HeaderActionButton
                icon={GitCompare}
                onClick={onToggleChanges}
                active={changesOpen}
                title={`${changesOpen ? 'Hide' : 'Show'} changes (${changesCombo})`}
                ariaLabel="Toggle changes"
                testId="changes-toggle"
              />
            </div>
          )}

          {/* Browser toggle pill */}
          {showPill('browser') && canShowBrowser && (
            <div data-pill-id="browser" className="flex-shrink-0">
              <HeaderActionButton
                icon={Globe}
                onClick={onToggleBrowser}
                active={browserOpen}
                title={`${browserOpen ? 'Hide' : 'Show'} browser (${browserCombo})`}
                ariaLabel="Toggle browser"
                testId="browser-toggle"
              />
            </div>
          )}

          {/* Conversation pill - opens the read-only transcript viewer for this
              task's newest session (also in the kebab as "View conversation").
              Disabled (muted) when the task has no session, live or historical. */}
          {showPill('conversation') && (
            <div data-pill-id="conversation" className="flex-shrink-0">
              <HeaderActionButton
                icon={MessageSquare}
                onClick={() => void openTaskConversation(task.id)}
                disabled={!conversationAvailable}
                title={conversationAvailable ? 'View conversation' : 'No conversation history for this task yet'}
                ariaLabel="View conversation"
                testId="conversation-pill"
              />
            </div>
          )}

          {/* Shortcut header pills */}
          {headerShortcuts.map((action) => {
            if (!showPill(`shortcut:${action.id ?? action.label}`)) return null;
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <div
                key={action.id ?? action.label}
                data-pill-id={`shortcut:${action.id ?? action.label}`}
                className="flex-shrink-0"
              >
                <HeaderActionButton
                  icon={ActionIcon}
                  onClick={() => executeShortcut(action)}
                  title={action.command}
                  label={action.label}
                  testId={`shortcut-pill-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Trailing controls: overflow menu + divider + pop-out (tiled) + maximize +
          close. flex-shrink-0 and measured as one unit so it is always reserved. */}
      <div ref={trailingRef} className="flex items-center gap-3 flex-shrink-0">
        {/* Actions */}
        <KebabMenu>
          {(close) => (
            <TaskDetailKebabItems
              task={task}
              close={close}
              setIsEditing={setIsEditing}
              canToggle={canToggle}
              isSessionActive={isSessionActive}
              isArchived={isArchived}
              toggling={toggling}
              onToggle={onToggle}
              onCommandSelect={onCommandSelect}
              onArchive={onArchive}
              onSendToBacklog={onSendToBacklog}
              onDelete={onDelete}
              onMoveTo={onMoveTo}
              moveTargets={moveTargets}
              menuShortcuts={overflowMenuShortcuts}
              executeShortcut={executeShortcut}
              projectPath={projectPath}
              canShowChanges={canShowChanges}
              changesOpen={changesOpen}
              onToggleChanges={onToggleChanges}
              canShowBrowser={canShowBrowser}
              browserOpen={browserOpen}
              onToggleBrowser={onToggleBrowser}
              canShowDescription={canShowDescription}
              descriptionPeekOpen={descriptionPeekOpen}
              onToggleDescription={onToggleDescription}
              conversationAvailable={conversationAvailable}
            />
          )}
        </KebabMenu>

        {/* Divider + Tile layout + Pop out (tiled only) + Maximize + Close */}
        <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
        {onApplyTilePreset && (
          <WindowLayoutMenu onApply={onApplyTilePreset} canTileMultiple={canTileMultiple ?? false} />
        )}
        {onUndock && (
          <button
            onClick={onUndock}
            data-testid="task-detail-undock"
            aria-label="Pop out of tiling"
            title="Pop out (float this window out of the tiled layout)"
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
          >
            <PictureInPicture2 size={16} />
          </button>
        )}
        <MaximizeToggleButton
          isMaximized={isMaximized}
          onToggle={onToggleMaximized}
          testId="task-detail-maximize"
        />
        <button
          onClick={onClose}
          data-testid="task-detail-close"
          title={`Close (${closeCombo})`}
          className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kebab menu items (extracted to keep header component clean)
// ---------------------------------------------------------------------------

interface TaskDetailKebabItemsProps {
  task: Task;
  close: () => void;
  setIsEditing: (editing: boolean) => void;
  canToggle: boolean;
  isSessionActive: boolean;
  isArchived: boolean;
  toggling: boolean;
  onToggle: () => void;
  onCommandSelect: (command: AgentCommand) => void;
  onArchive: () => void;
  onSendToBacklog: () => void;
  onDelete: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  moveTargets: Swimlane[];
  menuShortcuts: ShortcutConfig[];
  executeShortcut: (action: ShortcutConfig) => void;
  projectPath: string | null;
  canShowChanges: boolean;
  changesOpen: boolean;
  onToggleChanges: () => void;
  canShowBrowser: boolean;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  canShowDescription?: boolean;
  descriptionPeekOpen?: boolean;
  onToggleDescription?: () => void;
  /** Whether this task has any session (live or historical) to view. Disables
   *  the "View conversation" item rather than letting it resolve to nothing. */
  conversationAvailable: boolean;
}

function TaskDetailKebabItems({
  task,
  close,
  setIsEditing,
  canToggle,
  isSessionActive,
  isArchived,
  toggling,
  onToggle,
  onCommandSelect,
  onArchive,
  onSendToBacklog,
  onDelete,
  onMoveTo,
  moveTargets,
  menuShortcuts,
  executeShortcut,
  projectPath,
  canShowChanges,
  changesOpen,
  onToggleChanges,
  conversationAvailable,
  canShowBrowser,
  browserOpen,
  onToggleBrowser,
  canShowDescription = false,
  descriptionPeekOpen = false,
  onToggleDescription,
}: TaskDetailKebabItemsProps) {
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [showCommandsSubmenu, setShowCommandsSubmenu] = useState(false);
  const [linkingPr, setLinkingPr] = useState(false);

  const handleLinkPr = async () => {
    if (linkingPr) return;
    setLinkingPr(true);
    try {
      const result = await window.electronAPI.tasks.resolvePr(task.id, useProjectStore.getState().currentProject?.id ?? null);
      if (result.reason === 'resolver-unavailable') {
        useToastStore.getState().addToast({
          message: 'GitHub CLI not found - install gh and run gh auth login to link PRs',
          variant: 'error',
        });
      } else if (result.reason === 'transient-error') {
        useToastStore.getState().addToast({
          message: 'Could not reach GitHub - try again in a moment',
          variant: 'error',
        });
      } else if (result.linked && result.task?.pr_number != null) {
        useToastStore.getState().addToast({
          message: `Linked PR #${result.task.pr_number} (${result.task.pr_state ?? 'open'})`,
          variant: 'success',
        });
      } else {
        useToastStore.getState().addToast({
          message: task.branch_name ? `No PR found for branch "${task.branch_name}"` : 'No PR found for this task',
          variant: 'info',
        });
      }
    } catch {
      useToastStore.getState().addToast({ message: 'Could not resolve PR', variant: 'error' });
    } finally {
      setLinkingPr(false);
    }
  };

  const commandsFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const commandsFlyoutRef = useRef<HTMLDivElement>(null);
  const moveFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const moveFlyoutRef = useRef<HTMLDivElement>(null);

  const { placement: commandsFlyoutPlacement } = usePopoverPosition(commandsFlyoutTriggerRef, commandsFlyoutRef, showCommandsSubmenu, { mode: 'flyout' });
  const { placement: moveFlyoutPlacement } = usePopoverPosition(moveFlyoutTriggerRef, moveFlyoutRef, showMoveSubmenu, { mode: 'flyout' });

  const closeAll = () => {
    setShowMoveSubmenu(false);
    setShowCommandsSubmenu(false);
    close();
  };

  return (
    <>
      {/* Edit */}
      <KebabMenuItem
        icon={<Pencil size={14} />}
        label="Edit"
        onClick={() => { closeAll(); setIsEditing(true); }}
      />

      {/* View conversation - opens the structured transcript viewer. Disabled
          (muted) when the task has no session, live or historical. */}
      <KebabMenuItem
        icon={<MessageSquare size={14} />}
        label="View conversation"
        onClick={() => { closeAll(); void openTaskConversation(task.id); }}
        disabled={!conversationAvailable}
        data-testid="view-conversation-btn"
      />

      {/* Open folder */}
      {(task.worktree_path || projectPath) && (
        <KebabMenuItem
          icon={<FolderGit2 size={14} />}
          label="Open folder"
          onClick={() => { closeAll(); window.electronAPI.shell.openPath(task.worktree_path ?? projectPath!); }}
        />
      )}

      {/* Changes */}
      {canShowChanges && (
        <KebabMenuItem
          icon={<GitCompare size={14} />}
          label={changesOpen ? 'Hide changes' : 'Show changes'}
          onClick={() => { closeAll(); onToggleChanges(); }}
        />
      )}

      {/* Description peek */}
      {canShowDescription && onToggleDescription && (
        <KebabMenuItem
          icon={<AlignLeft size={14} />}
          label={descriptionPeekOpen ? 'Hide description' : 'Show description'}
          onClick={() => { closeAll(); onToggleDescription(); }}
        />
      )}

      {/* Browser (parity with the header Browser pill, so the overflow holds the
          full action set when the header hides quick-access pills on resize) */}
      {canShowBrowser && (
        <KebabMenuItem
          icon={<Globe size={14} />}
          label={browserOpen ? 'Hide browser' : 'Show browser'}
          onClick={() => { closeAll(); onToggleBrowser(); }}
        />
      )}

      {/* View PR */}
      {task.pr_url && (
        <KebabMenuItem
          icon={<GitPullRequest size={14} />}
          label={`View PR #${task.pr_number}`}
          onClick={() => { closeAll(); window.electronAPI.shell.openExternal(task.pr_url!); }}
        />
      )}

      {/* Link / refresh PR (authoritative branch->PR resolve; works with no live session) */}
      {(task.branch_name || task.worktree_path) && (
        <KebabMenuItem
          icon={linkingPr ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          label={task.pr_url ? 'Refresh PR' : 'Link PR'}
          onClick={() => { closeAll(); void handleLinkPr(); }}
          disabled={linkingPr}
        />
      )}

      {/* Pause / Resume */}
      {canToggle && (
        <KebabMenuItem
          icon={isSessionActive ? <CirclePause size={14} /> : <CirclePlay size={14} />}
          label={isSessionActive ? 'Pause session' : 'Resume session'}
          onClick={() => { closeAll(); onToggle(); }}
          disabled={toggling}
        />
      )}

      {/* Commands -- searchable flyout (shares CommandSearchList with the header
          pill). Hover to open / leave to close, like Move to: the flyout is a DOM
          child of this container, so moving the pointer INTO it (to type in the
          search) stays within the container and keeps it open; the search input
          auto-focuses on open so you can type immediately. */}
      {isSessionActive && (
        <div
          ref={commandsFlyoutTriggerRef}
          className="relative"
          onMouseEnter={() => setShowCommandsSubmenu(true)}
          onMouseLeave={() => setShowCommandsSubmenu(false)}
        >
          <button
            onClick={() => setShowCommandsSubmenu(!showCommandsSubmenu)}
            className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${showCommandsSubmenu ? 'bg-surface-hover text-fg' : ''}`}
            data-testid="kebab-commands-button"
          >
            <SquareChevronRight size={14} />
            <span className="flex-1">Commands</span>
            {commandsFlyoutPlacement.horizontal === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          {showCommandsSubmenu && (
            <div
              ref={commandsFlyoutRef}
              style={{ transformOrigin: commandsFlyoutPlacement.horizontal === 'left' ? 'right center' : 'left center' }}
              className="absolute w-[280px] max-h-[300px] flex flex-col bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 overflow-hidden overlay-popover-in"
            >
              <CommandSearchList
                cwd={task.worktree_path ?? projectPath ?? undefined}
                onSelect={(command) => { closeAll(); onCommandSelect(command); }}
                onClose={() => setShowCommandsSubmenu(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* Move to -- flyout submenu */}
      {moveTargets.length > 0 && (
        <div
          ref={moveFlyoutTriggerRef}
          className="relative"
          onMouseEnter={() => setShowMoveSubmenu(true)}
          onMouseLeave={() => setShowMoveSubmenu(false)}
        >
          <button
            onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
            className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${showMoveSubmenu ? 'bg-surface-hover text-fg' : ''}`}
          >
            <ArrowRightLeft size={14} />
            <span className="flex-1">Move to</span>
            {moveFlyoutPlacement.horizontal === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          {showMoveSubmenu && (
            <div ref={moveFlyoutRef} style={{ transformOrigin: moveFlyoutPlacement.horizontal === 'left' ? 'right center' : 'left center' }} className="absolute min-w-[150px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1 overlay-popover-in">
              {moveTargets.map((swimlane) => (
                <button
                  key={swimlane.id}
                  onClick={() => onMoveTo(swimlane.id)}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
                >
                  <span className="flex-shrink-0" style={{ color: swimlane.color }}>
                    {(() => {
                      const Icon = getSwimlaneIcon(swimlane);
                      return Icon ? (
                        <Icon size={14} strokeWidth={1.75} />
                      ) : (
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: swimlane.color }} />
                      );
                    })()}
                  </span>
                  {swimlane.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Shortcuts */}
      {menuShortcuts.length > 0 && (
        <>
          <KebabMenuDivider />
          {menuShortcuts.map((action) => {
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <KebabMenuItem
                key={action.id ?? action.label}
                icon={<ActionIcon size={14} />}
                label={action.label}
                onClick={() => { closeAll(); executeShortcut(action); }}
                data-testid={`shortcut-kebab-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
              />
            );
          })}
        </>
      )}

      {/* Divider before destructive actions */}
      <KebabMenuDivider />

      {!isArchived && (
        <KebabMenuItem
          icon={<Inbox size={14} />}
          label="Send to Backlog"
          onClick={() => { closeAll(); onSendToBacklog(); }}
          data-testid="send-to-backlog-btn"
        />
      )}

      {!isArchived && (
        <KebabMenuItem
          icon={<Archive size={14} />}
          label="Archive"
          onClick={() => { closeAll(); onArchive(); }}
        />
      )}

      {/* Delete -- always available */}
      <KebabMenuItem
        icon={<Trash2 size={14} />}
        label="Delete"
        onClick={() => { closeAll(); onDelete(); }}
        destructive
      />
    </>
  );
}
