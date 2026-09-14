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
 * Also covers `loadAgentList`'s `discoveredModelsByAgent` non-seeding: it must
 * apply only `agentList` / `agentListLoaded` and never write the persisted
 * `discoveredModelsByAgent` cache from a live `capabilities.models` list. That
 * seeding was deliberately removed (see the comment in config-store.ts) because
 * the union only ever grew, so a model an adapter stopped reporting could never
 * leave a picker - a companion one-shot migration in config-manager.ts clears
 * the cache once, and a restored seeding block would defeat it on next launch.
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
import type { AgentDetectionInfo, AppConfig, DeepPartial } from '../../src/shared/types';
import type { useConfigStore as UseConfigStoreType } from '../../src/renderer/stores/config-store';

const MODEL_RESCAN_COOLDOWN_MS = 60_000;

interface FreshConfigStore {
  useConfigStore: typeof UseConfigStoreType;
  /** The `window.electronAPI.config.set` mock - what `updateConfig` actually
   *  routes to (config-store.ts line 274). */
  configSet: ReturnType<typeof vi.fn<(partial: DeepPartial<AppConfig>) => Promise<void>>>;
  /** The `window.electronAPI.config.setSync` mock - unused by `updateConfig`
   *  today, but asserted against too so a future re-route is still caught. */
  configSetSync: ReturnType<typeof vi.fn<(partial: DeepPartial<AppConfig>) => void>>;
}

/** Stub `window.electronAPI` and dynamically re-import a pristine copy of the
 *  config store module, so config-store.ts's module-scope throttle state
 *  starts zeroed instead of carrying over from a previous test. */
async function freshConfigStore(
  agentsList: (forceRefresh?: boolean) => Promise<AgentDetectionInfo[]>,
): Promise<FreshConfigStore> {
  vi.resetModules();
  const configSet = vi.fn((_partial: DeepPartial<AppConfig>) => Promise.resolve());
  const configSetSync = vi.fn((_partial: DeepPartial<AppConfig>) => undefined);
  vi.stubGlobal('window', {
    electronAPI: {
      agents: { list: agentsList },
      config: {
        set: configSet,
        setSync: configSetSync,
        get: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
        getGlobal: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
      },
    },
  });
  const module = await import('../../src/renderer/stores/config-store');
  return { useConfigStore: module.useConfigStore, configSet, configSetSync };
}

/** Asserts that none of a config-write mock's recorded calls carried a
 *  `discoveredModelsByAgent` key, so a restored seeding block is caught even
 *  if it also happens to write other keys in the same partial. */
function expectNeverWroteDiscoveredModelsByAgent(
  mockFn: ReturnType<typeof vi.fn<(partial: DeepPartial<AppConfig>) => unknown>>,
): void {
  for (const call of mockFn.mock.calls) {
    const [partial] = call;
    expect(Object.prototype.hasOwnProperty.call(partial, 'discoveredModelsByAgent')).toBe(false);
  }
}

/** A realistic detected-agent fixture with a populated `capabilities.models`,
 *  standing in for what a live adapter probe returns. Model ids are test
 *  fixture data only (never hardcoded in `src/` - see
 *  `.claude/rules/cli-features-over-custom-layers.md`). */
function makeClaudeAgentInfo(models: string[]): AgentDetectionInfo {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    found: true,
    path: '/mock/bin/claude',
    version: '2.1.0',
    permissions: [],
    defaultPermission: 'default',
    capabilities: {
      supportsModelOverride: true,
      models,
      modelDisplayNames: Object.fromEntries(models.map((model) => [model, model])),
    },
  };
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
    const { useConfigStore } = await freshConfigStore(agentsList);

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
    const { useConfigStore } = await freshConfigStore(agentsList);

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
    const { useConfigStore } = await freshConfigStore(agentsList);

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

