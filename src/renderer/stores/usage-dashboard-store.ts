import { create } from 'zustand';
import type {
  UsageCustomWindow,
  UsageDashboardStats,
  UsageDayDrill,
  UsageStatsScope,
  UsageStatsScopeKind,
  UsageTimePeriod,
} from '../../shared/types';
import { useConfigStore } from './config-store';
import { useProjectStore } from './project-store';

/**
 * Usage-dashboard store: open state, the persisted range/scope selection, and
 * a stale-while-revalidate payload cache keyed per (scope, project, period) so
 * returning to a previously-viewed range repaints instantly and refreshes in
 * the background (the snappiness contract).
 *
 * Range/scope persistence: runtime state lives here (selection must update
 * instantly), persisted fire-and-forget to global config
 * (`usageStatsPeriod` / `usageStatsScope`, shared across all projects). On
 * boot the store ADOPTS the persisted values from the config store via a
 * subscription until the user first interacts, which closes the old
 * status-bar-period cold-load race (bug #316's second root cause): even if
 * the dashboard opens before `loadConfig()` resolves, the restored selection
 * lands the moment config does, and an open dashboard refetches.
 *
 * HMR: instance-pinned (Pattern E - the only runtime export is the
 * non-component hook) and re-synced via `loadDashboardStats()` in App.tsx's
 * `vite:afterUpdate` handler (Pattern B). tests/unit/hmr-resync.test.ts
 * enforces both; do not rename `loadDashboardStats` without updating it.
 */

export type UsageMetricMode = 'cost' | 'tokens';

/** Serve a cached payload without refetching when it is younger than this. */
const STALE_MS = 15_000;
/** Bound the payload cache (an all-time payload per project could otherwise grow unbounded). */
const MAX_CACHE_ENTRIES = 20;
/** Minimum gap between hover prefetches. */
const PREFETCH_THROTTLE_MS = 5_000;

// In-flight request dedupe, keyed like the cache. Reset on HMR is intentional:
// a dropped dedupe entry just means one extra cheap read.
// hmr-safe: transient in-flight promise dedupe only
const inFlightFetches = new Map<string, Promise<void>>();
// hmr-safe: prefetch throttle timestamp only
let lastPrefetchAtMs = 0;

export interface DashboardCacheEntry {
  payload: UsageDashboardStats;
  fetchedAt: number;
}

export interface UsageDashboardStore {
  statsOpen: boolean;
  period: UsageTimePeriod;
  scopeKind: UsageStatsScopeKind;
  /** Explicitly-viewed project for the 'project' scope; null = follow the
   *  app's current project. Session-only (never persisted): picking another
   *  project in the dashboard is a transient view, and a real project switch
   *  resets it (see onProjectSwitched). */
  viewedProjectId: string | null;
  /** Single-local-day drill-down (chart click). Transient; cleared by a
   *  RANGE change (the period pills are the "back to the full range"
   *  affordance) or a real app project switch. Cycling scope/projects inside
   *  the dashboard PRESERVES it, so one day can be compared across projects. */
  drill: UsageDayDrill | null;
  /** User-picked month window (the "Custom" range picker). Same lifecycle as
   *  drill: period pills / a real project switch clear it, scope cycling
   *  preserves it. Session-only, never persisted. */
  customWindow: UsageCustomWindow | null;
  metric: UsageMetricMode;
  /** True once the user explicitly picked a range/scope this session; stops config adoption. */
  userTouched: boolean;
  cache: Record<string, DashboardCacheEntry>;
  /** Cache key currently displayed (set immediately so cached data paints in the same frame). */
  activeKey: string | null;
  /** True only while fetching a key with NO cache entry (cold load). */
  loading: boolean;
  /** True while background-refreshing a key that already has cached data on screen. */
  refreshing: boolean;
  error: string | null;

