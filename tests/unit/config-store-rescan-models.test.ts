/**
 * Coverage for config-store's `rescanModels()` throttle: a Model dropdown
 * fires a forced `loadAgentList(true)` -> `agents.list(true)` probe on open,
 * fire-and-forget, collapsed by TWO independent guards so repeat opens never
 * spawn concurrent /model probes:
 *  - an in-flight lock (`modelRescanInFlight`) while the current probe's
 *    promise is still unresolved;
 *  - a 60s cooldown (`modelRescanLastAtMs` + `MODEL_RESCAN_COOLDOWN_MS`) after
 *    the probe resolves.
 *
 * `tests/ui/task-level-overrides.spec.ts` exercises the in-flight lock and a
 * reopen WITHIN the cooldown end to end, but never exercises the cooldown
 * actually elapsing and allowing a fresh probe through - that branch is
 * covered here.
 *
 * The throttle state is MODULE-SCOPE in config-store.ts (`modelRescanInFlight`,
 * `modelRescanLastAtMs`), so it would otherwise leak across tests in this
 * file. Each test gets a pristine copy via `vi.resetModules()` + a fresh
 * dynamic `import()`, following the pattern in `tests/unit/hmr-generation.test.ts`.
 * `vi.useFakeTimers()` controls `Date.now()` for the cooldown math so the
 * cooldown boundary is deterministic on any machine (including headless
 * Linux CI), never a real sleep.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { AgentDetectionInfo } from '../../src/shared/types';
import type { useConfigStore as UseConfigStoreType } from '../../src/renderer/stores/config-store';

const MODEL_RESCAN_COOLDOWN_MS = 60_000;

/** Stub `window.electronAPI` and dynamically re-import a pristine copy of the
 *  config store module, so config-store.ts's module-scope throttle state
 *  starts zeroed instead of carrying over from a previous test. */
async function freshConfigStore(
  agentsList: (forceRefresh?: boolean) => Promise<AgentDetectionInfo[]>,
): Promise<typeof UseConfigStoreType> {
  vi.resetModules();
  vi.stubGlobal('window', {
    electronAPI: {
      agents: { list: agentsList },
      config: {
        set: vi.fn().mockResolvedValue(undefined),
        setSync: vi.fn(),
        get: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
        getGlobal: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
      },
    },
  });
  const module = await import('../../src/renderer/stores/config-store');
  return module.useConfigStore;
}

describe('config-store rescanModels throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A fixed epoch well past the 60s cooldown so the very first rescanModels()
    // call in each test (compared against the freshly-reset `modelRescanLastAtMs
    // = 0`) is never itself mistaken for "still within the cooldown of time 0".
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires loadAgentList(true) -> agents.list(true) exactly once on the first call', async () => {
    const agentsList = vi.fn(async () => [] as AgentDetectionInfo[]);
    const useConfigStore = await freshConfigStore(agentsList);

    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentsList).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledWith(true);
  });

  it('does not fire a second probe while the first is still in flight (in-flight lock)', async () => {
    let resolveList: ((value: AgentDetectionInfo[]) => void) | undefined;
    const agentsList = vi.fn(
      () => new Promise<AgentDetectionInfo[]>((resolve) => { resolveList = resolve; }),
    );
    const useConfigStore = await freshConfigStore(agentsList);

    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentsList).toHaveBeenCalledTimes(1);

    // Second call while the first probe's promise is still unresolved: the
    // in-flight lock must swallow it rather than starting a concurrent probe.
    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentsList).toHaveBeenCalledTimes(1);

    resolveList?.([]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('does not re-fire within the cooldown after the first probe resolves, but fires again once the cooldown elapses', async () => {
    const agentsList = vi.fn(async () => [] as AgentDetectionInfo[]);
    const useConfigStore = await freshConfigStore(agentsList);

    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentsList).toHaveBeenCalledTimes(1);

    // Well within the 60s cooldown since the first probe resolved: the
    // cooldown guard blocks a second probe.
    await vi.advanceTimersByTimeAsync(1_000);
    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentsList).toHaveBeenCalledTimes(1);

    // Once the cooldown has fully elapsed since the last resolution, a new
    // call is let through as a fresh probe.
    await vi.advanceTimersByTimeAsync(MODEL_RESCAN_COOLDOWN_MS);
    useConfigStore.getState().rescanModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentsList).toHaveBeenCalledTimes(2);
  });
});
