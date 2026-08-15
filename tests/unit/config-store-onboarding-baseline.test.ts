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

/**
 * Coverage for `resetOnboarding`, the dev-only "Restart checklist" trigger that clears every
 * trace of onboarding for one project so the flow can be walked again from step one.
 *
 * Four properties carry the whole action, and each fails SILENTLY if broken:
 *
 *  - `onboardedProjectIds` drops the reset project but keeps the rest. Its only consumer is
 *    AppLayout's auto-open gate (`onboardedProjectIds.length > 0`), which no other test
 *    exercises, so an unfiltered or over-filtered write would show up only as the checklist
 *    auto-opening (or refusing to) for the wrong reason.
 *  - `walkthroughStep` is cleared to null. A stale spotlight surviving the reset would only
 *    surface as a walkthrough target from a PRIOR run flashing back onto the fresh checklist.
 *  - `onboardingStepsCompleted` drops the reset project's session-recorded steps in store
 *    state.
 *  - `onboardingBaseline` is a CONFIG_DICTIONARY_PATH, so the write REPLACES the map rather
 *    than merging into it - dropping this project's key without carrying every other
 *    project's entry through would silently wipe their baselines too. Same hazard
 *    `captureOnboardingBaseline` above guards against.
 */
describe('config-store resetOnboarding', () => {
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

  it('drops the project from onboardedProjectIds and carries every other project through the write', async () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        onboardedProjectIds: ['project-a', 'project-b', 'project-c'],
      },
    });

    await useConfigStore.getState().resetOnboarding('project-b');

    const written = configSet.mock.calls[0][0];
    expect(written.onboardedProjectIds).toEqual(['project-a', 'project-c']);
  });

  it('clears walkthroughStep so a stale spotlight does not survive the reset', async () => {
    useConfigStore.setState({ walkthroughStep: 'taskCreated' });

    await useConfigStore.getState().resetOnboarding('project-a');

    expect(useConfigStore.getState().walkthroughStep).toBeNull();
  });

  it('removes the project entry from onboardingStepsCompleted', async () => {
    useConfigStore.setState({
      onboardingStepsCompleted: {
        'project-a': ['defaultsChosen'],
        'project-b': ['taskCreated'],
      },
    });

    await useConfigStore.getState().resetOnboarding('project-a');

    const stepsAfter = useConfigStore.getState().onboardingStepsCompleted;
    expect(stepsAfter['project-a']).toBeUndefined();
    expect(stepsAfter['project-b']).toEqual(['taskCreated']);
  });

  it('drops the project from onboardingBaseline but carries every other project through the write', async () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        onboardingBaseline: {
          'project-a': makeBaseline({ swimlaneSignature: 'a-signature' }),
          'project-b': makeBaseline({ swimlaneSignature: 'b-signature' }),
        },
      },
    });

    await useConfigStore.getState().resetOnboarding('project-a');

    const written = configSet.mock.calls[0][0].onboardingBaseline;
    expect(written['project-a']).toBeUndefined();
    expect(written['project-b']).toEqual(makeBaseline({ swimlaneSignature: 'b-signature' }));
  });
});
