/**
 * A Gemini CLI installed in a WSL distro (#286).
 *
 * Gemini's `.gemini/settings.json` is shared by every session in a folder, so
 * nothing in it may name one session's path: the hooks call the folder's copy
 * of the WSL hook transport's script (which finds the session's folder through
 * `KANGENTIC_WSL_HOOK_DIR`), and on NAT networking the MCP entry is the
 * transport's stdio bridge with every value an env reference the session's own
 * environment fills. Trust, chats and the answer chat's cleanup read the
 * distro's Gemini directory, keyed by the `/mnt` cwd and compared with Linux case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { geminiChatsDir } from '../../src/main/agent/adapters/gemini/session-history-parser';
import { geminiHomeDir } from '../../src/main/agent/adapters/gemini/gemini-home';
import { ensureWorktreeTrust, removeWorktreeTrust } from '../../src/main/agent/adapters/gemini/trust-manager';
import { removeGeminiChat } from '../../src/main/agent/adapters/gemini/answer-stream';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const TOKEN = 'gemini-wsl-token-0123456789';
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
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/gemini',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget, project: string, sessionName: string): SpawnCommandOptions {
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', sessionName);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\gemini',
    taskId: 'task-1',
    cwd: project,
    projectRoot: project,
    permissionMode: 'default',
    shell: 'wsl -d Ubuntu',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: sessionName,
    cliTarget,
  };
}

interface GeminiSettingsFile {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  mcpServers: Record<string, unknown>;
}

function readSettings(project: string): GeminiSettingsFile {
  return JSON.parse(fs.readFileSync(path.join(project, '.gemini', 'settings.json'), 'utf-8')) as GeminiSettingsFile;
}

function hookCommands(settings: GeminiSettingsFile): string[] {
  return Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

/** Every `${NAME}` the entry holds. */
function referencedVariables(entry: unknown): string[] {
  return [...JSON.stringify(entry).matchAll(/\$\{([A-Z_]+)\}/g)].map((match) => match[1]);
}

describe('a Gemini session in a WSL distro', () => {
  it('starts the Linux path and hooks through the folder\'s copy of the transport script, the same for every session', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-gemini-wsl-project-');
    const adapter = new GeminiAdapter();

    const command = adapter.buildCommand(sessionOptions(target, project, 'session-1'));
    expect(command.startsWith('/home/dev/.local/bin/gemini')).toBe(true);
    const firstCommands = hookCommands(readSettings(project));

    const folderCopy = path.join(project, '.kangentic', 'gemini-wsl-hook.sh');
    expect(fs.existsSync(folderCopy)).toBe(true);
    expect(firstCommands.length).toBeGreaterThan(0);
    for (const hookCommand of firstCommands) {
      expect(hookCommand, hookCommand).toContain(cliPathForTarget(folderCopy, target));
      expect(hookCommand).not.toContain('event-bridge');
      expect(hookCommand).not.toContain('session-1');
      expect(hookCommand).not.toContain('</dev/null');
    }
    expect(firstCommands.some((hookCommand) => hookCommand.includes(' reply background-shell-hint '))).toBe(true);

    // A sibling session in the folder writes the same hooks.
    adapter.buildCommand(sessionOptions(target, project, 'session-2'));
    expect(hookCommands(readSettings(project))).toEqual(firstCommands);
  });

  it('on NAT networking writes the bridge entry, whose every reference the session\'s environment carries', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-gemini-wsl-project-');
    const options = sessionOptions(target, project, 'session-1');
    const adapter = new GeminiAdapter();
    adapter.buildCommand(options);
    const environment = adapter.buildEnv(options) ?? {};
    const sessionDirectory = path.dirname(options.eventsOutputPath!);

    const entry = readSettings(project).mcpServers.kangentic;
    expect(entry).toEqual({
      command: 'sh',
      args: ['${KANGENTIC_MCP_BRIDGE_SCRIPT}', 'mcp', '${KANGENTIC_MCP_URL}'],
      env: { KANGENTIC_MCP_TOKEN: '${KANGENTIC_MCP_TOKEN}' },
    });
    expect(JSON.stringify(readSettings(project))).not.toContain(TOKEN);
    for (const name of referencedVariables(entry)) expect(Object.keys(environment), name).toContain(name);
    expect(environment.KANGENTIC_MCP_BRIDGE_SCRIPT).toBe(cliPathForTarget(wslHookPaths(sessionDirectory).script, target));
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('on mirrored networking keeps the URL entry', () => {
    const project = makeDirectory('kangentic-gemini-wsl-project-');
    new GeminiAdapter().buildCommand(sessionOptions(targetOn('mirrored'), project, 'session-1'));
    expect(readSettings(project).mcpServers.kangentic).toEqual({
      httpUrl: '${KANGENTIC_MCP_URL}',
      headers: { 'X-Kangentic-Token': '${KANGENTIC_MCP_TOKEN}' },
    });
  });
});

