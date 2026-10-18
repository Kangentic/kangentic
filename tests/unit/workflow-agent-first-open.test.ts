/**
 * `awaitsFirstAgent`: the one rule for "this plan was never seen by a workflow
 * agent". Main reads it to answer an open with `startsOnRequest` instead of
 * starting an agent, and the renderer reads it to fold the pane on its first
 * frame, so the two agree only while the rule lives in one place.
 *
 * Each row that answers false meets the other two clauses, so dropping the one
 * it exists for flips exactly that row.
 */
import { describe, it, expect } from 'vitest';
import { awaitsFirstAgent } from '../../src/shared/workflow-agent-first-open';
import type { Workflow } from '../../src/shared/types';

interface Row {
  name: string;
  workflow: Pick<Workflow, 'state' | 'agent_name'>;
  taskCount: number;
  awaits: boolean;
}

describe('awaitsFirstAgent', () => {
  const rows: Row[] = [
    { name: 'a draft with tasks and no agent', workflow: { state: 'draft', agent_name: null }, taskCount: 3, awaits: true },
    { name: 'a running workflow with tasks and no agent', workflow: { state: 'running', agent_name: null }, taskCount: 3, awaits: true },
    { name: 'a paused workflow with tasks and no agent', workflow: { state: 'paused', agent_name: null }, taskCount: 3, awaits: true },
    { name: 'a draft with one task and no agent', workflow: { state: 'draft', agent_name: null }, taskCount: 1, awaits: true },
    // A finished workflow has nothing to plan, whatever is left on the board.
    { name: 'a done workflow with tasks and no agent', workflow: { state: 'done', agent_name: null }, taskCount: 3, awaits: false },
    // An agent that ran has seen the plan, or lost its conversation and continues from it.
    { name: 'a draft with tasks and a recorded agent', workflow: { state: 'draft', agent_name: 'claude' }, taskCount: 3, awaits: false },
    { name: 'a running workflow with tasks and a recorded agent', workflow: { state: 'running', agent_name: 'claude' }, taskCount: 3, awaits: false },
    // A workflow made in the view has no tasks until its agent plans, so its agent starts on open.
    { name: 'a draft with no tasks and no agent', workflow: { state: 'draft', agent_name: null }, taskCount: 0, awaits: false },
    { name: 'a running workflow with no tasks and no agent', workflow: { state: 'running', agent_name: null }, taskCount: 0, awaits: false },
  ];

  it.each(rows)('answers $awaits for $name', ({ workflow, taskCount, awaits }) => {
    expect(awaitsFirstAgent(workflow, taskCount)).toBe(awaits);
  });
});
