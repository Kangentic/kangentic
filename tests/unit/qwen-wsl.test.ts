/**
 * A Qwen Code installed in a WSL distro (#286): started by its Linux path, its
 * `.qwen/settings.json` hooks publishing through the WSL hook transport (a
 * distro may have no node), Kangentic's server given as the transport's stdio
 * bridge on NAT networking, and its trust, chats and `QWEN_HOME` read in the
 * distro, keyed by the `/mnt` cwd with Linux case.
 *
 * Qwen passes a hook its payload on stdin and closes it (Qwen's hooks docs:
 * "Input JSON is passed through stdin"), so unlike Aider's notification command
 * these hooks keep stdin: the real-sh case proves the payload reaches the record.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { qwenHomeDir } from '../../src/main/agent/adapters/qwen-code/qwen-home';
import { ensureWorktreeTrust, removeWorktreeTrust } from '../../src/main/agent/adapters/qwen-code/trust-manager';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { parseWslHookRecord, prepareWslHookTransport, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const TOKEN = 'qwen-wsl-token-0123456789';
// Names a task session as the caller, so the session is offered the hint's tool.
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function targetOn(networkingMode: 'nat' | 'mirrored', homeUnc = '\\\\wsl.localhost\\Ubuntu\\home\\dev', env: Record<string, string> = {}): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/qwen',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget): SpawnCommandOptions {
  const project = makeDirectory('kangentic-qwen-wsl-project-');
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', 'session-1');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\qwen',
    taskId: 'task-1',
    cwd: project,
    projectRoot: project,
    permissionMode: 'default',
    shell: 'wsl -d Ubuntu',
    statusOutputPath: path.join(sessionDirectory, 'status.json'),
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: 'session-1',
    cliTarget,
  };
}

interface QwenSettingsFile {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ name: string; command: string }> }>>;
}

describe('a Qwen session in a WSL distro', () => {
  it('starts the Linux path, hands --mcp-config the distro path of a bridge entry, and hooks through the transport', () => {
    const target = targetOn('nat');
    const options = sessionOptions(target);
    const sessionDirectory = path.dirname(options.eventsOutputPath!);
    const command = new QwenAdapter().buildCommand(options);

    expect(command.startsWith('/home/dev/.local/bin/qwen ')).toBe(true);
    expect(command).toContain(cliPathForTarget(path.join(sessionDirectory, 'mcp.json'), target));
    expect(command).not.toContain(TOKEN);

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers.kangentic).toEqual({
      command: 'sh',
      args: [cliPathForTarget(wslHookPaths(sessionDirectory).script, target), 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: TOKEN },
    });

    const settings = JSON.parse(fs.readFileSync(path.join(options.cwd, '.qwen', 'settings.json'), 'utf-8')) as QwenSettingsFile;
    const commands = Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.length).toBeGreaterThan(0);
    // The file is shared by every session in the folder, so the hooks name the
    // folder's copy of the script, never this session's own folder.
    const folderCopy = path.join(options.cwd, '.kangentic', 'qwen-wsl-hook.sh');
    expect(fs.existsSync(folderCopy)).toBe(true);
    for (const hookCommand of commands) {
      expect(hookCommand, hookCommand).toContain(cliPathForTarget(folderCopy, target));
      expect(hookCommand).not.toContain('session-1');
      expect(hookCommand).not.toContain('event-bridge');
      // The payload arrives on stdin, so stdin is never closed for it.
      expect(hookCommand).not.toContain('</dev/null');
    }
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/ event idle /);
    expect(commands.some((hookCommand) => hookCommand.includes(' reply background-shell-hint '))).toBe(true);
    expect(fs.existsSync(path.join(options.cwd, '.kangentic', 'qwen-event-bridge.cjs'))).toBe(false);
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('on mirrored networking gives the URL entry', () => {
    const options = sessionOptions(targetOn('mirrored'));
    new QwenAdapter().buildCommand(options);
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(path.dirname(options.eventsOutputPath!), 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers.kangentic).toEqual({ httpUrl: MCP_URL, headers: { 'X-Kangentic-Token': TOKEN } });
  });
});

describe('Qwen\'s own files for a Qwen in a WSL distro', () => {
  it('are under the distro\'s Qwen directory, its QWEN_HOME when set, slugged from the /mnt cwd with case kept', () => {
    const target = targetOn('nat');
    expect(qwenChatsDir('C:\\Users\\dev\\Proj', target)).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.qwen', 'projects', '-mnt-c-Users-dev-Proj', 'chats'),
    );
    expect(qwenHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev', { QWEN_HOME: '~/qwen-alt' }))).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\qwen-alt');
    expect(qwenHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev', { QWEN_HOME: '/opt/qwen' }))).toBe('\\\\wsl.localhost\\Ubuntu\\opt\\qwen');
  });

  it('trust is written and removed in the distro\'s file, keyed by the /mnt path, and only with that place', async () => {
    const distroHome = makeDirectory('kangentic-qwen-wsl-home-');
    const target = targetOn('nat', distroHome);
    fs.mkdirSync(path.join(distroHome, '.qwen'));
    fs.writeFileSync(path.join(distroHome, '.qwen', 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    const worktree = path.join(makeDirectory('kangentic-qwen-wsl-project-'), '.kangentic', 'worktrees', '1');
    const trustFile = path.join(distroHome, '.qwen', 'trustedFolders.json');
    const key = cliPathForTarget(path.resolve(worktree), target);

    await ensureWorktreeTrust(worktree, target);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))).toEqual({ [key]: 'TRUST_FOLDER' });

    await removeWorktreeTrust(worktree);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))).toEqual({ [key]: 'TRUST_FOLDER' });
    await removeWorktreeTrust(worktree, target);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))).toEqual({});
  });
});

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.runIf(shAvailable)('a Qwen hook command under a real sh (needs sh)', () => {
  it('publishes the payload Qwen writes on stdin, then closes, into the record', async () => {
    const paths = prepareWslHookTransport(makeDirectory('kangentic-qwen-wsl-sh-'));
    const payload = '{"session_id":"abc","hook_event_name":"Stop"}';
    const child = spawn('sh', [paths.script.replace(/\\/g, '/'), 'event', 'idle'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(payload);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 5_000);
      child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code).toBe(0);
    const records = fs.readdirSync(paths.inbox).filter((name) => name.endsWith('.rec'));
    expect(records).toHaveLength(1);
    const record = parseWslHookRecord(fs.readFileSync(path.join(paths.inbox, records[0]), 'utf-8'));
    expect(record?.head).toBe('idle');
    expect(record?.stdin).toBe(payload);
  });
});

describe.skipIf(shAvailable)('a Qwen hook command under a real sh', () => {
  it.skip('needs sh on PATH (Git Bash on Windows); CI\'s Linux runner has it', () => undefined);
});
