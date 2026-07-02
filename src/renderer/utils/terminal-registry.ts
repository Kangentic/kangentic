// A registry of mounted xterm terminals keyed by their container element, so
// the main-process context-menu handler can hit-test a right-click against the
// terminal under the cursor (via a window-global QUERY function) without any new
// IPC channel. Actions still travel back as CustomEvents; this global only
// answers "is there a block here, and what kind" so the menu can decide whether
// to show a "Copy Block" item.
import type { Terminal } from '@xterm/xterm';
import { blockKindAtPoint } from './terminal-block-buffer';
import type { BlockKind } from './terminal-blocks';
import { useConfigStore } from '../stores/config-store';

/** Result of probing a client point for a copyable terminal block. */
export interface TerminalBlockHitTestResult {
  isTerminal: boolean;
  blockKind: BlockKind | null;
}

// Live terminals keyed by their container element. Preserved across HMR (Pattern
// A in .claude/rules/hmr-patterns.md) so a hot edit of this module does not
// orphan terminals that the previous module instance registered.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const registeredTerminals: Map<HTMLElement, Terminal> = import.meta.hot?.data?.registeredTerminals ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.registeredTerminals = registeredTerminals;
  });
}

/** Register a mounted terminal and its container. Returns an unregister function. */
export function registerTerminal(terminal: Terminal, container: HTMLElement): () => void {
  registeredTerminals.set(container, terminal);
  return () => {
    if (registeredTerminals.get(container) === terminal) {
      registeredTerminals.delete(container);
    }
  };
}

/** Find the registered terminal whose container contains a client point. */
export function findTerminalAt(clientX: number, clientY: number): Terminal | null {
  for (const [container, terminal] of registeredTerminals) {
    const rect = container.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return terminal;
    }
  }
  return null;
}

/** Answer whether a client point lands on a terminal and, if so, on a block. */
export function hitTestTerminalBlock(clientX: number, clientY: number): TerminalBlockHitTestResult {
  // Stand down entirely when the user has disabled the block-copy affordance.
  if (!useConfigStore.getState().config.terminalBlockCopy) return { isTerminal: false, blockKind: null };
  const terminal = findTerminalAt(clientX, clientY);
  if (!terminal) return { isTerminal: false, blockKind: null };
  return { isTerminal: true, blockKind: blockKindAtPoint(terminal, clientX, clientY) };
}

declare global {
  interface Window {
    __kangenticTerminalBlockHitTest?: (clientX: number, clientY: number) => TerminalBlockHitTestResult;
  }
}

// Expose the hit-test as a window global for the main-process context-menu
// probe (executeJavaScript). A module re-eval under HMR simply re-points it at
// the new function, which reads the preserved registry, so no cleanup is needed.
window.__kangenticTerminalBlockHitTest = hitTestTerminalBlock;
