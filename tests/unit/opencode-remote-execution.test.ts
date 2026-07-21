/**
 * Unit tests for OpenCode remote execution ("support remote OpenCode servers").
 *
 * Covers the pieces added for `opencode attach <url> --dir <path>`:
 *  - command-builder.ts: the attach branch of buildOpenCodeCommand, and
 *    buildOpenCodeEnv returning null in remote mode.
 *  - opencode-adapter.ts: buildCommand tracking a remote target by cwd, and
 *    parseTranscript / locateSessionHistoryFile / sessionId.fromFilesystem
 *    branching on it.
 *  - remote-client.ts: probeOpenCodeServer / fetchOpenCodeSessionMessages
 *    against an injected FetchLike (no real network).
 *  - transcript-parser.ts: mapOpenCodeRemoteEntries.
 *  - agent/shared/execution-target.ts: resolveExecutionTarget.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  OpenCodeAdapter,
  OpenCodeCommandBuilder,
} from '../../src/main/agent/adapters/opencode';
import { OpenCodeSessionHistoryParser } from '../../src/main/agent/adapters/opencode/session-history-parser';
import { mapOpenCodeRemoteEntries } from '../../src/main/agent/adapters/opencode/transcript-parser';
import { probeOpenCodeServer, fetchOpenCodeSessionMessages, type FetchLike } from '../../src/main/agent/adapters/opencode/remote-client';
import { resolveExecutionTarget } from '../../src/main/agent/shared/execution-target';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { AgentExecutionServer, ResolvedExecutionTarget } from '../../src/shared/types';

const REMOTE_TARGET: ResolvedExecutionTarget = {
  url: 'http://10.0.0.5:4096',
  auth: { kind: 'basic', username: 'opencode', password: 'hunter2' },
  workingDirectory: '/home/dev/project',
};

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/opencode',
    taskId: 'task-001',
    cwd: '/home/dev/kangentic-worktree',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('OpenCodeCommandBuilder - remote attach', () => {
  const builder = new OpenCodeCommandBuilder();

  it('emits attach <url> instead of the binary alone', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('attach');
    expect(command).toContain('http://10.0.0.5:4096');
  });

  it('passes the server working directory via --dir', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('--dir');
    expect(command).toContain('/home/dev/project');
  });

  it('omits --dir when no server working directory is configured', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      executionTarget: { ...REMOTE_TARGET, workingDirectory: null },
    });
    expect(command).not.toContain('--dir');
  });

  it('passes basic auth via --username and --password', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('--username');
    expect(command).toContain('opencode');
    expect(command).toContain('--password');
    expect(command).toContain('hunter2');
  });

  it('never emits --model in remote mode (the server is the model authority)', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      model: 'anthropic/claude-sonnet',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).not.toContain('--model');
  });

  it('resumes via --session and omits the prompt, mirroring local resume', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      resume: true,
      sessionId: 'ses_abc123',
      prompt: 'this should be dropped',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('--session');
    expect(command).toContain('ses_abc123');
    expect(command).not.toContain('--prompt');
    expect(command).not.toContain('this should be dropped');
  });

  it('emits --agent for a fresh (non-resume) spawn with a non-default permission mode', () => {
    // Coverage hole: every other remote test in this file uses
    // permissionMode: 'default', which mapPermissionModeToAgent maps to null,
    // so the `if (agentName) parts.push('--agent', ...)` branch in
    // buildOpenCodeAttachCommand's fresh-spawn path is never exercised.
    // Reverting that push would ship a fresh remote task with no initial
    // agent, uncaught by any existing assertion.
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'acceptEdits',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('--agent');
    expect(command).toContain('build');
  });

  it('omits --agent for a fresh (non-resume) spawn whose permission mode maps to no agent', () => {
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).not.toContain('--agent');
  });

  it('emits --prompt with the prompt text on a fresh (non-resume) spawn', () => {
    // Coverage hole: the only existing remote prompt assertion checks the
    // ABSENCE of --prompt on the resume path. Nothing pins that a fresh spawn
    // actually carries the initial prompt through. Reverting that push would
    // ship a fresh remote task with no initial prompt, uncaught.
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      prompt: 'Implement the remote attach flow.',
      executionTarget: REMOTE_TARGET,
    });
    expect(command).toContain('--prompt');
    expect(command).toContain('Implement the remote attach flow.');
  });

  it('does not install the activity plugin in remote mode', () => {
    // A real temp dir (mirrors the hookHolders refcount tests below) so a
    // real plugin install would be observable on disk if the remote branch
    // ever fell through to the local buildHooks() call.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-opencode-remote-plugin-'));
    try {
      builder.buildOpenCodeCommand({
        opencodePath: '/usr/bin/opencode',
        taskId: 'task-001',
        cwd: projectDir,
        projectRoot: projectDir,
        permissionMode: 'default',
        eventsOutputPath: path.join(projectDir, 'events.jsonl'),
        executionTarget: REMOTE_TARGET,
      });
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.mjs'))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('OpenCodeCommandBuilder.buildOpenCodeEnv - remote mode', () => {
  it('returns null when an execution target is present, even with full MCP config', () => {
    const builder = new OpenCodeCommandBuilder();
    const env = builder.buildOpenCodeEnv({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/kangentic-worktree',
      permissionMode: 'default',
      mcpServerEnabled: true,
      mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-abc',
      mcpServerToken: 'token-deadbeef',
      executionTarget: REMOTE_TARGET,
    });
    expect(env).toBeNull();
  });
});

describe('OpenCodeAdapter - remote target tracking by cwd', () => {
  it('parseTranscript fetches from the remote server for a remote-mode cwd', async () => {
    const adapter = new OpenCodeAdapter();
    const cwd = '/home/dev/kangentic-worktree';
    adapter.buildCommand(makeOptions({ cwd, executionTarget: REMOTE_TARGET }));

    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    });
    // Substitute the module-level default fetch by monkeypatching global fetch,
    // since parseTranscript calls fetchOpenCodeSessionMessages with its default
    // fetchImpl parameter (no injection point through the adapter).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await adapter.parseTranscript('ses_abc123', cwd);
      expect(result.entries).toEqual([{ kind: 'user', uuid: 'm1', ts: expect.any(Number), text: 'hi' }]);
      expect(result.sourcePath).toBe('http://10.0.0.5:4096/session/ses_abc123/message');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parseTranscript falls back to local SQLite parsing for a cwd with no tracked remote target', async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.parseTranscript('ses_nonexistent', '/home/dev/purely-local-project');
    // No real OpenCode DB in CI - empty result, but crucially NOT a remote fetch.
    expect(result.entries).toEqual([]);
  });

  it('locateSessionHistoryFile returns null for a remote-mode cwd (handoff degrades)', async () => {
    const adapter = new OpenCodeAdapter();
    const cwd = '/home/dev/kangentic-worktree';
    adapter.buildCommand(makeOptions({ cwd, executionTarget: REMOTE_TARGET }));

    const result = await adapter.locateSessionHistoryFile('ses_abc123', cwd);
    expect(result).toBeNull();
  });

  it('sessionId.fromFilesystem skips the SQLite poll for a remote-mode cwd', async () => {
    const adapter = new OpenCodeAdapter();
    const cwd = '/home/dev/kangentic-worktree';
    adapter.buildCommand(makeOptions({ cwd, executionTarget: REMOTE_TARGET }));

    const parserSpy = vi.spyOn(OpenCodeSessionHistoryParser, 'captureSessionIdFromFilesystem');
    const result = await adapter.runtime.sessionId.fromFilesystem({ spawnedAt: new Date(), cwd });
    expect(result).toBeNull();
    expect(parserSpy).not.toHaveBeenCalled();
    parserSpy.mockRestore();
  });

  it('sessionId.fromFilesystem still polls normally for a local-mode cwd', async () => {
    const adapter = new OpenCodeAdapter();
    const parserSpy = vi.spyOn(OpenCodeSessionHistoryParser, 'captureSessionIdFromFilesystem').mockResolvedValue(null);
    await adapter.runtime.sessionId.fromFilesystem({ spawnedAt: new Date(), cwd: '/home/dev/purely-local-project' });
    expect(parserSpy).toHaveBeenCalledTimes(1);
    parserSpy.mockRestore();
  });

  it('buildCommand for a local spawn clears a previously tracked remote target for the same cwd', async () => {
    const adapter = new OpenCodeAdapter();
    const cwd = '/home/dev/kangentic-worktree';

    // First spawn on this cwd is remote - locateSessionHistoryFile degrades
    // to null (handoff has no local file for a remote session).
    adapter.buildCommand(makeOptions({ cwd, executionTarget: REMOTE_TARGET }));
    const locateSpy = vi.spyOn(OpenCodeSessionHistoryParser, 'locate').mockResolvedValue('/should/not/be/used');
    expect(await adapter.locateSessionHistoryFile('ses_abc123', cwd)).toBeNull();
    expect(locateSpy).not.toHaveBeenCalled();

    // The task flips back to local mode (a fresh spawn with no
    // executionTarget) on the SAME cwd. Without the `delete` in
    // buildCommand's local branch, this cwd would keep branching to the
    // dead remote target forever.
    adapter.buildCommand(makeOptions({ cwd }));

    const result = await adapter.locateSessionHistoryFile('ses_abc123', cwd);
    expect(locateSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('/should/not/be/used');
    locateSpy.mockRestore();

    // Same flip observed through the other remote-gated consumer.
    const parserSpy = vi.spyOn(OpenCodeSessionHistoryParser, 'captureSessionIdFromFilesystem').mockResolvedValue(null);
    await adapter.runtime.sessionId.fromFilesystem({ spawnedAt: new Date(), cwd });
    expect(parserSpy).toHaveBeenCalledTimes(1);
    parserSpy.mockRestore();
  });

  it('declares the remoteExecution capability with OpenCode-specific info', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.remoteExecution?.info).toMatchObject({
      urlPlaceholder: 'http://10.0.0.5:4096',
      authKind: 'basic',
      workingDirectoryScope: 'per-invocation',
    });
    // No agent-name branching in the renderer: the caveat copy is
    // adapter-authored data, not something the renderer strings together
    // by checking agent.name === 'opencode' (agent-adapters-boundary.md).
    expect(adapter.remoteExecution?.info.remoteModeCaveat).toBeTypeOf('string');
    expect(adapter.remoteExecution?.probeServer).toBeTypeOf('function');
  });
});

describe('probeOpenCodeServer', () => {
  const server: AgentExecutionServer = { url: 'http://10.0.0.5:4096', auth: { kind: 'basic', username: 'opencode', password: 'hunter2' } };

  it('returns reachable:true with the reported version on a healthy response', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true, version: '1.14.25' }),
    });
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: true, version: '1.14.25' });
  });

  it('sends a Basic auth header derived from username/password', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers;
      return { ok: true, status: 200, json: async () => ({ healthy: true, version: '1.0.0' }) };
    });
    await probeOpenCodeServer(server, fetchImpl);
    expect(capturedHeaders?.Authorization).toBe(`Basic ${Buffer.from('opencode:hunter2').toString('base64')}`);
  });

  it('returns reachable:false with the HTTP status on a non-2xx response', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'Server responded with HTTP 503' });
  });

  it('returns a credentials-specific reason on 401, distinct from a generic unreachable status', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'Authentication failed - check the username and password' });
  });

  it('returns a credentials-specific reason on 403 too', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'Authentication failed - check the username and password' });
  });

  it('returns reachable:false when the body reports healthy:false', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ healthy: false }) });
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'Server reported unhealthy' });
  });

  it('never throws on a network error - returns reachable:false with the error message', async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await probeOpenCodeServer(server, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'ECONNREFUSED' });
  });

  it('returns reachable:false when no URL is configured, without calling fetch', async () => {
    const fetchImpl: FetchLike = vi.fn();
    const result = await probeOpenCodeServer({ url: null, auth: { kind: 'none' } }, fetchImpl);
    expect(result).toEqual({ reachable: false, reason: 'No server URL configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchOpenCodeSessionMessages', () => {
  const server: AgentExecutionServer = { url: 'http://10.0.0.5:4096/', auth: { kind: 'none' } };

  it('trims a trailing slash and URL-encodes the session id in the request path', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl: FetchLike = vi.fn().mockImplementation(async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [] };
    });
    await fetchOpenCodeSessionMessages(server, 'ses abc/123', fetchImpl);
    expect(capturedUrl).toBe('http://10.0.0.5:4096/session/ses%20abc%2F123/message');
  });

  it('returns [] on a non-2xx response', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const result = await fetchOpenCodeSessionMessages(server, 'ses_x', fetchImpl);
    expect(result).toEqual([]);
  });

  it('returns [] when the body is not an array', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ not: 'an array' }) });
    const result = await fetchOpenCodeSessionMessages(server, 'ses_x', fetchImpl);
    expect(result).toEqual([]);
  });

  it('never throws on a network error - returns []', async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await fetchOpenCodeSessionMessages(server, 'ses_x', fetchImpl);
    expect(result).toEqual([]);
  });
});

describe('mapOpenCodeRemoteEntries', () => {
  it('maps user text, assistant reasoning/text/tool, and a paired tool_result', () => {
    const entries = mapOpenCodeRemoteEntries([
      {
        info: { id: 'm_user', role: 'user', time: { created: 1000 } },
        parts: [{ type: 'text', text: 'List the files.' }],
      },
      {
        info: { id: 'm_asst', role: 'assistant', time: { created: 2000 }, modelID: 'big-pickle' },
        parts: [
          { type: 'reasoning', text: 'I should list files.' },
          { type: 'text', text: 'Here are the files.' },
          { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file1.txt' } },
        ],
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'm_user', ts: 1000, text: 'List the files.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'big-pickle',
      blocks: [
        { type: 'thinking', text: 'I should list files.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', content: 'file1.txt', isError: false });
  });

  it('flags an error tool part via state.status', () => {
    const entries = mapOpenCodeRemoteEntries([
      {
        info: { id: 'm', role: 'assistant' },
        parts: [{ type: 'tool', callID: 'c', tool: 'bash', state: { status: 'error', output: 'failed' } }],
      },
    ]);
    expect(entries.find((entry) => entry.kind === 'tool_result')).toMatchObject({ isError: true, content: 'failed' });
  });

  it('skips a message whose id is missing entirely', () => {
    const entries = mapOpenCodeRemoteEntries([
      { info: { role: 'user' } as unknown as { id: string; role: string }, parts: [{ type: 'text', text: 'x' }] },
    ]);
    expect(entries).toEqual([]);
  });

  it('returns [] for an empty message list', () => {
    expect(mapOpenCodeRemoteEntries([])).toEqual([]);
  });
});

describe('resolveExecutionTarget', () => {
  it('returns null when no execution entry exists for the agent', () => {
    expect(resolveExecutionTarget('opencode', {}, {})).toBeNull();
  });

  it('returns null when the mode is local', () => {
    const result = resolveExecutionTarget(
      'opencode',
      { opencode: { url: 'http://10.0.0.5:4096', auth: { kind: 'none' } } },
      { opencode: { mode: 'local', workingDirectory: null } },
    );
    expect(result).toBeNull();
  });

  it('resolves the flattened target when mode is remote and a server URL is configured', () => {
    const result = resolveExecutionTarget(
      'opencode',
      { opencode: { url: 'http://10.0.0.5:4096', auth: { kind: 'basic', username: 'u', password: 'p' } } },
      { opencode: { mode: 'remote', workingDirectory: '/srv/project' } },
    );
    expect(result).toEqual({
      url: 'http://10.0.0.5:4096',
      auth: { kind: 'basic', username: 'u', password: 'p' },
      workingDirectory: '/srv/project',
    });
  });

  it('throws when mode is remote but no server URL is configured', () => {
    expect(() =>
      resolveExecutionTarget('opencode', {}, { opencode: { mode: 'remote', workingDirectory: null } }),
    ).toThrow(/no server URL is configured/);
  });
});
