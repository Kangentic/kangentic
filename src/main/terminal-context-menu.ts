// Pure helpers for the terminal-aware right-click context menu. The main
// process cannot read xterm's WebGL-rendered content directly, so it probes the
// renderer (via executeJavaScript against a window-global query function) to ask
// whether the click landed on a copyable block, then decides whether to show a
// "Copy Block" item. Kept separate from index.ts so the script building, result
// parsing, and timeout race are unit-testable without Electron.

export type TerminalBlockKind = 'quote' | 'box' | 'text' | 'message';

export interface TerminalBlockProbeResult {
  isTerminal: boolean;
  blockKind: TerminalBlockKind | null;
}

/** Upper bound on how long the menu waits for the renderer probe before opening without the item. */
export const PROBE_TIMEOUT_MS = 100;

const NO_BLOCK: TerminalBlockProbeResult = { isTerminal: false, blockKind: null };

/**
 * A renderer expression that returns `{ isTerminal, blockKind }` for a client
 * point. Coordinates are rounded before interpolation so the built string can
 * only ever contain numbers.
 */
export function buildBlockProbeScript(clientX: number, clientY: number): string {
  const x = Math.round(clientX);
  const y = Math.round(clientY);
  return `(window.__kangenticTerminalBlockHitTest ? window.__kangenticTerminalBlockHitTest(${x}, ${y}) : ({ isTerminal: false, blockKind: null }))`;
}

/** A renderer expression that dispatches the copy-block action for a client point. */
export function buildCopyBlockDispatchScript(clientX: number, clientY: number): string {
  const x = Math.round(clientX);
  const y = Math.round(clientY);
  return `window.dispatchEvent(new CustomEvent('terminal-copy-block', { detail: { x: ${x}, y: ${y} } }))`;
}

/** Validate an unknown probe result into a well-formed shape (defaults to no block). */
export function parseProbeResult(value: unknown): TerminalBlockProbeResult {
  if (!value || typeof value !== 'object') return { ...NO_BLOCK };
  const record = value as Record<string, unknown>;
  const blockKind =
    record.blockKind === 'quote' ||
    record.blockKind === 'box' ||
    record.blockKind === 'text' ||
    record.blockKind === 'message'
      ? record.blockKind
      : null;
  return { isTerminal: record.isTerminal === true, blockKind };
}

/**
 * Probe the renderer for a copyable block under a point. Resolves to "no block"
 * on any error or if the renderer does not answer within PROBE_TIMEOUT_MS, so
 * the worst case is a context menu that opens without the "Copy Block" item.
 */
export async function probeTerminalBlock(
  executeJavaScript: (script: string) => Promise<unknown>,
  clientX: number,
  clientY: number,
): Promise<TerminalBlockProbeResult> {
  try {
    return await Promise.race([
      executeJavaScript(buildBlockProbeScript(clientX, clientY))
        .then(parseProbeResult)
        // Swallow a rejection that lands AFTER the timeout already won the race
        // (webContents navigated / destroyed): the loser promise is otherwise
        // unhandled and would fire spurious app_error telemetry for what is
        // benign, expected behavior of a best-effort bounded probe.
        .catch((): TerminalBlockProbeResult => ({ ...NO_BLOCK })),
      new Promise<TerminalBlockProbeResult>((resolve) => {
        setTimeout(() => resolve({ ...NO_BLOCK }), PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { ...NO_BLOCK };
  }
}
