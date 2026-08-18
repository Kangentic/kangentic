import { create } from 'zustand';

/**
 * Which sessions currently have an agent driving their Browser pane.
 *
 * WHY THIS IS A VISUAL CONCERN AT ALL. Driving a page requires clicking it, and
 * a click gives the guest real keyboard focus - there is no way to interact with
 * a page without that. Every attempt to make focus-holding invisible and safe
 * was measured and failed: keystrokes end up on the wrong side, in one direction
 * or the other, because focus is genuinely shared in real time.
 *
 * So the focus move is not hidden, it is SHOWN. The terminal dims, the Browser
 * pane is highlighted, and the user can see where their typing will go instead of
 * discovering it after the fact. The interception remains as the safety net for
 * anyone who types anyway.
 *
 * Keyed by sessionId rather than the guest's webContentsId because the consumers
 * (the terminal side of the split, and the pane itself) are addressed by session;
 * `BrowserPane` owns the translation, since it is the only component that knows
 * both ids.
 */
interface AgentDriveState {
  /** Session ids whose pane an agent is driving right now. */
  drivingSessionIds: string[];
  setAgentDriving: (sessionId: string, driving: boolean) => void;
}

const createAgentDriveStore = () => create<AgentDriveState>((set) => ({
  drivingSessionIds: [],
  setAgentDriving: (sessionId, driving) =>
    set((state) => {
      const isTracked = state.drivingSessionIds.includes(sessionId);
      if (driving === isTracked) return state;
      return {
        drivingSessionIds: driving
          ? [...state.drivingSessionIds, sessionId]
          : state.drivingSessionIds.filter((id) => id !== sessionId),
      };
    }),
}));

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime exports are the non-component hooks, so it is NOT a
// React Fast Refresh boundary. Unpinned, a re-eval builds a SECOND store while
// `BrowserPane`'s subscription effect - keyed on [sessionId], not on the store -
// keeps writing to the first. The drive would then begin, land in an orphaned
// instance, and the terminal would never dim again for the rest of the session.
// Losing the cue silently defeats the point of the feature, which is that the
// focus move is SHOWN (.claude/rules/agent-driven-focus.md).
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedAgentDriveStore: ReturnType<typeof createAgentDriveStore> | undefined = import.meta.hot?.data?.agentDriveStore;

export const useAgentDriveStore = preservedAgentDriveStore ?? createAgentDriveStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.agentDriveStore = useAgentDriveStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // closures; force a clean full reload instead (rare; prod drops this block).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}

// Deliberately NO Pattern A snapshot of `drivingSessionIds`. Preserving it across
// a reload that lands between a drive's begin and end push would show "Agent
// typing here" with no drive underneath it, stuck until the next real drive.
// Resetting costs at most the remainder of one in-flight burst and self-corrects
// on the next begin/end edge. A renderer reload never restarts main, so its
// refcount is untouched: the mirror can lag by one burst, but it cannot stick.

/** True while an agent is driving this session's Browser pane. */
export function useIsAgentDrivingSession(sessionId: string | null | undefined): boolean {
  return useAgentDriveStore((state) =>
    sessionId ? state.drivingSessionIds.includes(sessionId) : false,
  );
}
