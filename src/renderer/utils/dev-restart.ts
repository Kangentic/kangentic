/**
 * The dev restart, for a long `npm start` session to keep up with merges.
 *
 * Vite's HMR delivers renderer code. It cannot deliver main, preload or worker
 * code: `scripts/dev.js` builds those once at boot. So dev.js builds them again
 * in memory whenever their sources change and, when the output differs from
 * the build Electron runs, tells this window over Vite's websocket
 * (`kangentic:main-stale`, see scripts/main-bundle-staleness.js). This module
 * turns that into a persistent toast with a Restart button. The same restart is
 * the `app.restart` hotkey and the root error screen's Restart.
 *
 * A restart suspends every running agent and resumes it after, so it is only
 * ever a button the user presses, never automatic, and it asks first while an
 * agent is in the middle of a turn (`DevRestartController`).
 *
 * Dev only. Every entry point is gated on `__KANGENTIC_DEV__`, and main
 * registers the `app.restart` handler only in a dev build.
 */
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { isActive } from '../../shared/activity-state';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { sharedModuleState } from '../stores/hmr-store-pin';
import { describeIpcError, asSentence } from '../lib/ipc-error';

interface DevRestartModuleState {
  /** The "Main process changed" toast on screen, if any. */
  toastId: string | null;
  /** The stale list the user closed the toast on, so the same list does not
   *  raise it again; a different list does. */
  dismissedFor: string | null;
  /** Asks before a restart while an agent is working. Set by the mounted
   *  `DevRestartController`; without one the restart runs at once. Its
   *  presence is also what says this is the main window, the one that shows
   *  the notice. */
  requester: (() => void) | null;
  /** dev.js's latest answer, applied when the controller mounts. */
  latestStaleBundles: string[];
}

// Pure so a production build, where nothing renders the controller, drops the
// whole module instead of keeping this one call.
const devRestartModuleState = /* @__PURE__ */ sharedModuleState<DevRestartModuleState>(
  // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
  import.meta.hot?.data,
  'devRestartModuleState',
  () => ({ toastId: null, dismissedFor: null, requester: null, latestStaleBundles: [] }),
);

/** The Vite events scripts/dev.js speaks (scripts/main-bundle-staleness.js). */
const MAIN_STALE_EVENT = 'kangentic:main-stale';
const MAIN_STALE_QUERY_EVENT = 'kangentic:main-stale-query';

interface ViteHotChannel {
  on: (event: string, listener: (data: unknown) => void) => void;
  send: (event: string, data?: unknown) => void;
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const viteHot: ViteHotChannel | undefined = import.meta.hot;

function staleBundlesOf(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const bundles = (data as { bundles?: unknown }).bundles;
  return Array.isArray(bundles) ? bundles.filter((bundle): bundle is string => typeof bundle === 'string') : [];
}

// Registered at module scope, never in a React effect: each evaluation of a
// module gets a new hot context, and Vite drops every listener the old one
// registered (vite/client's HMRContext constructor). A listener added from an
// effect was lost the first time a store edit re-ran this module, and the
// notice never showed. Each evaluation registers its own and asks for the
// current answer, which also catches a window that loads after the change.
if (__KANGENTIC_DEV__ && viteHot) {
  viteHot.on(MAIN_STALE_EVENT, (data) => {
    devRestartModuleState.latestStaleBundles = staleBundlesOf(data);
    // Only the main window, where the controller is mounted, shows it.
    if (devRestartModuleState.requester) reportMainStale(devRestartModuleState.latestStaleBundles);
  });
  viteHot.send(MAIN_STALE_QUERY_EVENT);
}

/** Sessions whose agent is in the middle of a turn, which a restart interrupts. */
export function countWorkingAgents(): number {
  const { sessions, sessionActivity } = useSessionStore.getState();
  return sessions.filter((session) => session.status === 'running' && isActive(sessionActivity[session.id])).length;
}

/** Restart now. A rejection (a main from before the restart channel existed, or
 *  a restart file it could not write) shows the raw error. */
export async function performDevRestart(): Promise<void> {
  try {
    await window.electronAPI.app.restart();
  } catch (error) {
    useToastStore.getState().addToast({
      title: i18n._(msg`Couldn't restart Kangentic`),
      message: asSentence(describeIpcError(error)),
      variant: 'error',
    });
  }
}

/** The one restart entry point the toast and the hotkey call. */
export function requestDevRestart(): void {
  const requester = devRestartModuleState.requester;
  if (requester) requester();
  else void performDevRestart();
}

/** Installs the confirm step and shows dev.js's latest answer; returns the
 *  uninstall. */
export function setDevRestartRequester(requester: () => void): () => void {
  devRestartModuleState.requester = requester;
  reportMainStale(devRestartModuleState.latestStaleBundles);
  return () => {
    if (devRestartModuleState.requester === requester) devRestartModuleState.requester = null;
  };
}

/** dev.js's answer: the bundles whose build on disk no longer matches the one
 *  running. A non-empty list shows the toast, an empty one (a restart, or the
 *  change reverted) takes it down. */
export function reportMainStale(staleBundles: readonly string[]): void {
  const toastStore = useToastStore.getState();
  if (staleBundles.length === 0) {
    devRestartModuleState.dismissedFor = null;
    if (devRestartModuleState.toastId !== null) toastStore.dismissToast(devRestartModuleState.toastId);
    devRestartModuleState.toastId = null;
    return;
  }
  const signature = [...staleBundles].sort().join('\n');
  const toastStillShown = devRestartModuleState.toastId !== null
    && toastStore.toasts.some((toast) => toast.id === devRestartModuleState.toastId);
  if (toastStillShown || devRestartModuleState.dismissedFor === signature) return;
  devRestartModuleState.toastId = toastStore.addToast({
    title: i18n._(msg`Main process changed`),
    message: i18n._(msg`Agents pause during a restart and resume after.`),
    variant: 'info',
    persistent: true,
    action: { label: i18n._(msg({ message: 'Restart', context: 'Action' })), icon: 'update', onClick: requestDevRestart },
    onDismiss: () => {
      devRestartModuleState.toastId = null;
      devRestartModuleState.dismissedFor = signature;
    },
  });
}
