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
