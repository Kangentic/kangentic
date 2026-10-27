/**
 * A Droid installed in a WSL distro (#286): started by its Linux path with its
 * `--cwd` in the distro's form, given Kangentic's server as the WSL hook
 * transport's bridge on NAT networking (the distro's loopback is its own), and
 * read back from the distro's `~/.factory/sessions/<slug of the /mnt cwd>/`.
 * A Droid on this machine keeps the URL entry and the paths it had.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { captureSessionIdFromFilesystem, droidSessionsDirForCwd } from '../../src/main/agent/adapters/droid/session-id-capture';
import { droidTranscriptFilePath } from '../../src/main/agent/adapters/droid/transcript-parser';
import { cliPathForTarget, toStoredCliTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1';
const MCP_TOKEN = 'token-not-for-disk';
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function targetOn(networkingMode: 'nat' | 'mirrored', homeUnc = '\\\\wsl.localhost\\Ubuntu\\home\\dev'): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/droid',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget | null): SpawnCommandOptions {
  const sessionDirectory = makeDirectory('kangentic-droid-wsl-session-');
  return {
    agentPath: cliTarget ? '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\droid' : '/usr/local/bin/droid',
    taskId: 'task-1',
    cwd: makeDirectory('kangentic-droid-wsl-project-'),
    permissionMode: 'default',
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
  const text = fs.readFileSync(path.join(folder, '.factory', 'mcp.json'), 'utf-8');
  expect(text).not.toContain(MCP_TOKEN);
  return (JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers.kangentic;
}

describe('a Droid session in a WSL distro', () => {
  it('on NAT networking starts the Linux path in the distro\'s cwd and writes the bridge entry', () => {
    const target = targetOn('nat');
    const options = sessionOptions(target);
    const sessionDirectory = path.dirname(options.eventsOutputPath!);
    const command = new DroidAdapter().buildCommand(options);

    expect(command.startsWith('/home/dev/.local/bin/droid --cwd ')).toBe(true);
    expect(command).toContain(cliPathForTarget(options.cwd, target));
    expect(command).not.toContain(MCP_TOKEN);
    expect(readEntry(options.cwd)).toEqual({
      type: 'stdio',
      command: 'sh',
      args: [cliPathForTarget(wslHookPaths(sessionDirectory).script, target), 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: '${KANGENTIC_MCP_TOKEN}' },
    });
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
    // The bridge reads the token from the variable the entry names.
    expect(new DroidAdapter().buildEnv(options)).toEqual({ KANGENTIC_MCP_TOKEN: MCP_TOKEN });
  });

  it('on mirrored networking keeps the URL entry', () => {
    const options = sessionOptions(targetOn('mirrored'));
    new DroidAdapter().buildCommand(options);
    expect(readEntry(options.cwd)).toEqual({ type: 'http', url: MCP_URL, headers: { 'X-Kangentic-Token': '${KANGENTIC_MCP_TOKEN}' } });
  });

  it('on this machine keeps the URL entry, the forward-slash cwd and no hook folder', () => {
    const options = sessionOptions(null);
    const command = new DroidAdapter().buildCommand(options);
    expect(command.startsWith(`/usr/local/bin/droid --cwd ${quoteArg(toForwardSlash(options.cwd), 'bash')}`)).toBe(true);
    expect(readEntry(options.cwd)).toEqual({ type: 'http', url: MCP_URL, headers: { 'X-Kangentic-Token': '${KANGENTIC_MCP_TOKEN}' } });
    expect(fs.existsSync(wslHookPaths(path.dirname(options.eventsOutputPath!)).directory)).toBe(false);
  });
});

describe('Droid\'s session files for a Droid in a WSL distro', () => {
  it('sit in the distro\'s home under the slug of the /mnt cwd', () => {
    const target = targetOn('nat');
    expect(droidSessionsDirForCwd('C:\\Users\\dev\\project', target)).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.factory', 'sessions', '-mnt-c-Users-dev-project'),
    );
    expect(droidTranscriptFilePath('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', 'C:\\Users\\dev\\project', target)).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.factory', 'sessions', '-mnt-c-Users-dev-project', '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f.jsonl'),
    );
    // This machine's slug is unchanged.
    expect(droidSessionsDirForCwd('C:\\Users\\dev\\project')).toBe(path.join(os.homedir(), '.factory', 'sessions', '-C-Users-dev-project'));
  });

  it('give the session id a new distro session wrote, read from the stored target', async () => {
    const distroHome = makeDirectory('kangentic-droid-wsl-home-');
    const target = targetOn('nat', distroHome);
    const cwd = makeDirectory('kangentic-droid-wsl-cwd-');
    const sessionId = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
    const sessionsDirectory = droidSessionsDirForCwd(cwd, target);
    fs.mkdirSync(sessionsDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionsDirectory, `${sessionId}.jsonl`), '{"type":"session_start"}\n');

    const captured = await captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd, cliTarget: toStoredCliTarget(target), maxAttempts: 1 });
    expect(captured).toBe(sessionId);
    expect(await new DroidAdapter().locateSessionHistoryFile(sessionId, cwd, target)).toBe(path.join(sessionsDirectory, `${sessionId}.jsonl`));
  });
});
