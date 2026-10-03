/**
 * Coverage for `updateProjectOverride`'s write-serialization chain
 * (src/renderer/stores/config-store.ts). Two properties fail SILENTLY if
 * broken, and neither is exercised by the sibling config-store test files:
 *
 *  - Two back-to-back writes run IN ORDER, and a REJECTING first write must
 *    not block, corrupt, or skip the second: the second write still reaches
 *    the IPC method and resolves with ITS OWN result, not the first's
 *    rejection and not the first's value. The store's own comment names the
 *    regression this guards against: "the chain tail stays Promise<void> so
 *    a write's result cannot leak into the NEXT write's `then`; the caller
 *    gets its own promise carrying the result." Reverting to a single-promise
 *    shape that reuses the chain as both the module-level tail AND the
 *    caller's return value drops that separation.
 *  - With no project open (`projectSettingsPath` is null), the write is a
 *    documented no-op that resolves `{ persisted: true }` and never touches
 *    the IPC method - nothing was attempted, so nothing failed. Reverting
 *    that early return to a bare `return;` would resolve `undefined`
 *    instead, which is what the settings panel destructures `{ persisted }`
 *    off one call site up (Sentry DESKTOP-1C).
 *
 * The store reads `window.electronAPI.config.*` at call time, stubbed here
 * (the unit tier has no jsdom); touching only `projectOverrides` /
 * `projectSettingsPath` never trips the store's theme / animations
 * subscriptions, so no DOM access occurs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { DEFAULT_CONFIG } from '../../src/shared/types';

describe('config-store updateProjectOverride write serialization', () => {
  let setProjectOverridesByPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setProjectOverridesByPath = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        config: {
          set: vi.fn(),
          setSync: vi.fn(),
          get: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
          getGlobal: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
          setProjectOverridesByPath,
        },
      },
    });
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      projectOverrides: null,
      projectSettingsPath: '/repo/proj',
      workspaceSeeded: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs two back-to-back writes in order; a rejecting first write does not block, corrupt, or skip the second', async () => {
    // callCount, not a per-call canned answer, so the assertion depends on
    // ORDER actually holding rather than on which promise vitest happens to
    // settle first: the first INVOCATION rejects, whichever write reaches it.
    let callCount = 0;
    setProjectOverridesByPath.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('disk full');
      return { persisted: true };
    });

    const firstWrite = useConfigStore.getState().updateProjectOverride({ git: { worktreesEnabled: false } });
    const secondWrite = useConfigStore.getState().updateProjectOverride({ git: { initScript: 'npm install' } });

    await expect(firstWrite).rejects.toThrow('disk full');
    // Not the first's rejection and not the first's value: the second call's
    // own configured result.
    await expect(secondWrite).resolves.toEqual({ persisted: true });

    // The second write's own IPC call actually happened - it was not skipped
    // because the first rejected - and it carried the SECOND partial.
    expect(setProjectOverridesByPath).toHaveBeenCalledTimes(2);
    const secondCallPartial = setProjectOverridesByPath.mock.calls[1][1] as { git?: { initScript?: string } };
    expect(secondCallPartial.git?.initScript).toBe('npm install');
  });

  it('resolves { persisted: true } and never calls the IPC method when no project is open', async () => {
    useConfigStore.setState({ projectSettingsPath: null });

    const result = await useConfigStore.getState().updateProjectOverride({ git: { worktreesEnabled: false } });

    expect(result).toEqual({ persisted: true });
    expect(setProjectOverridesByPath).not.toHaveBeenCalled();
  });
});

/**
 * An explicit target path, which Settings > Agent passes for the permission mode
 * it writes AFTER awaiting the agent write. The switcher can move the panel to
 * another project during that await; without the explicit path the mode landed
 * on whichever project the panel showed when the write ran.
 */
