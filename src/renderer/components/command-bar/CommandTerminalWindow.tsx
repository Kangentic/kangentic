/**
 * A single Command Terminal hosted inside a window-manager frame. Extracted from
 * the old fixed-modal `CommandBarOverlay`: the window-manager engine now owns the
 * frame (drag, 8-handle resize, maximize, Win11 snap, geometry persistence), so
 * this component only renders the CONTENT - a draggable header (title + Stop +
 * branch picker + command/changes pills + kebab + maximize + a hide-X), the xterm
 * body, an optional Changes panel, and the ContextBar footer. The X HIDES the
 * layer (keeps the PTY alive, like Ctrl+Shift+P / the panel-close combo / a
 * backdrop click); only Stop destroys the session.
 *
 * Lifecycle: an ephemeral transient session is spawned on mount (or reattached if
 * one is already alive for the project), scoped to the active project. Stop kills
 * the PTY and hides the layer; hiding the layer (Ctrl+Shift+P toggle, the panel-
 * close combo, or a backdrop click) keeps the PTY alive so reopening reattaches.
 * The xterm is never remounted during a frame drag/resize: the engine moves the
 * frame by transform and commits once, firing `terminal-panel-resize`, which
 * refits the terminal in place.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Circle, CircleStop, FolderOpen, GitCompare, Loader2, Maximize2, Minimize2, SquareChevronRight, X, Zap } from 'lucide-react';
import { BranchPicker } from '../dialogs/BranchPicker';
import { LaunchOverlay } from '../LaunchOverlay';
import { Pill } from '../Pill';
import { KebabMenu, KebabMenuItem, KebabMenuDivider } from '../KebabMenu';
import { CommandPalettePopover } from '../dialogs/task-detail/CommandPalettePopover';
import { useTerminal } from '../../hooks/useTerminal';
import { useKeybinding, useFormattedCombo } from '../../hooks/useKeybinding';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { ContextBar } from '../terminal/ContextBar';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { resolveShortcutCommand } from '../../../shared/template-vars';
import { ICON_REGISTRY } from '../../utils/swimlane-icons';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { getIsHmrReload } from '../../utils/hmr-flag';
import { useLayerStore } from '../../window-manager';
import type { ManagedWindow } from '../../window-manager';
import type { AgentCommand } from '../../../shared/types';
import { useCommandTerminalLayer } from './command-terminal-context';

const ChangesPanel = lazy(() => import('../dialogs/task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

/** The entity id the transient Command Terminal uses for its changes panel +
 *  per-entity UI flags (matches the old `CommandBarOverlay`). */
const COMMAND_TERMINAL_ENTITY_ID = 'command-terminal';

/**
 * The centered stop glyph: one small rounded square, sized + colored to sit dead
 * center in the 20px activity ring (the stop counterpart to task-detail's
 * `PauseBars`). `colorClass` is a `bg-*` matching the ring.
 */
function StopSquare({ colorClass }: { colorClass: string }): ReactNode {
  return (
    <span data-testid="stop-square" className="col-start-1 row-start-1 flex items-center justify-center">
      <span className={`w-[8px] h-[8px] rounded-[2px] ${colorClass}`} />
    </span>
  );
}

/**
 * The Stop button glyph, carrying the same activity ring the task-detail header
 * folds into its pause button (`PauseButtonIcon`), but with a STOP square centered
 * instead of pause bars - the command terminal stops (kills the PTY); it never
 * pauses. Activity is encoded by the surrounding ring:
 *   - thinking (agent working): a spinning emerald ring around the stop square.
 *   - idle/permission (needs you): a static amber ring around the stop square.
 *   - not yet running / no activity: the plain red CircleStop (rest state).
 */
