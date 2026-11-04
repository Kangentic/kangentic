/**
 * Goose's hook plugin (`src/main/agent/adapters/goose/hook-manager.ts`).
 *
 * Goose was not installed where this was written, so the payloads below are
 * the shapes Goose's hooks guide documents
 * (https://goose-docs.ai/docs/guides/context-engineering/hooks, "Hook Payload"):
 * snake_case `tool_name`, `tool_input`, `tool_call_id`. Each command is run
 * through the real event bridge, the way Goose's `sh -c` would run it, so a
 * directive that reads the wrong field fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildGooseHooks,
  goosePluginDirectory,
  gooseWindowsHookPath,
  removeGooseHooks,
  writeGooseHooks,
  GOOSE_EVENTS_PATH_ENV,
} from '../../src/main/agent/adapters/goose/hook-manager';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import { loadBetterSqlite3 } from '../../src/main/agent/shared/sqlite-loader';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { SessionUsage } from '../../src/shared/types';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let workDirectory: string;
let eventsFile: string;

beforeEach(() => {
  workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-hooks-'));
  eventsFile = path.join(workDirectory, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(workDirectory, { recursive: true, force: true });
});

/**
 * A bridge path with no space, backslash or drive letter, so the split below
 * finds it as one word on every OS. The real bridge (`BRIDGE`) is what runs;
 * a checkout path with a space would otherwise split into two words.
 */
const COMMAND_BRIDGE_PATH = '/bridge/event-bridge.js';

/**
 * Split a built hook command into the bridge's argv, past `node <bridge>`, the
 * way `sh -c` would: the builder quotes paths, and every directive is one bare
 * base64 token.
 */
function bridgeArguments(command: string): string[] {
  const words = (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
  if (words[0] !== 'node') throw new Error(`not a bridge command: ${command}`);
  return words.slice(2);
}

/** Run one event's command against a payload with `environment`, and return the events it wrote. */
function runHook(event: string, payload: object, environment: Record<string, string>): Array<Record<string, unknown>> {
  const command = buildGooseHooks(COMMAND_BRIDGE_PATH).hooks[event][0].hooks[0].command;
  execFileSync(process.execPath, [BRIDGE, ...bridgeArguments(command)], {
    input: JSON.stringify(payload),
    timeout: 5000,
    env: { ...process.env, ...environment },
  });
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('buildGooseHooks', () => {
  it('wires the documented events and no others', () => {
    expect(Object.keys(buildGooseHooks(BRIDGE).hooks).sort()).toEqual([
      'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit',
    ]);
  });

  it('gives every rule one command action with a timeout and no matcher, so it matches every call', () => {
    for (const rules of Object.values(buildGooseHooks(BRIDGE).hooks)) {
      expect(rules).toHaveLength(1);
      expect(rules[0].matcher).toBeUndefined();
      expect(rules[0].hooks).toEqual([expect.objectContaining({ type: 'command', timeout: 10 })]);
    }
  });

  it('routes every command through Goose\'s own events variable', () => {
    for (const rules of Object.values(buildGooseHooks(BRIDGE).hooks)) {
      expect(rules[0].hooks[0].command).toContain(`env:${GOOSE_EVENTS_PATH_ENV}`);
    }
  });

  it('builds a distro Goose\'s commands with the command it is handed', () => {
    const hooks = buildGooseHooks(BRIDGE, (eventType) => `sh copy event ${eventType}`).hooks;
    expect(hooks.Stop[0].hooks[0].command).toBe('sh copy event idle');
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('sh copy event tool_start');
  });
});

describe('Goose hook commands through the event bridge', () => {
  const environment = (): Record<string, string> => ({ [GOOSE_EVENTS_PATH_ENV]: eventsFile });

  it('reports a tool start with its name, call id and the file it acts on', () => {
    const events = runHook('PreToolUse', {
      event: 'PreToolUse',
      session_id: '20261103_1',
      matcher_context: 'write',
      tool_name: 'write',
      tool_input: { path: 'src/app.ts', content: 'x' },
      tool_call_id: 'call_1',
      working_dir: '/projects/my-app',
    }, environment());
    expect(events).toEqual([expect.objectContaining({ type: 'tool_start', tool: 'write', toolId: 'call_1', detail: 'src/app.ts' })]);
  });

  it('reads a shell call\'s command as its detail', () => {
    const events = runHook('PreToolUse', {
      event: 'PreToolUse',
      session_id: '20261103_1',
      tool_name: 'shell',
      tool_input: { command: 'rg TODO' },
      tool_call_id: 'call_2',
    }, environment());
    expect(events[0]).toMatchObject({ type: 'tool_start', tool: 'shell', detail: 'rg TODO' });
  });

  it('ends a tool by the same call id, on success and on failure', () => {
    runHook('PostToolUse', { event: 'PostToolUse', session_id: 's', tool_name: 'shell', tool_call_id: 'call_3' }, environment());
    const events = runHook('PostToolUseFailure', { event: 'PostToolUseFailure', session_id: 's', tool_name: 'edit', tool_call_id: 'call_4' }, environment());
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_end', tool: 'shell', toolId: 'call_3' }),
      expect.objectContaining({ type: 'tool_end', tool: 'edit', toolId: 'call_4' }),
    ]);
  });

  it('reports a prompt, a turn end, and the session\'s start and end', () => {
    runHook('SessionStart', { event: 'SessionStart', session_id: '20261103_1' }, environment());
    runHook('UserPromptSubmit', { event: 'UserPromptSubmit', session_id: '20261103_1', message: 'summarize this file' }, environment());
    runHook('Stop', { event: 'Stop', session_id: '20261103_1', last_assistant_message: 'Done.' }, environment());
    const events = runHook('SessionEnd', { event: 'SessionEnd', session_id: '20261103_1' }, environment());
    expect(events.map((event) => event.type)).toEqual(['session_start', 'prompt', 'idle', 'session_end']);
  });

  it('writes nothing for a Goose run without the variable (the user\'s own, or another agent loading the plugin)', () => {
    const events = runHook('Stop', { event: 'Stop', session_id: 's' }, { [GOOSE_EVENTS_PATH_ENV]: '' });
    expect(events).toEqual([]);
  });
});

