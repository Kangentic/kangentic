/**
 * An OpenCode installed in a WSL distro (#286).
 *
 * The session starts the distro's binary; the activity plugin is a file in the
 * project, so only the MCP entry changes: on NAT networking Kangentic's server
 * is the WSL hook transport's bridge, as OpenCode's `local` entry. The
 * distro's sessions live in its own SQLite database, which is never opened over
 * the share: the session id, the transcript and the auto_command check ask the
 * distro's CLI (`session list`, `export`) through `wsl.exe`. Every run is
 * caught here, `process.platform` is faked as win32 and the distro's facts are
 * a fixture, so this runs on every OS and starts no process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executed = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);
const answers = vi.hoisted(() => ({ stdout: '' }));
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  return {
    ...actual,
    execFileAsync: async (file: string, args: string[]) => {
      executed.push({ file, args });
      return { stdout: answers.stdout, stderr: '' };
    },
  };
});

const distroHome = vi.hoisted(() => ({ path: '' }));
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  const facts = () => ({
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome.path, uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
  });
  return { ...actual, resolveWslDistroFacts: async () => facts(), peekWslDistroFacts: () => facts() };
});

import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import {
  captureDistroOpenCodeSessionId,
  parseOpenCodeExport,
  parseOpenCodeSessionList,
  type DistroOpenCodeSession,
} from '../../src/main/agent/adapters/opencode/distro-sessions';
import { createOpenCodeCommandInjectionVerifier, findOpenCodeSubmittedTextInMessages } from '../../src/main/agent/adapters/opencode/command-injection-verifier';
import { cliPathForTarget, placeFromStored, toStoredCliTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { OpenCodeRemoteMessageEntry } from '../../src/main/agent/adapters/opencode/remote-client';

const TOKEN = 'opencode-wsl-token-0123456789';
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.opencode\\bin\\opencode';
const SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';
const realPlatform = process.platform;
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  executed.length = 0;
  answers.stdout = '';
  distroHome.path = makeDirectory('kangentic-opencode-wsl-home-');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function targetOn(networkingMode: 'nat' | 'mirrored'): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.opencode/bin/opencode',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome.path, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget): SpawnCommandOptions {
  const project = makeDirectory('kangentic-opencode-wsl-project-');
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', 'session-1');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: CLI_PATH,
    taskId: 'task-1',
    cwd: project,
    permissionMode: 'acceptEdits',
    shell: 'wsl -d Ubuntu',
    statusOutputPath: path.join(sessionDirectory, 'status.json'),
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: 'session-1',
    cliTarget,
  };
}

function configOf(env: Record<string, string> | null): { mcp: Record<string, unknown> } {
  return JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}') as { mcp: Record<string, unknown> };
}

function exportOf(messages: OpenCodeRemoteMessageEntry[]): string {
  return JSON.stringify({ info: { id: SESSION_ID }, messages });
}

const USER_TURN: OpenCodeRemoteMessageEntry = {
  info: { id: 'msg_user', role: 'user', time: { created: 2_000 } },
  parts: [{ type: 'text', text: 'run the tests' }],
};
const ASSISTANT_TURN: OpenCodeRemoteMessageEntry = {
  info: { id: 'msg_assistant', role: 'assistant', time: { created: 3_000 } },
  parts: [{ type: 'step-start' }, { type: 'text', text: 'All green.' }],
};

describe('an OpenCode session in a WSL distro', () => {
  it('starts the Linux path, and on NAT names the bridge as a local server with the token in its environment', () => {
    const adapter = new OpenCodeAdapter();
    const target = targetOn('nat');
    const options = sessionOptions(target);
    const command = adapter.buildCommand(options);
    expect(command.startsWith('/home/dev/.opencode/bin/opencode ')).toBe(true);
    expect(command).not.toContain(TOKEN);

    const script = cliPathForTarget(wslHookPaths(path.dirname(options.eventsOutputPath!)).script, target);
    expect(configOf(adapter.buildEnv(options)).mcp.kangentic).toEqual({
      type: 'local',
      command: ['sh', script, 'mcp', MCP_URL],
      environment: { KANGENTIC_MCP_TOKEN: TOKEN },
      enabled: true,
    });
  });

  it('on mirrored networking keeps the remote entry', () => {
    const adapter = new OpenCodeAdapter();
    expect(configOf(adapter.buildEnv(sessionOptions(targetOn('mirrored')))).mcp.kangentic).toEqual({
      type: 'remote', url: MCP_URL, enabled: true, headers: { 'X-Kangentic-Token': TOKEN },
    });
  });

  it('reads the transcript from the distro CLI\'s export, never this machine\'s database', async () => {
    answers.stdout = exportOf([USER_TURN, ASSISTANT_TURN]);
    const place = placeFromStored(toStoredCliTarget(targetOn('nat')));
    const parsed = await new OpenCodeAdapter().parseTranscript(SESSION_ID, 'C:\\Users\\dev\\project', place);
    expect(parsed.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
    expect(executed).toHaveLength(1);
    expect(path.basename(executed[0].file).toLowerCase()).toBe('wsl.exe');
    expect(executed[0].args.slice(-3)).toEqual(['export', SESSION_ID, '--pure']);
    expect(executed[0].args).toContain('/home/dev/.opencode/bin/opencode');
  });

  it('reads nothing for a session row from before the CLI path was kept', async () => {
    const stored = toStoredCliTarget(targetOn('nat'));
    const place = placeFromStored({ ...stored!, linuxCliPath: undefined });
    const parsed = await new OpenCodeAdapter().parseTranscript(SESSION_ID, 'C:\\Users\\dev\\project', place);
    expect(parsed.entries).toEqual([]);
    expect(executed).toHaveLength(0);
  });

  it('has no history file to hand off and no pages to read', async () => {
    const adapter = new OpenCodeAdapter();
    const place = placeFromStored(toStoredCliTarget(targetOn('nat')));
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, 'C:\\Users\\dev\\project', place)).resolves.toBeNull();
    await expect(adapter.readTranscriptPage(SESSION_ID, 'C:\\Users\\dev\\project', { direction: 'before', cursor: '', limit: 10 } as never, place))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported_agent' });
  });

  it('reads the sign-in from the distro\'s data home', async () => {
    const adapter = new OpenCodeAdapter();
    await expect(adapter.probeAuth(CLI_PATH)).resolves.toBe(false);
    fs.mkdirSync(path.join(distroHome.path, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(distroHome.path, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'api' } }));
    await expect(adapter.probeAuth(CLI_PATH)).resolves.toBe(true);
  });
});

describe('the distro CLI\'s session output', () => {
  it('parses a session list, and reads no output (no sessions yet) as none', () => {
    expect(parseOpenCodeSessionList('')).toEqual([]);
    expect(parseOpenCodeSessionList('not json')).toEqual([]);
    expect(parseOpenCodeSessionList(JSON.stringify([
      { id: SESSION_ID, title: 't', updated: 2, created: 1, projectId: 'p', directory: '/mnt/c/work' },
      { id: 42 },
    ]))).toEqual([{ id: SESSION_ID, directory: '/mnt/c/work', created: 1 }]);
  });

  it('parses an export, skipping anything before its JSON', () => {
    expect(parseOpenCodeExport(`Exporting session\n${exportOf([USER_TURN])}`)).toEqual([USER_TURN]);
    expect(parseOpenCodeExport('')).toEqual([]);
  });

  it('captures the newest session in the spawn\'s directory and window', async () => {
    const target = targetOn('nat');
    const spawnedAt = new Date(1_000_000);
    const directory = cliPathForTarget('C:\\Users\\dev\\project', target);
    const sessions: DistroOpenCodeSession[] = [
      { id: 'ses_other_directory_0000000', directory: '/mnt/c/Users/dev/elsewhere', created: 1_001_000 },
      { id: 'ses_before_the_spawn_000000', directory, created: 990_000 },
      { id: SESSION_ID, directory: directory.toUpperCase().replace('/MNT/', '/mnt/'), created: 1_002_000 },
    ];
    const list = vi.fn(async () => sessions);
    await expect(captureDistroOpenCodeSessionId({ spawnedAt, cwd: 'C:\\Users\\dev\\project', target, list, sleep: async () => undefined })).resolves.toBe(SESSION_ID);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('gives up after its attempts when no session appears', async () => {
    const list = vi.fn(async () => [] as DistroOpenCodeSession[]);
    await expect(captureDistroOpenCodeSessionId({
      spawnedAt: new Date(), cwd: 'C:\\Users\\dev\\project', target: targetOn('nat'), list, maxAttempts: 3, sleep: async () => undefined,
    })).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('the auto_command check for a distro session', () => {
  it('finds the submitted text among the exported user turns sent after it', () => {
    expect(findOpenCodeSubmittedTextInMessages([USER_TURN, ASSISTANT_TURN], 'run the tests', 1_990)).toBe(true);
    expect(findOpenCodeSubmittedTextInMessages([USER_TURN], 'run the tests', 5_000)).toBe(false);
    expect(findOpenCodeSubmittedTextInMessages([ASSISTANT_TURN], 'All green.', 0)).toBe(false);
  });

  it('exports the session in the distro, and checks nothing without the CLI path', async () => {
    const exportSession = vi.fn(async () => [USER_TURN]);
    const verifier = createOpenCodeCommandInjectionVerifier(exportSession);
    const stored = toStoredCliTarget(targetOn('nat'));
    const context = { type: 'command-injection' as const, text: 'run the tests', sentAt: 1_990, agentSessionId: SESSION_ID, cwd: 'C:\\Users\\dev\\project' };
    await expect(verifier({ ...context, cliTarget: stored })).resolves.toBe(true);
    expect(exportSession).toHaveBeenCalledWith(expect.objectContaining({ linuxCliPath: '/home/dev/.opencode/bin/opencode' }), SESSION_ID, 'C:\\Users\\dev\\project');
    await expect(verifier({ ...context, cliTarget: { ...stored!, linuxCliPath: undefined } })).resolves.toBe(false);
    expect(exportSession).toHaveBeenCalledTimes(1);
  });
});
