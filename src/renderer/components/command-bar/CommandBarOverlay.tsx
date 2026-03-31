import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, FolderOpen, SquareChevronRight, X, Zap } from 'lucide-react';
import { BranchPicker } from '../dialogs/BranchPicker';
import { ShimmerOverlay } from '../ShimmerOverlay';
import { Pill } from '../Pill';
import { KebabMenu, KebabMenuItem, KebabMenuDivider } from '../KebabMenu';
import { CommandPalettePopover } from '../dialogs/task-detail/CommandPalettePopover';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { resolveShortcutCommand } from '../../../shared/template-vars';
import { ICON_REGISTRY } from '../../utils/swimlane-icons';
import { resolveProjectRoot } from '../../../shared/git-utils';
import type { ClaudeCommand } from '../../../shared/types';

type Phase = 'entering' | 'visible' | 'exiting';

interface CommandBarOverlayProps {
  onClose: () => void;
}

export function CommandBarOverlay({ onClose }: CommandBarOverlayProps) {
  const [phase, setPhase] = useState<Phase>('entering');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const config = useConfigStore((s) => s.config);
  const rawProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  // Resolve to the main repo root if the current project is a worktree
  const projectPath = useMemo(() => rawProjectPath ? resolveProjectRoot(rawProjectPath) : null, [rawProjectPath]);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const backdropMouseDown = useRef(false);
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

  // Spawn transient session on mount, or reattach to existing one
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    const state = useSessionStore.getState();
    const existingSessionId = state.transientSessionId;
    if (existingSessionId) {
      // Reattach to existing background session - skip spawn, terminal ready immediately
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
        onClose();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for Claude Code's TUI to activate (alternate screen buffer detected)
  // or usage data to arrive before mounting xterm. This ensures the scrollback
  // buffer contains the clean TUI, not shell noise.
  const hasFirstOutput = useSessionStore((state) => sessionId ? !!state.sessionFirstOutput[sessionId] : false);
  const hasUsage = useSessionStore((state) => sessionId ? !!state.sessionUsage[sessionId] : false);
  const hasSessionStarted = hasFirstOutput || hasUsage;
  const [terminalReady, setTerminalReady] = useState(false);

  // Lift shimmer when TUI activates or usage arrives (Claude Code is ready)
  useEffect(() => {
    if (hasSessionStarted && !terminalReady) setTerminalReady(true);
  }, [hasSessionStarted, terminalReady]);

  // Lift shimmer if session exits before usage arrives
  useEffect(() => {
    if (!sessionId || terminalReady) return;
    const cleanup = window.electronAPI.sessions.onExit((exitSessionId) => {
      if (exitSessionId === sessionId) setTerminalReady(true);
    });
    return cleanup;
  }, [sessionId, terminalReady]);

  // Only pass sessionId to useTerminal once ready - prevents xterm from
  // initializing and fetching noisy scrollback before Claude Code's TUI is drawn.
  const effectiveSessionId = terminalReady ? sessionId : null;

  const { terminalRef, initTerminal, fit, focus } = useTerminal({
    sessionId: effectiveSessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    scrollbackLines: config.terminal.scrollbackLines,
    cursorStyle: config.terminal.cursorStyle,
  });

  const fileDrop = useTerminalFileDrop(effectiveSessionId, focus);

  // Init terminal once session is ready AND container has dimensions.
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
      }
    };

    tryInit();

    let observer: ResizeObserver | null = null;
    if (!initialized.current) {
      observer = new ResizeObserver(() => {
        tryInit();
        if (initialized.current) {
          observer?.disconnect();
        }
      });
      observer.observe(element);
    }

    return () => {
      observer?.disconnect();
      initialized.current = false;
    };
  }, [effectiveSessionId, initTerminal]);

  // Re-fit when phase becomes visible (animation done, container has final dimensions)
  useEffect(() => {
    if (phase === 'visible' && initialized.current) {
      fit();
      focus();
    }
  }, [phase, fit, focus]);

  const defaultBranch = config.git.defaultBaseBranch || 'main';

  // Kill current session, checkout new branch, and respawn
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

  const handleTerminate = useCallback(async () => {
    try {
      await useSessionStore.getState().killTransientSession();
    } catch {
      // Best-effort cleanup
    }
    onClose();
  }, [onClose]);

  const handleCommandSelect = useCallback((command: ClaudeCommand) => {
    setShowCommandPalette(false);
    if (!sessionId) return;
    // Write the command name directly to the running terminal
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

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  const handleAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') onClose();
  };

  const backdropAnimation = phase === 'entering'
    ? 'dialog-backdrop-in 150ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-backdrop-out 100ms ease-in forwards'
      : 'none';

  const contentAnimation = phase === 'entering'
    ? 'command-bar-in 150ms ease-out forwards'
    : phase === 'exiting'
      ? 'command-bar-out 100ms ease-in forwards'
      : 'none';

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50"
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleAnimationEnd}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
      data-testid="command-bar-overlay"
    >
      <div
        className="absolute top-20 left-1/2 -translate-x-1/2 w-[70%] max-w-4xl"
        style={{ animation: contentAnimation }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="bg-surface-raised border border-edge rounded-lg shadow-2xl overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-edge flex-shrink-0">
            <button
              onClick={handleTerminate}
              className="p-1 rounded-full text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0"
              title="Stop terminal"
              aria-label="Stop terminal"
              data-testid="command-bar-terminate-button"
            >
              <CircleStop size={18} />
            </button>
            <span className="text-sm text-fg-muted">Command Terminal</span>
            <BranchPicker
              value={branch || ''}
              defaultBranch={defaultBranch}
              onChange={handleBranchChange}
            />

            {/* Action pills - overflow hidden to clip when header is narrow, but
                disabled when command palette is open so the dropdown isn't clipped */}
            <div className={`flex-1 flex items-center gap-3 min-w-0${showCommandPalette ? '' : ' overflow-hidden'}`}>
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

            {/* Kebab menu + close */}
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
              onClick={requestClose}
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
              title="Hide terminal"
              aria-label="Hide terminal"
            >
              <X size={16} />
            </button>
          </div>

          {/* Terminal area */}
          <div className="relative h-[60vh]" style={{ backgroundColor: '#18181b' }}>
            {!terminalReady && <ShimmerOverlay label="Starting Command Terminal..." />}
            <FileDropOverlay {...fileDrop} />
            <div
              ref={terminalRef}
              className="h-full"
              data-testid="command-bar-terminal"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
