import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { BranchPicker } from '../dialogs/BranchPicker';
import { ShimmerOverlay } from '../ShimmerOverlay';
import { useTerminal } from '../../hooks/useTerminal';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';

type Phase = 'entering' | 'visible' | 'exiting';

interface CommandBarOverlayProps {
  onClose: () => void;
}

export function CommandBarOverlay({ onClose }: CommandBarOverlayProps) {
  const [phase, setPhase] = useState<Phase>('entering');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const config = useConfigStore((s) => s.config);
  const backdropMouseDown = useRef(false);
  const spawnedRef = useRef(false);

  // Spawn transient session on mount
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    useSessionStore.getState().spawnTransientSession()
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

  const modifierKey = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl';

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
          <div className="flex items-center px-4 py-2.5 border-b border-edge flex-shrink-0">
            <TerminalSquare size={16} className="text-fg-muted mr-2" />
            <span className="text-sm text-fg-muted">Command Terminal</span>
            <div className="ml-3">
              <BranchPicker
                value={branch || ''}
                defaultBranch={defaultBranch}
                onChange={handleBranchChange}
              />
            </div>
            <span className="flex-1" />
            <kbd className="text-xs text-fg-faint bg-surface px-1.5 py-0.5 rounded border border-edge">
              {modifierKey}+Shift+P to close
            </kbd>
          </div>

          {/* Terminal area */}
          <div className="relative h-[60vh]" style={{ backgroundColor: '#18181b' }}>
            {!terminalReady && <ShimmerOverlay label="Starting Command Terminal..." />}
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
