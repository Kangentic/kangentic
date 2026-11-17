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
});
