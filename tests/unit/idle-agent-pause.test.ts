/**
 * The low-memory pause decision (src/main/diagnostics/idle-agent-pause.ts):
 * when memory is low, pause the agent that has waited on the user longest,
 * one per tick, until headroom clears the recovery line. Never a working
 * agent, a Command Terminal, a workflow agent, an agent with work on its way,
 * one the user is typing into or looking at, or one that has waited less
 * than five minutes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MIN_WAIT_BEFORE_PAUSE_MS,
  createIdleAgentPauser,
  createMemoryReliefState,
  evaluateMemoryRelief,
  isPauseEligible,
  pickAgentToPause,
  type IdleAgentFacts,
} from '../../src/main/diagnostics/idle-agent-pause';
import { pressureThreshold, recoveryLine, type HostMemorySample } from '../../src/main/diagnostics/host-memory';

const GB = 1024 * 1024 * 1024;
const LIMIT = 64 * GB;
const NOW = 10_000_000_000;

function facts(overrides: Partial<IdleAgentFacts> = {}): IdleAgentFacts {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    status: 'running',
    transient: false,
    workflowId: null,
    activity: 'idle',
    waitingSince: NOW - 10 * 60_000,
    hasDraft: false,
    focused: false,
    hasPendingSubmit: false,
    hasPendingDelivery: false,
    hasOpenBackgroundWork: false,
    inWorkingWait: false,
    ...overrides,
  };
}

function windowsSample(remainingBytes: number): HostMemorySample {
  return {
    ts: '2026-10-21T00:00:00.000Z',
    platform: 'win32',
    commitLimitBytes: LIMIT,
    commitRemainingBytes: remainingBytes,
    physicalTotalBytes: 32 * GB,
    physicalFreeBytes: 4 * GB,
    physicalAvailableBytes: null,
  };
}

const LOW = pressureThreshold(LIMIT) - 1;
const GREY = (pressureThreshold(LIMIT) + recoveryLine(LIMIT)) / 2;
const RECOVERED = recoveryLine(LIMIT);

describe('evaluateMemoryRelief', () => {
  it('starts below the threshold and holds through the grey zone until the recovery line', () => {
    const state = createMemoryReliefState();

    expect(evaluateMemoryRelief({ kind: 'bytes', remainingBytes: GREY, limitBytes: LIMIT }, state)).toBe(false);
    expect(evaluateMemoryRelief({ kind: 'bytes', remainingBytes: LOW, limitBytes: LIMIT }, state)).toBe(true);
    // A pause freed some memory, not yet enough: keep going.
    expect(evaluateMemoryRelief({ kind: 'bytes', remainingBytes: GREY, limitBytes: LIMIT }, state)).toBe(true);
    expect(evaluateMemoryRelief({ kind: 'bytes', remainingBytes: RECOVERED, limitBytes: LIMIT }, state)).toBe(false);
    // Back in the grey zone from above: still off.
    expect(evaluateMemoryRelief({ kind: 'bytes', remainingBytes: GREY, limitBytes: LIMIT }, state)).toBe(false);
  });

  it('follows the macOS level: on at warn or critical, off once normal', () => {
    const state = createMemoryReliefState();

    expect(evaluateMemoryRelief({ kind: 'level', low: true }, state)).toBe(true);
    expect(evaluateMemoryRelief({ kind: 'level', low: true }, state)).toBe(true);
    expect(evaluateMemoryRelief({ kind: 'level', low: false }, state)).toBe(false);
  });

  it('pauses nothing on a missing reading and keeps the latch as it was', () => {
    const state = createMemoryReliefState();
    evaluateMemoryRelief({ kind: 'bytes', remainingBytes: LOW, limitBytes: LIMIT }, state);

    expect(evaluateMemoryRelief(null, state)).toBe(false);
    expect(state.active).toBe(true);
  });
});

describe('isPauseEligible', () => {
  it('takes a task agent idle for longer than the minimum wait', () => {
    expect(isPauseEligible(facts(), NOW)).toBe(true);
  });

  it('takes an agent waiting at a permission prompt', () => {
    expect(isPauseEligible(facts({ activity: 'permission' }), NOW)).toBe(true);
  });

  it('never takes a working agent', () => {
    expect(isPauseEligible(facts({ activity: 'thinking' }), NOW)).toBe(false);
    expect(isPauseEligible(facts({ activity: undefined }), NOW)).toBe(false);
  });

  it('waits the minimum before taking one', () => {
    expect(isPauseEligible(facts({ waitingSince: NOW - MIN_WAIT_BEFORE_PAUSE_MS + 1 }), NOW)).toBe(false);
    expect(isPauseEligible(facts({ waitingSince: NOW - MIN_WAIT_BEFORE_PAUSE_MS }), NOW)).toBe(true);
    expect(isPauseEligible(facts({ waitingSince: null }), NOW)).toBe(false);
  });

  it.each([
    ['a session that is not running', { status: 'suspended' as const }],
    ['a queued session', { status: 'queued' as const }],
    ['a Command Terminal', { transient: true }],
    ['a workflow agent', { workflowId: 'wf-1' }],
    ['an agent the user is typing into', { hasDraft: true }],
    ['an agent on screen', { focused: true }],
    ['an agent with keystrokes on their way', { hasPendingSubmit: true }],
    ['an agent with a column message on its way', { hasPendingDelivery: true }],
    // The overnight case: the card read idle while the agent's own gate ran
    // in the background, and the pause killed the CLI with the gate still going.
    ['an agent waiting on its own background work', { hasOpenBackgroundWork: true }],
    ['an agent a step check ruled still working', { inWorkingWait: true }],
    ['a session with no task', { taskId: '' }],
    ['a session with no project', { projectId: '' }],
  ])('never takes %s', (_label, overrides) => {
    expect(isPauseEligible(facts(overrides), NOW)).toBe(false);
  });
});

describe('pickAgentToPause', () => {
  it('picks the eligible agent that has waited longest', () => {
    const recent = facts({ sessionId: 'recent', waitingSince: NOW - 6 * 60_000 });
    const oldest = facts({ sessionId: 'oldest', waitingSince: NOW - 60 * 60_000 });
    const middle = facts({ sessionId: 'middle', waitingSince: NOW - 20 * 60_000 });

    expect(pickAgentToPause([recent, oldest, middle], NOW)?.sessionId).toBe('oldest');
  });

  it('skips an ineligible agent even when it has waited longest', () => {
    const longestButFocused = facts({ sessionId: 'focused', focused: true, waitingSince: NOW - 90 * 60_000 });
    const eligible = facts({ sessionId: 'eligible', waitingSince: NOW - 10 * 60_000 });

    expect(pickAgentToPause([longestButFocused, eligible], NOW)?.sessionId).toBe('eligible');
  });

  it('picks nothing when nobody qualifies', () => {
    expect(pickAgentToPause([facts({ activity: 'thinking' })], NOW)).toBeNull();
    expect(pickAgentToPause([], NOW)).toBeNull();
  });
});

describe('createIdleAgentPauser', () => {
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  }

  function makePauser(options: {
    enabled?: boolean;
    candidates?: IdleAgentFacts[];
    pause?: (target: IdleAgentFacts) => Promise<boolean>;
  } = {}) {
    const onPaused = vi.fn();
    const pause = vi.fn(options.pause ?? (async () => true));
    const listCandidates = vi.fn(() => options.candidates ?? [facts()]);
    const pauser = createIdleAgentPauser({
      isEnabled: () => options.enabled ?? true,
      listCandidates,
      pause,
      onPaused,
      now: () => NOW,
    });
    return { pauser, pause, onPaused, listCandidates };
  }

  it('pauses one agent on a low tick and reports how long it waited', async () => {
    const { pauser, pause, onPaused } = makePauser();

    pauser.onSample(windowsSample(LOW));
    await settle();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(onPaused).toHaveBeenCalledWith(expect.objectContaining({ pausedAt: NOW, waitedMs: 10 * 60_000 }));
  });

  it('pauses nothing while memory is fine, and reads no sessions', () => {
    const { pauser, pause, listCandidates } = makePauser();

    pauser.onSample(windowsSample(RECOVERED));

    expect(pause).not.toHaveBeenCalled();
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('pauses nothing with the setting off', () => {
    const { pauser, pause } = makePauser({ enabled: false });

    pauser.onSample(windowsSample(LOW));

    expect(pause).not.toHaveBeenCalled();
  });

  it('pauses one per tick, the next one on the next tick', async () => {
    const { pauser, pause } = makePauser();

    pauser.onSample(windowsSample(LOW));
    await settle();
    pauser.onSample(windowsSample(GREY));
    await settle();

    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the last pause is still running', async () => {
    let finish: (paused: boolean) => void = () => {};
    const { pauser, pause } = makePauser({ pause: () => new Promise<boolean>((resolve) => { finish = resolve; }) });

    pauser.onSample(windowsSample(LOW));
    pauser.onSample(windowsSample(LOW));
    expect(pause).toHaveBeenCalledTimes(1);

    finish(true);
    await settle();
    pauser.onSample(windowsSample(LOW));
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('stops once headroom clears the recovery line', async () => {
    const { pauser, pause } = makePauser();

    pauser.onSample(windowsSample(LOW));
    await settle();
    pauser.onSample(windowsSample(RECOVERED));
    await settle();
    pauser.onSample(windowsSample(GREY));
    await settle();

    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the pause declined', async () => {
    const { pauser, onPaused } = makePauser({ pause: async () => false });

    pauser.onSample(windowsSample(LOW));
    await settle();

    expect(onPaused).not.toHaveBeenCalled();
  });

  it('survives a pause that throws, and pauses again on the next tick', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const { pauser, pause } = makePauser({
      pause: async () => {
        calls += 1;
        if (calls === 1) throw new Error('lock wedged');
        return true;
      },
    });

    pauser.onSample(windowsSample(LOW));
    await settle();
    pauser.onSample(windowsSample(LOW));
    await settle();

    expect(pause).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it('acts on a low spell already under way when the setting is turned on', async () => {
    let enabled = false;
    const pause = vi.fn(async () => true);
    const pauser = createIdleAgentPauser({
      isEnabled: () => enabled,
      listCandidates: () => [facts()],
      pause,
      onPaused: vi.fn(),
      now: () => NOW,
    });

    pauser.onSample(windowsSample(LOW));
    enabled = true;
    pauser.onSample(windowsSample(GREY));
    await settle();

    expect(pause).toHaveBeenCalledTimes(1);
  });
});
