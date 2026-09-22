import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { enableTerminalClipboard } from '../../src/renderer/utils/terminal-clipboard';
import { useAgentDriveStore } from '../../src/renderer/stores/agent-drive-store';

/**
 * Ctrl+C in a terminal releases that session's Browser drive veil LOCALLY,
 * without waiting for the activity engine to agree.
 *
 * Measured end to end against a live agent: 3067ms from the keypress to the
 * veil clearing. That is `UserInterruptCoordinator`'s 3000ms settle window,
 * which exists so the engine gives the agent's own `PostToolUseFailure` /
 * `Stop` hooks a chance to fire before it force-idles a session that may
 * still be working. Correct for the engine, and far too long for this veil,
 * which SWALLOWS THE POINTER - three seconds of "I pressed stop and my own
 * browser is still dead" is the complaint the release path exists to answer.
 *
 * Why the gap is that large is worth keeping: interrupting DURING a tool call
 * fires `PostToolUseFailure` with `is_interrupt` and idles at once, while
 * interrupting BETWEEN calls fires no hook at all. A call runs ~300ms out of
 * every ~2s, so the slow path is the common one, which is why it presented as
 * intermittent.
 *
 * This lives in the unit tier rather than beside the other veil cases in
 * `tests/ui/browser-pane-agent-input-focus.spec.ts` because that spec's
 * terminals are hand-rolled `<input class="xterm-helper-textarea">` elements
 * with no xterm behind them, so xterm's custom key handler is never attached
 * and the gesture cannot be driven there at all. Here the real handler is
 * captured and called directly.
 */

type KeyEventHandler = (event: KeyboardEvent) => boolean;

function captureKeyHandler(sessionId: string | undefined): KeyEventHandler {
  let handler: KeyEventHandler | null = null;
  const terminal = {
    attachCustomKeyEventHandler: (keyEventHandler: KeyEventHandler) => { handler = keyEventHandler; },
    parser: { registerOscHandler: () => ({ dispose() { /* noop */ } }) },
    hasSelection: () => false,
    getSelection: () => '',
    cols: 80,
  } as unknown as Terminal;

  const element = {
    querySelector: () => null,
    addEventListener: () => undefined,
    matches: () => false,
  } as unknown as HTMLElement;

  // Positional: (terminal, el, onWrite, shellName, sessionId, ...).
  enableTerminalClipboard(terminal, element, vi.fn(), undefined, sessionId);
  if (!handler) throw new Error('key handler was not registered');
  return handler;
}

function ctrlC(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'c',
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    type: 'keydown',
    ...overrides,
  } as KeyboardEvent;
}

const SESSION = 'sess-interrupt';

/** The unit tier runs in node, so there is no `window` until one is made. */
const globals = globalThis as unknown as { window?: { electronAPI?: unknown } };
let notifyUserInterrupt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAgentDriveStore.setState({ drivingSessionIds: [], userInterrupts: {} });
  notifyUserInterrupt = vi.fn(() => Promise.resolve());
  globals.window = { electronAPI: { sessions: { notifyUserInterrupt } } };
});

describe('Ctrl+C releases the drive veil without the engine', () => {
  it('counts the interrupt for that session', () => {
    const handler = captureKeyHandler(SESSION);

    handler(ctrlC());

    expect(useAgentDriveStore.getState().userInterrupts[SESSION]).toBe(1);
  });

  it('counts a SECOND press, because a repeat is a second intent', () => {
    // A counter rather than a flag: the user pressing Ctrl+C again after the
    // agent kept going has to register, and there is no sensible moment to
    // reset a flag.
    const handler = captureKeyHandler(SESSION);

    handler(ctrlC());
    handler(ctrlC());

    expect(useAgentDriveStore.getState().userInterrupts[SESSION]).toBe(2);
  });

  it('still signals the engine, which owns the session state', () => {
    // The local release is an addition, not a replacement. The engine is what
    // moves the session out of `thinking` for the board, the monitor and the
    // sidebar counts; this only frees the pane.
    const handler = captureKeyHandler(SESSION);

    handler(ctrlC());

    expect(notifyUserInterrupt).toHaveBeenCalledWith(SESSION);
  });

  it('leaves other sessions alone', () => {
    const handler = captureKeyHandler(SESSION);

    handler(ctrlC());

    expect(useAgentDriveStore.getState().userInterrupts['sess-other']).toBeUndefined();
  });

  it('ignores Cmd+C, which is copy on macOS and never an interrupt', () => {
    const handler = captureKeyHandler(SESSION);

    handler(ctrlC({ ctrlKey: false, metaKey: true }));

    expect(useAgentDriveStore.getState().userInterrupts[SESSION]).toBeUndefined();
  });

  it('does nothing when the terminal has no session', () => {
    const handler = captureKeyHandler(undefined);

    expect(() => handler(ctrlC())).not.toThrow();
    expect(useAgentDriveStore.getState().userInterrupts).toEqual({});
  });
});
