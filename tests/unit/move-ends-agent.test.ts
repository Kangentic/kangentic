/**
 * `moveEndsAgent` decides which of `handleTaskMove`'s Phase 1 branches ends the
 * task's live agent, and `exitAgentEndingReason` words why an exit row that
 * needs the agent is skipped. Both the branches and the exit hook read them, so
 * the hook can never skip a message the branch would then have delivered.
 */
import { describe, it, expect } from 'vitest';
import { moveEndsAgent, exitAgentEndingReason } from '../../src/main/ipc/helpers/move-ends-agent';

describe('moveEndsAgent', () => {
  it.each([
    ['no destination column', undefined, null],
    ['a To Do column', { role: 'todo', auto_spawn: true }, 'todo'],
    ['a To Do column with Start an agent here off', { role: 'todo', auto_spawn: false }, 'todo'],
    ['a Done column', { role: 'done', auto_spawn: true }, 'done'],
    ['a Done column with Start an agent here off', { role: 'done', auto_spawn: false }, 'done'],
    ['a plain column with Start an agent here off', { role: null, auto_spawn: false }, 'parked'],
    ['a plain column that starts an agent', { role: null, auto_spawn: true }, null],
  ] as const)('%s', (_label, lane, expected) => {
    expect(moveEndsAgent(lane as Parameters<typeof moveEndsAgent>[0])).toBe(expected);
  });
});

describe('exitAgentEndingReason', () => {
  const lane = { name: 'Review' };

  it('is undefined when the move ends no agent or there is no destination column', () => {
    expect(exitAgentEndingReason(null, lane)).toBeUndefined();
    expect(exitAgentEndingReason('todo', undefined)).toBeUndefined();
  });

  it('names the destination column for each ending', () => {
    const todo = exitAgentEndingReason('todo', lane);
    const done = exitAgentEndingReason('done', lane);
    const parked = exitAgentEndingReason('parked', lane);

    expect(todo).toContain('moving to Review ends the agent');
    expect(done).toContain('moving to Review stops the agent');
    expect(parked).toContain('Review starts no agent and stops this one');
    expect(new Set([todo, done, parked]).size).toBe(3);
  });

  // A session switch and a handoff suspend the agent for another conversation,
  // so an exit message typed into it is cut off unread (kangentic.com #145).
  it('skips for a session switch and a handoff, which end the conversation for another', () => {
    expect(exitAgentEndingReason(null, lane, { kind: 'switch' })).toBe(
      'Not sent: moving to Review starts a new session, so this one could not act on the message.',
    );
    expect(exitAgentEndingReason(null, lane, { kind: 'handoff', targetAgent: 'codex' })).toBe(
      'Not sent: moving to Review hands the task to another agent, so this one could not act on the message.',
    );
  });

  it('gives no reason for a restart, a full column or a kept session, whose message is carried or typed', () => {
    expect(exitAgentEndingReason(null, lane, { kind: 'restart', reason: 'effort' })).toBeUndefined();
    expect(exitAgentEndingReason(null, lane, { kind: 'yield' })).toBeUndefined();
    expect(exitAgentEndingReason(null, lane, { kind: 'keep' })).toBeUndefined();
  });

  it('lets an ending destination win over the fate', () => {
    expect(exitAgentEndingReason('done', lane, { kind: 'switch' })).toContain('moving to Review stops the agent');
  });
});
