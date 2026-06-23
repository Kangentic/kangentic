/**
 * Context for the command-terminal window layer. Carries the layer-level "hide"
 * action (Ctrl+Shift+P / Escape / backdrop click) down to a command-terminal
 * WINDOW so its Stop control can kill the PTY and hide the layer, without the
 * window needing to know how the layer is mounted. React context crosses the
 * window-manager's body portal, so a provider above the layer reaches the
 * portaled `CommandTerminalWindow`.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

export interface CommandTerminalLayerContextValue {
  /** Hide the whole command-terminal layer (keeps every PTY alive; reopening
   *  reattaches). Driven by Ctrl+Shift+P / Escape / backdrop click. */
  hideLayer: () => void;
}

const CommandTerminalLayerContext = createContext<CommandTerminalLayerContextValue | null>(null);

export function CommandTerminalLayerProvider({
  hideLayer,
  children,
}: {
  hideLayer: () => void;
  children: ReactNode;
}) {
  // Memoize so the context value keeps a stable identity across re-renders and
  // does not re-render every `useCommandTerminalLayer()` consumer (the heavy
  // `CommandTerminalWindow`) whenever a parent re-renders.
  const value = useMemo<CommandTerminalLayerContextValue>(() => ({ hideLayer }), [hideLayer]);
  return (
    <CommandTerminalLayerContext.Provider value={value}>
      {children}
    </CommandTerminalLayerContext.Provider>
  );
}

export function useCommandTerminalLayer(): CommandTerminalLayerContextValue {
  const value = useContext(CommandTerminalLayerContext);
  if (!value) {
    throw new Error('useCommandTerminalLayer must be used within a CommandTerminalLayerProvider');
  }
  return value;
}
