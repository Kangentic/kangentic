import { describe, expect, it, vi } from 'vitest';
import { resolveFreshAgentSessionId } from '../../src/main/agent/shared/fresh-agent-session-id';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { SessionIdCreation } from '../../src/shared/types';

function adapter(fields: Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'>): Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'> {
  return fields;
}

const created: SessionIdCreation = { agentSessionId: 'chat-created', outcome: 'ok' };

describe('resolveFreshAgentSessionId', () => {
  it('mints an id when the CLI accepts one Kangentic chose, asking it nothing', async () => {
    const createSessionId = vi.fn(async () => created);
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: true,
      createSessionId,
    }), { cliPath: '/bin/agent', workingDirectory: '/work', permissionMode: 'acceptEdits', prompt: 'go' });
    expect(result.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.sessionIdCreation).toBe('not_asked');
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it('creates a chat when the launch will not report its own id', async () => {
    const createSessionId = vi.fn(async () => created);
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => false,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'acceptEdits', prompt: 'go' });
    expect(result).toEqual({ agentSessionId: 'chat-created', sessionIdCreation: 'ok' });
    expect(createSessionId).toHaveBeenCalledWith('/bin/cursor-agent', '/work');
  });

  it('leaves a print launch to report its own id, as not asked', async () => {
    const createSessionId = vi.fn(async () => created);
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => true,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'bypassPermissions', prompt: 'go' });
    expect(result).toEqual({ agentSessionId: null, sessionIdCreation: 'not_asked' });
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it.each(['failed', 'timeout', 'no_id'] as const)('passes on a CLI that could not create one: %s', async (outcome) => {
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId: async () => ({ agentSessionId: null, outcome }),
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default', prompt: 'go' });
    expect(result).toEqual({ agentSessionId: null, sessionIdCreation: outcome });
  });

  it('reads a createSessionId that rejects anyway as failed', async () => {
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId: async () => { throw new Error('EACCES /Users/dev/cursor-agent'); },
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default', prompt: 'go' });
    expect(result).toEqual({ agentSessionId: null, sessionIdCreation: 'failed' });
  });

  it('asks the adapter about the launch with its mode, its flag and the prompt its command carries', async () => {
    const reportsLaunchSessionId = vi.fn(() => true);
    await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId: async () => created,
      reportsLaunchSessionId,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'auto', nonInteractive: false, prompt: 'Fix it' });
    expect(reportsLaunchSessionId).toHaveBeenCalledWith({ permissionMode: 'auto', nonInteractive: false, prompt: 'Fix it' });
  });

  it('stops waiting on the chat when the spawn is aborted', async () => {
    const controller = new AbortController();
    // A create-chat that never answers: only the abort can end the wait.
    const createSessionId = vi.fn(() => new Promise<SessionIdCreation>(() => {}));
    const pending = resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => false,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default', prompt: 'go', signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ agentSessionId: null, sessionIdCreation: 'aborted' });
    expect(createSessionId).toHaveBeenCalledOnce();
  });

  it('asks for no chat when the spawn was aborted before it started', async () => {
    const controller = new AbortController();
    controller.abort();
    const createSessionId = vi.fn(async () => created);
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId,
      reportsLaunchSessionId: () => false,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default', prompt: 'go', signal: controller.signal });
    expect(result).toEqual({ agentSessionId: null, sessionIdCreation: 'aborted' });
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it('returns the created chat when the signal never aborts', async () => {
    const controller = new AbortController();
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
      createSessionId: async () => created,
      reportsLaunchSessionId: () => false,
    }), { cliPath: '/bin/cursor-agent', workingDirectory: '/work', permissionMode: 'default', prompt: 'go', signal: controller.signal });
    expect(result).toEqual({ agentSessionId: 'chat-created', sessionIdCreation: 'ok' });
  });

  it('returns null, not asked, for a CLI that neither accepts nor creates an id', async () => {
    const result = await resolveFreshAgentSessionId(adapter({
      supportsCallerSessionId: false,
    }), { cliPath: '/bin/codex', workingDirectory: '/work', permissionMode: 'default', prompt: 'go' });
    expect(result).toEqual({ agentSessionId: null, sessionIdCreation: 'not_asked' });
  });
});
