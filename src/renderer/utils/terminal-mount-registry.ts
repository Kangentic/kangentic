/**
 * Which sessions this renderer currently has an xterm MOUNTED for, published to
 * main as a whole-set replace (`sessions.setMounted`).
 *
 * Why this is not the focused set: focus answers "is the user looking at it",
 * and main uses it to gate PTY data. Mounting answers "is something holding a
 * grid", which is a different question with a harder consequence. A PARKED
 * terminal (Backlog view, a window occluded by a maximized one) is unfocused
 * yet still mounted at its own cols/rows, and xterm re-sends dimensions only
 * when its OWN size changes - so if main reshapes that PTY underneath it, the
 * two disagree with no path back and the reveal replays a frame drawn for a
 * grid the terminal no longer has. Main therefore leaves a MOUNTED session's
 * grid alone (see SessionManager.scheduleRestingGridRestore).
 *
 * Published from the terminals themselves rather than derived from view state:
 * the mount lifecycle is the fact, and every surface that grows a terminal
 * later gets this for free instead of needing another visibility rule.
 *
 * Shipped, unlike the neighbouring dev-only terminal-grid-registry: main
 * depends on this in every build.
 */

/** Refcounted: two panes can legitimately hold the same session (an inactive
 *  panel pane plus a detail window mid-handoff).
 *
 *  Preserved across HMR (Pattern A, mirroring parked-terminals.ts). The
 *  registration lives in initTerminal, which runs once per xterm construction
 *  and never re-runs on a Fast Refresh - so a reset Map here would hold
 *  claims only in the DISCARDED module instance, and the next registration
 *  from the fresh instance would publish a whole-set replace that erased
 *  every still-mounted claim. Main would then read a parked-but-mounted
 *  terminal as unheld and reshape its grid underneath it, which is the exact
 *  state this registry exists to prevent. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const mountedSessionCounts: Map<string, number> = import.meta.hot?.data?.mountedSessionCounts ?? new Map<string, number>();
let publishScheduled = false;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.mountedSessionCounts = mountedSessionCounts;
  });
}

function publishMountedSessions(): void {
  publishScheduled = false;
  window.electronAPI.sessions.setMounted([...mountedSessionCounts.keys()]);
}

/** Coalesced to one message per microtask: a Backlog -> Board switch mounts N
 *  terminals in one commit, and main only cares about the settled set. */
function scheduleMountedPublish(): void {
  if (publishScheduled) return;
  publishScheduled = true;
  queueMicrotask(publishMountedSessions);
}

/** Register a mounted terminal. Returns the release for the mount's cleanup. */
export function registerMountedTerminal(sessionId: string | null): () => void {
  if (!sessionId) return () => { /* session-less pane: no PTY to hold */ };
  mountedSessionCounts.set(sessionId, (mountedSessionCounts.get(sessionId) ?? 0) + 1);
  scheduleMountedPublish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (mountedSessionCounts.get(sessionId) ?? 1) - 1;
    if (remaining > 0) mountedSessionCounts.set(sessionId, remaining);
    else mountedSessionCounts.delete(sessionId);
    scheduleMountedPublish();
  };
}
