import { describe, it, expect } from 'vitest';
import { resolveTargetAgent } from '../../src/main/transition-engine/agent-resolver';

describe('resolveTargetAgent', () => {
  it('uses column agent_override when set', () => {
    const result = resolveTargetAgent({
      columnAgent: 'codex',
      taskAgent: 'claude',
      projectDefaultAgent: 'gemini',
    });
    expect(result.agent).toBe('codex');
  });

  it('falls back to project default when no column override', () => {
    const result = resolveTargetAgent({
      columnAgent: null,
      taskAgent: 'claude',
      projectDefaultAgent: 'codex',
    });
    expect(result.agent).toBe('codex');
  });

  it('falls back to DEFAULT_AGENT when no column or project override', () => {
    const result = resolveTargetAgent({
      columnAgent: null,
      taskAgent: null,
      projectDefaultAgent: null,
    });
    expect(result.agent).toBe('claude');
  });

  it('does NOT use task.agent in resolution chain', () => {
    const result = resolveTargetAgent({
      columnAgent: null,
      taskAgent: 'codex',
      projectDefaultAgent: null,
    });
    // taskAgent is 'codex' but should NOT be used for resolution
    // Falls through to DEFAULT_AGENT
    expect(result.agent).toBe('claude');
  });

  it('detects handoff when task.agent differs from resolved agent', () => {
    const result = resolveTargetAgent({
      columnAgent: 'codex',
      taskAgent: 'claude',
      projectDefaultAgent: null,
    });
    expect(result.isHandoff).toBe(true);
  });

  it('no handoff when task.agent matches resolved agent', () => {
    const result = resolveTargetAgent({
      columnAgent: 'claude',
      taskAgent: 'claude',
      projectDefaultAgent: null,
    });
    expect(result.isHandoff).toBe(false);
  });

  it('no handoff when task.agent is null (fresh task)', () => {
    const result = resolveTargetAgent({
      columnAgent: 'codex',
      taskAgent: null,
      projectDefaultAgent: null,
    });
    expect(result.isHandoff).toBe(false);
  });

  it('detects handoff via project default when column has no override', () => {
    const result = resolveTargetAgent({
      columnAgent: null,
      taskAgent: 'claude',
      projectDefaultAgent: 'gemini',
    });
    expect(result.agent).toBe('gemini');
    expect(result.isHandoff).toBe(true);
  });

  it('column override takes priority over project default', () => {
    const result = resolveTargetAgent({
      columnAgent: 'aider',
      taskAgent: null,
      projectDefaultAgent: 'codex',
    });
    expect(result.agent).toBe('aider');
  });

  it('handles reverse handoff (codex -> claude)', () => {
    const result = resolveTargetAgent({
      columnAgent: 'claude',
      taskAgent: 'codex',
      projectDefaultAgent: null,
    });
    expect(result.agent).toBe('claude');
    expect(result.isHandoff).toBe(true);
  });
});
