/**
 * `launchKeyOf` decides whether the agent started during a worktree's setup
 * script (#955) is the one the task's spawn would start. It is an exclude-list:
 * the prompt, the MCP token and the task id are left out, and every other
 * option is in the key, one added later included, so a new option can only make
 * an adoption fail safe (the early agent is discarded and the spawn launches as
 * before), never adopt an agent launched some other way.
 */
import { describe, it, expect } from 'vitest';
import { launchKeyOf } from '../../src/main/transition-engine/early-agent';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const BASE_OPTIONS: SpawnCommandOptions = {
  agentPath: 'claude',
  taskId: 'task-1',
  cwd: '/some/project/.kangentic/worktrees/7',
  permissionMode: 'default',
};

function keyWith(overrides: Partial<SpawnCommandOptions>, agentName = 'claude'): string {
  return launchKeyOf(agentName, { ...BASE_OPTIONS, ...overrides });
}

describe('launchKeyOf: what the key leaves out', () => {
  it.each([
    { option: 'prompt', first: { prompt: 'Fix the login form.' }, second: { prompt: 'A different prompt.' } },
    { option: 'mcpServerToken', first: { mcpServerToken: 'token-one' }, second: { mcpServerToken: 'token-two' } },
    { option: 'taskId', first: { taskId: 'task-1' }, second: { taskId: 'task-2' } },
  ])('ignores $option', ({ first, second }) => {
    expect(keyWith(first)).toBe(keyWith(second));
  });

  it('ignores all three at once, set against ones that are absent or different', () => {
    const allThree = launchKeyOf('claude', { ...BASE_OPTIONS, prompt: 'Fix the login form.', mcpServerToken: 'token-one', taskId: 'task-9' });
    const noneButTaskId = launchKeyOf('claude', { ...BASE_OPTIONS, taskId: 'task-1' });

    expect(allThree).toBe(noneButTaskId);
  });

  it('does not write the left-out options into the key', () => {
    const key = keyWith({ prompt: 'Fix the login form.', mcpServerToken: 'token-one' });
    const named = Object.keys(JSON.parse(key) as Record<string, unknown>);

    expect(named).not.toContain('prompt');
    expect(named).not.toContain('mcpServerToken');
    expect(named).not.toContain('taskId');
    expect(key).not.toContain('Fix the login form.');
    expect(key).not.toContain('token-one');
  });
});

describe('launchKeyOf: what changes the key', () => {
  it.each([
    { option: 'model', value: { model: 'opus' } },
    { option: 'effort', value: { effort: 'high' } },
    { option: 'permissionMode', value: { permissionMode: 'plan' as const } },
    { option: 'cwd', value: { cwd: '/some/project/.kangentic/worktrees/8' } },
    { option: 'agentPath', value: { agentPath: 'claude-other' } },
    { option: 'sessionId', value: { sessionId: 'agent-session-1' } },
    { option: 'resume', value: { resume: true } },
    { option: 'mcpServerUrl', value: { mcpServerUrl: 'http://127.0.0.1:1234/mcp' } },
    { option: 'launchOptions', value: { launchOptions: { fullscreen: true } } },
    // Options the key's code never names: they ride in because the key is an exclude-list.
    { option: 'readOnly', value: { readOnly: true } },
    { option: 'capturePromptText', value: { capturePromptText: true } },
    { option: 'bypassAvailable', value: { bypassAvailable: true } },
    { option: 'readableDirectories', value: { readableDirectories: ['/some/other/checkout'] } },
  ])('changes when $option changes', ({ value }) => {
    expect(keyWith(value)).not.toBe(keyWith({}));
  });

  it('changes when one value of an option changes to another', () => {
    expect(keyWith({ model: 'opus' })).not.toBe(keyWith({ model: 'sonnet' }));
  });

  it('changes with the agent', () => {
    expect(keyWith({}, 'claude')).not.toBe(keyWith({}, 'codex'));
  });

  it('puts an option added later into the key, so it fails safe', () => {
    const withFutureOption: SpawnCommandOptions = Object.assign({}, BASE_OPTIONS, { someOptionAddedLater: 'on' });

    expect(launchKeyOf('claude', withFutureOption)).not.toBe(launchKeyOf('claude', BASE_OPTIONS));
    expect(launchKeyOf('claude', withFutureOption)).toContain('someOptionAddedLater');
  });
});

describe('launchKeyOf: two builds of one launch', () => {
  it('reads the same whatever order the options were built in', () => {
    const forward: SpawnCommandOptions = {
      agentPath: 'claude', taskId: 'task-1', cwd: BASE_OPTIONS.cwd, permissionMode: 'default', model: 'opus', effort: 'high', resume: false,
    };
    const reversed: SpawnCommandOptions = {
      resume: false, effort: 'high', model: 'opus', permissionMode: 'default', cwd: BASE_OPTIONS.cwd, taskId: 'task-1', agentPath: 'claude',
    };

    expect(launchKeyOf('claude', reversed)).toBe(launchKeyOf('claude', forward));
  });

  it('writes the agent first and every option after it in sorted order', () => {
    const key = keyWith({ model: 'opus', effort: 'high', resume: false });
    const named = Object.keys(JSON.parse(key) as Record<string, unknown>);

    expect(named[0]).toBe('agentName');
    expect(named.slice(1)).toEqual([...named.slice(1)].sort());
    expect(named.slice(1)).toEqual(['agentPath', 'cwd', 'effort', 'model', 'permissionMode', 'resume']);
  });

  it('reads an option left unset, undefined or null the same', () => {
    const unset = launchKeyOf('claude', BASE_OPTIONS);
    const undefinedModel = launchKeyOf('claude', { ...BASE_OPTIONS, model: undefined });
    const nullModel = launchKeyOf('claude', { ...BASE_OPTIONS, model: null } as unknown as SpawnCommandOptions);

    expect(undefinedModel).toBe(unset);
    expect(nullModel).toBe(unset);
  });
});
