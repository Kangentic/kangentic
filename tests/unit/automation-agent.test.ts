/**
 * The Automation agent's CLI resolution (`resolveAutomationAgent`,
 * src/main/automations/automation-agent.ts): how long a CLI detection and its
 * effort levels are cached.
 *
 * A discovery that SUCCEEDED is kept for five minutes. One that THREW (a probe
 * timeout) is kept for 30 seconds, so a single failure does not drop effort from
 * every check for the full five. Both are read off `Date.now()`, so fake timers
 * with a set system time decide which side of each limit a call lands on. The
 * resolution itself awaits plain promises and uses no timers, so it runs
 * unchanged under them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAutomationAgent,
  resetAutomationAgentCacheForTests,
  type AutomationAgentDeps,
} from '../../src/main/automations/automation-agent';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { AppConfig } from '../../src/shared/types';

vi.mock('../../src/main/agent/shared/answer-run-directory', () => ({
  ensureAnswerHomeDirectory: async () => '/mock/answer-home',
  withAnswerRunDirectory: async (work: (directory: string) => Promise<unknown>) => work('/mock/answer-run'),
}));

const START = new Date('2026-10-13T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Discover = () => Promise<{ effortLevels: string[] }>;

/** An Automation agent that takes a model and an effort, with a CLI probe and a discovery the test controls. */
function createFixture(discoverCapabilities: Discover): {
  deps: AutomationAgentDeps;
  detect: ReturnType<typeof vi.fn>;
} {
  const detect = vi.fn(async () => ({ found: true, path: '/mock/fake-agent' }));
  const adapter = {
    name: 'fake-agent',
    displayName: 'Fake Agent',
    answerCapabilities: { streaming: false, search: false, model: true, effort: true, defaultEffort: 'low' },
    detect,
    discoverCapabilities,
    answerFromContext: async () => 'C1: yes',
  } as unknown as AgentAdapter;
  const deps: AutomationAgentDeps = {
    loadConfig: () => ({
      automation: { agent: 'fake-agent', model: 'fake-model', effort: null },
      agent: { cliPaths: {} },
    }) as unknown as AppConfig,
    listAgents: async () => [{ name: 'fake-agent', adapter }],
  };
  return { deps, detect };
}

/** Move the clock to `elapsedMs` after START. */
function atElapsed(elapsedMs: number): void {
  vi.setSystemTime(new Date(START.getTime() + elapsedMs));
}

describe('resolveAutomationAgent detection cache', () => {
  beforeEach(() => {
    resetAutomationAgentCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a discovery that threw after 30 seconds, and drops effort until then', async () => {
    const discover = vi.fn<Discover>()
      .mockRejectedValueOnce(new Error('probe timed out'))
      .mockResolvedValue({ effortLevels: ['low', 'high'] });
    const { deps, detect } = createFixture(discover);

    // The probe threw, so there are no levels to prove an effort against.
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, agentName: 'fake-agent', effort: null });
    expect(discover).toHaveBeenCalledTimes(1);

    // Inside the 30 seconds the failure is the answer, with no second probe.
    atElapsed(29 * SECOND);
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: null });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);

    // Past it, discovery runs again and the adapter's recommended level comes back.
    atElapsed(31 * SECOND);
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: 'low' });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(detect).toHaveBeenCalledTimes(2);

    // The retry succeeded, so it is cached for the long limit now.
    atElapsed(2 * MINUTE);
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: 'low' });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('does not re-run a discovery that succeeded at 31 seconds, only after five minutes', async () => {
    const discover = vi.fn<Discover>().mockResolvedValue({ effortLevels: ['low', 'high'] });
    const { deps, detect } = createFixture(discover);

    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: 'low' });
    expect(discover).toHaveBeenCalledTimes(1);

    atElapsed(31 * SECOND);
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: 'low' });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);

    atElapsed(4 * MINUTE + 59 * SECOND);
    await resolveAutomationAgent(deps, 'check');
    expect(discover).toHaveBeenCalledTimes(1);

    atElapsed(5 * MINUTE + SECOND);
    await expect(resolveAutomationAgent(deps, 'check')).resolves.toMatchObject({ ok: true, effort: 'low' });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});
