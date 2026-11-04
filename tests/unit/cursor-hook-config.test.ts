/**
 * Cursor's project hooks file (`.cursor/hooks.json`): the merge with the
 * user's own hooks, the removal, and what the real event bridge writes for each
 * hook Kangentic registers.
 *
 * Payloads are shaped from Cursor's hooks reference
 * (https://cursor.com/docs/hooks, fetched 2026-11-03), not captured from a
 * running Cursor: none was available when this was built.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCursorHookCommands,
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS_ENV,
  CURSOR_WSL_HOOK_COPY_NAME,
  CURSOR_WSL_HOOK_FLAG,
  removeCursorProjectHooks,
  writeCursorProjectHooks,
} from '../../src/main/agent/adapters/cursor/hook-config';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import { isKangenticHookCommand } from '../../src/main/agent/shared/hook-utils';
import { copyWslHookScriptInto, prepareWslHookTransport } from '../../src/main/agent/shared/wsl-hook-transport';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import { toForwardSlash } from '../../src/shared/paths';
import { gitBashPath, HOOK_PROBE_SEGMENT, installedShOrPowerShellHosts, runAsHookShell, type HookShellHost } from './helpers/shell-argv-probe';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

/** The POSIX shells installed here that run `-c <command>`: sh and bash, or Git Bash on Windows. */
function posixShellPaths(): string[] {
  const shellPaths: string[] = [];
  for (const host of installedShOrPowerShellHosts()) {
    if (host === 'sh' || host === 'bash') shellPaths.push(host);
    if (host === 'git-bash') {
      const gitBash = gitBashPath();
      if (gitBash) shellPaths.push(gitBash);
    }
  }
  return shellPaths;
}

// Computed once, up front, so a missing shell shows as a skipped test.
const posixShells = posixShellPaths();

/** A path as a POSIX shell here reads it: `/c/...` under Git Bash on Windows, unchanged elsewhere. */
function posixShellPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  return toForwardSlash(filePath).replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

/** Run a whole hook command through one host the way Cursor does, and return what it printed. */
function runCommandInHost(host: HookShellHost, command: string, input: string, env: Record<string, string>): { status: number | null; stdout: string } {
  const options = { input, env: { ...process.env, ...env }, encoding: 'utf-8' as const, windowsHide: true, timeout: 25_000 };
  let program: string;
  let args: string[];
  if (host === 'git-bash') {
    program = gitBashPath() ?? 'bash';
    args = ['-c', command];
  } else if (host === 'sh' || host === 'bash') {
    program = host;
    args = ['-c', command];
  } else {
    program = host;
    args = ['-NoProfile', '-NonInteractive', '-Command', command];
  }
  const result = spawnSync(program, args, options);
  return { status: result.status, stdout: result.stdout ?? '' };
}

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-cursor-hooks-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const hooksPath = () => path.join(folder, '.cursor', 'hooks.json');
const readHooks = () => JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')) as { version: number; hooks: Record<string, Array<{ command: string; timeout?: number }>> };
const readJson = () => JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')) as Record<string, unknown>;
const writeHooks = (value: unknown) => {
  fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
  fs.writeFileSync(hooksPath(), typeof value === 'string' ? value : JSON.stringify(value));
};

