/**
 * Conversation viewer, hosted inside a managed window on the board task-detail
 * layer. Its `anchor` is the Kangentic session id that opened it.
 *
 * Fetches the structured transcript for the picked session directly via
 * `window.electronAPI.transcripts.get` (precedent: SessionSummaryPanel calls the
 * IPC bridge directly), renders it through the pure `ConversationView`, and
 * offers a session picker (when the task has more than one session), an
 * "Open task" jump, and a "Copy as Markdown" export.
 *
 * The title bar reuses the same panel.* keybindings + structural-Escape pattern
 * as TaskDetailWindow (gated on `isFocused`); it adds no new KEYBINDINGS entries.
 * Close routes through the frame's animated `requestClose`; the conversation
 * window bridge mirrors the closure back to clearing `conversationSessionId`.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, X, SquareArrowOutUpRight, Copy, Check, Loader2, PictureInPicture2 } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import { WindowLayoutMenu } from '../../components/dialogs/WindowLayoutMenu';
import { KebabMenu, KebabMenuItem } from '../../components/KebabMenu';
import { Select } from '../../components/settings/shared';
import { ConversationView } from '../../components/conversation/ConversationView';
import { formatShortDateTime } from '../../lib/datetime';
import { transcriptToMarkdown } from '../../../shared/transcript-format';
import { useLayerStore } from '../context';
import type { ManagedWindow } from '../store/types';
import type { TranscriptGetResponse, ConversationSessionMeta } from '../../../shared/types';

interface ConversationWindowProps {
  managedWindow: ManagedWindow;
  isFocused: boolean;
  isMaximized: boolean;
  titleBarPointerDown: (event: React.PointerEvent) => void;
  requestClose: () => void;
}

/** How often to re-fetch the transcript while its session is still live, so an
 *  open viewer follows new turns as the agent produces them. */
const LIVE_REFRESH_MS = 2500;

