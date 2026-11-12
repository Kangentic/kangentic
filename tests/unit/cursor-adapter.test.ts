/**
 * Unit tests for CursorAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

// Mock which, fs, exec-version, and child_process before importing adapter
let mockWhichResult: string | Error = '/usr/local/bin/agent';
let mockExecVersionStdout = '0.50.3\n';
let mockExecVersionShouldFail = false;
let execVersionCallCount = 0;

// Controls for `child_process.execFile` used by sessionBootstrap
// (`agent about --format json`). Tests rewrite these to simulate
// various Cursor CLI responses.
let mockAboutShouldFail = false;
let mockAboutStdout = JSON.stringify({
  cliVersion: '2026.04.15-dccdccd',
  model: 'Auto',
  subscriptionTier: 'Free',
});
// `options` is what the production code passed as the exec options (`cwd`,
// `timeout`, ...): the second argument of `exec(cmd, options)` on Windows and
// the third of `execFile(file, args, options)` elsewhere.
type RecordedExecOptions = { cwd?: string; timeout?: number };
const aboutCallLog: Array<{ path: string; args: readonly string[]; options: RecordedExecOptions }> = [];

vi.mock('which', () => ({
  default: async () => {
    if (mockWhichResult instanceof Error) throw mockWhichResult;
    return mockWhichResult;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: () => true,
    },
  };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async () => {
    execVersionCallCount++;
    if (mockExecVersionShouldFail) {
      throw new Error('command not found');
    }
    return { stdout: mockExecVersionStdout, stderr: '' };
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  // Replace both execFile (unix path) and exec (Windows .cmd shim path)
  // with test-controlled fakes that play nicely with `util.promisify`.
  // Node's native execFile exposes a `util.promisify.custom` returning
  // `{ stdout, stderr }`; we mirror that so adapter code written as
  // `const { stdout } = await execAsync(...)` works against the mock
  // without touching the real CLI, on every platform.
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  type ExecCallback = (err: Error | null, stdout?: string, stderr?: string) => void;
  type ExecResult = Promise<{ stdout: string; stderr: string }>;
  type LogEntry = { path: string; args: readonly string[]; options: RecordedExecOptions };

  const makeMock = (recordCall: (entry: LogEntry) => void) => Object.assign(
    // Sync callback form: only hit if production code bypasses
    // promisify and calls execFile/exec directly with a callback.
    // The adapter uses the promisified form exclusively, so this
    // branch exists only to satisfy the function signature.
    (...mockArgs: unknown[]) => {
      const callback = mockArgs.find((candidate): candidate is ExecCallback => typeof candidate === 'function');
      if (callback) callback(null, mockAboutStdout, '');
    },
    {
      [promisifyCustom]: (firstArg: string, secondArg?: readonly string[] | unknown, thirdArg?: unknown): ExecResult => {
        const pathArg = firstArg;
        const args = Array.isArray(secondArg) ? (secondArg as readonly string[]) : [];
        // The options object is the first non-array object after the command:
        // second on `exec(cmd, options)`, third on `execFile(file, args, options)`.
        const options = [secondArg, thirdArg].find(
          (candidate): candidate is RecordedExecOptions =>
            typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
        ) ?? {};
        recordCall({ path: pathArg, args, options });
        if (mockAboutShouldFail) {
          return Promise.reject(new Error('agent about failed'));
        }
        return Promise.resolve({ stdout: mockAboutStdout, stderr: '' });
      },
    },
  );

  // `execFile(path, args)` on unix → aboutCallLog entry preserves args.
  const mockExecFile = makeMock(({ path: pathArg, args, options }) => {
    aboutCallLog.push({ path: pathArg, args, options });
  });

  // `exec(cmdString)` on Windows → parse the quoted path + args back
  // out of the single command string so tests can still assert on them
  // uniformly. Expected shape: `"<path>" about --format json`.
  const mockExec = makeMock(({ path: cmdString, options }) => {
    const match = cmdString.match(/^"([^"]+)"\s+(.*)$/);
    if (match) {
      aboutCallLog.push({ path: match[1], args: match[2].split(/\s+/), options });
    } else {
      aboutCallLog.push({ path: cmdString, args: [], options });
    }
  });

  return {
    ...original,
    execFile: mockExecFile,
    exec: mockExec,
  };
});

// Import after mocks are set up
const { CursorAdapter } = await import('../../src/main/agent/adapters/cursor');
const { resetCursorCapabilityCacheForTests } = await import('../../src/main/agent/adapters/cursor/capability-discovery');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/local/bin/agent',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── CursorAdapter ────────────────────────────────────────────────────────────

describe('CursorAdapter', () => {
  let adapter: CursorAdapter;

  beforeEach(() => {
    adapter = new CursorAdapter();
    resetCursorCapabilityCacheForTests();
    mockWhichResult = '/usr/local/bin/agent';
    mockExecVersionStdout = '0.50.3\n';
    mockExecVersionShouldFail = false;
    execVersionCallCount = 0;
    mockAboutShouldFail = false;
    mockAboutStdout = JSON.stringify({
      cliVersion: '2026.04.15-dccdccd',
      model: 'Auto',
      subscriptionTier: 'Free',
    });
    aboutCallLog.length = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "cursor"', () => {
    expect(adapter.name).toBe('cursor');
  });

  it('has displayName "Cursor CLI"', () => {
    expect(adapter.displayName).toBe('Cursor CLI');
  });

  it('has sessionType "cursor_agent"', () => {
    expect(adapter.sessionType).toBe('cursor_agent');
  });

  it('does not support caller session IDs', () => {
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  // ── A conversation created before launch ─────────────────────────────────
  //
  // An interactive Cursor session prints no session id. `create-chat` makes an
  // empty chat and prints its id (measured: a bare UUID line), and the launch
  // opens it with `--resume=<id>`, so Kangentic knows the id from the start.
  // The print path reports its own id and does not create a chat first.
  describe('a conversation created before launch', () => {
    const CHAT_ID = '997bca3d-4c50-43e2-a038-9a99860f4e7c';

    it('reports its own session id only on the print path', () => {
      expect(adapter.reportsLaunchSessionId({ permissionMode: 'default' })).toBe(false);
      expect(adapter.reportsLaunchSessionId({ permissionMode: 'acceptEdits' })).toBe(false);
      expect(adapter.reportsLaunchSessionId({ permissionMode: 'acceptEdits', nonInteractive: true })).toBe(true);
      expect(adapter.reportsLaunchSessionId({ permissionMode: 'bypassPermissions' })).toBe(true);
    });

    it('creates a chat and reads its id', async () => {
      mockAboutStdout = `${CHAT_ID}\n`;
      expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', '/projects/my-app')).toBe(CHAT_ID);
      expect(aboutCallLog.at(-1)?.args).toContain('create-chat');
    });

    it('is null when the CLI cannot create one, or prints no id', async () => {
      mockAboutShouldFail = true;
      expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', '/projects/my-app')).toBeNull();
      mockAboutShouldFail = false;
      mockAboutStdout = 'Not logged in\n';
      expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', '/projects/my-app')).toBeNull();
    });

    // The folder matters if Cursor files chats by workspace, and the timeout is
    // what keeps a start from hanging on a CLI that never answers. Both ride the
    // exec options: `cwd` and `timeout`. Windows runs the CLI through `exec` (a
    // .cmd shim needs a shell) and the other platforms through `execFile`, so
    // both are run here whatever the host is.
    it.each(['win32', 'linux'] as const)('runs create-chat in the session\'s own folder with a 20 second timeout on %s', async (platform) => {
      mockAboutStdout = `${CHAT_ID}\n`;
      const workingDirectory = '/projects/my-app';
      const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', workingDirectory)).toBe(CHAT_ID);
      } finally {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }

      expect(aboutCallLog).toHaveLength(1);
      expect(aboutCallLog[0].args).toContain('create-chat');
      expect(aboutCallLog[0].options.cwd).toBe(workingDirectory);
      expect(aboutCallLog[0].options.timeout).toBe(20_000);
    });

    it('reads an uppercase id on its own line of multi-line output, and returns it lowercase', async () => {
      mockAboutStdout = `Cursor Agent 2026.04.29\r\n${CHAT_ID.toUpperCase()}\r\n`;
      expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', '/projects/my-app')).toBe(CHAT_ID);
    });

    it('does not take an id that is only part of a longer line', async () => {
      mockAboutStdout = `Created chat ${CHAT_ID} for this folder\n`;
      expect(await adapter.createSessionId('/usr/local/bin/cursor-agent', '/projects/my-app')).toBeNull();
    });

    it('opens the created chat on a fresh start, with the first message', () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: CHAT_ID, prompt: 'Plan the work.', shell: 'bash' }));
      expect(command).toContain(`--resume=${quoteArg(CHAT_ID, 'bash')}`);
      expect(command).toContain(quoteArg('Plan the work.', 'bash'));
    });

    it('sends no message on a resume, as before', () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: CHAT_ID, resume: true, prompt: 'Plan the work.', shell: 'bash' }));
      expect(command).toContain(`--resume=${quoteArg(CHAT_ID, 'bash')}`);
      expect(command).not.toContain('Plan the work.');
    });
  });

  // ── Kangentic MCP ────────────────────────────────────────────────────────
  //
  // Cursor's CLI reads the project's `.cursor/mcp.json`, whose entry's url and
  // token are env references, so each session's own values ride its env.
  describe('Kangentic MCP wiring', () => {
    const mcpOptions = (folder: string, overrides: Partial<SpawnCommandOptions> = {}) => makeOptions({
      cwd: folder,
      mcpServerEnabled: true,
      mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-1/session-1',
      mcpServerToken: 'secret-token',
      ...overrides,
    });

    // `existsSync` is mocked in this file; everything else in `fs` is real.
    function withFolder(run: (folder: string) => void): void {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-cursor-adapter-mcp-'));
      try {
        run(folder);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }

    it('declares per-session MCP delivery', () => {
      expect(adapter.kangenticMcp).toBe('per-session');
    });

    it('approves the project\'s MCP servers on a fresh start and on a resume', () => {
      withFolder((folder) => {
        expect(adapter.buildCommand(mcpOptions(folder))).toContain('--approve-mcps');
        expect(adapter.buildCommand(mcpOptions(folder, { resume: true, sessionId: 'chat-1' }))).toContain('--approve-mcps');
      });
    });

    it('puts the session\'s own URL and token in its environment, never the command', () => {
      withFolder((folder) => {
        const command = adapter.buildCommand(mcpOptions(folder));
        expect(command).not.toContain('session-1');
        expect(command).not.toContain('secret-token');
        expect(adapter.buildEnv?.(mcpOptions(folder))).toEqual({
          KANGENTIC_MCP_URL: 'http://127.0.0.1:5555/mcp/project-1/session-1',
          KANGENTIC_MCP_TOKEN: 'secret-token',
        });
      });
    });

    it('wires nothing without the server, or without its token', () => {
      withFolder((folder) => {
        expect(adapter.buildCommand(mcpOptions(folder, { mcpServerEnabled: false }))).not.toContain('--approve-mcps');
        expect(adapter.buildCommand(mcpOptions(folder, { mcpServerToken: undefined }))).not.toContain('--approve-mcps');
        expect(adapter.buildEnv?.(mcpOptions(folder, { mcpServerEnabled: false }))).toBeNull();
      });
    });

    it('keeps the entry until the last session in the folder leaves', () => {
      withFolder((folder) => {
        adapter.buildCommand(mcpOptions(folder, { taskId: 'task-a', ptySessionId: 'session-a' }));
        adapter.buildCommand(mcpOptions(folder, { taskId: 'task-b', ptySessionId: 'session-b' }));
        const configPath = path.join(folder, '.cursor', 'mcp.json');

        adapter.removeHooks(folder, 'session-a');
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('kangentic');

        adapter.removeHooks(folder, 'session-b');
        expect(() => fs.readFileSync(configPath, 'utf-8')).toThrow();
      });
    });

    it('an older session of the same task leaving late keeps the newer session\'s entry', () => {
      // A killed young session's PTY exits up to the grace after the task's
      // next session started; its late release must not strip the entry.
      withFolder((folder) => {
        adapter.buildCommand(mcpOptions(folder, { taskId: 'task-a', ptySessionId: 'old-session' }));
        adapter.buildCommand(mcpOptions(folder, { taskId: 'task-a', ptySessionId: 'new-session' }));
        const configPath = path.join(folder, '.cursor', 'mcp.json');

        adapter.removeHooks(folder, 'old-session');
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('kangentic');

        adapter.removeHooks(folder, 'new-session');
        expect(() => fs.readFileSync(configPath, 'utf-8')).toThrow();
      });
    });

    const configPathIn = (folder: string) => path.join(folder, '.cursor', 'mcp.json');
    const writeConfig = (folder: string, text: string): void => {
      fs.mkdirSync(path.join(folder, '.cursor'));
      fs.writeFileSync(configPathIn(folder), text);
    };

    // The project-delete sweep calls `removeHooks` with no session, after every
    // session is killed, so it must not wait on holders that are already gone.
    describe('removal with no session', () => {
      it('strips the entry even while two sessions still hold the folder', () => {
        withFolder((folder) => {
          adapter.buildCommand(mcpOptions(folder, { taskId: 'task-a', ptySessionId: 'session-a' }));
          adapter.buildCommand(mcpOptions(folder, { taskId: 'task-b', ptySessionId: 'session-b' }));
          expect(fs.readFileSync(configPathIn(folder), 'utf-8')).toContain('kangentic');

          adapter.removeHooks(folder);

          expect(() => fs.readFileSync(configPathIn(folder), 'utf-8')).toThrow();
        });
      });

      it('keeps the user\'s own servers when it strips the entry', () => {
        withFolder((folder) => {
          writeConfig(folder, JSON.stringify({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } } }));
          adapter.buildCommand(mcpOptions(folder, { taskId: 'task-a', ptySessionId: 'session-a' }));
          adapter.buildCommand(mcpOptions(folder, { taskId: 'task-b', ptySessionId: 'session-b' }));

          adapter.removeHooks(folder);

          expect(JSON.parse(fs.readFileSync(configPathIn(folder), 'utf-8'))).toEqual({
            mcpServers: { mine: { url: 'http://localhost:1/mcp' } },
          });
        });
      });
    });

    it.each<[string, Partial<SpawnCommandOptions>]>([
      ['the server is off', { mcpServerEnabled: false }],
      ['there is no token', { mcpServerToken: undefined }],
      ['there is no URL', { mcpServerUrl: undefined }],
    ])('writes no MCP config when %s', (_reason, overrides) => {
      withFolder((folder) => {
        adapter.buildCommand(mcpOptions(folder, overrides));
        // Not `existsSync`: this file mocks it to always answer true.
        expect(fs.readdirSync(folder)).toEqual([]);
      });
    });

    // A config Kangentic cannot merge into (here JSONC: a comment and a trailing
    // comma) holds the user's servers and is never rewritten. The session starts
    // without Kangentic's tools, and without the approval flag that would also
    // load the user's own project servers unprompted.
    describe('a folder whose MCP config Kangentic cannot merge into', () => {
      const JSONC_CONFIG = [
        '{',
        '  // my servers',
        '  "mcpServers": {',
        '    "mine": { "url": "http://localhost:1/mcp" },',
        '  },',
        '}',
        '',
      ].join('\n');

      let restoreWarn: () => void;
      beforeEach(() => {
        // The refusal is logged; keep that out of the test output.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        restoreWarn = () => warnSpy.mockRestore();
      });
      afterEach(() => {
        restoreWarn();
      });

      it.each<[string, Partial<SpawnCommandOptions>]>([
        ['a fresh start', {}],
        ['a resume', { resume: true, sessionId: 'chat-1' }],
      ])('adds neither the entry nor --approve-mcps on %s', (_start, overrides) => {
        withFolder((folder) => {
          writeConfig(folder, JSONC_CONFIG);

          const command = adapter.buildCommand(mcpOptions(folder, overrides));

          expect(command).not.toContain('--approve-mcps');
          expect(fs.readFileSync(configPathIn(folder), 'utf-8')).toBe(JSONC_CONFIG);
        });
      });

      it('names Cursor CLI and the config path as the reason its tools cannot load', () => {
        withFolder((folder) => {
          writeConfig(folder, JSONC_CONFIG);

          const reason = adapter.kangenticMcpBlockedReason(folder);

          expect(reason).toEqual(expect.any(String));
          expect(reason).toContain('Cursor CLI');
          expect(reason).toContain(configPathIn(folder));
        });
      });
    });

    describe('kangenticMcpBlockedReason', () => {
      it('is null for a folder with no MCP config', () => {
        withFolder((folder) => {
          expect(adapter.kangenticMcpBlockedReason(folder)).toBeNull();
        });
      });

      it('is null for a config Kangentic can merge into', () => {
        withFolder((folder) => {
          writeConfig(folder, JSON.stringify({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } } }));
          expect(adapter.kangenticMcpBlockedReason(folder)).toBeNull();
        });
      });
    });
  });

  // ── Kangentic hooks ──────────────────────────────────────────────────────
  //
  // The project's `.cursor/hooks.json` is read by every Cursor session in the
  // folder. Only a session-screen start carries the variable the hook commands
  // write through, so a print run (which reports on stream-json) adds nothing.
  describe('Kangentic hooks wiring', () => {
    const hooksPathIn = (folder: string) => path.join(folder, '.cursor', 'hooks.json');
    const hookOptions = (folder: string, overrides: Partial<SpawnCommandOptions> = {}) => makeOptions({
      cwd: folder,
      eventsOutputPath: path.join(folder, '.kangentic', 'sessions', 'session-1', 'events.jsonl'),
      ...overrides,
    });

    function withFolder(run: (folder: string) => void): void {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-cursor-adapter-hooks-'));
      try {
        run(folder);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }

    it.each<PermissionMode>(['default', 'acceptEdits', 'plan'])('wires the hooks and their variable on a %s session screen', (permissionMode) => {
      withFolder((folder) => {
        const options = hookOptions(folder, { permissionMode });
        adapter.buildCommand(options);
        const hooks = JSON.parse(fs.readFileSync(hooksPathIn(folder), 'utf-8')) as { version: number; hooks: Record<string, unknown[]> };
        expect(hooks.version).toBe(1);
        expect(Object.keys(hooks.hooks)).toEqual(expect.arrayContaining(['preToolUse', 'postToolUse', 'stop', 'sessionStart']));
        expect(adapter.buildEnv?.(options)).toEqual({ KANGENTIC_EVENTS_PATH_INTERACTIVE: options.eventsOutputPath });
      });
    });

    // A resume returns before `-p` is added, so it opens the session screen in
    // every mode and prints no stream-json: its turn end can only be a hook.
    it.each<[string, Partial<SpawnCommandOptions>]>([
      ['a print-mode resume', { permissionMode: 'bypassPermissions', sessionId: 'chat-1', resume: true }],
      ['a non-interactive resume', { permissionMode: 'default', nonInteractive: true, sessionId: 'chat-1', resume: true }],
    ])('wires the hooks for %s, which opens the session screen', (_start, overrides) => {
      withFolder((folder) => {
        const options = hookOptions(folder, overrides);
        expect(adapter.buildCommand(options)).not.toContain('stream-json');
        // Not `existsSync`: this file mocks it to always answer true.
        expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toContain('KANGENTIC_EVENTS_PATH_INTERACTIVE');
        expect(adapter.buildEnv?.(options)).toEqual({ KANGENTIC_EVENTS_PATH_INTERACTIVE: options.eventsOutputPath });
      });
    });

    it.each<[string, Partial<SpawnCommandOptions>]>([
      ['a print run', { permissionMode: 'bypassPermissions' }],
      ['a session screen asked to run non-interactive', { permissionMode: 'default', nonInteractive: true }],
      ['a start with no events file', { eventsOutputPath: undefined }],
    ])('wires no hooks for %s', (_start, overrides) => {
      withFolder((folder) => {
        const options = hookOptions(folder, overrides);
        adapter.buildCommand(options);
        // Not `existsSync`: this file mocks it to always answer true.
        expect(fs.readdirSync(folder)).toEqual([]);
        expect(adapter.buildEnv?.(options)).toBeNull();
      });
    });

    it('keeps the hooks until the last session in the folder leaves, MCP or not', () => {
      withFolder((folder) => {
        adapter.buildCommand(hookOptions(folder, { taskId: 'task-a', ptySessionId: 'session-a' }));
        adapter.buildCommand(hookOptions(folder, { taskId: 'task-b', ptySessionId: 'session-b' }));

        adapter.removeHooks(folder, 'session-a');
        expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toContain('KANGENTIC_EVENTS_PATH_INTERACTIVE');

        adapter.removeHooks(folder, 'session-b');
        expect(() => fs.readFileSync(hooksPathIn(folder), 'utf-8')).toThrow();
      });
    });

    it('a print run leaving does not strip the hooks a session screen in the folder still uses', () => {
      withFolder((folder) => {
        adapter.buildCommand(hookOptions(folder, { ptySessionId: 'screen' }));
        adapter.buildCommand(hookOptions(folder, { ptySessionId: 'print', permissionMode: 'bypassPermissions' }));

        adapter.removeHooks(folder, 'print');
        expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toContain('KANGENTIC_EVENTS_PATH_INTERACTIVE');
      });
    });

    it('a start over a hooks file Kangentic cannot merge into takes no hold on the folder', () => {
      withFolder((folder) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const unusableText = '{ // mine\n "hooks": {} }';
          fs.mkdirSync(path.join(folder, '.cursor'));
          fs.writeFileSync(hooksPathIn(folder), unusableText);

          adapter.buildCommand(hookOptions(folder, { ptySessionId: 'blocked' }));
          adapter.removeHooks(folder, 'blocked');
          expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toBe(unusableText);

          // The blocked start must not have held the folder: once the user fixes
          // the file, the next session's release strips it as the last holder.
          adapter.buildCommand(hookOptions(folder, { ptySessionId: 'blocked' }));
          fs.writeFileSync(hooksPathIn(folder), '{}');
          adapter.buildCommand(hookOptions(folder, { ptySessionId: 'working' }));
          expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toContain('KANGENTIC_EVENTS_PATH_INTERACTIVE');
          adapter.removeHooks(folder, 'working');
          expect(() => fs.readFileSync(hooksPathIn(folder), 'utf-8')).toThrow();
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    it('a release with no session id strips the hooks while sessions still hold the folder', () => {
      withFolder((folder) => {
        adapter.buildCommand(hookOptions(folder, { taskId: 'task-a', ptySessionId: 'session-a' }));
        adapter.buildCommand(hookOptions(folder, { taskId: 'task-b', ptySessionId: 'session-b' }));
        expect(fs.readFileSync(hooksPathIn(folder), 'utf-8')).toContain('KANGENTIC_EVENTS_PATH_INTERACTIVE');

        adapter.removeHooks(folder);

        expect(() => fs.readFileSync(hooksPathIn(folder), 'utf-8')).toThrow();
      });
    });

    it('carries the hooks variable beside the MCP server\'s', () => {
      withFolder((folder) => {
        const options = hookOptions(folder, {
          mcpServerEnabled: true,
          mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-1/session-1',
          mcpServerToken: 'secret-token',
        });
        expect(adapter.buildEnv?.(options)).toEqual({
          KANGENTIC_EVENTS_PATH_INTERACTIVE: options.eventsOutputPath,
          KANGENTIC_MCP_URL: 'http://127.0.0.1:5555/mcp/project-1/session-1',
          KANGENTIC_MCP_TOKEN: 'secret-token',
        });
      });
    });
  });

  // ── The model a start passed ────────────────────────────────────────────

  describe('configuredModelFromCommand', () => {
    it.each<[PermissionMode, string]>([
      ['default', 'bash'],
      ['bypassPermissions', 'bash'],
      ['default', 'powershell'],
      ['bypassPermissions', 'cmd.exe'],
    ])('reads the --model id back from a %s command built for %s', (permissionMode, shell) => {
      const command = adapter.buildCommand(makeOptions({ permissionMode, model: 'cursor-grok-4.6-high', prompt: 'go', shell }));
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'cursor-grok-4.6-high', displayName: 'cursor-grok-4.6-high' });
    });

    it('names the model as the cached --list-models catalog does', async () => {
      const { discoverCursorCapabilities } = await import('../../src/main/agent/adapters/cursor/capability-discovery');
      // The exec mock answers `--help` and `--list-models` alike, so one
      // output carries the flag the help read looks for and a model row.
      mockAboutStdout = '  --model <model>  Model to use\ncursor-grok-4.6-high - Grok 4.6 High\n';
      await discoverCursorCapabilities('/usr/local/bin/agent', true);
      expect(adapter.configuredModelFromCommand('agent "go" --model cursor-grok-4.6-high')).toEqual({
        id: 'cursor-grok-4.6-high',
        displayName: 'Grok 4.6 High',
      });
    });

    // The cache is module-level; `beforeEach` resets it through the module's own
    // lever, so the "no catalog" cases here and below do not depend on test order.
    it('has no display name before any catalog is cached', async () => {
      const { cachedCursorModelDisplayName } = await import('../../src/main/agent/adapters/cursor/capability-discovery');
      expect(cachedCursorModelDisplayName('cursor-grok-4.6-high')).toBeNull();
    });

    it('finds a cached display name by a trimmed id, and has none for an id the catalog lacks', async () => {
      const { discoverCursorCapabilities, cachedCursorModelDisplayName } = await import('../../src/main/agent/adapters/cursor/capability-discovery');
      mockAboutStdout = '  --model <model>  Model to use\nsome-id - Some Model\n';
      await discoverCursorCapabilities('/usr/local/bin/agent', true);
      expect(cachedCursorModelDisplayName('  some-id  ')).toBe('Some Model');
      expect(cachedCursorModelDisplayName('other-id')).toBeNull();
    });

    it.each([
      ['an unquoted id at the end', 'agent --trust "do it" --model gpt-5'],
      ['an unquoted id before the print output format', 'agent --trust "do it" --model gpt-5 --output-format stream-json'],
    ])('reads the id of a hand-written command with %s', (_label, command) => {
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'gpt-5', displayName: 'gpt-5' });
    });

    it('is null when --model is not the last flag', () => {
      expect(adapter.configuredModelFromCommand('agent --model gpt-5 "prompt"')).toBeNull();
    });

    it('is null for a command with no model, even when its prompt mentions --model', () => {
      expect(adapter.configuredModelFromCommand(adapter.buildCommand(makeOptions({ prompt: 'go' })))).toBeNull();
      expect(adapter.configuredModelFromCommand(adapter.buildCommand(makeOptions({ prompt: 'try --model gpt-5', shell: 'bash' })))).toBeNull();
    });
  });

  it('defaults to bypassPermissions so stream-json telemetry is on', () => {
    // Stream-json's init event is the only documented surface that
    // exposes Cursor's resolved model + session_id together. Defaulting
    // to bypassPermissions ensures the ContextBar model pill resolves
    // and `--resume=<id>` works without the user opting in manually.
    expect(adapter.defaultPermission).toBe('bypassPermissions');
  });

  it('exposes a streamOutput parser factory', () => {
    expect(adapter.runtime.streamOutput).toBeDefined();
    const parser = adapter.runtime.streamOutput?.createParser();
    expect(parser).toBeDefined();
    expect(typeof parser?.parseTelemetry).toBe('function');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await adapter.detect('/custom/agent');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/agent');
      expect(result.version).toBe('0.50.3');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/local/bin/agent');
    });

    it('returns found: false when which fails', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: false with configured path when --version fails on override', async () => {
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/agent');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/agent');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/agent');
      const second = await adapter.detect('/custom/agent');
      expect(first).toBe(second);
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/agent');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/agent');
      expect(execVersionCallCount).toBe(2);
    });

    it('parses version from plain version string', async () => {
      mockExecVersionStdout = '0.50.3\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('0.50.3');
    });

    it('parses version from prefixed "agent" output', async () => {
      mockExecVersionStdout = 'agent 1.2.3\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('1.2.3');
    });

    it('parses version from "Cursor Agent" prefix', async () => {
      mockExecVersionStdout = 'Cursor Agent 2.0.0-beta\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('2.0.0-beta');
    });

    it('returns null for non-version output', async () => {
      mockExecVersionStdout = 'Usage: agent [options]\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBeNull();
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    // ── Interactive mode (default) ──────────────────────────────────────

    it('builds interactive command with prompt as positional arg', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).not.toContain('-p');
      expect(command).not.toContain('--output-format');
      expect(command).not.toContain('--trust');
      expect(command).toContain('Fix the bug');
    });

    it('omits prompt when none provided', () => {
      const command = adapter.buildCommand(makeOptions());
      const parts = command.split(' ');
      // Only the agent path
      expect(parts.length).toBe(1);
    });

    // ── Non-interactive mode (bypassPermissions) ────────────────────────

    it('adds --trust, -p and --output-format stream-json for bypassPermissions', () => {
      const command = adapter.buildCommand(makeOptions({
        permissionMode: 'bypassPermissions',
        prompt: 'Fix the bug',
      }));
      expect(command).toContain('--trust');
      expect(command).toContain('-p');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
    });

    it('adds --trust, -p and --output-format stream-json for nonInteractive flag', () => {
      const command = adapter.buildCommand(makeOptions({
        nonInteractive: true,
        prompt: 'Fix the bug',
      }));
      expect(command).toContain('--trust');
      expect(command).toContain('-p');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
    });

    // ── Resume mode ─────────────────────────────────────────────────────

    it('builds resume command with --resume flag', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'chat-abc-123',
        resume: true,
      }));
      expect(command).toContain('--resume=');
      expect(command).toContain('chat-abc-123');
      expect(command).not.toContain('--trust');
    });

    it('resume command does not include prompt or -p', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'chat-abc-123',
        resume: true,
        prompt: 'This should be ignored',
      }));
      expect(command).not.toContain('-p');
      expect(command).not.toContain('This should be ignored');
    });

    it('trusts a non-interactive resume so a new worktree does not exit on Workspace Trust', () => {
      const command = adapter.buildCommand(makeOptions({
        permissionMode: 'bypassPermissions',
        sessionId: 'chat-abc-123',
        resume: true,
      }));
      expect(command).toContain('--trust');
      expect(command).toContain('--resume=');
      expect(command).not.toContain('-p');
    });

    // ── Permission mode mapping ─────────────────────────────────────────

    describe('permission mode mapping', () => {
      // `default` is the confirm-changes screen. `acceptEdits` is the same
      // screen with --force, so commands run unless one is explicitly denied,
      // and `plan` is the same screen in Cursor's plan mode. Every other mode
      // must emit `--output-format stream-json`. Cursor's docs say stream-json
      // only works with --print, so without this the init event never lands
      // and ContextBar is stuck on "Starting agent..." forever.
      const streamJsonModes: PermissionMode[] = [
        'bypassPermissions', 'dontAsk', 'auto',
      ];
      const interactiveModes: PermissionMode[] = ['default'];

      for (const mode of streamJsonModes) {
        it(`emits --trust, -p and --output-format stream-json for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({
            permissionMode: mode,
            prompt: 'test',
          }));
          expect(command).toContain('--trust');
          expect(command).toContain('-p');
          expect(command).toContain('--output-format');
          expect(command).toContain('stream-json');
        });
      }

      for (const mode of interactiveModes) {
        it(`uses interactive mode for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({
            permissionMode: mode,
            prompt: 'test',
          }));
          expect(command).not.toContain('-p');
          expect(command).not.toContain('--output-format');
          expect(command).not.toContain('--trust');
          expect(command).not.toContain('--force');
        });
      }

      it('keeps the session screen and skips approvals for acceptEdits', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'acceptEdits',
          prompt: 'test',
        }));
        expect(command).toContain('--trust');
        expect(command).toContain('--force');
        expect(command).toContain('test');
        expect(command).not.toContain('-p');
        expect(command).not.toContain('--output-format');
        expect(command).not.toContain('stream-json');
      });

      // `--mode plan` (https://cursor.com/docs/cli/reference/parameters). The
      // plan screen keeps the session open for Cursor's own plan review.
      it('opens the session screen in plan mode for plan, with --trust and no force', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'plan', prompt: 'test', shell: 'bash' }));
        expect(command).toContain('--trust');
        expect(command).toContain('--mode plan');
        expect(command).toContain(quoteArg('test', 'bash'));
        expect(command).not.toContain('--force');
        expect(command).not.toContain('-p');
        expect(command).not.toContain('stream-json');
      });

      it('keeps plan mode on a resumed plan session', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'plan',
          sessionId: 'chat-abc-123',
          resume: true,
          prompt: 'This should be ignored',
        }));
        expect(command).toContain('--mode plan');
        expect(command).toContain('--resume=');
        expect(command).not.toContain('This should be ignored');
      });

      it('runs plan as a print run when asked to run non-interactive', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'plan', nonInteractive: true, prompt: 'test' }));
        expect(command).toContain('-p');
        expect(command).toContain('stream-json');
        expect(command).not.toContain('--mode');
      });

      it('offers plan beside the three modes it already had', () => {
        expect(adapter.permissions.map((entry) => entry.mode)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
      });

      it('creates a chat before a plan start, which prints no session id', () => {
        expect(adapter.reportsLaunchSessionId({ permissionMode: 'plan' })).toBe(false);
      });

      it('keeps --force on a resumed skip-approvals session', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'acceptEdits',
          sessionId: 'chat-abc-123',
          resume: true,
          prompt: 'This should be ignored',
        }));
        expect(command).toContain('--trust');
        expect(command).toContain('--force');
        expect(command).toContain('--resume=');
        expect(command).not.toContain('-p');
        expect(command).not.toContain('This should be ignored');
      });

      it('prints stream-json when skip-approvals is asked to run non-interactive', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'acceptEdits',
          nonInteractive: true,
          prompt: 'test',
        }));
        expect(command).toContain('--trust');
        expect(command).toContain('-p');
        expect(command).toContain('stream-json');
        expect(command).not.toContain('--force');
      });

      it('uses stream-json when nonInteractive is explicitly requested', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'default',
          nonInteractive: true,
          prompt: 'test',
        }));
        expect(command).toContain('--trust');
        expect(command).toContain('-p');
        expect(command).toContain('stream-json');
      });
    });

    // ── Shell quoting ───────────────────────────────────────────────────

    describe('shell quoting', () => {
      it('replaces double quotes with single quotes for non-unix shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'powershell',
        }));
        expect(command).not.toContain('"broken"');
        expect(command).toContain("'broken'");
      });

      it('preserves double quotes for unix-like shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'bash',
        }));
        expect(command).toContain('"broken"');
      });
    });

    it('starts with quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/agent',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/agent', 'bash'))).toBe(true);
    });
  });

  // ── Runtime strategy ──────────────────────────────────────────────────────

  describe('runtime', () => {
    it('reads hooks first, with the terminal as the fallback until one arrives', () => {
      expect(adapter.runtime.activity.kind).toBe('hooks_and_pty');
    });

    it('reports its turn end', () => {
      expect(adapter.runtime.reportsTurnEnd).toBe(true);
    });

    it('has session ID capture via fromOutput', () => {
      expect(adapter.runtime.sessionId).toBeDefined();
      expect(adapter.runtime.sessionId!.fromOutput).toBeDefined();
    });

    // A sessionStart hook's `session_id` is the conversation id (hooks docs).
    // The bridge keeps at most 2048 characters of the payload, so the read must
    // not need closed JSON.
    it('reads the conversation id from a sessionStart hook, even cut short', () => {
      const fromHook = adapter.runtime.sessionId!.fromHook!;
      const sessionId = '997bca3d-4c50-43e2-a038-9a99860f4e7c';
      expect(fromHook(JSON.stringify({ session_id: sessionId, is_background_agent: false, hook_event_name: 'sessionStart' }))).toBe(sessionId);
      expect(fromHook(`{"conversation_id":"${sessionId.toUpperCase()}","generation_id":"g-1","workspace_roots":["/projects/x`)).toBe(sessionId);
      expect(fromHook('{"session_id":"not-a-uuid"}')).toBeNull();
    });

    it('has no session history', () => {
      expect(adapter.runtime.sessionHistory).toBeUndefined();
    });

    it('reads its hooks\' events file, with no status line', () => {
      const statusFile = adapter.runtime.statusFile!;
      expect(statusFile.parseStatus('{}')).toBeNull();
      expect(statusFile.parseEvent('{"ts":1,"type":"tool_start","tool":"Shell"}')).toEqual({ ts: 1, type: 'tool_start', tool: 'Shell' });
      expect(statusFile.parseEvent('not json')).toBeNull();
      expect(statusFile.isFullRewrite).toBe(false);
    });

    it('accepts only a bridge-shaped line as a hook event', () => {
      const parseEvent = adapter.runtime.statusFile!.parseEvent;
      expect(parseEvent('')).toBeNull();
      expect(parseEvent('   \t ')).toBeNull();
      expect(parseEvent('{"ts":1}')).toBeNull();
      expect(parseEvent('{"ts":1,"type":2}')).toBeNull();
      expect(parseEvent('[{"ts":1,"type":"idle"}]')).toBeNull();
      expect(parseEvent('{"type":"idle"}')).toBeNull();
      expect(parseEvent('{"type":"idle","ts":"1"}')).toBeNull();
      expect(parseEvent('{"ts":1,"type":"idle"}')).toEqual({ ts: 1, type: 'idle' });
    });

    it('does not export a sessionBootstrap runtime hook', () => {
      // Adapter-specific lifecycle work lives in `attachSession`, not in
      // the declarative runtime surface.
      expect((adapter.runtime as { sessionBootstrap?: unknown }).sessionBootstrap).toBeUndefined();
    });

    it('exposes an attachSession lifecycle hook', () => {
      expect(typeof adapter.attachSession).toBe('function');
    });
  });

  // ── attachSession ─────────────────────────────────────────────────────────

  describe('attachSession', () => {
    type UsagePatch = Partial<import('../../src/shared/types').SessionUsage>;

    function makeContext() {
      const applied: UsagePatch[] = [];
      return {
        context: {
          sessionId: 'test-session-id',
          applyUsage: (usage: UsagePatch) => { applied.push(usage); },
        },
        applied,
      };
    }

    async function flushPromises() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }

    it('invokes `agent about --format json` on the detected CLI path', async () => {
      const { context } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(aboutCallLog).toHaveLength(1);
      expect(aboutCallLog[0].path).toBe('/usr/local/bin/agent');
      expect(aboutCallLog[0].args).toEqual(['about', '--format', 'json']);
    });

    // `about` reports the account's default model. A start that passed
    // `--model` is seeded from its command, which `about` would overwrite.
    it('does not ask `about` for a session started with --model', async () => {
      adapter.buildCommand(makeOptions({ model: 'gpt-5', ptySessionId: 'test-session-id' }));
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(aboutCallLog).toHaveLength(0);
      expect(applied).toHaveLength(0);
    });

    it('disposing the --model early return clears the launch, so the next attach asks `about`', async () => {
      adapter.buildCommand(makeOptions({ model: 'gpt-5', ptySessionId: 'test-session-id' }));
      const { context } = makeContext();
      const firstAttachment = adapter.attachSession!(context);
      await flushPromises();
      expect(aboutCallLog).toHaveLength(0);

      firstAttachment.dispose();
      adapter.attachSession!(context);
      await flushPromises();

      expect(aboutCallLog).toHaveLength(1);
    });

    it('does not ask `about` when taking back an agent this process did not start', async () => {
      const { context, applied } = makeContext();
      adapter.attachSession!({ ...context, takingBack: true });
      await flushPromises();
      expect(aboutCallLog).toHaveLength(0);
      expect(applied).toHaveLength(0);
    });

    it('still asks `about` for a resume, which carries no --model', async () => {
      adapter.buildCommand(makeOptions({ model: 'gpt-5', sessionId: 'chat-1', resume: true, ptySessionId: 'test-session-id' }));
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(aboutCallLog).toHaveLength(1);
      expect(applied).toEqual([{ model: { id: 'Auto', displayName: 'Auto' } }]);
    });

    it('applies usage with model from the about payload', async () => {
      mockAboutStdout = JSON.stringify({
        cliVersion: '2026.04.15-dccdccd',
        model: 'Auto',
      });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toEqual([{ model: { id: 'Auto', displayName: 'Auto' } }]);
    });

    it('keeps the about display name when no --list-models catalog is cached', async () => {
      mockAboutStdout = JSON.stringify({ model: 'Claude 4.6 Sonnet' });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toEqual([
        { model: { id: 'Claude 4.6 Sonnet', displayName: 'Claude 4.6 Sonnet' } },
      ]);
    });

    it('applies nothing when the about command fails', async () => {
      mockAboutShouldFail = true;
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
    });

    it('applies nothing when stdout is not valid JSON', async () => {
      mockAboutStdout = 'not-json-at-all';
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
    });

    it('applies nothing when the model field is missing', async () => {
      mockAboutStdout = JSON.stringify({ cliVersion: 'x' });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
    });

    it('applies nothing when the model field is an empty string', async () => {
      mockAboutStdout = JSON.stringify({ model: '' });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
    });

    it('applies nothing when the model field is non-string', async () => {
      mockAboutStdout = JSON.stringify({ model: 42 });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
    });

    it('applies nothing when the CLI is not detected', async () => {
      mockWhichResult = new Error('not found');
      adapter.invalidateDetectionCache();
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toHaveLength(0);
      // Should not even attempt the about call without a resolved path.
      expect(aboutCallLog).toHaveLength(0);
    });

    it('dispose() prevents a late-arriving about result from being applied', async () => {
      // Delay the mock so dispose can land first.
      let resolveExec: ((result: { stdout: string; stderr: string }) => void) | null = null;
      const slowPromise = new Promise<{ stdout: string; stderr: string }>((resolve) => {
        resolveExec = resolve;
      });
      // Overwrite the promisified mock to return our pending promise.
      const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
      const cp = await import('node:child_process');
      // Save and restore each mock on its own: restoring both from one saved
      // value left `execFile` running the `exec` fake (string-parsed args, no
      // options) for every later test on the platforms that call `execFile`.
      const previousExec = (cp.exec as unknown as Record<symbol, unknown>)[promisifyCustom];
      const previousExecFile = (cp.execFile as unknown as Record<symbol, unknown>)[promisifyCustom];
      (cp.exec as unknown as Record<symbol, unknown>)[promisifyCustom] = () => slowPromise;
      (cp.execFile as unknown as Record<symbol, unknown>)[promisifyCustom] = () => slowPromise;
      try {
        const { context, applied } = makeContext();
        const attachment = adapter.attachSession!(context);
        if (attachment) attachment.dispose();
        resolveExec?.({ stdout: JSON.stringify({ model: 'Auto' }), stderr: '' });
        await flushPromises();
        expect(applied).toHaveLength(0);
      } finally {
        (cp.exec as unknown as Record<symbol, unknown>)[promisifyCustom] = previousExec;
        (cp.execFile as unknown as Record<symbol, unknown>)[promisifyCustom] = previousExecFile;
      }
    });

    it('returns an attachment with a dispose method', () => {
      const { context } = makeContext();
      const attachment = adapter.attachSession!(context);
      expect(attachment).toBeDefined();
      expect(typeof (attachment as import('../../src/shared/types').SessionAttachment).dispose).toBe('function');
    });

    it('two attachments on the same instance are independent - first dispose does not affect second', async () => {
      // Two sessions sharing the same adapter instance (normal when two tasks
      // use Cursor). Each gets a separate dispose flag, so disposing the first
      // attachment must not block the second attachment's applyUsage call.
      const { context: contextA, applied: appliedA } = makeContext();
      const { context: contextB, applied: appliedB } = makeContext();

      const attachmentA = adapter.attachSession!(contextA);
      const attachmentB = adapter.attachSession!(contextB);

      // Dispose the first attachment immediately
      if (attachmentA) attachmentA.dispose();

      await flushPromises();

      // First: disposed, so nothing applied
      expect(appliedA).toHaveLength(0);

      // Second: untouched, so the model should resolve normally
      expect(appliedB).toEqual([{ model: { id: 'Auto', displayName: 'Auto' } }]);

      // Dispose the second cleanly
      if (attachmentB) attachmentB.dispose();
    });

    it('applyUsage called from a microtask BEFORE dispose sets the flag is still applied', async () => {
      // Scenario: the about promise resolves synchronously (microtask), but
      // test code queues dispose() to run in the NEXT microtask via
      // setImmediate. The race: applyUsage resolves before dispose flips
      // the flag, so usage must be applied.
      //
      // This is the exact race described in audit gap 7: the .then() callback
      // that calls applyUsage is queued before dispose(), so disposed=false
      // when applyUsage executes. The flag is only set after the microtask
      // queue drains.
      const { context, applied } = makeContext();

      // Attach session (fires the about query immediately)
      const attachment = adapter.attachSession!(context);

      // Flush the about promise (.then resolves in microtask queue)
      await new Promise((resolve) => setImmediate(resolve));

      // Dispose AFTER the microtask that called applyUsage has run
      if (attachment) attachment.dispose();

      // Since the about result arrived before dispose flipped the flag,
      // usage must have been applied.
      expect(applied).toHaveLength(1);
      expect(applied[0]).toHaveProperty('model');
    });
  });

  describe('usageFromOutput', () => {
    it('reads occupancy and the live model from a TUI status bar, and ignores events', () => {
      const usage = adapter.usageFromOutput!('thinking...\nAuto \u00b7 9.2% \u00b7 1 file edited\n');
      expect(usage?.contextWindow?.usedPercentage).toBe(9.2);
      expect(usage?.model).toEqual({
        id: 'Auto',
        displayName: 'Auto',
        reportedByAgent: true,
      });
    });

    it('returns null when the chunk names no occupancy', () => {
      expect(adapter.usageFromOutput!('ready\n')).toBeNull();
    });
  });

  // ── Session ID capture ────────────────────────────────────────────────────

  describe('sessionId.fromOutput', () => {
    function fromOutput(data: string): string | null {
      return adapter.runtime.sessionId!.fromOutput!(data);
    }

    it('captures UUID from NDJSON init event', () => {
      const line = '{"type":"system","subtype":"init","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","model":"Claude 4 Sonnet"}';
      expect(fromOutput(line)).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    });

    it('captures UUID from multi-line NDJSON stream', () => {
      const output = [
        '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","model":"GPT-5","permissionMode":"default"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}',
      ].join('\n');
      expect(fromOutput(output)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('returns null for interactive output without session_id', () => {
      expect(fromOutput('Welcome to Cursor Agent')).toBeNull();
      expect(fromOutput('MOCK_CURSOR_SESSION:abc')).toBeNull();
    });

    it('returns null for empty data', () => {
      expect(fromOutput('')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(fromOutput('{"session_id": "not-a-uuid"}')).toBeNull();
    });

    it('matches real Cursor CLI NDJSON fixture format', () => {
      // Real-format fixture from Cursor CLI docs
      const fixture = '{"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"/absolute/path","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","model":"Claude 4 Sonnet","permissionMode":"default"}';
      expect(fromOutput(fixture)).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    });
  });

  // ── No-op methods ────────────────────────────────────────────────────────

  describe('no-op methods', () => {
    it('ensureTrust resolves without error', async () => {
      await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    });

    it('removeHooks does not throw', () => {
      expect(() => adapter.removeHooks('/some/dir')).not.toThrow();
    });

    it('locateSessionHistoryFile returns null when the transcript file is not on disk', async () => {
      const result = await adapter.locateSessionHistoryFile('session-1', '/some/dir');
      expect(result).toBeNull();
    });
  });

  // ── Output detection ──────────────────────────────────────────────────────

  describe('detectFirstOutput', () => {
    it('returns true for any non-empty data', () => {
      expect(adapter.detectFirstOutput('hello')).toBe(true);
    });

    it('returns false for empty data', () => {
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  // ── Exit sequence ─────────────────────────────────────────────────────────

  describe('getExitSequence', () => {
    it('returns Ctrl+C', () => {
      expect(adapter.getExitSequence()).toEqual(['\x03']);
    });
  });

  // ── interpolateTemplate ──────────────────────────────────────────────────

  describe('interpolateTemplate', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('leaves unmatched placeholders unchanged', () => {
      const result = adapter.interpolateTemplate('{{name}} - {{unknown}}', { name: 'test' });
      expect(result).toBe('test - {{unknown}}');
    });
  });
});

// ── getInjectionSequence ─────────────────────────────────────────────────────

describe('CursorAdapter - getInjectionSequence', () => {
  let adapter: CursorAdapter;

  beforeEach(() => {
    adapter = new CursorAdapter();
    resetCursorCapabilityCacheForTests();
  });

  it('emits /model <name> when modelChanged is true', () => {
    const sequence = adapter.getInjectionSequence({
      model: 'claude-4-sonnet',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual(['/model claude-4-sonnet']);
  });

  it('returns empty array when only effortChanged (Cursor has no effort concept)', () => {
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: false,
      effort: 'high',
      effortChanged: true,
    });
    expect(sequence).toEqual([]);
  });

  it('emits only /model when both model and effort change (effort still ignored)', () => {
    // Cursor encodes reasoning strength in model names (e.g. "Thinking" variants),
    // so effort changes alone produce no injection command.
    const sequence = adapter.getInjectionSequence({
      model: 'claude-4.1-sonnet-thinking',
      modelChanged: true,
      effort: 'high',
      effortChanged: true,
    });
    expect(sequence).toEqual(['/model claude-4.1-sonnet-thinking']);
  });

  it('returns empty array when neither field changed', () => {
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: false,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual([]);
  });

  it('returns empty array when modelChanged is true but model value is null', () => {
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual([]);
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe('Agent Registry - Cursor', () => {
  it('has cursor adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('cursor')).toBe(true);
  });

  it('getOrThrow returns CursorAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('cursor');
    expect(adapter.name).toBe('cursor');
    expect(adapter.sessionType).toBe('cursor_agent');
  });

  it('lists cursor among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('cursor');
  });

  it('can look up cursor by session type', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('cursor_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('cursor');
  });
});