  open: () => void;
  close: () => void;
  toggle: () => void;
  setPeriod: (period: UsageTimePeriod) => void;
  setScopeKind: (kind: UsageStatsScopeKind) => void;
  /** View a specific project's stats (project scope) without switching the
   *  app's current project. Pass null to follow the current project again. */
  setViewedProject: (projectId: string | null) => void;
  /** Drill into one local day (or null to return to the base range). */
  setDrill: (drill: UsageDayDrill | null) => void;
  /** Apply a custom month window (or null to return to the quick period). */
  setCustomWindow: (customWindow: UsageCustomWindow | null) => void;
  setMetric: (metric: UsageMetricMode) => void;
  /** Reset transient view state on a real project switch and force-refetch
   *  (the #316 fix path); no-ops the fetch while closed. */
  onProjectSwitched: () => void;
  /** Title-bar hover prefetch: throttled, fetches even while closed. */
  prefetch: () => void;
  /**
   * Fetch the payload for the current (scope, period, project, drill).
   * Dedupes in-flight requests, serves cache under STALE_MS unless `force`,
   * no-ops while closed unless `evenIfClosed`.
   */
  loadDashboardStats: (options?: { force?: boolean; evenIfClosed?: boolean }) => Promise<void>;
}

/** Cache key for one (scope, project, period, drill, window) payload. Exported for tests. */
export function dashboardCacheKey(
  scopeKind: UsageStatsScopeKind,
  projectId: string | null,
  period: UsageTimePeriod,
  drillDayStartMs: number | null = null,
  customWindow: UsageCustomWindow | null = null,
): string {
  const windowSegment = customWindow ? `${customWindow.sinceMs}-${customWindow.untilMs}` : 'full';
  return `${scopeKind}:${scopeKind === 'project' ? projectId ?? 'none' : 'all'}:${period}:${drillDayStartMs ?? 'base'}:${windowSegment}`;
}

/** Insertion-order-evict the cache down to MAX_CACHE_ENTRIES. Exported for tests. */
export function boundCache(
  cache: Record<string, DashboardCacheEntry>,
  maxEntries: number = MAX_CACHE_ENTRIES,
): Record<string, DashboardCacheEntry> {
  const keys = Object.keys(cache);
  if (keys.length <= maxEntries) return cache;
  const bounded: Record<string, DashboardCacheEntry> = {};
  for (const key of keys.slice(keys.length - maxEntries)) {
    bounded[key] = cache[key];
  }
  return bounded;
}

/**
 * The scope actually queried: the explicitly-viewed project when set, else
 * the app's current project. A stored 'project' preference degrades to 'all'
 * when neither exists (welcome screen with no explicit pick) WITHOUT
 * overwriting the stored preference, so opening a project again restores it.
 */
function resolveEffectiveScope(scopeKind: UsageStatsScopeKind, viewedProjectId: string | null): {
  effectiveKind: UsageStatsScopeKind;
  scope: UsageStatsScope;
  projectId: string | null;
} {
  const targetProjectId = viewedProjectId ?? useProjectStore.getState().currentProject?.id ?? null;
  if (scopeKind === 'project' && targetProjectId) {
    return {
      effectiveKind: 'project',
      scope: { kind: 'project', projectId: targetProjectId },
      projectId: targetProjectId,
    };
  }
  return { effectiveKind: 'all', scope: { kind: 'all' }, projectId: null };
}

