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
import { Circle, CircleStop, FolderOpen, FolderGit, GitBranch, GitCompare, Loader2, Maximize2, Minimize2, PictureInPicture2, SquareChevronRight, Zap } from 'lucide-react';
import { BranchPicker } from '../dialogs/BranchPicker';
import { LaunchOverlay } from '../LaunchOverlay';
import { HeaderActionButton } from '../HeaderActionButton';
import { KebabMenu, KebabMenuItem, KebabMenuDivider } from '../KebabMenu';
import { CommandPalettePopover } from '../dialogs/task-detail/CommandPalettePopover';
import { useHeaderPillOverflow, type HeaderPillSpec } from '../dialogs/task-detail/useHeaderPillOverflow';
import { WindowLayoutMenu } from '../dialogs/WindowLayoutMenu';
import { useTerminal } from '../../hooks/useTerminal';
import { useKeybinding, useFormattedCombo } from '../../hooks/useKeybinding';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { ContextBar } from '../terminal/ContextBar';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { commandTerminalChangesEntityId } from '../../stores/session-store/task-changes-panel-slice';
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
import { PanelErrorBoundary } from '../PanelErrorBoundary';

const ChangesPanel = lazy(() => import('../dialogs/task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

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
 *   - thinking (agent working): a spinning active ring around the stop square.
 *   - idle/permission (needs you): a static attention ring around the stop square.
 *   - not yet running / no activity: the plain red CircleStop (rest state).
 */
function StopButtonIcon({ isThinking, isIdle }: { isThinking: boolean; isIdle: boolean }): ReactNode {
  if (isThinking) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-active animate-spin [stroke-dasharray:47_16]" />
        <StopSquare colorClass="bg-active" />
      </span>
    );
  }
  if (isIdle) {
    return (
      <span className="grid place-items-center">
        <Circle size={20} className="col-start-1 row-start-1 text-attention" />
        <StopSquare colorClass="bg-attention" />
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
  // The window's durable anchor IS its Command Terminal slot id (`slot-1`,
  // `slot-2`, ...). It pairs the persistent window to its ephemeral PTY across
  // hide/reopen and project switches; the transient session is keyed by it.
  const slot = managedWindow.anchor;
  // This window's own Changes-panel entity id (namespaced by slot), so the
  // open flag and per-entity panel state (selected file, scroll, scope, ...)
  // never leak across Command Terminal windows.
  const commandTerminalEntityId = commandTerminalChangesEntityId(slot);
  const useStore = useLayerStore();
  const toggleMaximizeWindow = useStore((state) => state.toggleMaximizeWindow);
  const closeWindow = useStore((state) => state.closeWindow);
  // Window-layout parity with the task-detail window: tile presets, pop-out
  // (untile back to floating), and the multi-window gate for columns/grid.
  const applyTilePreset = useStore((state) => state.applyTilePreset);
  const untileWindow = useStore((state) => state.untileWindow);
  const windowCount = useStore((state) => Object.keys(state.windows).length);
  const isTiled = useStore((state) => state.windows[windowId]?.leafId != null);
  const { hideLayer } = useCommandTerminalLayer();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const config = useConfigStore((s) => s.config);
  const rawProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // Adapter-declared: this agent needs an explicit reference (not a bare path) to
  // reliably read a pasted/dropped image. A transient Command Terminal spawns the
  // project's default agent (see transient-sessions.ts), so resolve the template by
  // projectAgent - the same signal ContextBar's agentFallback and SESSION_INJECT_SETTINGS
  // use here. Never branch on agent name - see .claude/rules/agent-adapters-boundary.md.
  const pasteImageTemplate = useConfigStore(
    (s) => s.agentList.find((a) => a.name === projectAgent)?.pastedImageReferenceTemplate,
  );
  // Resolve to the main repo root if the current project is a worktree.
  const projectPath = useMemo(() => (rawProjectPath ? resolveProjectRoot(rawProjectPath) : null), [rawProjectPath]);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(commandTerminalEntityId));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);
  const handleToggleChanges = useCallback(() => toggleChangesOpen(commandTerminalEntityId), [toggleChangesOpen, commandTerminalEntityId]);

  const maximizeCombo = useFormattedCombo('panel.maximize');
  const spawnedRef = useRef(false);
  const terminalPaneRef = useRef<HTMLDivElement>(null);
  // The branch picker can fold into the kebab; this drives the kebab-anchored
  // fallback dropdown ("Switch branch").
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  // Refs for the measured "priority-plus" header overflow (the title keeps a ~50ch
  // floor; pills reclaim the space above it and fold into the kebab as the window
  // narrows). Mirrors the task-detail header.
  const headerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const titleSpanRef = useRef<HTMLSpanElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // The Commands palette anchors to its pill when visible, else to the kebab (so
  // it still opens after the pill has folded into the overflow menu).
  const kebabWrapRef = useRef<HTMLDivElement>(null);

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  // Quick-access pills fold into the kebab in DESCENDING priority as the window
  // narrows, so the title always wins the space fight (useHeaderPillOverflow).
  const pillSpecs = useMemo<HeaderPillSpec[]>(() => {
    // Commands is kebab-only (a menu, not a one-tap toggle), matching the task-detail header.
    const specs: HeaderPillSpec[] = [];
    if (projectPath) specs.push({ id: 'folder', priority: 40 });
    if (projectPath) specs.push({ id: 'changes', priority: 30 });
    specs.push({ id: 'branch', priority: 25 });
    for (const action of headerShortcuts) specs.push({ id: `shortcut:${action.id ?? action.label}`, priority: 10 });
    return specs;
  }, [projectPath, headerShortcuts]);

  const hiddenPillIds = useHeaderPillOverflow(headerRef, leadingRef, trailingRef, titleSpanRef, pillsRef, pillSpecs);
  const showPill = (id: string) => !hiddenPillIds.has(id);

  // A header-only shortcut that folded must surface in the kebab so the overflow
  // stays the complete action set. The built-in pills (Commands / Open folder /
  // Changes) are always in the kebab already; a 'both'-display shortcut is already
  // a menu shortcut, so it is skipped here.
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

  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const transientLabel = useSessionStore((state) =>
    projectId ? state.transientSessions[transientKey(projectId, slot)]?.label ?? null : null,
  );

  // Spawn this slot's transient session on mount, or reattach to an existing one
  // (the PTY survives a layer hide, so reopening reattaches instead of
  // respawning). Each window owns its (project, slot) session.
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    const state = useSessionStore.getState();
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) {
      hideLayer();
      return;
    }

    const existing = state.transientSessions[transientKey(currentProjectId, slot)];
    if (existing) {
      // Reattach only if the PTY is still alive; a stale map entry (session died
      // while stashed) falls through to a fresh spawn.
      const alive = state.sessions.find((session) => session.id === existing.sessionId && session.status === 'running');
      if (alive) {
        setSessionId(existing.sessionId);
        setBranch(existing.branch);
        setTerminalReady(true);
        return;
      }
    }

    state.spawnTransientSession(slot)
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
        // Drop just this window; the layer's count bridge hides the layer if it
        // was the last one.
        closeWindow(windowId);
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
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) return false;
    // Reattach shimmer-free only if the slot's session is still alive; a stale
    // entry (session died while the layer was hidden, exit event not yet applied)
    // must fall through to the spawn path WITH the shimmer, mirroring the mount
    // effect's alive check below.
    const state = useSessionStore.getState();
    const existing = state.transientSessions[transientKey(currentProjectId, slot)];
    return !!existing && state.sessions.some((session) => session.id === existing.sessionId && session.status === 'running');
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

  const { terminalRef, initTerminal, fit, flushResize, focus } = useTerminal({
    sessionId: effectiveSessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    scrollbackLines: config.terminal.scrollbackLines,
    cursorStyle: config.terminal.cursorStyle,
    shellName: commandTerminalShell ?? undefined,
    pasteImageTemplate,
  });

  const fileDrop = useTerminalFileDrop(effectiveSessionId, focus, commandTerminalShell ?? undefined, pasteImageTemplate);

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
      // fit() reflows xterm; flushResize() lands the PTY SIGWINCH immediately rather
      // than 200ms later, so Claude's redraw arrives with the reflow (no resize
      // flash). Mirrors the task-detail terminal's immediatePanelResize path.
      if (initialized.current) { fit(); flushResize(); }
    };
    window.addEventListener('terminal-panel-resize', onPanelResize);
    return () => window.removeEventListener('terminal-panel-resize', onPanelResize);
  }, [fit, flushResize]);

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

  // Kill this slot's session, checkout the new branch, and respawn it.
  const handleBranchChange = useCallback(async (newBranch: string) => {
    const resolvedBranch = newBranch || defaultBranch;
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) return;
    try {
      await useSessionStore.getState().killTransientSessionBySlot(currentProjectId, slot);
      setSessionId(null);
      setTerminalReady(false);
      initialized.current = false;
      const result = await useSessionStore.getState().spawnTransientSession(slot, resolvedBranch);
      setSessionId(result.session.id);
      setBranch(result.branch);
      if (result.checkoutError) {
        useToastStore.getState().addToast({ message: result.checkoutError, variant: 'warning' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useToastStore.getState().addToast({ message, variant: 'error' });
    }
  }, [defaultBranch, slot]);

  // Stop = destroy THIS terminal's PTY and close its window. The layer's count
  // bridge hides the whole layer when the last window closes. Hiding the layer
  // (the X / Ctrl+Shift+P / backdrop) is separate and keeps every PTY alive.
  const handleTerminate = useCallback(async () => {
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    try {
      if (currentProjectId) {
        await useSessionStore.getState().killTransientSessionBySlot(currentProjectId, slot);
      }
    } catch {
      // Best-effort cleanup.
    }
    closeWindow(windowId);
  }, [closeWindow, windowId, slot]);

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

  // Pop out: evict this terminal from its tile group back to a floating window
  // (the partner stays / collapses to its half). Mirrors the task-detail pop-out.
  const handleUndock = useCallback(() => untileWindow(windowId), [untileWindow, windowId]);

  // Maximize hotkey (mirrors the task-detail window). Capture phase so it beats
  // the embedded xterm's control-char handling. Layer hide (panel.close) is bound
  // once by the layer's bridge, so it is not re-bound here.
  useKeybinding('panel.maximize', () => handleToggleMaximized(), { capture: true });

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="command-terminal-window">
      {/* Header. Priority-plus layout: the title keeps a ~50ch floor; the pills
          reclaim the space above it and fold into the kebab as the window narrows
          (useHeaderPillOverflow). */}
      <div ref={headerRef} className="flex items-center gap-3 px-4 h-[54px] border-b border-edge flex-shrink-0 select-none min-w-0">
        {/* Leading cluster: Stop (protected, measured as one unit). */}
        <div ref={leadingRef} className="flex items-center flex-shrink-0">
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
        </div>

        {/* Title - the overflow calc reserves only a ~50ch floor (not the full
            width), so pills reclaim the space above it; this is also the drag
            handle (double-click toggles maximize). */}
        <div
          className="flex-1 min-w-[64px] truncate cursor-grab active:cursor-grabbing"
          onPointerDown={titleBarPointerDown}
          onDoubleClick={handleToggleMaximized}
        >
          {/* Inline span so its scrollWidth measures the TEXT width (not the
              flex-grown div); useHeaderPillOverflow reserves up to a ~50ch floor
              of that width for the title and lets the pills reclaim the rest. */}
          <span
            ref={titleSpanRef}
            className="text-base font-semibold text-fg truncate"
            title={transientLabel ?? 'Command Terminal'}
            data-testid="command-bar-label"
          >
            {transientLabel ?? 'Command Terminal'}
          </span>
        </div>

        {/* Quick-access pills - each wrapped with `data-pill-id` so the overflow
            calc can measure it; only the ones that fit are rendered. */}
        <div ref={pillsRef} className="flex items-center gap-3 flex-shrink-0">
          {/* Open folder pill - icon-only. The command terminal always runs in the
              project git dir (never a worktree), so the FolderGit glyph matches the
              task-detail no-worktree case; the path shows once the folder opens. */}
          {projectPath && showPill('folder') && (
            <div data-pill-id="folder" className="flex-shrink-0">
              <HeaderActionButton
                icon={FolderGit}
                onClick={() => window.electronAPI.shell.openPath(projectPath)}
                title="Project"
                ariaLabel="Open project folder"
                testId="command-bar-folder-button"
              />
            </div>
          )}

          {projectPath && showPill('changes') && (
            <div data-pill-id="changes" className="flex-shrink-0">
              <HeaderActionButton
                icon={GitCompare}
                onClick={handleToggleChanges}
                active={changesOpen}
                title={changesOpen ? 'Hide changes' : 'Show changes'}
                ariaLabel="Toggle changes"
                testId="command-bar-changes-toggle"
              />
            </div>
          )}

          {showPill('branch') && (
            <div data-pill-id="branch" className="flex-shrink-0">
              <BranchPicker
                value={branch || ''}
                defaultBranch={defaultBranch}
                onChange={handleBranchChange}
              />
            </div>
          )}

          {headerShortcuts.map((action) => {
            const pillId = `shortcut:${action.id ?? action.label}`;
            if (!showPill(pillId)) return null;
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <div key={pillId} data-pill-id={pillId} className="flex-shrink-0">
                <HeaderActionButton
                  icon={ActionIcon}
                  onClick={() => handleShortcutExecute(action)}
                  title={action.command}
                  label={action.label}
                  testId={`command-bar-shortcut-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                />
              </div>
            );
          })}
        </div>

        {/* Trailing window controls (always protected, so they never get clipped):
            kebab, layout menu, pop-out (when tiled), maximize. There is no per-window
            hide/X - Stop destroys this terminal; the backdrop / Ctrl+Shift+W /
            Ctrl+Shift+P hide the whole layer. */}
        <div ref={trailingRef} className="flex items-center gap-3 flex-shrink-0">
          <div ref={kebabWrapRef} className="flex-shrink-0">
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
                  <KebabMenuItem
                    icon={<GitBranch size={14} />}
                    label="Switch branch"
                    onClick={() => { close(); setBranchMenuOpen(true); }}
                    data-testid="command-bar-kebab-switch-branch"
                  />
                  {projectPath && (
                    <KebabMenuItem
                      icon={<GitCompare size={14} />}
                      label={changesOpen ? 'Hide changes' : 'Show changes'}
                      onClick={() => { close(); handleToggleChanges(); }}
                    />
                  )}
                  {overflowMenuShortcuts.length > 0 && (
                    <>
                      <KebabMenuDivider />
                      {overflowMenuShortcuts.map((action) => {
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
          </div>

          {/* Kebab-anchored branch dropdown, shown when the inline branch pill has
              folded into the overflow menu ("Switch branch"). Renders nothing until
              opened. */}
          <BranchPicker
            value={branch || ''}
            defaultBranch={defaultBranch}
            onChange={handleBranchChange}
            hideTrigger
            open={branchMenuOpen}
            onOpenChange={setBranchMenuOpen}
            anchorRef={kebabWrapRef}
          />

          {/* Divider + window controls: tile layout + pop-out (tiled only) +
              maximize. Mirrors TaskDetailHeader's divider placement (right
              after the kebab, before the window-frame cluster). */}
          <div className="w-px h-5 bg-surface-hover flex-shrink-0" />

          <WindowLayoutMenu onApply={applyTilePreset} canTileMultiple={windowCount >= 2} />

          {isTiled && (
            <button
              onClick={handleUndock}
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
              title="Pop out (float)"
              aria-label="Pop out terminal"
              data-testid="command-bar-popout"
            >
              <PictureInPicture2 size={16} />
            </button>
          )}

          <button
            onClick={handleToggleMaximized}
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            title={`${isMaximized ? 'Restore' : 'Maximize'} (${maximizeCombo})`}
            aria-label={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
            data-testid="command-bar-maximize"
          >
            {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>

        {/* Commands palette: rendered once at the header root. Commands is kebab-only
            now (no header pill), so it always anchors to the kebab. */}
        {showCommandPalette && (
          <CommandPalettePopover
            triggerRef={kebabWrapRef}
            cwd={projectPath ?? undefined}
            onSelect={handleCommandSelect}
            onClose={() => setShowCommandPalette(false)}
          />
        )}
      </div>

      {/* Body */}
      <div className="relative flex flex-1 min-h-0">
        {/* Terminal. min-w-0 lets this flex item shrink below the xterm's content
            width when the window narrows; without it `min-width: auto` pins the pane
            to the terminal's column width, so it overflows the window and fit() reads
            the stale (too-wide) size and never reduces columns. overflow-hidden clips
            the brief pre-fit overflow. Mirrors the Changes panel sibling. */}
        <div ref={terminalPaneRef} className={`${changesOpen ? 'w-1/2' : 'flex-1'} relative min-w-0 overflow-hidden`} style={{ backgroundColor: '#18181b' }}>
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
            <PanelErrorBoundary label="Changes panel">
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-full">
                    <Loader2 size={20} className="animate-spin text-fg-muted" />
                  </div>
                }
              >
                <ChangesPanel
                  entityId={commandTerminalEntityId}
                  projectPath={projectPath}
                  baseBranch="HEAD"
                />
              </Suspense>
            </PanelErrorBoundary>
          </div>
        )}
      </div>

      {sessionId && <ContextBar sessionId={sessionId} agentFallback={projectAgent} />}
    </div>
  );
}