describe('config-store updateProjectOverride with an explicit target path', () => {
  let setProjectOverridesByPath: ReturnType<typeof vi.fn>;
  let getProjectOverridesByPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setProjectOverridesByPath = vi.fn().mockResolvedValue({ persisted: true });
    getProjectOverridesByPath = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        config: {
          set: vi.fn(),
          setSync: vi.fn(),
          get: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
          getGlobal: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
          setProjectOverridesByPath,
          getProjectOverridesByPath,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes to the target the panel has left, merged over main\'s copy, and leaves the panel\'s state alone', async () => {
    const panelOverrides = { git: { autoFetch: false } };
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      projectSettingsPath: '/repo/other',
      projectOverrides: panelOverrides,
    });
    getProjectOverridesByPath.mockResolvedValue({ agent: { permissionMode: 'plan' }, git: { prAutoRefresh: false } });

    await useConfigStore.getState().updateProjectOverride({ agent: { permissionMode: 'default' } }, '/repo/target');

    expect(getProjectOverridesByPath).toHaveBeenCalledWith('/repo/target');
    expect(setProjectOverridesByPath).toHaveBeenCalledTimes(1);
    expect(setProjectOverridesByPath.mock.calls[0][0], 'the gesture\'s project, not the one the panel moved to').toBe('/repo/target');
    expect(
      setProjectOverridesByPath.mock.calls[0][1],
      'merged over the target\'s own overrides, never over the panel\'s copy of another project',
    ).toEqual({ agent: { permissionMode: 'default' }, git: { prAutoRefresh: false } });
    expect(useConfigStore.getState().projectOverrides).toBe(panelOverrides);
    expect(useConfigStore.getState().projectSettingsPath).toBe('/repo/other');
  });

  it('merges over the panel\'s live copy, with no fetch, when the panel is still on the target', async () => {
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      projectSettingsPath: '/repo/target',
      projectOverrides: { git: { autoFetch: false } },
    });

    await useConfigStore.getState().updateProjectOverride({ agent: { permissionMode: 'default' } }, '/repo/target');

    expect(getProjectOverridesByPath).not.toHaveBeenCalled();
    expect(setProjectOverridesByPath).toHaveBeenCalledWith('/repo/target', {
      git: { autoFetch: false },
      agent: { permissionMode: 'default' },
    });
    expect(useConfigStore.getState().projectOverrides).toEqual({
      git: { autoFetch: false },
      agent: { permissionMode: 'default' },
    });
  });

  it('fetches main\'s copy when the panel is back on the target but its overrides have not loaded yet', async () => {
    // openProjectSettings nulls projectOverrides on every path change and refetches
    // them. A write that lands before that refetch returns has no live copy to merge
    // over. Main replaces the whole file, so a merge over {} would drop git.prAutoRefresh.
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      projectSettingsPath: '/repo/target',
      projectOverrides: null,
    });
    getProjectOverridesByPath.mockResolvedValue({ agent: { permissionMode: 'plan' }, git: { prAutoRefresh: false } });

    await useConfigStore.getState().updateProjectOverride({ agent: { permissionMode: 'default' } }, '/repo/target');

    expect(getProjectOverridesByPath).toHaveBeenCalledWith('/repo/target');
    expect(setProjectOverridesByPath).toHaveBeenCalledTimes(1);
    expect(
      setProjectOverridesByPath.mock.calls[0][1],
      'merged over main\'s copy, so the key the partial does not name survives',
    ).toEqual({ agent: { permissionMode: 'default' }, git: { prAutoRefresh: false } });
    expect(setProjectOverridesByPath.mock.calls[0][0]).toBe('/repo/target');
    expect(
      useConfigStore.getState().projectOverrides,
      'the panel is on the target, so it takes the merged result',
    ).toEqual({ agent: { permissionMode: 'default' }, git: { prAutoRefresh: false } });
  });

  it('writes exactly the partial, and resolves persisted, when the panel is elsewhere and main holds no overrides for the target', async () => {
    const panelOverrides = { git: { autoFetch: false } };
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      projectSettingsPath: '/repo/other',
      projectOverrides: panelOverrides,
    });
    getProjectOverridesByPath.mockResolvedValue(null);

    const result = await useConfigStore.getState().updateProjectOverride({ agent: { permissionMode: 'default' } }, '/repo/target');

    expect(result).toEqual({ persisted: true });
    expect(getProjectOverridesByPath).toHaveBeenCalledWith('/repo/target');
    expect(setProjectOverridesByPath).toHaveBeenCalledTimes(1);
    expect(setProjectOverridesByPath.mock.calls[0][0]).toBe('/repo/target');
    expect(
      setProjectOverridesByPath.mock.calls[0][1],
      'a target main has nothing for starts from {}, never from the other project\'s copy the panel holds',
    ).toEqual({ agent: { permissionMode: 'default' } });
    expect(useConfigStore.getState().projectOverrides).toBe(panelOverrides);
    expect(useConfigStore.getState().projectSettingsPath).toBe('/repo/other');
  });
});