describe('config-store loadAgentList does not seed discoveredModelsByAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('leaves an empty discoveredModelsByAgent map untouched', async () => {
    const claudeAgent = makeClaudeAgentInfo(['claude-opus-4-8', 'claude-sonnet-4-5']);
    const agentsList = vi.fn(async () => [claudeAgent]);
    const { useConfigStore, configSet, configSetSync } = await freshConfigStore(agentsList);

    const discoveredModelsBefore = useConfigStore.getState().config.discoveredModelsByAgent;
    expect(discoveredModelsBefore).toEqual({});

    await useConfigStore.getState().loadAgentList();
    // Flush any fire-and-forget write a restored seeding block might issue
    // without awaiting (`rememberDiscoveredModel`'s own shape, config-store.ts
    // line 415-417, is exactly this pattern).
    await vi.advanceTimersByTimeAsync(0);

    // Positive control: the call's actual job still happens.
    expect(useConfigStore.getState().agentList).toEqual([claudeAgent]);
    expect(useConfigStore.getState().agentListLoaded).toBe(true);

    // The behavior under test: nothing was written from capabilities.models.
    expectNeverWroteDiscoveredModelsByAgent(configSet);
    expectNeverWroteDiscoveredModelsByAgent(configSetSync);
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toBe(discoveredModelsBefore);
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toEqual({});
  });

  it('leaves an undefined discoveredModelsByAgent untouched (pre-migration persisted shape)', async () => {
    const claudeAgent = makeClaudeAgentInfo(['claude-opus-4-8', 'claude-sonnet-4-5']);
    const agentsList = vi.fn(async () => [claudeAgent]);
    const { useConfigStore, configSet, configSetSync } = await freshConfigStore(agentsList);

    // An older persisted config predating this field: the key is simply
    // absent, which is the runtime shape `rememberDiscoveredModel`'s own
    // `?? {}` fallback (config-store.ts line 408) defends against.
    const configWithoutDiscoveredModels: AppConfig = { ...DEFAULT_CONFIG };
    Reflect.deleteProperty(configWithoutDiscoveredModels, 'discoveredModelsByAgent');
    useConfigStore.setState({ config: configWithoutDiscoveredModels });
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toBeUndefined();

    await useConfigStore.getState().loadAgentList();
    await vi.advanceTimersByTimeAsync(0);

    expect(useConfigStore.getState().agentList).toEqual([claudeAgent]);
    expect(useConfigStore.getState().agentListLoaded).toBe(true);

    expectNeverWroteDiscoveredModelsByAgent(configSet);
    expectNeverWroteDiscoveredModelsByAgent(configSetSync);
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toBeUndefined();
  });

  it('does not grow an already-populated discoveredModelsByAgent from newly reported capability models', async () => {
    // A model the user actually ran previously, learned via `rememberDiscoveredModel`.
    const previouslyRememberedModels = { claude: ['claude-opus-4-1-20250805'] };
    // The live adapter now reports a DIFFERENT set (no overlap), simulating the
    // exact bug class this deletion guards against: a capabilities probe must
    // never grow (or shrink) the persisted cache on its own.
    const claudeAgent = makeClaudeAgentInfo(['claude-opus-4-8', 'claude-sonnet-4-5']);
    const agentsList = vi.fn(async () => [claudeAgent]);
    const { useConfigStore, configSet, configSetSync } = await freshConfigStore(agentsList);

    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, discoveredModelsByAgent: previouslyRememberedModels },
    });
    const discoveredModelsBefore = useConfigStore.getState().config.discoveredModelsByAgent;

    await useConfigStore.getState().loadAgentList();
    await vi.advanceTimersByTimeAsync(0);

    expect(useConfigStore.getState().agentList).toEqual([claudeAgent]);
    expect(useConfigStore.getState().agentListLoaded).toBe(true);

    expectNeverWroteDiscoveredModelsByAgent(configSet);
    expectNeverWroteDiscoveredModelsByAgent(configSetSync);
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toBe(discoveredModelsBefore);
    expect(useConfigStore.getState().config.discoveredModelsByAgent).toEqual(previouslyRememberedModels);
  });
});
