/**
 * Coverage for `captureOnboardingBaseline`, the write that makes onboarding steps 1 and 2
 * honest.
 *
 * Two properties carry the whole feature, and both fail SILENTLY if broken - the checklist
 * would simply show the wrong number of ticks, with no error anywhere:
 *
 *  - First write wins. The checklist captures a baseline every time it opens, so a capture
 *    that overwrote would re-baseline against settings the user has ALREADY changed and
 *    silently un-tick real progress.
 *  - The write carries every project's entry. `onboardingBaseline` is a
 *    CONFIG_DICTIONARY_PATHS entry, so the main-process save REPLACES the map instead of
 *    merging into it; sending only the current project would wipe every other project's
 *    baseline. Same hazard `saveWorkspaceForProject` guards against, which is why this
 *    mirrors config-store-workspace.test.ts.
 *
 * The store reads `window.electronAPI.config.*` at call time, stubbed here (the unit tier
 * has no jsdom); touching only `onboardingBaseline` never trips the store's theme /
 * animations subscriptions, so no DOM access occurs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { DEFAULT_CONFIG, type OnboardingBaseline } from '../../src/shared/types';

function makeBaseline(overrides: Partial<OnboardingBaseline> = {}): OnboardingBaseline {
  return {
    defaultAgent: 'claude',
    defaultModel: null,
    defaultEffort: null,
    permissionMode: 'acceptEdits',
    swimlaneSignature: 'seed-signature',
    ...overrides,
  };
}

describe('config-store onboarding baseline', () => {
  let configSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: {
        config: {
          set: configSet,
          setSync: vi.fn(),
          get: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
          getGlobal: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
        },
      },
    });
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      workspaceSeeded: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a baseline for a project that has none', () => {
    useConfigStore.getState().captureOnboardingBaseline('project-a', makeBaseline());

    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet.mock.calls[0][0]).toEqual({
      onboardingBaseline: { 'project-a': makeBaseline() },
    });
  });

  it('does NOT overwrite an existing baseline, so reopening never un-ticks real progress', () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        onboardingBaseline: { 'project-a': makeBaseline({ defaultAgent: 'claude' }) },
      },
    });

    // The user has since switched agents; a re-capture here would treat 'codex' as the
    // starting point and step 1 would silently revert to unticked.
    useConfigStore.getState().captureOnboardingBaseline('project-a', makeBaseline({ defaultAgent: 'codex' }));

    expect(configSet).not.toHaveBeenCalled();
    expect(useConfigStore.getState().config.onboardingBaseline?.['project-a'].defaultAgent).toBe('claude');
  });

  it('carries other projects through the write, because the map is replaced not merged', () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        onboardingBaseline: { 'project-a': makeBaseline({ swimlaneSignature: 'a-signature' }) },
      },
    });

    useConfigStore.getState().captureOnboardingBaseline('project-b', makeBaseline({ swimlaneSignature: 'b-signature' }));

    const written = configSet.mock.calls[0][0].onboardingBaseline;
    expect(Object.keys(written).sort()).toEqual(['project-a', 'project-b']);
    expect(written['project-a'].swimlaneSignature).toBe('a-signature');
    expect(written['project-b'].swimlaneSignature).toBe('b-signature');
  });
});
