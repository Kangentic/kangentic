import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';

interface NameFromPromptButtonProps {
  /** Description (or other prompt text) used as the source for summarization. */
  description: string;
  /** Callback invoked with the suggested title when summarization succeeds. */
  onTitle: (title: string) => void;
}

/**
 * Returns true when the "Name from prompt" affordance should be visible:
 * the active project's default agent is detected and exposes the summarize
 * capability, and `description` is non-empty.
 *
 * Exposed separately from `<NameFromPromptButton>` so callers can size their
 * title input (e.g. add right padding) without duplicating the gating logic.
 */
export function useNameFromPromptAvailable(description: string): boolean {
  const agentList = useConfigStore((s) => s.agentList);
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);

  const summarizeAvailable = useMemo(() => {
    if (!projectAgent) return false;
    const adapter = agentList.find((entry) => entry.name === projectAgent);
    return !!adapter?.found && !!adapter?.supportsSummarize;
  }, [agentList, projectAgent]);

  if (!summarizeAvailable) return false;
  if (description.trim().length === 0) return false;
  return true;
}

/**
 * Renders a square icon button (Sparkles) that calls the active project's agent
 * adapter via `agent.summarize` and pipes the result back through `onTitle`.
 * Returns `null` when the affordance is unavailable (see useNameFromPromptAvailable).
 *
 * Sized to sit alongside a title input in a horizontal flex row (NOT inside it):
 * the button is 32x32 and matches the input's vertical rhythm.
 */
export function NameFromPromptButton({ description, onTitle }: NameFromPromptButtonProps): ReactElement | null {
  const available = useNameFromPromptAvailable(description);
  const [isPending, setIsPending] = useState(false);
  // Track unmount via ref so a late-arriving summarize result doesn't call setState
  // on an unmounted component or invoke onTitle on a dialog the user already closed.
  // We set the flag inside the effect (not just on initial render) because React
  // StrictMode in development synthetically remounts components, and a ref-init
  // value alone would be left false after the synthetic cleanup.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleClick = useCallback(async () => {
    const promptText = description.trim();
    if (!promptText || isPending) return;
    setIsPending(true);
    try {
      const result = await window.electronAPI.agent.summarize({ prompt: promptText });
      if (!mountedRef.current) return;
      if (result.ok) {
        onTitle(result.title);
      } else {
        useToastStore.getState().addToast({
          message: `Could not generate title: ${result.reason}`,
          variant: 'warning',
        });
      }
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      useToastStore.getState().addToast({
        message: `Could not generate title: ${message}`,
        variant: 'error',
      });
    } finally {
      if (mountedRef.current) setIsPending(false);
    }
  }, [description, isPending, onTitle]);

  if (!available) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      data-testid="name-from-prompt-button"
      aria-label="Generate a title from the description"
      title="Generate a title from the description"
      // `surface-control`, matching the title input beside it (see
      // FIELD_CONTROL_BASE in `Field.tsx` for why the token exists). Hover stays
      // border + text only: the fill can sit at or past `surface-hover`, so a bg
      // swap there would be invisible or inverted.
      className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 text-fg-muted hover:text-accent-fg bg-surface-control border border-edge-input hover:border-accent rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
    </button>
  );
}
