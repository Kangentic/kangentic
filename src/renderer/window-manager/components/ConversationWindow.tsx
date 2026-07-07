/**
 * Conversation viewer, hosted inside a managed window on the board task-detail
 * layer. Its `anchor` is the Kangentic session id that opened it, used only to
 * resolve which task to show - `transcripts.get` always returns that task's
 * ENTIRE lifecycle (every session it has ever accumulated, stitched into one
 * timeline), regardless of which of its sessions the anchor points at. There
 * is deliberately no session picker: which session shows is not a setting.
 *
 * Fetches the structured transcript directly via `window.electronAPI.transcripts.get`
 * (precedent: SessionSummaryPanel calls the IPC bridge directly), renders it
 * through the pure `ConversationView`, and offers an "Open task" jump and a
 * "Copy as Markdown" export.
 *
 * The title bar reuses the same panel.* keybindings + structural-Escape pattern
 * as TaskDetailWindow (gated on `isFocused`); it adds no new KEYBINDINGS entries.
 * Close routes through the frame's animated `requestClose`; the conversation
 * window bridge mirrors the closure back to clearing `conversationSessionId`.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, X, SquareTerminal, Copy, Check, Loader2, PictureInPicture2 } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import { WindowLayoutMenu } from '../../components/dialogs/WindowLayoutMenu';
import { KebabMenu, KebabMenuItem } from '../../components/KebabMenu';
import { HeaderActionButton } from '../../components/HeaderActionButton';
import { ConversationView } from '../../components/conversation/ConversationView';
import { transcriptToMarkdown } from '../../../shared/transcript-format';
import { useLayerStore } from '../context';
import type { ManagedWindow } from '../store/types';
import type { TranscriptGetResponse } from '../../../shared/types';

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

/**
 * Cheap fingerprint of a transcript response, so a live poll that returns
 * identical content skips the state update entirely (the common case between
 * actual new turns). Without this, every 2.5s tick replaces the whole entries
 * array, re-runs the viewer's O(n) memos, and re-renders the visible rows -
 * a periodic hitch that fights smooth scrolling on a long transcript. Captures
 * appends (entry count), a streaming last turn (its content length grows in
 * place), and status/degraded/source flips - the changes that actually warrant
 * a repaint. A mid-transcript edit with an unchanged length is not detected,
 * but transcripts are append-and-stream, so that does not occur in practice. */
function transcriptSignature(response: TranscriptGetResponse | null): string {
  if (!response) return 'null';
  const count = response.entries.length;
  const last = count > 0 ? response.entries[count - 1] : null;
  let lastLen = 0;
  if (last) {
    if (last.kind === 'assistant') {
      lastLen = last.blocks.reduce((sum, block) => sum + (block.type === 'tool_use' ? 0 : block.text.length), 0);
    } else if (last.kind === 'tool_result') {
      lastLen = last.content.length;
    } else {
      lastLen = last.text.length;
    }
  }
  return `${count}:${last?.uuid ?? ''}:${last?.ts ?? 0}:${lastLen}:${response.sessionStatus ?? ''}:${response.degraded ? 1 : 0}:${response.source}`;
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
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const setDetailTaskId = useSessionStore((state) => state.setDetailTaskId);
  const scrollToTurnUuid = useSessionStore((state) => state.scrollToTurnUuid);
  const setScrollToTurnUuid = useSessionStore((state) => state.setScrollToTurnUuid);
  const conversationSessionId = useSessionStore((state) => state.conversationSessionId);
  const sessions = useSessionStore((state) => state.sessions);

  const useStore = useLayerStore();
  const toggleMaximizeWindow = useStore((state) => state.toggleMaximizeWindow);
  const applyTilePreset = useStore((state) => state.applyTilePreset);
  const untileWindow = useStore((state) => state.untileWindow);
  const isTiled = useStore((state) => state.windows[managedWindow.id]?.state === 'tiled');
  const windowCount = useStore((state) => Object.keys(state.windows).length);

  const [response, setResponse] = useState<TranscriptGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  // Auto-follow new turns only when the user is neither focused on nor
  // hovering this window - otherwise a live poll would yank them away from
  // whatever part of the transcript they are reading.
  const autoFollowNewMessages = !isFocused && !isHovering;

  // Fetch the transcript on mount. The anchor only resolves WHICH task to
  // show - the response always spans that task's entire lifecycle.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.electronAPI.transcripts
      .get({ sessionId: managedWindow.anchor, projectId: currentProjectId })
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
  }, [managedWindow.anchor, currentProjectId]);

  const taskId = response?.taskId ?? null;

  // Live-follow: re-fetch on an interval (no loading spinner) while EITHER the
  // latest contributing session is still running/queued, OR the reactive
  // session store shows any live session for this task at all. The second
  // check is load-bearing for an isolated-swimlane move: the anchor session
  // can go 'suspended' and a brand-new isolated session can spawn moments
  // later, and there is a real gap between those two events where the poll's
  // own last-fetched sessionStatus is stale (still the old, now-suspended
  // session) - without the store check, polling would stop right there and
  // never resume, even though a new session starts seconds later. The effect
  // depends only on primitives/derived booleans, so a refresh that leaves
  // "still live" true does not re-arm the timer.
  const sessionStatus = response?.sessionStatus ?? null;
  const taskHasLiveSession = taskId
    ? sessions.some((session) => session.taskId === taskId && (session.status === 'running' || session.status === 'queued'))
    : false;
  useEffect(() => {
    const live = sessionStatus === 'running' || sessionStatus === 'queued' || taskHasLiveSession;
    if (!live) return;
    let cancelled = false;
    const interval = setInterval(() => {
      window.electronAPI.transcripts
        .get({ sessionId: managedWindow.anchor, projectId: currentProjectId })
        .then((result) => {
          if (cancelled) return;
          // Returning the SAME reference when nothing changed makes React bail
          // out of the re-render, so an idle live session does not repaint the
          // viewer every 2.5s.
          setResponse((previous) =>
            transcriptSignature(previous) === transcriptSignature(result) ? previous : result,
          );
        })
        .catch(() => undefined);
    }, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionStatus, taskHasLiveSession, managedWindow.anchor, currentProjectId]);

  const handleCopyMarkdown = useCallback(() => {
    if (!response) return;
    // Only flip to "copied" once the write actually resolves; a rejected write
    // (unfocused document / denied permission) must not falsely signal success
    // or surface as an unhandled rejection.
    void navigator.clipboard
      .writeText(transcriptToMarkdown(response.entries))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
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
              matching TaskDetailHeader's header row): both are common enough in a
              read-only viewer to earn a one-tap affordance rather than living only
              behind "...". The kebab entries stay too (same pill+kebab redundancy
              TaskDetailHeader uses for "View conversation"). */}
          {taskId && (
            <HeaderActionButton
              icon={SquareTerminal}
              onClick={handleOpenTask}
              title="Open task"
              ariaLabel="Open task"
              testId="conversation-open-task-button"
            />
          )}
          <HeaderActionButton
            icon={copied ? CopiedCheckIcon : Copy}
            onClick={handleCopyMarkdown}
            disabled={!response}
            title="Copy conversation as Markdown"
            ariaLabel="Copy conversation"
            testId="conversation-copy-markdown-button"
          />

          <KebabMenu>
            {(close) => (
              <>
                {taskId && (
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
          autoFollowNewMessages={autoFollowNewMessages}
        />
      )}
    </div>
  );
}