function StopButtonIcon({ isThinking, isIdle }: { isThinking: boolean; isIdle: boolean }): ReactNode {
  if (isThinking) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-emerald-400 animate-spin [stroke-dasharray:47_16]" />
        <StopSquare colorClass="bg-emerald-400" />
      </span>
    );
  }
  if (isIdle) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-amber-400" />
        <StopSquare colorClass="bg-amber-400" />
      </span>
    );
  }
  return <CircleStop size={18} />;
}

interface CommandTerminalWindowProps {
  managedWindow: ManagedWindow;
  /** True while the frame is maximized (driven by the window store). */
  isMaximized: boolean;
  /** Pointer-down on the header drag handle; starts the window drag. */
  titleBarPointerDown: (event: React.PointerEvent) => void;
}

export function CommandTerminalWindow({ managedWindow, isMaximized, titleBarPointerDown }: CommandTerminalWindowProps) {
  const windowId = managedWindow.id;
  const useStore = useLayerStore();
  const toggleMaximizeWindow = useStore((state) => state.toggleMaximizeWindow);
  const { hideLayer } = useCommandTerminalLayer();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const config = useConfigStore((s) => s.config);
  const rawProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // Resolve to the main repo root if the current project is a worktree.
  const projectPath = useMemo(() => (rawProjectPath ? resolveProjectRoot(rawProjectPath) : null), [rawProjectPath]);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(COMMAND_TERMINAL_ENTITY_ID));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);
  const handleToggleChanges = useCallback(() => toggleChangesOpen(COMMAND_TERMINAL_ENTITY_ID), [toggleChangesOpen]);

  const maximizeCombo = useFormattedCombo('panel.maximize');
  const closeCombo = useFormattedCombo('panel.close');
  const spawnedRef = useRef(false);
  const commandButtonRef = useRef<HTMLDivElement>(null);

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const transientLabel = useSessionStore((state) =>
    projectId ? state.transientSessions[projectId]?.label ?? null : null,
  );

  // Spawn the transient session on mount, or reattach to an existing one (the PTY
  // survives a layer hide, so reopening reattaches instead of respawning).
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    const state = useSessionStore.getState();
    const existingSessionId = state.transientSessionId;
    if (existingSessionId) {
      setSessionId(existingSessionId);
      setBranch(state.transientBranch);
      setTerminalReady(true);
      return;
    }

    state.spawnTransientSession()
      .then((result) => {
        setSessionId(result.session.id);
        setBranch(result.branch);
        if (result.checkoutError) {
          useToastStore.getState().addToast({ message: result.checkoutError, variant: 'warning' });
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast({ message, variant: 'error' });
        hideLayer();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for Claude Code's TUI to activate (alternate screen buffer detected) or
  // usage data to arrive before mounting xterm, so the scrollback contains the
  // clean TUI rather than shell noise.
  const hasFirstOutput = useSessionStore((state) => (sessionId ? !!state.sessionFirstOutput[sessionId] : false));
  const hasUsage = useSessionStore((state) => (sessionId ? !!state.sessionUsage[sessionId] : false));
  const hasSessionStarted = hasFirstOutput || hasUsage;
  // On an HMR remount, skip the shimmer when reattaching to a live transient
  // session (otherwise useState(false) would flash the launch overlay).
  const [terminalReady, setTerminalReady] = useState(() => {
    if (!getIsHmrReload()) return false;
    return !!useSessionStore.getState().transientSessionId;
  });

  useEffect(() => {
    if (hasSessionStarted && !terminalReady) setTerminalReady(true);
  }, [hasSessionStarted, terminalReady]);

  // Lift the shimmer if the session exits before usage arrives.
  useEffect(() => {
    if (!sessionId || terminalReady) return;
    const cleanup = window.electronAPI.sessions.onExit((exitSessionId) => {
      if (exitSessionId === sessionId) setTerminalReady(true);
    });
    return cleanup;
  }, [sessionId, terminalReady]);

  // Only pass sessionId to useTerminal once ready, so xterm does not init and
  // fetch noisy scrollback before Claude Code's TUI is drawn.
  const effectiveSessionId = terminalReady ? sessionId : null;

  // The transient session's activity, surfaced as the Stop button's ring (the
  // command-terminal counterpart to the task-detail pause button). Classified via
  // the shared idle-vs-active helpers, never inline literals. Gated on the session
  // having started so the ring only shows for a live session.
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const sessionRunning = terminalReady && !!sessionId;
  const isThinking = sessionRunning && isActive(activity);
  const isIdle = sessionRunning && requiresUserInteraction(activity);
  const showActivityRing = isThinking || isIdle;

  const commandTerminalShell = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessions.find((session) => session.id === sessionId)?.shell : undefined,
      [sessionId],
    ),
  );

  const { terminalRef, initTerminal, fit, focus } = useTerminal({
    sessionId: effectiveSessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    scrollbackLines: config.terminal.scrollbackLines,
    cursorStyle: config.terminal.cursorStyle,
    shellName: commandTerminalShell ?? undefined,
  });

  const fileDrop = useTerminalFileDrop(effectiveSessionId, focus, commandTerminalShell ?? undefined);

  // Init the terminal once the session is ready AND the container has dimensions.
  const initialized = useRef(false);
  useEffect(() => {
    if (!effectiveSessionId) return;
    const element = terminalRef.current;
    if (!element) return;

    const tryInit = () => {
      if (initialized.current) return;
      if (element.offsetWidth > 0 && element.offsetHeight > 0) {
        initTerminal();
        initialized.current = true;
        fit();
        focus();
      }
    };

    tryInit();

    let observer: ResizeObserver | null = null;
    if (!initialized.current) {
      observer = new ResizeObserver(() => {
        tryInit();
        if (initialized.current) observer?.disconnect();
      });
      observer.observe(element);
    }

    return () => {
      observer?.disconnect();
      initialized.current = false;
    };
  }, [effectiveSessionId, initTerminal, terminalRef, fit, focus]);

  // Refit when the frame's settled size changes. The engine commits a drag/resize/
  // maximize/snap/tile geometry ONCE and dispatches a single coalesced
  // `terminal-panel-resize`; the xterm is never remounted, so fitting in place is
  // all that is needed.
  useEffect(() => {
    const onPanelResize = () => {
      if (initialized.current) fit();
    };
    window.addEventListener('terminal-panel-resize', onPanelResize);
    return () => window.removeEventListener('terminal-panel-resize', onPanelResize);
  }, [fit]);

  // Refit when the changes panel toggles (the terminal column width changes).
  useEffect(() => {
    if (initialized.current) requestAnimationFrame(() => fit());
  }, [changesOpen, fit]);

  // Restore terminal focus after a maximize/restore toggle (the button, Ctrl+Shift+M,
  // and the header double-click all flip `isMaximized`), so the next keystroke lands
  // in the terminal instead of the maximize button. The command terminal OWNS the
  // xterm focus, so call `focus()` directly. Mirrors TaskDetailWindow's re-homing of
  // the PR #33 fix; keys on the maximize toggle (not `terminal-panel-resize`, which
  // also fires on drag/resize) and skips the initial mount.
  const wasMaximizedRef = useRef(isMaximized);
  useEffect(() => {
    if (wasMaximizedRef.current === isMaximized) return;
    wasMaximizedRef.current = isMaximized;
    if (initialized.current) focus();
  }, [isMaximized, focus]);

  // Restore keyboard focus to the terminal after a maximize/restore toggle, so the
  // next keystroke lands in the terminal instead of the maximize button (the button
  // takes DOM focus when clicked; the panel.maximize keybinding and the header
  // double-click also flip `isMaximized`). Keyed on `isMaximized`, deliberately NOT
  // on `terminal-panel-resize` (which also fires on drag/snap/tile and would steal
  // focus then).
  useEffect(() => {
    if (initialized.current) focus();
  }, [isMaximized, focus]);

  const defaultBranch = config.git.defaultBaseBranch || 'main';

  // Kill the current session, checkout the new branch, and respawn.
  const handleBranchChange = useCallback(async (newBranch: string) => {
    const resolvedBranch = newBranch || defaultBranch;
    try {
      await useSessionStore.getState().killTransientSession();
      setSessionId(null);
      setTerminalReady(false);
      initialized.current = false;
      const result = await useSessionStore.getState().spawnTransientSession(resolvedBranch);
      setSessionId(result.session.id);
      setBranch(result.branch);
      if (result.checkoutError) {
        useToastStore.getState().addToast({ message: result.checkoutError, variant: 'warning' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useToastStore.getState().addToast({ message, variant: 'error' });
    }
  }, [defaultBranch]);

  // Stop = destroy this terminal's PTY, then hide the layer.
  const handleTerminate = useCallback(async () => {
    try {
      await useSessionStore.getState().killTransientSession();
    } catch {
      // Best-effort cleanup.
    }
    hideLayer();
  }, [hideLayer]);

  const handleCommandSelect = useCallback((command: AgentCommand) => {
    setShowCommandPalette(false);
    if (!sessionId) return;
    window.electronAPI.sessions.write(sessionId, command.displayName + '\n');
  }, [sessionId]);

  const handleShortcutExecute = useCallback((action: { command: string }) => {
    const cwd = projectPath ?? '';
    const resolved = resolveShortcutCommand(action.command, {
      cwd,
      branchName: branch ?? '',
      taskTitle: '',
      projectPath: cwd,
    });
    window.electronAPI.shell.exec(resolved, cwd);
  }, [projectPath, branch]);

  const handleToggleMaximized = useCallback(() => toggleMaximizeWindow(windowId), [toggleMaximizeWindow, windowId]);

  // Maximize hotkey (mirrors the task-detail window). Capture phase so it beats
  // the embedded xterm's control-char handling. Layer hide (panel.close) is bound
  // once by the layer's bridge, so it is not re-bound here.
  useKeybinding('panel.maximize', () => handleToggleMaximized(), { capture: true });

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="command-terminal-window">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-edge flex-shrink-0 select-none">
        <button
          onClick={handleTerminate}
          className={`inline-flex items-center justify-center p-1 rounded-full transition-colors flex-shrink-0 ${
            showActivityRing ? 'hover:bg-surface-hover' : 'text-red-400 hover:bg-red-400/10'
          }`}
          title="Stop terminal"
          aria-label="Stop terminal"
          data-testid="command-bar-terminate-button"
        >
          <StopButtonIcon isThinking={isThinking} isIdle={isIdle} />
        </button>
        {/* Drag handle: the title region. Double-click toggles maximize. */}
        <div
          className="flex-1 min-w-0 cursor-grab active:cursor-grabbing"
          onPointerDown={titleBarPointerDown}
          onDoubleClick={handleToggleMaximized}
        >
          <span
            className="text-base font-semibold text-fg truncate"
            title={transientLabel ?? 'Command Terminal'}
            data-testid="command-bar-label"
          >
            {transientLabel ?? 'Command Terminal'}
          </span>
        </div>
        <BranchPicker
          value={branch || ''}
          defaultBranch={defaultBranch}
          onChange={handleBranchChange}
        />

        {/* Action pills */}
        <div className={`flex items-center flex-wrap gap-3 min-w-0${showCommandPalette ? '' : ' overflow-hidden max-h-7'}`}>
          <div className="relative flex-shrink-0" ref={commandButtonRef}>
            <Pill
              shape="square"
              onClick={() => setShowCommandPalette(!showCommandPalette)}
              className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors"
              title="Run a command or skill"
              data-testid="command-bar-commands-button"
            >
              <SquareChevronRight size={14} />
              Commands
            </Pill>
            {showCommandPalette && (
              <CommandPalettePopover
                triggerRef={commandButtonRef}
                cwd={projectPath ?? undefined}
                onSelect={handleCommandSelect}
                onClose={() => setShowCommandPalette(false)}
              />
            )}
          </div>

          {projectPath && (
            <Pill
              shape="square"
              onClick={() => window.electronAPI.shell.openPath(projectPath)}
              className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={projectPath}
              data-testid="command-bar-folder-button"
            >
              <FolderOpen size={14} />
              Project
            </Pill>
          )}

          {projectPath && (
            <Pill
              shape="square"
              onClick={handleToggleChanges}
              className={`flex-shrink-0 transition-colors border ${
                changesOpen
                  ? 'bg-accent/15 text-accent-fg border-accent/30'
                  : 'bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover border-transparent'
              }`}
              title={changesOpen ? 'Hide changes' : 'Show changes'}
              data-testid="command-bar-changes-toggle"
            >
              <GitCompare size={14} />
              Changes
            </Pill>
          )}

          {headerShortcuts.map((action) => {
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <Pill
                key={action.id ?? action.label}
                shape="square"
                onClick={() => handleShortcutExecute(action)}
                className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={action.command}
                data-testid={`command-bar-shortcut-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <ActionIcon size={14} />
                {action.label}
              </Pill>
            );
          })}
        </div>

        {/* Kebab menu */}
        <KebabMenu>
          {(close) => (
            <>
              {projectPath && (
                <KebabMenuItem
                  icon={<FolderOpen size={14} />}
                  label="Open folder"
                  onClick={() => { close(); window.electronAPI.shell.openPath(projectPath); }}
                />
              )}
              <KebabMenuItem
                icon={<SquareChevronRight size={14} />}
                label="Commands"
                onClick={() => { close(); setShowCommandPalette(true); }}
              />
              {projectPath && (
                <KebabMenuItem
                  icon={<GitCompare size={14} />}
                  label={changesOpen ? 'Hide changes' : 'Show changes'}
                  onClick={() => { close(); handleToggleChanges(); }}
                />
              )}
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
                        onClick={() => { close(); handleShortcutExecute(action); }}
                        data-testid={`command-bar-kebab-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                      />
                    );
                  })}
                </>
              )}
              <KebabMenuDivider />
              <KebabMenuItem
                icon={<CircleStop size={14} />}
                label="Stop terminal"
                onClick={() => { close(); handleTerminate(); }}
                destructive
                data-testid="command-bar-kebab-stop"
              />
            </>
          )}
        </KebabMenu>

        <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
        <button
          onClick={handleToggleMaximized}
          className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
          title={`${isMaximized ? 'Restore' : 'Maximize'} (${maximizeCombo})`}
          aria-label={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
          data-testid="command-bar-maximize"
        >
          {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          onClick={hideLayer}
          className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
          title={`Hide terminal (${closeCombo})`}
          aria-label="Hide terminal"
          data-testid="command-bar-hide"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="relative flex flex-1 min-h-0">
        {/* Terminal */}
        <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} relative`} style={{ backgroundColor: '#18181b' }}>
          {!terminalReady && <LaunchOverlay label="Starting Command Terminal..." />}
          <FileDropOverlay {...fileDrop} />
          <div
            ref={terminalRef}
            className="h-full"
            data-testid="command-bar-terminal"
          />
        </div>

        {/* Changes panel */}
        {changesOpen && projectPath && (
          <div className="w-1/2 min-h-0 border-l border-edge">
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={20} className="animate-spin text-fg-muted" />
                </div>
              }
            >
              <ChangesPanel
                entityId={COMMAND_TERMINAL_ENTITY_ID}
                projectPath={projectPath}
                baseBranch="HEAD"
              />
            </Suspense>
          </div>
        )}
      </div>

      {sessionId && <ContextBar sessionId={sessionId} agentFallback={projectAgent} />}
    </div>
  );
}
