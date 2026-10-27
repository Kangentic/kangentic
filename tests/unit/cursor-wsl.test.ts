/**
 * A Cursor installed in a WSL distro (#286).
 *
 * Cursor takes Kangentic's MCP server only from a workspace `.cursor/mcp.json`,
 * whose entry is STATIC (`${env:...}` references), so sibling sessions write
 * the same bytes. A distro on NAT networking cannot reach this machine's
 * loopback and gets the hook transport's stdio bridge instead of the URL
 * entry. These pin that each reference in the entry written is a variable the
 * session's environment carries, that this machine's sessions keep exactly the
 * URL entry and the two variables they had, that `about` asks the session's
 * own CLI, and that a Knowledge Graph answer from the distro writes its
 * bridge entry into its own workspace, never the one a Cursor on this machine
 * reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executed = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[] }>);
const started = vi.hoisted(() => [] as Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>);
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  return {
    ...actual,
    execFileAsync: async (file: string, args: readonly string[] = []) => {
      executed.push({ file, args });
      return { stdout: '{"model":"Composer 2"}', stderr: '' };
    },
  };
});
vi.mock('../../src/main/utility-process/off-main-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-cli')>();
  return {
    ...actual,
    spawnOffMainCli: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      started.push({ command, args, cwd: options.cwd, env: options.env });
      throw new Error('stopped at the start, as the test intends');
    },
  };
});
const FACTS = vi.hoisted(() => ({
  distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as 'nat' | 'mirrored',
}));
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  return { ...actual, resolveWslDistroFacts: async () => FACTS, peekWslDistroFacts: () => FACTS };
});

import { CursorAdapter } from '../../src/main/agent/adapters/cursor';
import {
  CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY,
  CURSOR_KANGENTIC_MCP_ENTRY,
  cursorAnswerHome,
} from '../../src/main/agent/adapters/cursor/answer-workspace';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1';
const MCP_TOKEN = 'token-not-for-argv';
const realPlatform = process.platform;
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function targetOn(networkingMode: 'nat' | 'mirrored'): CliTarget {
  return { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/cursor-agent', facts: { ...FACTS, networkingMode } };
}

function sessionOptions(cliTarget: CliTarget | null): SpawnCommandOptions {
  const projectFolder = makeDirectory('kangentic-cursor-wsl-project-');
  const sessionDirectory = makeDirectory('kangentic-cursor-wsl-session-');
  return {
    agentPath: cliTarget ? '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\cursor-agent' : '/opt/cursor/cursor-agent',
    taskId: 'task-1',
    cwd: projectFolder,
    permissionMode: 'bypassPermissions',
    shell: cliTarget ? 'wsl -d Ubuntu' : 'bash',
    prompt: 'Fix the login race',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: MCP_TOKEN,
    ptySessionId: 'pty-1',
    ...(cliTarget ? { cliTarget } : {}),
  };
}

function readEntry(folder: string): unknown {
  const config = JSON.parse(fs.readFileSync(path.join(folder, '.cursor', 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
  return config.mcpServers.kangentic;
}

/** Every `${env:NAME}` the entry holds. */
function referencedVariables(entry: unknown): string[] {
  return [...JSON.stringify(entry).matchAll(/\$\{env:([A-Z_]+)\}/g)].map((match) => match[1]);
}