// Controls whose own click/drag must win over a window drag or maximize toggle
// (mirrors TaskDetailWindow's selector).
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

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
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const setDetailTaskId = useSessionStore((state) => state.setDetailTaskId);
  const scrollToTurnUuid = useSessionStore((state) => state.scrollToTurnUuid);
  const setScrollToTurnUuid = useSessionStore((state) => state.setScrollToTurnUuid);
  const conversationSessionId = useSessionStore((state) => state.conversationSessionId);

  const useStore = useLayerStore();
  const toggleMaximizeWindow = useStore((state) => state.toggleMaximizeWindow);
  const applyTilePreset = useStore((state) => state.applyTilePreset);
  const untileWindow = useStore((state) => state.untileWindow);
  const isTiled = useStore((state) => state.windows[managedWindow.id]?.state === 'tiled');
  const windowCount = useStore((state) => Object.keys(state.windows).length);

  // Which session's transcript is shown. Defaults to the window's anchor; the
  // session picker re-points it.
  const [pickedSessionId, setPickedSessionId] = useState(managedWindow.anchor);
  const [response, setResponse] = useState<TranscriptGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionList, setSessionList] = useState<ConversationSessionMeta[]>([]);
  const [copied, setCopied] = useState(false);

  // Fetch the transcript for the picked session (on mount + when the picker moves).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.electronAPI.transcripts
      .get({ sessionId: pickedSessionId, projectId: currentProjectId })
      .then((result) => {
        if (cancelled) return;
        setResponse(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResponse(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickedSessionId, currentProjectId]);

  // Live-follow: while the session is still running/queued its transcript can
  // grow, so silently re-fetch on an interval (no loading spinner). The effect
  // depends only on the primitive status, so each refresh does not re-arm the
  // timer; when the session goes non-live the effect re-runs and stops polling.
  const sessionStatus = response?.sessionStatus ?? null;
  useEffect(() => {
    const live = sessionStatus === 'running' || sessionStatus === 'queued';
    if (!live) return;
    let cancelled = false;
    const interval = setInterval(() => {
      window.electronAPI.transcripts
        .get({ sessionId: pickedSessionId, projectId: currentProjectId })
        .then((result) => {
          if (!cancelled) setResponse(result);
        })
        .catch(() => undefined);
    }, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionStatus, pickedSessionId, currentProjectId]);

  // Once we know the owning task, list its sessions so the picker can offer them.
  const taskId = response?.taskId ?? null;
  useEffect(() => {
    if (!taskId) {
      setSessionList([]);
      return;
    }
    let cancelled = false;
    window.electronAPI.transcripts
      .listSessions(taskId, currentProjectId)
      .then((list) => {
        if (!cancelled) setSessionList(list);
      })
      .catch(() => {
        if (!cancelled) setSessionList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, currentProjectId]);

  const handleCopyMarkdown = useCallback(() => {
    if (!response) return;
    navigator.clipboard.writeText(transcriptToMarkdown(response.entries));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [response]);

  const handleOpenTask = useCallback(() => {
    if (taskId) setDetailTaskId(taskId);
  }, [taskId, setDetailTaskId]);

  const consumeScroll = useCallback(() => {
    setScrollToTurnUuid(null);
  }, [setScrollToTurnUuid]);

  const handleToggleMaximized = useCallback(() => toggleMaximizeWindow(managedWindow.id), [toggleMaximizeWindow, managedWindow.id]);
  const handleUndock = useCallback(() => untileWindow(managedWindow.id), [untileWindow, managedWindow.id]);

  // Task-detail parity keybindings (capture phase, gated on focus). No new
  // registry entries: reuse panel.maximize / panel.close.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true, enabled: isFocused });
  useKeybinding('panel.close', requestClose, { capture: true, enabled: isFocused });

  // Structural Escape (keybindings-registry exception, like BaseDialog /
  // TaskDetailWindow): bubble-phase, gated on focus.
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
  const agentName = response?.agentName ?? '';
  // Only this window (the one the signal points at) consumes the one-shot scroll,
  // so a second open conversation window never races to clear it.
  const activeScrollUuid = managedWindow.anchor === conversationSessionId ? scrollToTurnUuid : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="conversation-window">
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

          {sessionList.length > 1 && (
            <Select
              value={pickedSessionId}
              onChange={(event) => setPickedSessionId(event.target.value)}
              className="appearance-none bg-surface-hover border border-edge-input rounded pl-2.5 pr-8 py-1 text-xs text-fg focus:outline-none focus:border-accent"
              chevronSize={13}
              chevronClassName="right-2"
              data-testid="conversation-session-picker"
            >
              {sessionList.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {formatShortDateTime(session.startedAt)}
                  {session.isolatedSwimlaneId ? ' (isolated)' : ''}
                </option>
              ))}
            </Select>
          )}

          <KebabMenu>
            {(close) => (
              <>
                {taskId && (
                  <KebabMenuItem
                    icon={<SquareArrowOutUpRight size={13} />}
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
                    handleCopyMarkdown();
                    close();
                  }}
                  disabled={!response}
                  data-testid="conversation-copy-markdown"
                />
              </>
            )}
          </KebabMenu>

          <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
          <WindowLayoutMenu onApply={applyTilePreset} canTileMultiple={windowCount >= 2} />
          {isTiled && (
            <button
              type="button"
              onClick={handleUndock}
              aria-label="Pop out"
              title="Pop out (float this window out of the tiled layout)"
              data-testid={`conversation-undock-${managedWindow.id}`}
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            >
              <PictureInPicture2 size={16} />
            </button>
          )}
          <MaximizeToggleButton
            isMaximized={isMaximized}
            onToggle={handleToggleMaximized}
            testId={`conversation-maximize-${managedWindow.id}`}
          />
          <button
            type="button"
            onClick={requestClose}
            title="Close"
            aria-label="Close window"
            data-testid="conversation-close"
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {loading || !response ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-fg-muted" />
        </div>
      ) : (
        <ConversationView
          entries={response.entries}
          degraded={response.degraded}
          source={response.source}
          unavailableReason={response.unavailableReason}
          agentName={agentName}
          scrollToTurnUuid={activeScrollUuid}
          onConsumedScroll={consumeScroll}
        />
      )}
    </div>
  );
}