describe('Gemini\'s own files for a Gemini in a WSL distro', () => {
  it('are under the distro\'s Gemini directory, inside its GEMINI_CLI_HOME when set', () => {
    expect(geminiChatsDir('C:\\Users\\dev\\Proj', targetOn('nat'))).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.gemini', 'tmp', 'proj', 'chats'),
    );
    expect(geminiHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev', { GEMINI_CLI_HOME: '/opt/gemini-home' })))
      .toBe(path.join('\\\\wsl.localhost\\Ubuntu\\opt\\gemini-home', '.gemini'));
  });

  it('trust is keyed by the /mnt path in the distro\'s file, an ancestor matches with Linux case, and removal needs the place', async () => {
    const distroHome = makeDirectory('kangentic-gemini-wsl-home-');
    const target = targetOn('nat', distroHome);
    const trustFile = path.join(distroHome, '.gemini', 'trustedFolders.json');
    const project = path.join(makeDirectory('kangentic-gemini-wsl-project-'), 'Repo');
    const worktree = path.join(project, '.kangentic', 'worktrees', '1');
    const projectKey = cliPathForTarget(path.resolve(project), target);
    const worktreeKey = cliPathForTarget(path.resolve(worktree), target);

    // An ancestor trusted under other casing is a different directory on Linux.
    fs.mkdirSync(path.dirname(trustFile), { recursive: true });
    fs.writeFileSync(trustFile, JSON.stringify({ [projectKey.toLowerCase()]: 'TRUST_FOLDER' }));
    await ensureWorktreeTrust(worktree, target);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))[worktreeKey]).toBe('TRUST_FOLDER');

    await removeWorktreeTrust(worktree);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))[worktreeKey]).toBe('TRUST_FOLDER');
    await removeWorktreeTrust(worktree, target);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))[worktreeKey]).toBeUndefined();

    // The ancestor at the exact case covers the worktree, so nothing is written.
    fs.writeFileSync(trustFile, JSON.stringify({ [projectKey]: 'TRUST_FOLDER' }));
    await ensureWorktreeTrust(worktree, target);
    expect(JSON.parse(fs.readFileSync(trustFile, 'utf-8'))).toEqual({ [projectKey]: 'TRUST_FOLDER' });
  });

  it('an answer\'s chat is removed from the distro, found through the registry under the /mnt cwd', async () => {
    const distroHome = makeDirectory('kangentic-gemini-wsl-home-');
    const target = targetOn('nat', distroHome);
    const answerHome = makeDirectory('kangentic-gemini-wsl-ask-');
    const sessionId = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
    const geminiDirectory = path.join(distroHome, '.gemini');
    fs.mkdirSync(path.join(geminiDirectory, 'tmp', 'ask-slug', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(geminiDirectory, 'projects.json'), JSON.stringify({ projects: { [cliPathForTarget(answerHome, target)]: 'ask-slug' } }));
    const chat = path.join(geminiDirectory, 'tmp', 'ask-slug', 'chats', `session-2026-10-27T12-00-${sessionId.slice(0, 8)}.jsonl`);
    fs.writeFileSync(chat, '{}\n');

    await removeGeminiChat(answerHome, sessionId, target);
    expect(fs.existsSync(chat)).toBe(false);
  });
});
