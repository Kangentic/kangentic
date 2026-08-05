import { useAnnouncementsStore } from '../../renderer/stores/announcements-store';
import { useBacklogStore } from '../../renderer/stores/backlog-store';
import { useBoardStore } from '../../renderer/stores/board-store';
import { useConfigStore } from '../../renderer/stores/config-store';
import { useDictationStore } from '../../renderer/stores/dictation-store';
import { useMobileStore } from '../../renderer/stores/mobile-store';
import { useMonitorStore } from '../../renderer/stores/monitor-store';
import { usePopOutStore } from '../../renderer/stores/pop-out-store';
import { useProjectStore } from '../../renderer/stores/project-store';
import { useSessionStore } from '../../renderer/stores/session-store';
import { useToastStore } from '../../renderer/stores/toast-store';
import { useUpdaterStore } from '../../renderer/stores/updater-store';
import { useUsageDashboardStore } from '../../renderer/stores/usage-dashboard-store';
import type { RendererStateSnapshot, StoreStateResult } from '../shared/types';
import { readStoreStateFrom, type ReadableStore } from './store-state';

/**
 * Aggregator for the dev-only `window.__kangenticPreviewSnapshot` global.
 * Reads each Zustand store's current state, sanitizes large arrays
 * (events, transcripts), and returns a single JSON-serializable shape.
 *
 * Heavy fields like `sessionEvents`, `events.jsonl` content, and DnD
 * temp state are excluded - the agent reads those via dedicated MCP
 * tools instead. The snapshot's job is to surface "what is the renderer
 * thinking about right now": active project, dialog state, current task,
 * scroll position, transient sessions, multi-select, recent toasts.
 *
 * `recentToasts` is a ring buffer populated by `install.tsx`'s subscriber
 * on the toast store. Future ring buffers (dialog open/close, renderer
 * IPC errors) can be added with the same pattern when the corresponding
 * subscribers exist.
 */

const RING_SIZE = 50;
const recentToasts: unknown[] = [];

export function pushToastEntry(entry: unknown): void {
  recentToasts.push(entry);
  while (recentToasts.length > RING_SIZE) recentToasts.shift();
}

export function buildPreviewSnapshot(): RendererStateSnapshot {
  return {
    ts: new Date().toISOString(),
    board: summarizeBoard(useBoardStore.getState()),
    session: summarizeSession(useSessionStore.getState()),
    project: useProjectStore.getState(),
    config: useConfigStore.getState(),
    backlog: summarizeBacklog(useBacklogStore.getState()),
    toast: useToastStore.getState(),
    transient: extractTransient(useSessionStore.getState()),
    scroll: { activeScrollY: window.scrollY, pageHeight: document.body?.scrollHeight ?? null },
    focus: {
      activeElementSelector: describeActiveElement(),
      activeElementTag: document.activeElement?.tagName ?? null,
    },
    recentToasts: [...recentToasts],
  };
}

/**
 * Registry of renderer Zustand stores readable via the dev-only
 * `kangentic_devtools_store_state` tool. Adding a store here makes its
 * full state (by name + path) readable from a live `/preview` - this is
 * the one place a new store (e.g. a future window-manager store) must be
 * registered. A unit test (`devtools-preview-stores.test.ts`) asserts
 * every `src/renderer/stores/*-store.ts` is listed so a forgotten entry
 * fails CI instead of silently being unreadable.
 */
const PREVIEW_STORES: Record<string, ReadableStore> = {
  announcements: useAnnouncementsStore,
  backlog: useBacklogStore,
  board: useBoardStore,
  config: useConfigStore,
  dictation: useDictationStore,
  mobile: useMobileStore,
  monitor: useMonitorStore,
  // Quoted because the file stem is kebab-case (pop-out-store.ts); the
  // completeness test matches the key to the filename stem.
  'pop-out': usePopOutStore,
  project: useProjectStore,
  session: useSessionStore,
  toast: useToastStore,
  updater: useUpdaterStore,
  // Quoted because the file stem is kebab-case (usage-dashboard-store.ts);
  // the completeness test matches the key to the filename stem.
  'usage-dashboard': useUsageDashboardStore,
};

/**
 * Read one registered store's state, optionally drilling into `path`.
 * Installed on `window.__kangenticPreviewStoreState` by `install.tsx` and
 * invoked by the inspection server's `/store-state` endpoint.
 */
export function readStoreState(storeName: string, path?: string | null): StoreStateResult {
  return readStoreStateFrom(PREVIEW_STORES, storeName, path);
}

function summarizeBoard(state: unknown): unknown {
  const partial = state as Record<string, unknown>;
  return {
    taskCount: Array.isArray(partial.tasks) ? partial.tasks.length : null,
    swimlaneCount: Array.isArray(partial.swimlanes) ? partial.swimlanes.length : null,
    archivedTaskCount: Array.isArray(partial.archivedTasks) ? partial.archivedTasks.length : null,
    activeView: partial.activeView ?? null,
    boardConfig: partial.boardConfig ?? null,
  };
}

function summarizeSession(state: unknown): unknown {
  const partial = state as Record<string, unknown>;
  const sessions = Array.isArray(partial.sessions) ? partial.sessions : [];
  return {
    sessionCount: sessions.length,
    activeSessionId: partial.activeSessionId ?? null,
    detailTaskId: partial.detailTaskId ?? null,
    dialogSessionIds: partial.dialogSessionIds ?? [],
    scrollToEventKey: partial.scrollToEventKey ?? null,
    seenIdleSessions: partial.seenIdleSessions ?? null,
    latestRateLimits: partial.latestRateLimits ?? null,
  };
}

function summarizeBacklog(state: unknown): unknown {
  const partial = state as Record<string, unknown>;
  return {
    itemCount: Array.isArray(partial.items) ? partial.items.length : null,
    selectedCount: partial.selectedIds instanceof Set ? partial.selectedIds.size : null,
    hydrated: partial.hydrated ?? null,
    showNewDialog: partial.showNewDialog ?? null,
  };
}

function extractTransient(state: unknown): unknown {
  const partial = state as Record<string, unknown>;
  // Transient sessions are stored in a Map; convert to a plain object so
  // it round-trips through Runtime.evaluate's JSON serialization.
  const transient = partial.transientSessions;
  if (transient instanceof Map) {
    const out: Record<string, unknown> = {};
    transient.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return transient ?? null;
}

function describeActiveElement(): string | null {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  if (element instanceof Element) {
    if (element.id) return `#${element.id}`;
    const testId = element.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    return element.tagName.toLowerCase();
  }
  return null;
}
