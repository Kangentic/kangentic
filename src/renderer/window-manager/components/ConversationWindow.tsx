/**
 * Conversation viewer, hosted inside a managed window on the board task-detail
 * layer. Its `anchor` is the Kangentic session id that opened it, used only to
 * resolve which task to show (see `useConversationState`).
 *
 * The viewer itself is host-agnostic: `useConversationState` owns the
 * transcript read, the Route tabs, paging, the live poll, Copy and the opening
 * position, and `ConversationBody` draws them. This window is the host: it
 * supplies the project, the anchor and the one-shot requests the stores hold
 * (a tab, a scroll-to-turn, the terminal viewport at open), and
 * keeps the chrome: the title bar with "Open task", Copy and the kebab, the
 * maximize and close controls, and their keybindings.
 *
 * The title bar reuses the same panel.* keybindings + structural-Escape pattern
 * as TaskDetailWindow (gated on `isFocused`). The in-viewer search bar is
 * always visible (ConversationView owns it, including the `conversation.find`
 * Mod+F binding that focuses it - there is no open/close state to toggle
 * here). Close routes through the frame's animated `requestClose`; the
 * conversation window bridge mirrors the closure back to clearing
 * `conversationSessionId`.
 *
 * An open that names a column (`managedWindow.conversationTab`) switches an
 * open window to it. No caller names one: the completed task view's Route
 * card opens that view's own Conversation tab instead. A search hit
 * (`scrollToTurnUuid` in the session
 * store, for the window anchored on `conversationSessionId`) or a Knowledge
 * Graph source row (`managedWindow.scrollToTurnUuid`) switches to All, where
 * every turn is.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, X, SquareTerminal, Copy, Check, PictureInPicture2, ArrowUpToLine } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import { KebabMenu, KebabMenuItem } from '../../components/KebabMenu';
import { HeaderActionButton } from '../../components/HeaderActionButton';
import { Tooltip } from '../../components/Tooltip';
import { ConversationBody } from '../../components/conversation/ConversationBody';
import { useConversationState } from '../../components/conversation/use-conversation-state';
import { useLayerStore, useWindowManager } from '../context';
import type { ManagedWindow } from '../store/types';

interface ConversationWindowProps {
  managedWindow: ManagedWindow;
  isFocused: boolean;
  isMaximized: boolean;
  titleBarPointerDown: (event: React.PointerEvent) => void;
  requestClose: () => void;
}

// Controls whose own click/drag must win over a window drag or maximize toggle
// (mirrors TaskDetailWindow's selector).
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

/** HeaderActionButton takes an icon COMPONENT, not a pre-rendered element, so the
 *  brief "copied" confirmation (green check, same as the kebab twin) is its own
 *  tiny component rather than an inline conditional element. */
function CopiedCheckIcon({ size }: { size?: number }) {
  return <Check size={size} className="text-green-400" />;
}

function isInteractiveTarget(event: React.PointerEvent | React.MouseEvent): boolean {
  const interactive = (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR);
  return !!interactive && (event.currentTarget as HTMLElement).contains(interactive);
}

