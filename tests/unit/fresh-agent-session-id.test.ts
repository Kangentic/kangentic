import { describe, expect, it, vi } from 'vitest';
import { resolveFreshAgentSessionId } from '../../src/main/agent/shared/fresh-agent-session-id';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

function adapter(fields: Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'>): Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'> {
  return fields;
}

describe('resolveFreshAgentSessionId', () => {
  it('mints an id when the CLI accepts one Kangentic chose', async () => {
    const createSessionId = vi.fn(async () => 'created');
    const id = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: true,
      createSessionId,
    }), { cliPath: '/bin/agent', workingDirectory: '/work', permissionMode: 'acceptEdits' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it('creates a chat when the launch will not report its own id', async () => {
    const createSessionId = vi.fn(async () => 'chat-created');
    const id = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => false,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'acceptEdits' });
    expect(id).toBe('chat-created');
    expect(createSessionId).toHaveBeenCalledWith('/bin/cursor-agent', '/work');
  });

  it('leaves a print launch to report its own id', async () => {
    const createSessionId = vi.fn(async () => 'chat-created');
    const id = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => true,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'bypassPermissions' });
    expect(id).toBeNull();
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it('returns null when the CLI could not create one', async () => {
    const id = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId: async () => null,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default' });
    expect(id).toBeNull();
  });

  it('returns null for a CLI that neither accepts nor creates an id', async () => {
    const id = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
    }), { cliPath: '/bin/codex', workingDirectory: '/work', permissionMode: 'default' });
    expect(id).toBeNull();
  });
});