function createUsageDashboardStore() {
  const store = create<UsageDashboardStore>()((set, get) => ({
    statsOpen: false,
    period: 'live',
    scopeKind: 'project',
    viewedProjectId: null,
    drill: null,
    customWindow: null,
    metric: 'cost',
    userTouched: false,
    cache: {},
    activeKey: null,
    loading: false,
    refreshing: false,
    error: null,

    open: () => {
      if (get().statsOpen) return;
      set({ statsOpen: true });
      // Fetch AFTER the flip so the shell paints first (never block first paint).
      void get().loadDashboardStats();
    },

    close: () => set({ statsOpen: false }),

    toggle: () => {
      if (get().statsOpen) {
        get().close();
      } else {
        get().open();
      }
    },

    setPeriod: (period) => {
      // Same-period clicks still clear an active drill / custom window (the
      // range pills are the natural "back to the full range" affordance).
      if (period === get().period && get().drill === null && get().customWindow === null) return;
      set({ period, drill: null, customWindow: null, userTouched: true });
      window.electronAPI.config.set({ usageStatsPeriod: period });
      void get().loadDashboardStats();
    },

    setScopeKind: (kind) => {
      if (kind === get().scopeKind) return;
      // Deliberately KEEPS an active drill: cycling scope/projects is how one
      // day gets compared across projects; only the period pills clear it.
      set({ scopeKind: kind, userTouched: true });
      window.electronAPI.config.set({ usageStatsScope: kind });
      void get().loadDashboardStats();
    },

    setViewedProject: (projectId) => {
      const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
      set({
        scopeKind: 'project',
        // Normalize "picked the current project" back to follow mode. An
        // active drill is preserved (see setScopeKind).
        viewedProjectId: projectId === currentProjectId ? null : projectId,
        userTouched: true,
      });
      // Only the KIND persists; the specific viewed project is session-only.
      window.electronAPI.config.set({ usageStatsScope: 'project' });
      void get().loadDashboardStats();
    },

    setDrill: (drill) => {
      set({ drill });
      void get().loadDashboardStats();
    },

    setCustomWindow: (customWindow) => {
      // A new window invalidates a drill day picked inside the old one.
      set({ customWindow, drill: null, userTouched: true });
      void get().loadDashboardStats();
    },

    setMetric: (metric) => set({ metric }),

    onProjectSwitched: () => {
      // Transient view state follows the app: a real project switch lands you
      // on the NEW project's stats (base range), never a stale drill or a
      // previously-picked other project. The unconditional force refetch is
      // the #316 fix (same-range switches must still refresh the data).
      set({ viewedProjectId: null, drill: null, customWindow: null });
      void get().loadDashboardStats({ force: true });
    },

    prefetch: () => {
      const now = Date.now();
      if (now - lastPrefetchAtMs < PREFETCH_THROTTLE_MS) return;
      lastPrefetchAtMs = now;
      void get().loadDashboardStats({ evenIfClosed: true });
    },

    loadDashboardStats: async (options) => {
      const state = get();
      if (!state.statsOpen && !options?.evenIfClosed) return;

      const { scope, effectiveKind, projectId } = resolveEffectiveScope(state.scopeKind, state.viewedProjectId);
      const key = dashboardCacheKey(effectiveKind, projectId, state.period, state.drill?.dayStartMs ?? null, state.customWindow);
      const cached = state.cache[key];

      // Point the UI at this key immediately: a cached payload repaints in the
      // same frame; only a truly-cold key shows a loading state.
      set({ activeKey: key, loading: !cached, refreshing: Boolean(cached), error: null });

      if (cached && !options?.force && Date.now() - cached.fetchedAt < STALE_MS) {
        set({ loading: false, refreshing: false });
        return;
      }

      const existing = inFlightFetches.get(key);
      if (existing) {
        await existing;
        return;
      }

      const fetchPromise = (async () => {
        try {
          const payload = await window.electronAPI.usage.getDashboardStats(scope, state.period, state.drill, state.customWindow);
          set((current) => ({
            cache: boundCache({
              ...current.cache,
              [key]: { payload, fetchedAt: Date.now() },
            }),
            ...(current.activeKey === key
              ? { loading: false, refreshing: false, error: null }
              : {}),
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((current) =>
            current.activeKey === key
              ? { loading: false, refreshing: false, error: message }
              : {},
          );
        } finally {
          inFlightFetches.delete(key);
        }
      })();
      inFlightFetches.set(key, fetchPromise);
      await fetchPromise;
    },
  }));

  // Adopt the persisted range/scope from config until the user interacts.
  // Runs once per pinned store instance; closes the cold-load ordering race
  // (config may resolve after an early open - the restored selection is
  // applied the moment it lands, and an open dashboard refetches).
  useConfigStore.subscribe((configState) => {
    const dashboardState = store.getState();
    if (dashboardState.userTouched) return;
    const period = configState.config.usageStatsPeriod ?? configState.config.statusBarPeriod ?? 'live';
    const scopeKind = configState.config.usageStatsScope ?? 'project';
    if (period === dashboardState.period && scopeKind === dashboardState.scopeKind) return;
    store.setState({ period, scopeKind });
    if (dashboardState.statsOpen) {
      void store.getState().loadDashboardStats();
    }
  });

  return store;
}

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component hook, so it is not a Fast
// Refresh boundary; without pinning, a re-eval could hand a second store (and
// a second config subscription) to part of the tree.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedUsageDashboardStore: ReturnType<typeof createUsageDashboardStore> | undefined = import.meta.hot?.data?.usageDashboardStore;

export const useUsageDashboardStore = preservedUsageDashboardStore ?? createUsageDashboardStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.usageDashboardStore = useUsageDashboardStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // closures; force a clean full reload instead (prod drops this whole block).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