beforeEach(() => {
  executed.length = 0;
  started.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('a Cursor session in a WSL distro', () => {
  it('on NAT networking starts the Linux path and writes the bridge entry, whose every reference the session carries', () => {
    const adapter = new CursorAdapter();
    const target = targetOn('nat');
    const options = sessionOptions(target);
    const command = adapter.buildCommand(options);
    const environment = adapter.buildEnv(options) ?? {};
    const sessionDirectory = path.dirname(options.eventsOutputPath!);

    expect(command.startsWith('/home/dev/.local/bin/cursor-agent ')).toBe(true);
    expect(command).toContain('--approve-mcps');
    expect(command).not.toContain(MCP_TOKEN);

    const entry = readEntry(options.cwd);
    expect(entry).toEqual({
      command: 'sh',
      args: ['${env:KANGENTIC_MCP_BRIDGE_SCRIPT}', 'mcp', '${env:KANGENTIC_MCP_URL}'],
      env: { KANGENTIC_MCP_TOKEN: '${env:KANGENTIC_MCP_TOKEN}' },
    });
    expect(JSON.stringify(entry)).not.toContain(MCP_TOKEN);
    for (const name of referencedVariables(entry)) expect(Object.keys(environment), name).toContain(name);

    // The script it names is the one the session's relay watches.
    expect(environment.KANGENTIC_MCP_BRIDGE_SCRIPT).toBe(cliPathForTarget(wslHookPaths(sessionDirectory).script, target));
    expect(fs.existsSync(wslHookPaths(sessionDirectory).script)).toBe(true);
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);

    adapter.removeHooks(options.cwd, 'pty-1');
    expect(fs.existsSync(path.join(options.cwd, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('on mirrored networking keeps the URL entry, which reaches this machine from the distro', () => {
    const adapter = new CursorAdapter();
    const options = sessionOptions(targetOn('mirrored'));
    adapter.buildCommand(options);
    const environment = adapter.buildEnv(options) ?? {};

    expect(readEntry(options.cwd)).toEqual(CURSOR_KANGENTIC_MCP_ENTRY);
    for (const name of referencedVariables(CURSOR_KANGENTIC_MCP_ENTRY)) expect(Object.keys(environment), name).toContain(name);
  });

  it('on this machine writes the URL entry and passes exactly the two variables it always did', () => {
    const adapter = new CursorAdapter();
    const options = sessionOptions(null);
    const command = adapter.buildCommand(options);

    expect(command.startsWith('/opt/cursor/cursor-agent ')).toBe(true);
    expect(readEntry(options.cwd)).toEqual(CURSOR_KANGENTIC_MCP_ENTRY);
    expect(adapter.buildEnv(options)).toEqual({ KANGENTIC_MCP_URL: MCP_URL, KANGENTIC_MCP_TOKEN: MCP_TOKEN });
    expect(fs.existsSync(wslHookPaths(path.dirname(options.eventsOutputPath!)).directory)).toBe(false);
  });

  it('every reference in the bridge entry is one the bridge reads or a session sets', () => {
    expect(referencedVariables(CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY).sort()).toEqual(
      ['KANGENTIC_MCP_BRIDGE_SCRIPT', 'KANGENTIC_MCP_TOKEN', 'KANGENTIC_MCP_URL'],
    );
  });
});

describe('the model a Cursor session reports at start (about)', () => {
  async function aboutCall(adapter: CursorAdapter): Promise<{ file: string; args: readonly string[] }> {
    const applied = new Promise<void>((resolve) => {
      adapter.attachSession({ sessionId: 'pty-1', applyUsage: () => resolve() });
    });
    await applied;
    expect(executed).toHaveLength(1);
    return executed[0];
  }

  it('asks the distro\'s Cursor through wsl.exe for a session started from it', async () => {
    const adapter = new CursorAdapter();
    adapter.buildCommand(sessionOptions(targetOn('nat')));
    const call = await aboutCall(adapter);
    expect(call.file.endsWith('wsl.exe')).toBe(true);
    expect(call.args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
    expect(call.args).toContain('/home/dev/.local/bin/cursor-agent');
    expect(call.args.slice(-3)).toEqual(['about', '--format', 'json']);
  });

  it('asks the CLI the session was started with on this machine, not the one on PATH', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const adapter = new CursorAdapter();
    adapter.buildCommand(sessionOptions(null));
    const call = await aboutCall(adapter);
    expect(call).toEqual({ file: '/opt/cursor/cursor-agent', args: ['about', '--format', 'json'] });
  });
});

describe('a Knowledge Graph answer from a Cursor in a WSL distro on NAT networking', () => {
  it('writes the bridge entry into its own workspace and leaves the shared answer home\'s alone', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const answerHome = makeDirectory('kangentic-cursor-wsl-answer-home-');
    const runDirectory = makeDirectory('kangentic-cursor-wsl-answer-run-');
    const target = targetOn('nat');

    await expect(new CursorAdapter().answerFromContext(
      'What changed?',
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\cursor-agent',
      answerHome,
      null,
      { retrieval: { url: MCP_URL, token: MCP_TOKEN }, runDirectory },
    )).rejects.toThrow();

    const workspace = cursorAnswerHome(answerHome, target);
    expect(path.dirname(workspace)).toBe(answerHome);
    expect(readEntry(workspace)).toEqual(CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY);
    expect(fs.existsSync(path.join(answerHome, '.cursor'))).toBe(false);
    expect(fs.existsSync(wslHookPaths(runDirectory).signal)).toBe(true);

    expect(started).toHaveLength(1);
    const run = started[0];
    expect(run.command.endsWith('wsl.exe')).toBe(true);
    expect(run.cwd).toBe(workspace);
    expect(run.args).toContain('--approve-mcps');
    expect(run.args.join(' ')).not.toContain(MCP_TOKEN);
    expect(run.env.KANGENTIC_MCP_BRIDGE_SCRIPT).toBe(cliPathForTarget(wslHookPaths(runDirectory).script, target));
    expect(run.env.KANGENTIC_MCP_TOKEN).toBe(MCP_TOKEN);
    expect(run.env.WSLENV).toContain('KANGENTIC_MCP_BRIDGE_SCRIPT/u');
  });
});