describe('gooseWindowsHookPath', () => {
  const gitSh = 'C:\\Program Files\\Git\\bin\\sh.exe';
  const only = (...present: string[]) => (filePath: string): boolean => present.includes(filePath);

  it('appends Git for Windows\' bin folder under PATH\'s own spelling when sh is missing', () => {
    const environment = { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;', ProgramFiles: 'C:\\Program Files' };
    expect(gooseWindowsHookPath(environment, only(gitSh))).toEqual({
      Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin',
    });
  });

  it('changes nothing when sh is already on PATH (a Git Bash terminal)', () => {
    const environment = { PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows', ProgramFiles: 'C:\\Program Files' };
    expect(gooseWindowsHookPath(environment, only('C:\\Program Files\\Git\\usr\\bin\\sh.exe', gitSh))).toBeNull();
  });

  it('changes nothing without Git for Windows', () => {
    expect(gooseWindowsHookPath({ Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, only())).toBeNull();
  });

  it('finds a per-user install under LOCALAPPDATA', () => {
    const environment = { Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
    expect(gooseWindowsHookPath(environment, only('C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\sh.exe'))).toEqual({
      Path: 'C:\\Windows;C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin',
    });
  });
});

describe('writeGooseHooks and removeGooseHooks', () => {
  it('writes the plugin manifest and hooks file into .agents/plugins/kangentic-goose', () => {
    writeGooseHooks(workDirectory);
    const pluginDirectory = goosePluginDirectory(workDirectory);
    expect(pluginDirectory).toBe(path.join(workDirectory, '.agents', 'plugins', 'kangentic-goose'));
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'plugin.json'), 'utf-8')) as { name: string };
    expect(manifest.name).toBe('kangentic-goose');
    const hooksFile = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'hooks', 'hooks.json'), 'utf-8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(hooksFile.hooks)).toContain('Stop');
  });

  it('removes only its own plugin and keeps Antigravity\'s kangentic plugin beside it', () => {
    const antigravityPlugin = path.join(workDirectory, '.agents', 'plugins', 'kangentic');
    fs.mkdirSync(antigravityPlugin, { recursive: true });
    fs.writeFileSync(path.join(antigravityPlugin, 'plugin.json'), '{}');
    writeGooseHooks(workDirectory);
    removeGooseHooks(workDirectory);
    expect(fs.existsSync(goosePluginDirectory(workDirectory))).toBe(false);
    expect(fs.existsSync(path.join(antigravityPlugin, 'plugin.json'))).toBe(true);
  });

  it('folds up .agents when its plugin was the only thing in it', () => {
    writeGooseHooks(workDirectory);
    removeGooseHooks(workDirectory);
    expect(fs.existsSync(path.join(workDirectory, '.agents'))).toBe(false);
  });
});

