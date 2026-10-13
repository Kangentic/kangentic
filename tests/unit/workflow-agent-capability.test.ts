/**
 * Which agents can be a workflow's own agent: launched read-only, on a session id
 * Kangentic chose. The agent list offers only these in Settings > Workflows, and
 * the workflow agent's start refuses a recorded conversation on any other, so
 * both read this one answer. It is true only when the adapter declares BOTH
 * capabilities; an absent `supportsReadOnlyLaunch` (it is optional) means no.
 */
import { describe, it, expect } from 'vitest';
import { canBeWorkflowAgent } from '../../src/main/agent/shared/workflow-agent-capability';

describe('canBeWorkflowAgent', () => {
  it.each([
    { supportsReadOnlyLaunch: true, supportsCallerSessionId: true, expected: true },
    { supportsReadOnlyLaunch: true, supportsCallerSessionId: false, expected: false },
    { supportsReadOnlyLaunch: false, supportsCallerSessionId: true, expected: false },
    { supportsReadOnlyLaunch: false, supportsCallerSessionId: false, expected: false },
    { supportsReadOnlyLaunch: undefined, supportsCallerSessionId: true, expected: false },
    { supportsReadOnlyLaunch: undefined, supportsCallerSessionId: false, expected: false },
  ])(
    'is $expected when read-only launch is $supportsReadOnlyLaunch and a chosen session id is $supportsCallerSessionId',
    ({ supportsReadOnlyLaunch, supportsCallerSessionId, expected }) => {
      expect(canBeWorkflowAgent({ supportsReadOnlyLaunch, supportsCallerSessionId })).toBe(expected);
    },
  );

  it('is false for an adapter that leaves read-only launch out altogether', () => {
    expect(canBeWorkflowAgent({ supportsCallerSessionId: true })).toBe(false);
  });
});