describe('buildCursorHookCommands', () => {
  const commands = buildCursorHookCommands('/bridge/event-bridge.js');

  it('registers every documented event Kangentic reports on', () => {
    expect(Object.keys(commands).sort()).toEqual(Object.values(CURSOR_HOOK_EVENTS).sort());
  });

  it('writes through the interactive-only variable, which the shared cleanup still recognizes', () => {
    for (const command of Object.values(commands)) {
      expect(command).toContain(`"env:${CURSOR_HOOK_EVENTS_ENV}"`);
      expect(isKangenticHookCommand(command)).toBe(true);
    }
  });

  // Cursor runs a hook command through PowerShell on Windows (hooks docs) and a
  // POSIX shell elsewhere. The whole command, run by each such shell installed
  // here, must reach the bridge with its path intact under a folder name built
  // to break quoting.
  it('a hook command writes its event through every shell Cursor may use, wherever the bridge lives', () => {
    const trickyDirectory = path.join(folder, HOOK_PROBE_SEGMENT);
    fs.mkdirSync(trickyDirectory, { recursive: true });
    const bridgeCopy = path.join(trickyDirectory, 'event-bridge.js');
    fs.copyFileSync(BRIDGE, bridgeCopy);
    const eventsOutput = path.join(trickyDirectory, 'events.jsonl');
    const preToolUse = buildCursorHookCommands(toForwardSlash(bridgeCopy)).preToolUse;
    for (const host of installedShOrPowerShellHosts()) {
      fs.rmSync(eventsOutput, { force: true });
      runAsHookShell(host, preToolUse, {
        input: JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Read', tool_use_id: 'call-1' }),
        env: { [CURSOR_HOOK_EVENTS_ENV]: eventsOutput },
      });
      expect(fs.readFileSync(eventsOutput, 'utf-8'), host).toContain('"tool_start"');
    }
  }, 60_000);

  // `runHook` below runs node on the command's tokens and never a shell, so the
  // reply Cursor reads is only proven here: the whole command through each shell.
  it('the prompt hook prints the continue reply through every shell Cursor may use', () => {
    const command = buildCursorHookCommands(toForwardSlash(BRIDGE)).beforeSubmitPrompt;
    const eventsOutput = path.join(folder, 'prompt-events.jsonl');
    for (const host of installedShOrPowerShellHosts()) {
      fs.rmSync(eventsOutput, { force: true });
      const result = runCommandInHost(host, command, JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', prompt: 'go' }), { [CURSOR_HOOK_EVENTS_ENV]: eventsOutput });
      expect(result.stdout, host).toContain('{"continue":true}');
      expect(fs.readFileSync(eventsOutput, 'utf-8'), host).toContain('"prompt"');
    }
  }, 60_000);
});

describe('the project hooks file', () => {
  it('creates a version 1 file with one entry per event, and keeps it out of git status', () => {
    fs.mkdirSync(path.join(folder, '.git', 'info'), { recursive: true });
    expect(writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' })).toBe(true);

    const written = readHooks();
    expect(written.version).toBe(1);
    for (const eventName of Object.values(CURSOR_HOOK_EVENTS)) {
      expect(written.hooks[eventName]).toEqual([{ command: expect.stringContaining('event-bridge'), timeout: 10 }]);
    }
    expect(fs.readFileSync(path.join(folder, '.git', 'info', 'exclude'), 'utf-8')).toContain('.cursor/hooks.json');
  });

  it('keeps the user\'s own hooks and settings, and does not add its entries twice', () => {
    writeHooks({ version: 1, hooks: { stop: [{ command: './my-stop.sh' }], afterFileEdit: [{ command: './format.sh' }] } });

    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    const first = fs.readFileSync(hooksPath(), 'utf-8');
    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });

    expect(fs.readFileSync(hooksPath(), 'utf-8')).toBe(first);
    const written = readHooks();
    expect(written.hooks.afterFileEdit).toEqual([{ command: './format.sh' }]);
    expect(written.hooks.stop.map((entry) => entry.command)).toEqual(['./my-stop.sh', expect.stringContaining('event-bridge')]);
  });

  it('replaces an entry an older install wrote from another bridge path', () => {
    writeCursorProjectHooks(folder, { eventBridge: '/old-install/event-bridge.js' });
    writeCursorProjectHooks(folder, { eventBridge: '/new-install/event-bridge.js' });

    const commands = readHooks().hooks.stop.map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('/new-install/');
  });

  it.each([
    ['not JSON', '{ // mine\n "hooks": {} }'],
    ['a hooks value that is not an object of lists', JSON.stringify({ version: 1, hooks: { stop: 'run.sh' } })],
  ])('leaves a file that is %s as it is', (_reason, text) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeHooks(text);
      expect(writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' })).toBe(false);
      expect(fs.readFileSync(hooksPath(), 'utf-8')).toBe(text);
    } finally {
      warn.mockRestore();
    }
  });

  it('removal leaves only the user\'s hooks', () => {
    writeHooks({ version: 1, hooks: { stop: [{ command: './my-stop.sh' }] } });
    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });

    removeCursorProjectHooks(folder);

    expect(readHooks()).toEqual({ version: 1, hooks: { stop: [{ command: './my-stop.sh' }] } });
  });

  it('removal deletes a file that held only Kangentic\'s hooks', () => {
    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    removeCursorProjectHooks(folder);
    expect(fs.existsSync(hooksPath())).toBe(false);
  });

  it('removal leaves a user\'s file with nothing of Kangentic\'s untouched', () => {
    const text = JSON.stringify({ version: 1, hooks: { stop: [{ command: './my-stop.sh' }] } });
    writeHooks(text);
    removeCursorProjectHooks(folder);
    expect(fs.readFileSync(hooksPath(), 'utf-8')).toBe(text);
  });

  it('does not rewrite a file that already holds exactly these entries', () => {
    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' })).toBe(true);
      expect(writeSpy).not.toHaveBeenCalled();
      // Control: the spy does intercept the write when the entries do change.
      expect(writeCursorProjectHooks(folder, { eventBridge: '/other-install/event-bridge.js' })).toBe(true);
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('keeps a user file\'s top-level keys exactly, adding no version, and hands the file back on removal', () => {
    const original = { custom: true, hooks: { stop: [{ command: './my-stop.sh' }] } };
    writeHooks(original);

    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    const written = readJson();
    expect(written.custom).toBe(true);
    expect(written).not.toHaveProperty('version');

    removeCursorProjectHooks(folder);
    expect(readJson()).toEqual(original);
  });

  it('keeps a version the user set through the write and the removal', () => {
    writeHooks({ version: 2, hooks: { stop: [{ command: './my-stop.sh' }] } });

    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    expect(readJson().version).toBe(2);

    removeCursorProjectHooks(folder);
    expect(readJson()).toEqual({ version: 2, hooks: { stop: [{ command: './my-stop.sh' }] } });
  });

  it('does not add a user\'s existing hooks file to .git/info/exclude', () => {
    fs.mkdirSync(path.join(folder, '.git', 'info'), { recursive: true });
    writeHooks({ version: 1, hooks: { stop: [{ command: './my-stop.sh' }] } });

    expect(writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' })).toBe(true);

    const excludePath = path.join(folder, '.git', 'info', 'exclude');
    const excludeText = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    expect(excludeText).not.toContain('.cursor/hooks.json');
  });

  it('removal keeps a user file with a non-hooks key and no hooks of its own', () => {
    writeHooks({ custom: true });
    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });

    removeCursorProjectHooks(folder);

    expect(fs.existsSync(hooksPath())).toBe(true);
    expect(readJson()).toEqual({ custom: true });
  });

  it('drops an event that held only Kangentic\'s entries from an older install, and keeps the user\'s empty list', () => {
    const olderKangenticCommand = buildCursorHookCommands('/old/event-bridge.js').stop;
    writeHooks({ version: 1, hooks: { afterFileEdit: [{ command: olderKangenticCommand }], beforeReadFile: [] } });

    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });

    const written = readHooks();
    expect(written.hooks).not.toHaveProperty('afterFileEdit');
    expect(written.hooks.beforeReadFile).toEqual([]);
  });

  it('removal hands back a file that held a user\'s empty event list, exactly as it was', () => {
    const original = { version: 1, hooks: { beforeReadFile: [], stop: [{ command: './a.sh' }] } };
    writeHooks(original);

    writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    removeCursorProjectHooks(folder);

    expect(readJson()).toEqual(original);
  });

  it('reports false and leaves the path alone when hooks.json cannot be read as a file', () => {
    fs.mkdirSync(hooksPath(), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' })).toBe(false);
      expect(fs.statSync(hooksPath()).isDirectory()).toBe(true);
      // Treated as unusable, so no write is even attempted (a write to a
      // directory would fail on its own and also return false).
      expect(writeSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      warn.mockRestore();
    }
  });
});

