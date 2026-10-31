/**
 * Context for the command-terminal window layer. Carries the layer-level actions
 * down to a command-terminal WINDOW: "hide" (Ctrl+Shift+P / the panel-close
 * combo / backdrop click), and "resume beside" for a resume the window cannot
 * take in place, without the window needing to know how the layer is mounted
 * (or importing it). React
 * context crosses the window-manager's body portal, so a provider above the
 * layer reaches the portaled `CommandTerminalWindow`.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

export interface CommandTerminalLayerContextValue {
  /** Hide the whole command-terminal layer (keeps every PTY alive; reopening
   *  reattaches). Driven by Ctrl+Shift+P / the panel-close combo / backdrop click.
   *  Never by Escape, which the terminal keeps for the agent. */
  hideLayer: () => void;
  /** Resume an earlier conversation in a new terminal beside the others. */
  resumeBeside: (agentSessionId: string) => void;
}

const CommandTerminalLayerContext = createContext<CommandTerminalLayerContextValue | null>(null);

export function CommandTerminalLayerProvider({
  hideLayer,
  resumeBeside,
  children,
}: {
  hideLayer: () => void;
  resumeBeside: (agentSessionId: string) => void;
  children: ReactNode;
}) {
  // Memoize so the context value keeps a stable identity across re-renders and
  // does not re-render every `useCommandTerminalLayer()` consumer (the heavy
  // `CommandTerminalWindow`) whenever a parent re-renders.
  const value = useMemo<CommandTerminalLayerContextValue>(
    () => ({ hideLayer, resumeBeside }),
    [hideLayer, resumeBeside],
  );
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
