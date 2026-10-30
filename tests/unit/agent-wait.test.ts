import { describe, it, expect } from 'vitest';
import { agentActivityMark, agentWaitKind, waitMarkForReason } from '../../src/renderer/components/board/agent-wait';
import { formatActivityReasonText } from '../../src/renderer/components/board/activity-reason-text';
import type { ActivityReason, ActivityState } from '../../src/shared/types';

// One function decides which mark an agent session wears, for every surface that
// draws one (board card, Workflows inspector and agent pane, Agent Monitor). A
// question, an approval and a finished turn are told apart by shape (#452).

const question: ActivityReason = { kind: 'permission', since: 0, waitKind: 'question' };
const approval: ActivityReason = { kind: 'permission', since: 0, waitKind: 'approval' };
const unknownWait: ActivityReason = { kind: 'permission', since: 0 };
const finishedTurn: ActivityReason = { kind: 'idle', since: 0 };

describe('agentActivityMark', () => {
  it('draws the working ring for a working agent, whatever the reason', () => {
    expect(agentActivityMark('thinking', { kind: 'turn-active' })).toBe('agent-working');
    expect(agentActivityMark('thinking', undefined)).toBe('agent-working');
  });

  it('draws the envelope for a finished turn', () => {
    expect(agentActivityMark('idle', finishedTurn)).toBe('agent-idle');
    expect(agentActivityMark('idle', undefined)).toBe('agent-idle');
  });

  it('draws the speech bubble for a question', () => {
    expect(agentActivityMark('permission', question)).toBe('agent-question');
  });

  it('draws the crested shield for an approval', () => {
    expect(agentActivityMark('permission', approval)).toBe('agent-approval');
  });

  it('draws the bubble for a wait whose kind the agent did not report', () => {
    expect(agentActivityMark('permission', unknownWait)).toBe('agent-question');
  });

  it('lets the state decide a wait is open, so a lagging reason still draws a wait', () => {
    // The web demo seeds states with no reason, and a resync can land one before the other.
    expect(agentActivityMark('permission', undefined)).toBe('agent-question');
    expect(agentActivityMark('permission', finishedTurn)).toBe('agent-question');
    // ...and a stale permission reason on an idle session draws the envelope.
    expect(agentActivityMark('idle', approval)).toBe('agent-idle');
  });

  it('covers every ActivityState, so a new variant fails here', () => {
    const states: ActivityState[] = ['thinking', 'idle', 'permission'];
    expect(states.map((state) => agentActivityMark(state, approval))).toEqual(['agent-working', 'agent-idle', 'agent-approval']);
  });
});

describe('agentWaitKind', () => {
  it('names the wait only while one is open', () => {
    expect(agentWaitKind('permission', question)).toBe('question');
    expect(agentWaitKind('permission', approval)).toBe('approval');
    expect(agentWaitKind('permission', unknownWait)).toBe('unknown');
    expect(agentWaitKind('idle', question)).toBeNull();
    expect(agentWaitKind('thinking', question)).toBeNull();
    expect(agentWaitKind(undefined, question)).toBeNull();
  });
});

describe('waitMarkForReason', () => {
  it('leads a wait reason\'s tooltip with its own mark', () => {
    expect(waitMarkForReason({ kind: 'permission', since: 0, waitKind: 'question' })).toBe('agent-question');
    expect(waitMarkForReason({ kind: 'permission', since: 0, waitKind: 'approval' })).toBe('agent-approval');
    expect(waitMarkForReason({ kind: 'permission', since: 0 })).toBe('agent-question');
  });
});

describe('formatActivityReasonText for a wait', () => {
  const twoMinutesIn = 2 * 60_000;

  it('says what the wait is for, with how long it has lasted', () => {
    expect(formatActivityReasonText(question, twoMinutesIn)).toBe('Asking you a question for 2m 0s');
    expect(formatActivityReasonText(approval, twoMinutesIn)).toBe('Waiting for your approval for 2m 0s');
    expect(formatActivityReasonText(unknownWait, twoMinutesIn)).toBe('Waiting on you for 2m 0s');
  });

  it('keeps a finished turn as it was', () => {
    expect(formatActivityReasonText(finishedTurn, 3 * 60_000)).toBe('Idle for 3m 0s');
  });
});