const wslPlace: CliPlace = {
  kind: 'wsl',
  distro: 'Ubuntu',
  facts: {
    distro: 'Ubuntu',
    homeLinux: '/home/dev',
    homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/usr/bin',
    env: {},
    networkingMode: 'nat',
  },
};

describe('the hooks file for a Cursor in a WSL distro', () => {
  it('writes no hooks file and reports false when the transport cannot be prepared', () => {
    // A session folder whose parent is a regular file cannot be created (ENOTDIR).
    const blocker = path.join(folder, 'blocker');
    fs.writeFileSync(blocker, 'not a folder');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(writeCursorProjectHooks(folder, { wsl: { place: wslPlace, sessionDirectory: path.join(blocker, 'session') } })).toBe(false);
      expect(fs.existsSync(hooksPath())).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Cursor runs the command under `sh` in the distro. With the gating variable
  // unset (a print run, the user's own Cursor) the gate publishes nothing, the
  // hook exits 0 so Cursor reports no failure, and the prompt is still let
  // through. The script path is never reached, so it need not exist here.
  it('the prompt hook is gated on the interactive variable and still prints the continue reply', () => {
    const sessionDirectory = path.join(folder, 'session');
    expect(writeCursorProjectHooks(folder, { wsl: { place: wslPlace, sessionDirectory } })).toBe(true);
    const command = readHooks().hooks.beforeSubmitPrompt[0].command;
    expect(command).toMatch(new RegExp(`^if \\[ -n "\\$${CURSOR_HOOK_EVENTS_ENV}" \\]; then sh `));
    expect(command).toMatch(/; fi; printf '%s' '\{"continue":true\}'$/);
    expect(fs.existsSync(path.join(sessionDirectory, 'wsl-hooks', 'inbox'))).toBe(true);
  });

  it.skipIf(posixShells.length === 0)('the prompt hook, run under sh with the gating variable unset, exits 0, prints the continue reply, and publishes nothing', () => {
    const sessionDirectory = path.join(folder, 'session');
    expect(writeCursorProjectHooks(folder, { wsl: { place: wslPlace, sessionDirectory } })).toBe(true);
    const command = readHooks().hooks.beforeSubmitPrompt[0].command;
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment[CURSOR_HOOK_EVENTS_ENV];

    for (const shellPath of posixShells) {
      const result = spawnSync(shellPath, ['-c', command], { input: '{}', env: environment, encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
      expect(result.status, shellPath).toBe(0);
      expect(result.stdout, shellPath).toBe('{"continue":true}');
    }
    expect(fs.readdirSync(path.join(sessionDirectory, 'wsl-hooks', 'inbox'))).toEqual([]);
  }, 60_000);

  // With the flag set, each command runs the transport, whose published files
  // the real inbox turns into events. The script path is given in the form the
  // shell here reads (`/c/...` under Git Bash), since the `/mnt/c/...` form of a
  // distro does not exist on this machine. Red-green: dropping the `aborted`
  // directive in hook-config.ts makes the aborted stop read `idle`.
  it.skipIf(posixShells.length === 0)('the WSL commands, run under sh with the flag set, carry the tool, the subagent and the stop status mapping', async () => {
    const sessionDirectory = path.join(folder, 'session');
    const transportPaths = prepareWslHookTransport(sessionDirectory);
    const commands = buildCursorHookCommands('/unused/event-bridge.js', {
      folderHooks: { ...transportPaths, script: posixShellPath(transportPaths.script) },
      place: wslPlace,
    });
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined });
    inbox.start();
    try {
      const environment = {
        [CURSOR_HOOK_EVENTS_ENV]: CURSOR_WSL_HOOK_FLAG,
        KANGENTIC_WSL_HOOK_DIR: posixShellPath(transportPaths.directory),
      };
      const runs: Array<[string, Record<string, unknown>]> = [
        ['preToolUse', { tool_name: 'Shell', tool_use_id: 'c1' }],
        ['subagentStart', { subagent_id: 'sub-1', subagent_type: 'explore' }],
        ['stop', { status: 'aborted' }],
        ['stop', { status: 'error' }],
        ['stop', { status: 'completed' }],
      ];
      for (const [eventName, payload] of runs) {
        const result = spawnSync(posixShells[0], ['-c', commands[eventName]], {
          input: JSON.stringify(payload),
          env: { ...process.env, ...environment },
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 30_000,
        });
        expect(result.status, eventName).toBe(0);
        expect(result.stdout, eventName).toBe('');
      }
      await vi.waitFor(() => {
        expect(fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(runs.length);
      }, { timeout: 10_000, interval: 50 });
    } finally {
      inbox.close();
    }
    const events = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: 'tool_start', tool: 'Shell', toolId: 'c1' });
    expect(events[1]).toMatchObject({ type: 'subagent_start', subagentId: 'sub-1', detail: 'explore' });
    expect(events.slice(2).map((event) => event.type)).toEqual(['interrupted', 'turn_failed', 'idle']);
  }, 60_000);

  // The last Kangentic start in a folder decides which form the file holds.
  it.each([
    ['node then WSL', true],
    ['WSL then node', false],
  ])('a rewrite from %s leaves one Kangentic entry per event, all of the later form', (_label, nodeFirst) => {
    const sessionDirectory = path.join(folder, 'session');
    const writeNode = () => writeCursorProjectHooks(folder, { eventBridge: '/bridge/event-bridge.js' });
    const writeWsl = () => writeCursorProjectHooks(folder, { wsl: { place: wslPlace, sessionDirectory } });
    expect((nodeFirst ? writeNode : writeWsl)()).toBe(true);
    expect((nodeFirst ? writeWsl : writeNode)()).toBe(true);

    const written = readHooks();
    for (const eventName of Object.values(CURSOR_HOOK_EVENTS)) {
      const entries = written.hooks[eventName];
      expect(entries, eventName).toHaveLength(1);
      if (nodeFirst) {
        expect(entries[0].command, eventName).toContain('wsl-hook.sh');
        expect(entries[0].command, eventName).not.toContain('event-bridge');
      } else {
        expect(entries[0].command, eventName).toContain('event-bridge');
        expect(entries[0].command, eventName).not.toContain('wsl-hook.sh');
      }
    }
  });

  it('the shared cleanup recognizes every WSL-form command', () => {
    const sessionDirectory = path.join(folder, 'session');
    const folderHooks = { ...prepareWslHookTransport(sessionDirectory), script: copyWslHookScriptInto(folder, CURSOR_WSL_HOOK_COPY_NAME) };
    const commands = buildCursorHookCommands('/unused/event-bridge.js', { folderHooks, place: wslPlace });
    expect(Object.keys(commands).sort()).toEqual(Object.values(CURSOR_HOOK_EVENTS).sort());
    for (const [eventName, command] of Object.entries(commands)) {
      expect(command, eventName).toContain('wsl-hook.sh');
      expect(isKangenticHookCommand(command), eventName).toBe(true);
    }
  });
});

/**
 * Run one registered hook's command through the real bridge, the way Cursor
 * runs it: the payload on stdin, the session's environment. The command's
 * tokens after `node "<bridge>"` are the bridge's own arguments. A token is a
 * double-quoted word or a run of non-spaces, so a bridge path with a space in
 * it stays one token; the directives are base64 with no spaces.
 *
 * It depends on `buildBridgeCommand`'s format: `node` and the bridge path are
 * the first two tokens, so `slice(2)` is the bridge's own arguments. It runs
 * node directly, never through a shell; the shell round trips are above.
 */
function runHook(eventName: string, payload: Record<string, unknown>, eventsPath: string | null): { events: Array<Record<string, unknown>>; stdout: string } {
  const command = buildCursorHookCommands(toForwardSlash(BRIDGE))[eventName];
  const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  const args = tokens.slice(2).map((token) => token.replace(/^"|"$/g, ''));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[CURSOR_HOOK_EVENTS_ENV];
  if (eventsPath) env[CURSOR_HOOK_EVENTS_ENV] = eventsPath;
  const result = spawnSync(process.execPath, [BRIDGE, ...args], { input: JSON.stringify(payload), env, encoding: 'utf-8' });
  const lines = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf-8').trim().split('\n') : [];
  return { events: lines.filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>), stdout: result.stdout };
}