export function ConversationWindow({
  managedWindow,
  isFocused,
  isMaximized,
  titleBarPointerDown,
  requestClose,
}: ConversationWindowProps) {
  const openProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // A window the Knowledge Graph opened from another project's island reads its
  // transcript from THAT project; every other window reads the open one.
  const currentProjectId = managedWindow.projectId ?? openProjectId;
  const scrollToTurnUuid = useSessionStore((state) => state.scrollToTurnUuid);
  const setScrollToTurnUuid = useSessionStore((state) => state.setScrollToTurnUuid);
  const conversationSessionId = useSessionStore((state) => state.conversationSessionId);
  const pendingTuiAnchor = useSessionStore((state) => state.pendingTuiAnchor);
  const setPendingTuiAnchor = useSessionStore((state) => state.setPendingTuiAnchor);
  const sessions = useSessionStore((state) => state.sessions);

  // Whether THIS layer can put a task detail somewhere the user will see it. The
  // board supplies the route, and so does the in-app Knowledge Graph (it closes
  // the graph first); the detached graph does not (see
  // `WindowManagerLayerOptions.revealTaskDetail`), so "Open task" hides there
  // rather than doing nothing at all.
  const { layer } = useWindowManager();
  const revealTaskDetail = layer.revealTaskDetail;

  const layerStore = useLayerStore();
  const toggleMaximizeWindow = layerStore((state) => state.toggleMaximizeWindow);
  const untileWindow = layerStore((state) => state.untileWindow);
  const isTiled = layerStore((state) => state.windows[managedWindow.id]?.state === 'tiled');
  const clearConversationTab = layerStore((state) => state.clearConversationTab);
  const clearWindowScrollTarget = layerStore((state) => state.clearWindowScrollTarget);

  const [isHovering, setIsHovering] = useState(false);

  // Auto-follow new turns only when the user is neither focused on nor
  // hovering this window - otherwise a live poll would yank them away from
  // whatever part of the transcript they are reading.
  const autoFollowNewMessages = !isFocused && !isHovering;

  // An open's tab request: the viewer applies it during render, and the
  // store's copy is cleared here once it has been seen.
  const tabRequest = managedWindow.conversationTab;
  useEffect(() => {
    if (tabRequest) clearConversationTab(managedWindow.id);
  }, [tabRequest, clearConversationTab, managedWindow.id]);

  const windowScrollTarget = managedWindow.scrollToTurnUuid;
  // Only this window (the one the signal points at) consumes the one-shot scroll,
  // so a second open conversation window never races to clear it.
  const activeScrollUuid = windowScrollTarget
    ?? (managedWindow.anchor === conversationSessionId ? scrollToTurnUuid : null);
  const handleScrollConsumed = useCallback(() => {
    // A per-window target (the Knowledge Graph's source rows) is this window's
    // own; the session-store one-shot belongs to the board's bridge.
    if (windowScrollTarget) clearWindowScrollTarget(managedWindow.id);
    else setScrollToTurnUuid(null);
  }, [windowScrollTarget, clearWindowScrollTarget, managedWindow.id, setScrollToTurnUuid]);

  const handleTuiAnchorConsumed = useCallback(() => setPendingTuiAnchor(null), [setPendingTuiAnchor]);

  const isTaskLive = useCallback(
    (taskId: string) => sessions.some((session) => session.taskId === taskId && (session.status === 'running' || session.status === 'queued')),
    [sessions],
  );

  const conversation = useConversationState({
    projectId: currentProjectId,
    anchorSessionId: managedWindow.anchor,
    requestKey: `conversation-window:${managedWindow.id}`,
    tabRequest,
    scrollTarget: activeScrollUuid,
    onScrollConsumed: handleScrollConsumed,
    tuiAnchor: pendingTuiAnchor,
    onTuiAnchorConsumed: handleTuiAnchorConsumed,
    isTaskLive,
  });
  const { response, taskId, copied, copyMarkdown, paging } = conversation;
  const jumpToStart = paging.jumpToStart;

  const handleOpenTask = useCallback(() => {
    // A window opened from another project's island names that project, so the
    // task opens there rather than being looked up on the open board.
    if (taskId) revealTaskDetail?.(taskId, managedWindow.projectId);
  }, [taskId, revealTaskDetail, managedWindow.projectId]);

  /** Both "Open task" affordances gate on this: a real task AND a layer that can
   *  actually show it. */
  const canOpenTask = taskId !== null && revealTaskDetail !== undefined;

  const handleToggleMaximized = useCallback(() => toggleMaximizeWindow(managedWindow.id), [toggleMaximizeWindow, managedWindow.id]);
  const handleUndock = useCallback(() => untileWindow(managedWindow.id), [untileWindow, managedWindow.id]);

  // Task-detail parity keybindings (capture phase, gated on focus). No new
  // registry entries for maximize/close: reuse panel.maximize / panel.close.
  // conversation.find is registered inside ConversationView itself, which
  // owns the always-visible search bar it focuses.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true, enabled: isFocused });
  useKeybinding('panel.close', requestClose, { capture: true, enabled: isFocused });

  // Structural Escape (keybindings-registry exception, like BaseDialog /
  // TaskDetailWindow): bubble-phase, gated on focus. The search bar has no
  // open/close state to special-case here - Escape always closes the window
  // (the search input's own Escape handler stops propagation before this
  // listener sees it, so typing Escape while focused in search just blurs it).
  useEffect(() => {
    if (!isFocused) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFocused, requestClose]);

  const onTitleBarPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0 || isInteractiveTarget(event)) return;
    titleBarPointerDown(event);
  }, [titleBarPointerDown]);

  const onTitleBarDoubleClick = useCallback((event: React.MouseEvent) => {
    if (isInteractiveTarget(event)) return;
    handleToggleMaximized();
  }, [handleToggleMaximized]);

  const taskTitle = response?.taskTitle || 'Session';

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="conversation-window"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        className="border-b border-edge flex-shrink-0 select-none"
        data-testid="conversation-titlebar"
        onPointerDown={onTitleBarPointerDown}
        onDoubleClick={onTitleBarDoubleClick}
      >
        <div className="flex items-center gap-2 px-4 py-3 min-w-0">
          <MessageSquare size={15} className="flex-shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            {/* Just the task title. Agent name and timestamp now live on each
                message (pill + per-message time), so the header stays minimal. */}
            <div className="text-sm font-semibold text-fg truncate" data-testid="conversation-title">
              {taskTitle}
            </div>
          </div>

          {/* Promoted from kebab-only to visible icon buttons (shared component,
              matching TaskDetailHeader's header row): common enough in a
              read-only viewer to earn a one-tap affordance rather than living only
              behind "...". The kebab entries stay too (same pill+kebab redundancy
              TaskDetailHeader uses for "View conversation"). Search has no toggle
              button here - it is always visible inside ConversationView. */}
          {canOpenTask && (
            <HeaderActionButton
              icon={SquareTerminal}
              onClick={handleOpenTask}
              tip="Open task"
              testId="conversation-open-task-button"
            />
          )}
          <HeaderActionButton
            icon={copied ? CopiedCheckIcon : Copy}
            onClick={copyMarkdown}
            disabled={!response}
            tip="Copy conversation as Markdown"
            ariaLabel="Copy conversation"
            testId="conversation-copy-markdown-button"
          />

          <KebabMenu>
            {(close) => (
              <>
                {canOpenTask && (
                  <KebabMenuItem
                    icon={<SquareTerminal size={13} />}
                    label="Open task"
                    onClick={() => {
                      handleOpenTask();
                      close();
                    }}
                    data-testid="conversation-open-task"
                  />
                )}
                <KebabMenuItem
                  icon={copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                  label="Copy conversation"
                  onClick={() => {
                    copyMarkdown();
                    close();
                  }}
                  disabled={!response}
                  data-testid="conversation-copy-markdown"
                />
                {paging.enabled && (
                  <KebabMenuItem
                    icon={<ArrowUpToLine size={13} />}
                    label="Jump to start"
                    onClick={() => {
                      jumpToStart();
                      close();
                    }}
                    data-testid="conversation-jump-to-start"
                  />
                )}
              </>
            )}
          </KebabMenu>

          <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
          {isTiled && (
            <Tooltip label="Float this window out of the tiled layout">
              <button
                type="button"
                onClick={handleUndock}
                aria-label="Pop out"
                data-testid={`conversation-undock-${managedWindow.id}`}
                className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
              >
                <PictureInPicture2 size={16} />
              </button>
            </Tooltip>
          )}
          <MaximizeToggleButton
            isMaximized={isMaximized}
            onToggle={handleToggleMaximized}
            testId={`conversation-maximize-${managedWindow.id}`}
          />
          <Tooltip label="Close window" keys="panel.close">
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close window"
              data-testid="conversation-close"
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      <ConversationBody
        state={conversation}
        isFocused={isFocused}
        autoFollowNewMessages={autoFollowNewMessages}
      />
    </div>
  );
}