describe('GooseAdapter hook holds', () => {
  function spawnOptions(ptySessionId: string): SpawnCommandOptions {
    return {
      agentPath: '/usr/bin/goose',
      taskId: 'task-1',
      cwd: workDirectory,
      permissionMode: 'default',
      shell: 'bash',
      ptySessionId,
      sessionId: `name-${ptySessionId}`,
      eventsOutputPath: path.join(workDirectory, 'sessions', ptySessionId, 'events.jsonl'),
    };
  }

  it('installs the plugin on a spawn and keeps it until the folder\'s last session releases', () => {
    const adapter = new GooseAdapter();
    adapter.buildCommand(spawnOptions('pty-1'));
    adapter.buildCommand(spawnOptions('pty-2'));
    const hooksFile = path.join(goosePluginDirectory(workDirectory), 'hooks', 'hooks.json');
    expect(fs.existsSync(hooksFile)).toBe(true);

    adapter.removeHooks(workDirectory, 'pty-1');
    expect(fs.existsSync(hooksFile)).toBe(true);
    adapter.removeHooks(workDirectory, 'pty-2');
    expect(fs.existsSync(hooksFile)).toBe(false);
  });

  it('installs nothing for a launch with no events file', () => {
    const adapter = new GooseAdapter();
    adapter.buildCommand({ ...spawnOptions('pty-1'), eventsOutputPath: undefined });
    expect(fs.existsSync(goosePluginDirectory(workDirectory))).toBe(false);
  });

  it('removes the plugin at once when no session id is given, even while a session holds it', () => {
    const adapter = new GooseAdapter();
    adapter.buildCommand(spawnOptions('pty-1'));
    const hooksFile = path.join(goosePluginDirectory(workDirectory), 'hooks', 'hooks.json');
    expect(fs.existsSync(hooksFile)).toBe(true);

    adapter.removeHooks(workDirectory);
    expect(fs.existsSync(goosePluginDirectory(workDirectory))).toBe(false);
  });

  describe('the launch record', () => {
    const previousRoot = process.env.GOOSE_PATH_ROOT;

    beforeEach(() => {
      process.env.GOOSE_PATH_ROOT = workDirectory;
      const DatabaseConstructor = loadBetterSqlite3();
      if (!DatabaseConstructor) throw new Error('better-sqlite3 failed to load');
      const databasePath = path.join(workDirectory, 'data', 'sessions', 'sessions.db');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseConstructor(databasePath);
      database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, total_tokens INTEGER)');
      const insert = database.prepare('INSERT INTO sessions (id, name, total_tokens) VALUES (?, ?, ?)');
      insert.run('20261103_1', 'name-pty-1', 1000);
      insert.run('20261103_2', 'name-pty-2', 2000);
      database.close();
    });

    afterEach(() => {
      if (previousRoot === undefined) delete process.env.GOOSE_PATH_ROOT;
      else process.env.GOOSE_PATH_ROOT = previousRoot;
    });

    it('is dropped with the session\'s hold, so a later attach for that session polls nothing', () => {
      const adapter = new GooseAdapter();
      adapter.buildCommand(spawnOptions('pty-1'));
      adapter.buildCommand(spawnOptions('pty-2'));

      adapter.removeHooks(workDirectory, 'pty-1');

      const abandoned: Array<Partial<SessionUsage>> = [];
      adapter.attachSession({ sessionId: 'pty-1', applyUsage: (usage) => abandoned.push(usage) }).dispose();
      expect(abandoned).toEqual([]);

      // Control: a session whose record was kept does read its row.
      const kept: Array<Partial<SessionUsage>> = [];
      const attachment = adapter.attachSession({ sessionId: 'pty-2', applyUsage: (usage) => kept.push(usage) });
      expect(kept).toHaveLength(1);
      expect(kept[0].contextWindow?.usedTokens).toBe(2000);
      attachment.dispose();
    });
  });

  describe('a Goose in a WSL distro', () => {
    const distroPlace = {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxCliPath: '/home/dev/.local/bin/goose',
      facts: {
        distro: 'Ubuntu',
        homeLinux: '/home/dev',
        homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
        uncRoot: '\\\\wsl.localhost\\Ubuntu',
        interactivePath: '/usr/bin',
        env: {},
        networkingMode: 'nat',
      },
    } as unknown as SpawnCommandOptions['cliTarget'];

    it('installs hooks that run the workspace copy of the transport script, not node', () => {
      const adapter = new GooseAdapter();
      adapter.buildCommand({ ...spawnOptions('pty-1'), cliTarget: distroPlace });

      const hooksFile = JSON.parse(fs.readFileSync(path.join(goosePluginDirectory(workDirectory), 'hooks', 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const commands = Object.values(hooksFile.hooks).map((rules) => rules[0].hooks[0].command);
      expect(commands).toHaveLength(7);
      for (const command of commands) {
        expect(command.startsWith('node')).toBe(false);
        expect(command.startsWith('sh ')).toBe(true);
        expect(command).toContain('goose-wsl-hook.sh');
      }
      expect(hooksFile.hooks.Stop[0].hooks[0].command).toContain(' event idle');

      expect(fs.existsSync(path.join(workDirectory, '.kangentic', 'goose-wsl-hook.sh'))).toBe(true);
      // The session's own transport folder sits beside its events file.
      expect(fs.existsSync(path.join(workDirectory, 'sessions', 'pty-1', 'wsl-hooks', 'wsl-hook.sh'))).toBe(true);
    });
  });

  describe('git exclusion', () => {
    it('hides the plugin from git in a checkout, and not the .kangentic folder', () => {
      fs.mkdirSync(path.join(workDirectory, '.git', 'info'), { recursive: true });
      const adapter = new GooseAdapter();
      adapter.buildCommand(spawnOptions('pty-1'));
      const excludePath = path.join(workDirectory, '.git', 'info', 'exclude');
      const afterLocal = fs.readFileSync(excludePath, 'utf-8').split('\n');
      expect(afterLocal).toContain('.agents/plugins/kangentic-goose/');
      expect(afterLocal).not.toContain('.kangentic/');
    });

    it('also excludes .kangentic/ for a distro Goose, whose transport copy lives there', () => {
      fs.mkdirSync(path.join(workDirectory, '.git', 'info'), { recursive: true });
      const adapter = new GooseAdapter();
      adapter.buildCommand({
        ...spawnOptions('pty-1'),
        cliTarget: { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/usr/bin/goose', facts: { distro: 'Ubuntu', networkingMode: 'nat' } } as unknown as SpawnCommandOptions['cliTarget'],
      });
      const lines = fs.readFileSync(path.join(workDirectory, '.git', 'info', 'exclude'), 'utf-8').split('\n');
      expect(lines).toContain('.agents/plugins/kangentic-goose/');
      expect(lines).toContain('.kangentic/');
    });
  });
});