describe('what the bridge writes for each hook', () => {
  const common = {
    conversation_id: '997bca3d-4c50-43e2-a038-9a99860f4e7c',
    generation_id: 'gen-1',
    model: 'Composer 2.5',
    cursor_version: '2026.10.22',
    workspace_roots: ['/projects/my-app'],
    transcript_path: null,
  };
  const eventsPath = () => path.join(folder, 'events.jsonl');

  it('a tool call is a start and an end paired by its id', () => {
    const start = runHook('preToolUse', { ...common, hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'npm test', working_directory: '/projects/my-app' }, tool_use_id: 'call-1' }, eventsPath());
    expect(start.stdout).toBe('');
    runHook('postToolUse', { ...common, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 'call-1', tool_output: 'ok', duration: 12 }, eventsPath());
    runHook('postToolUseFailure', { ...common, hook_event_name: 'postToolUseFailure', tool_name: 'Read', tool_use_id: 'call-2', error_message: 'missing', failure_type: 'error' }, eventsPath());

    const events = runHook('sessionEnd', { ...common, hook_event_name: 'sessionEnd', session_id: common.conversation_id, reason: 'completed' }, eventsPath()).events;
    expect(events.map((event) => [event.type, event.tool, event.toolId])).toEqual([
      ['tool_start', 'Shell', 'call-1'],
      ['tool_end', 'Shell', 'call-1'],
      ['tool_end', 'Read', 'call-2'],
      ['session_end', undefined, undefined],
    ]);
  });

  it('a prompt is submitted with an explicit continue, and nothing answers for a tool or a subagent', () => {
    const prompt = runHook('beforeSubmitPrompt', { ...common, hook_event_name: 'beforeSubmitPrompt', prompt: 'fix it', attachments: [] }, eventsPath());
    expect(JSON.parse(prompt.stdout)).toEqual({ continue: true });
    expect(prompt.events.at(-1)?.type).toBe('prompt');
    expect(runHook('subagentStart', { ...common, hook_event_name: 'subagentStart', subagent_id: 'sub-1', subagent_type: 'explore', task: 'look' }, eventsPath()).stdout).toBe('');
  });

  it('a subagent opens with its id and closes with a named stop', () => {
    runHook('subagentStart', { ...common, hook_event_name: 'subagentStart', subagent_id: 'sub-1', subagent_type: 'explore', task: 'look' }, eventsPath());
    const events = runHook('subagentStop', { ...common, hook_event_name: 'subagentStop', subagent_type: 'explore', status: 'completed', task: 'look' }, eventsPath()).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'subagent_start', subagentId: 'sub-1', detail: 'explore' }),
      expect.objectContaining({ type: 'subagent_stop', detail: 'explore' }),
    ]);
  });

  it.each([
    ['completed', 'idle'],
    ['aborted', 'interrupted'],
    ['error', 'turn_failed'],
  ])('the stop hook with status %s ends the turn as %s', (status, type) => {
    const events = runHook('stop', { ...common, hook_event_name: 'stop', status, loop_count: 0 }, eventsPath()).events;
    expect(events.at(-1)?.type).toBe(type);
  });

  it('a compaction and a session start are reported, the start with its payload', () => {
    runHook('preCompact', { ...common, hook_event_name: 'preCompact', trigger: 'auto', context_usage_percent: 91 }, eventsPath());
    const events = runHook('sessionStart', { ...common, hook_event_name: 'sessionStart', session_id: common.conversation_id, is_background_agent: false }, eventsPath()).events;
    expect(events[0].type).toBe('compact');
    expect(events[1].type).toBe('session_start');
    expect(String(events[1].hookContext)).toContain(common.conversation_id);
  });

  it('writes nothing for a Cursor run without the variable: a print run, or the user\'s own', () => {
    const { events } = runHook('preToolUse', { ...common, tool_name: 'Shell', tool_use_id: 'call-1' }, null);
    expect(events).toEqual([]);
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});
