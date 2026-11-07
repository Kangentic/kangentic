/**
 * `planRemoteSpawn` with the real quoting and clear helpers (the flow test mocks them). What it
 * protects: a command typed into a host's shell is quoted for THAT shell on Linux, whatever this
 * computer runs, so a Windows client's PowerShell or cmd rules never shape a line a host reads.
 */
import { describe, expect, it } from 'vitest';
import { planRemoteSpawn, consoleCloseIsGracefulOnHost } from '../../src/main/pty/spawn/remote-spawn';
import type { AgentParser, SpawnRemote } from '../../src/shared/types';

const remote = (shellName: string): SpawnRemote => ({ hostId: 'host-a', cwd: '/home/dev/api', shellName });
const plan = (shellName: string) => planRemoteSpawn({ taskId: 'task-9', env: undefined, agentParser: undefined }, remote(shellName));

describe('the line typed into a host\'s shell', () => {
  it('clears the screen first and leaves a plain command alone in bash, zsh and sh', () => {
    for (const shellName of ['bash', 'zsh', 'sh']) {
      expect(plan(shellName).typedLine("claude --model 'opus'")).toBe("clear; claude --model 'opus'");
    }
  });

  it('keeps a Windows-looking path argument as written, because only a Windows platform rewrites one', () => {
    expect(plan('bash').typedLine('"C:\\tools\\agent.exe" --flag')).toBe('clear; "C:\\tools\\agent.exe" --flag');
  });

  it('prefixes a quoted command head with ^ for nushell, as nushell needs to run it as a program', () => {
    expect(plan('nu').typedLine('"/opt/claude" --flag')).toBe('clear; ^"/opt/claude" --flag');
  });

  it('does not use PowerShell\'s call operator or cmd\'s cls for a Linux login shell', () => {
    const line = plan('fish').typedLine('claude');
    expect(line).toBe('clear; claude');
    expect(line).not.toContain('cls');
    expect(line.startsWith('& ')).toBe(false);
  });
});

describe('the environment of a remote spawn', () => {
  it('tags the task and defaults TERM, and keeps a TERM the adapter set', () => {
    expect(plan('bash').env).toEqual({ KANGENTIC_TASK_ID: 'task-9', TERM: 'xterm-256color' });
    const kept = planRemoteSpawn({ taskId: 'task-9', env: { TERM: 'screen' }, agentParser: undefined }, remote('bash'));
    expect(kept.env.TERM).toBe('screen');
  });

  it('treats an empty TERM as absent, as the local spawn does', () => {
    const emptied = planRemoteSpawn({ taskId: 'task-9', env: { TERM: '' }, agentParser: undefined }, remote('bash'));
    expect(emptied.env.TERM).toBe('xterm-256color');
  });

  it('never grows a WSLENV entry', () => {
    expect(Object.keys(plan('bash').env)).not.toContain('WSLENV');
  });
});

describe('whether closing the console is the agent\'s graceful exit on a host', () => {
  const parserFor = (answers: Partial<Record<NodeJS.Platform, boolean>>) =>
    ({ consoleCloseIsGraceful: (platform: NodeJS.Platform) => answers[platform] === true }) as unknown as AgentParser;

  it('follows the adapter\'s answer for Linux', () => {
    expect(consoleCloseIsGracefulOnHost(parserFor({ linux: true }))).toBe(true);
    expect(consoleCloseIsGracefulOnHost(parserFor({ win32: true, darwin: true }))).toBe(false);
  });

  it('is false for an agent that has no opinion, or none', () => {
    expect(consoleCloseIsGracefulOnHost({} as unknown as AgentParser)).toBe(false);
    expect(consoleCloseIsGracefulOnHost(undefined)).toBe(false);
  });
});
