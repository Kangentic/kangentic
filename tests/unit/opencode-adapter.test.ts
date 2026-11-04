/**
 * Unit tests for OpenCodeAdapter - validates that the command
 * builder, runtime strategy, and lifecycle methods produce shapes
 * consistent with the documented OpenCode CLI surface
 * (https://github.com/anomalyco/opencode).
 *
 * Authoritative TUI flag table (from /anomalyco/opencode docs):
 *
 *   --continue / -c   continue last session
 *   --session  / -s   session ID to continue
 *   --fork            fork session when continuing
 *   --prompt          initial prompt for the TUI
 *   --model    / -m   provider/model
 *   --agent           agent to use
 *   --port, --hostname server config
 *
 * The TUI's positional argument is a project DIRECTORY, NOT a prompt.
 * The non-interactive `opencode run` subcommand is the only place
 * `--dangerously-skip-permissions` is documented.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `discoverCapabilities` reads `--help` on OpenCode 1 only. The exec seam records
// each help read (and answers with a help text that has no --model flag) while a
// test arms it; unarmed, every call goes to the real function.
// A test can set `helpText` (a help with `--model`) and `modelsOutput` (what
// `opencode models --verbose` prints); each read is recorded with its arguments.
const helpReads = vi.hoisted(() => ({
  armed: false,
  calls: [] as string[],
  helpText: 'opencode [project]\n\nOptions:\n  --help  show help\n',
  modelsOutput: '',
  // While set, the `opencode models` answer waits on it, so a test holds a read in flight.
  modelsGate: null as Promise<void> | null,
}));
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  const answer = async (commandLine: string) => {
    const isModelsRead = commandLine.includes('models');
    if (isModelsRead && helpReads.modelsGate) await helpReads.modelsGate;
    return { stdout: isModelsRead ? helpReads.modelsOutput : helpReads.helpText, stderr: '' };
  };
  return {
    ...actual,
    execAsync: (...args: Parameters<typeof actual.execAsync>) => {
      if (!helpReads.armed) return actual.execAsync(...args);
      helpReads.calls.push(String(args[0]));
      return answer(String(args[0]));
    },
    execFileAsync: (...args: Parameters<typeof actual.execFileAsync>) => {
      if (!helpReads.armed) return actual.execFileAsync(...args);
      const commandLine = `${String(args[0])} ${(Array.isArray(args[1]) ? args[1] : []).join(' ')}`;
      helpReads.calls.push(commandLine);
      return answer(commandLine);
    },
  };
});

// The two windowed tool reads are stubbed, so a test sees the window the adapter hands
// them without opening the machine's real OpenCode database.
const toolReads = vi.hoisted(() => ({
  counts: vi.fn((..._args: unknown[]): null => null),
  resultTokens: vi.fn((..._args: unknown[]): null => null),
}));
vi.mock('../../src/main/agent/adapters/opencode/transcript-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/adapters/opencode/transcript-usage')>();
  return {
    ...actual,
    readOpenCodeToolCountsAtPath: (...args: unknown[]) => toolReads.counts(...args),
    readOpenCodeToolResultTokensAtPath: (...args: unknown[]) => toolReads.resultTokens(...args),
  };
});

// A WSL distro's facts are a fixture: the home share is a temp folder a test plants files in.
const distroHome = vi.hoisted(() => ({ path: '' }));
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  const facts = () => ({
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome.path, uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
  });
  return { ...actual, resolveWslDistroFacts: async () => facts(), peekWslDistroFacts: () => facts() };
});

import {
  OpenCodeAdapter,
  OpenCodeDetector,
  OpenCodeCommandBuilder,
} from '../../src/main/agent/adapters/opencode';
import { openCodeTranscriptSourcePath } from '../../src/main/agent/adapters/opencode/transcript-parser';
import { isOpenCodeV2, openCodeMajorVersion } from '../../src/main/agent/adapters/opencode/version';
import { isDistroOpenCodeV2 } from '../../src/main/agent/adapters/opencode/distro-sessions';
import type { CliPlace, CliTarget } from '../../src/main/agent/shared/cli-target';
import { loadBetterSqlite3 } from '../../src/main/agent/adapters/opencode/session-history-parser';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

const isWindows = process.platform === 'win32';
const q = (str: string) => (isWindows ? `"${str}"` : `'${str}'`);

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/opencode',
    taskId: 'task-001',
    cwd: '/home/dev/project',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('OpenCode Adapter', () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  describe('adapter identity', () => {
    it('has correct name, displayName, and sessionType', () => {
      expect(adapter.name).toBe('opencode');
      expect(adapter.displayName).toBe('OpenCode');
      expect(adapter.sessionType).toBe('opencode_agent');
    });

    it('does not support caller-specified session IDs', () => {
      expect(adapter.supportsCallerSessionId).toBe(false);
    });

    it('declares the permission options OpenCode itself has: its agents, the default agent, and --auto', () => {
      // OpenCode's autonomy is its agents plus the TUI's `--auto` flag. Modes
      // with no OpenCode meaning (dontAsk, auto) are not offered.
      const entries = adapter.permissions.map((entry) => ({ mode: entry.mode, label: entry.label }));
      expect(entries).toEqual([
        { mode: 'plan', label: 'Plan' },
        { mode: 'default', label: 'Default Agent' },
        { mode: 'acceptEdits', label: 'Build' },
        { mode: 'bypassPermissions', label: 'Build (Auto-approve)' },
      ]);
    });

    it('uses acceptEdits (Build) as default permission', () => {
      expect(adapter.defaultPermission).toBe('acceptEdits');
    });
  });

  describe('buildCommand - fresh session', () => {
    it('emits the binary path and no positional prompt', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'fix the bug' }));
      expect(command).toContain('/usr/bin/opencode');
      // Prompt MUST go through --prompt, not as a positional. The TUI
      // positional is a project directory.
      expect(command).toContain('--prompt');
      expect(command).toContain('fix the bug');
    });

    it('passes prompt via --prompt flag with shell-safe quoting', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'fix the bug' }));
      expect(command).toContain(`--prompt ${q('fix the bug')}`);
    });

    it('omits --prompt entirely when no prompt is supplied', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--prompt');
    });

    it('does not emit a positional project directory', () => {
      // The PTY layer sets the shell cwd; we must not pass a
      // positional, otherwise OpenCode would chdir into the prompt
      // text or some other accidental value.
      const command = adapter.buildCommand(makeOptions({ prompt: 'hello' }));
      const tokens = command.split(' ').filter((t) => t.length > 0);
      // First token is the binary path. Whitespace-free paths are not
      // quoted by quoteArg, so we accept either form.
      expect(tokens[0].replace(/^["']|["']$/g, '')).toBe('/usr/bin/opencode');
      // The very next token must be a flag - never a bare value that
      // OpenCode would interpret as a project directory positional.
      expect(tokens[1]).toBe('--prompt');
    });

    it('does not emit --dangerously-skip-permissions in TUI mode', () => {
      // That flag exists only on the `run` subcommand. Documenting
      // this absence so a future change does not silently regress.
      const modes: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];
      for (const permissionMode of modes) {
        const command = adapter.buildCommand(makeOptions({ permissionMode, prompt: 'go' }));
        expect(command).not.toContain('--dangerously-skip-permissions');
      }
    });

    describe('--agent flag (permission mode → OpenCode primary agent)', () => {
      // Agent names "plan" and "build" have no whitespace, so quoteArg
      // emits them bare on every platform. Asserting on the literal
      // unquoted form keeps the tests platform-agnostic.

      it('emits --agent plan for the plan permission mode', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'plan', prompt: 'go' }));
        expect(command).toContain('--agent plan');
      });

      it('emits --agent build for acceptEdits', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'acceptEdits', prompt: 'go' }));
        expect(command).toContain('--agent build');
      });

      it('emits --agent build for bypassPermissions', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'bypassPermissions', prompt: 'go' }));
        expect(command).toContain('--agent build');
      });

      it('omits --agent for default mode (defers to user opencode.json default_agent)', () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: 'default', prompt: 'go' }));
        expect(command).not.toContain('--agent');
      });

      it('omits --agent for non-OpenCode modes that may leak through (dontAsk, auto)', () => {
        for (const permissionMode of ['dontAsk', 'auto'] as PermissionMode[]) {
          const command = adapter.buildCommand(makeOptions({ permissionMode, prompt: 'go' }));
          expect(command).not.toContain('--agent');
        }
      });
    });

    describe('--auto (Build (Auto-approve), OpenCode 1.17.12 and later, and OpenCode 2)', () => {
      const builder = new OpenCodeCommandBuilder();
      const base = { opencodePath: '/usr/bin/opencode', taskId: 'task-001', cwd: '/home/dev/project' };

      it('passes --auto with --agent build on a CLI that has the flag', () => {
        for (const cliVersion of ['1.17.12', '1.18.31', '1.20.0']) {
          const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'bypassPermissions', prompt: 'fix the bug', cliVersion });
          expect(command).toBe(`/usr/bin/opencode --auto --agent build --prompt ${q('fix the bug')}`);
        }
      });

      it('passes --agent build alone on an older or unread version, which would reject the flag', () => {
        for (const cliVersion of ['1.17.11', '1.14.25', null, 'dev build']) {
          const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'bypassPermissions', prompt: 'fix the bug', cliVersion });
          expect(command).toBe(`/usr/bin/opencode --agent build --prompt ${q('fix the bug')}`);
        }
      });

      it('passes --auto on a resume too, since it is a flag on the TUI process', () => {
        const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'bypassPermissions', resume: true, sessionId: 'ses_abc123def456', cliVersion: '1.18.31' });
        expect(command).toBe('/usr/bin/opencode --auto --session ses_abc123def456');
      });

      it('passes --auto on OpenCode 2 beside --standalone', () => {
        const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'bypassPermissions', prompt: 'fix the bug', cliVersion: 'v2.2.5' });
        expect(command).toBe(`/usr/bin/opencode --standalone --auto --prompt ${q('fix the bug')}`);
      });

      it('never passes --auto for any other mode, or to attach', () => {
        for (const permissionMode of ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'] as PermissionMode[]) {
          const command = builder.buildOpenCodeCommand({ ...base, permissionMode, prompt: 'go', cliVersion: '1.18.31' });
          expect(command).not.toContain('--auto');
        }
        const executionTarget = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' as const }, workingDirectory: '/srv/project' };
        const attach = builder.buildOpenCodeCommand({ ...base, permissionMode: 'bypassPermissions', executionTarget, cliVersion: '1.18.31' });
        expect(attach).not.toContain('--auto');
      });
    });
  });

  describe('buildCommand - resume session', () => {
    it('builds resume command with --session flag and session ID', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'ses_abc123def456',
      }));
      expect(command).toContain('--session');
      expect(command).toContain('ses_abc123def456');
    });

    it('omits prompt on resume (matches Claude --resume convention)', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'ses_abc123def456',
        prompt: 'this should be dropped',
      }));
      expect(command).not.toContain('--prompt');
      expect(command).not.toContain('this should be dropped');
    });

    it('falls through to fresh-session shape when resume is true but sessionId is missing', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: undefined,
        prompt: 'fallback prompt',
      }));
      expect(command).not.toContain('--session');
      expect(command).toContain('--prompt');
      expect(command).toContain('fallback prompt');
    });

    it('omits --agent on resume so the user\'s runtime Tab choice is preserved', () => {
      // Even when permissionMode is 'plan', resuming an existing
      // OpenCode session must not force --agent. The saved session
      // already has an active agent and the user may have Tab-switched
      // to a different one mid-conversation. Forcing --agent here
      // would shadow that runtime choice.
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'ses_abc123def456',
        permissionMode: 'plan',
      }));
      expect(command).not.toContain('--agent');
    });
  });

  describe('runtime strategy', () => {
    it('uses hooks-with-PTY-fallback activity detection', () => {
      // OpenCode's plugin system fires `tool.execute.before/after` and
      // `event` for `session.*` types in TUI mode. Hooks are authoritative,
      // and the PTY silence timer remains as a fallback for the gap
      // between idle events (upstream issue #2021 still open).
      expect(adapter.runtime.activity.kind).toBe('hooks_and_pty');
    });

    it('parses event-bridge JSONL via runtime.statusFile.parseEvent', () => {
      const parseEvent = adapter.runtime.statusFile?.parseEvent;
      expect(parseEvent).toBeTypeOf('function');
      const sample = JSON.stringify({ ts: 123, type: 'tool_start', tool: 'bash' });
      expect(parseEvent?.(sample)).toEqual({ ts: 123, type: 'tool_start', tool: 'bash' });
      expect(parseEvent?.('not json')).toBeNull();
    });

    it('extracts sessionID from hookContext via runtime.sessionId.fromHook', () => {
      const fromHook = adapter.runtime.sessionId?.fromHook;
      expect(fromHook).toBeTypeOf('function');
      const hookContext = JSON.stringify({ sessionID: 'ses_abc123' });
      expect(fromHook?.(hookContext)).toBe('ses_abc123');
      expect(fromHook?.('{}')).toBeNull();
      expect(fromHook?.('not json')).toBeNull();
    });

    it('declares fromOutput and fromFilesystem session ID capture', () => {
      expect(adapter.runtime.sessionId?.fromOutput).toBeTypeOf('function');
      expect(adapter.runtime.sessionId?.fromFilesystem).toBeTypeOf('function');
    });

    // Real OpenCode session ID format (verified empirically against
    // v1.14.25): `ses_<26 alphanumeric>`. UUID variants are still
    // accepted defensively for forward compatibility.
    const REAL_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

    it('captures native ses_* ID from labeled startup output', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = `Welcome to OpenCode\nsession id: ${REAL_SESSION_ID}\n`;
      expect(fromOutput?.(sample)).toBe(REAL_SESSION_ID);
    });

    it('captures native ses_* ID from session_id-style JSON labels', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = `"session_id": "${REAL_SESSION_ID}"`;
      expect(fromOutput?.(sample)).toBe(REAL_SESSION_ID);
    });

    it('ignores a bare --session flag echo (our resume command, not an agent banner)', () => {
      // A `--session <id>` flag in the scrollback is a COMMAND line, not the
      // agent announcing its id: it appears when the shell echoes our own
      // resume invocation. Capturing from it would re-capture an id we already
      // know, and - the real bug - lets a stale id leak in (see the PSReadLine
      // case below). The labeled-banner-only match requires a `:`/`=` separator,
      // which a bare flag form lacks.
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = `Resume with: opencode --session '${REAL_SESSION_ID}'`;
      expect(fromOutput?.(sample)).toBeNull();
    });

    it('ignores a stale --session <uuid> from a PSReadLine history autosuggestion (flaky-capture regression)', () => {
      // On Windows, PSReadLine renders a ghosted command-history suggestion into
      // the PTY before the agent runs. A prior run's resume command
      // (`opencode --session <stale-uuid>`) thus appears in the scrollback ahead
      // of the real `session id: ses_...` banner. The scanner must skip the
      // flag-form echo and capture only the announced banner; otherwise it
      // resumes the wrong (stale) session. This is the exact bug that flaked the
      // OpenCode session-ID capture E2E test.
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const staleAutosuggestion =
        '> & "C:\\path\\mock-opencode.cmd" --session 1f7e3f94-29ed-4640-a012-c892ee8186a8';
      expect(fromOutput?.(staleAutosuggestion)).toBeNull();
      // And the same buffer once the real banner arrives: the banner wins.
      const withBanner = `${staleAutosuggestion}\r\nsession id: ${REAL_SESSION_ID}`;
      expect(fromOutput?.(withBanner)).toBe(REAL_SESSION_ID);
    });

    it('strips ANSI before pattern matching the native ID', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = `\x1b[36msession id:\x1b[0m \x1b[1m${REAL_SESSION_ID}\x1b[0m`;
      expect(fromOutput?.(sample)).toBe(REAL_SESSION_ID);
    });

    it('also captures UUID format defensively (forward-compat fallback)', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = 'session id: 550e8400-e29b-41d4-a716-446655440000';
      expect(fromOutput?.(sample)).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('returns null when no session ID is present', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      expect(fromOutput?.('just some banner text')).toBeNull();
    });
  });

  describe('lifecycle hooks', () => {
    it('detects first output via cursor-hide ESC sequence', () => {
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('hello world')).toBe(false);
    });

    it('exit sequence is Ctrl+C only (verified empirically: /exit and /quit are not recognised commands)', () => {
      const exitSequence = adapter.getExitSequence?.();
      expect(exitSequence).toEqual(['\x03']);
    });

    it('removeHooks is safe on a project with no installed plugin', () => {
      // OpenCode hooks live in `<project>/.opencode/plugins/`. A fresh
      // directory with no plugin installed should be a clean no-op.
      expect(() => adapter.removeHooks('/some/dir', 'session-001')).not.toThrow();
    });

    it('ensureTrust is a no-op (OpenCode has no trust dialog)', async () => {
      await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    });
  });

  // ── probeAuth ────────────────────────────────────────────────────────────
  //
  // probeAuth reads ~/.local/share/opencode/auth.json - the file that
  // `opencode auth login` writes provider credentials into. The renderer
  // surfaces the false case as an amber "Not signed in" warning so users
  // know to authenticate before moving a task.

  describe('probeAuth', () => {
    // Read the fixture once at the start of each test, BEFORE installing
    // the readFileSync spy, so the spy doesn't intercept the fixture load.
    let opencodeAuthFixture: string;

    beforeEach(() => {
      opencodeAuthFixture = fs.readFileSync(
        path.join(__dirname, '..', 'fixtures', 'opencode-auth.json'),
        'utf8',
      );
      // The project detected an OpenCode 1 just before; no test here runs a CLI.
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('1.18.31');
    });

    // OpenCode 2 keeps sign-ins in its database's `credential` table, and
    // imports a V1 auth.json there at start (measured on 2.2.5). A V2 user who
    // signed in only through V2 has no auth.json, and was warned they were not.
    describe('on OpenCode 2', () => {
      let fakeHome: string;

      function plantCredentials(count: number, home: string = fakeHome): void {
        const DatabaseConstructor = loadBetterSqlite3();
        if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
        const directory = path.join(home, '.local', 'share', 'opencode');
        fs.mkdirSync(directory, { recursive: true });
        const database = new DatabaseConstructor(path.join(directory, 'opencode.db'));
        database.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT)');
        for (let index = 0; index < count; index += 1) {
          database.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run(`cred_${index}`, 'opencode', 'API key', 'secret');
        }
        database.close();
      }

      beforeEach(() => {
        fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-v2-auth-'));
        vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
        vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('v2.2.5');
      });

      afterEach(() => {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      });

      it('reads a sign-in from the database\'s credential table, with no auth.json', async () => {
        plantCredentials(1);
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(true);
      });

      it('falls back to auth.json, and reports no sign-in when neither has one', async () => {
        plantCredentials(0);
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(false);
        fs.writeFileSync(path.join(fakeHome, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'api' } }));
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(true);
      });

      it('does not consult the credential table on OpenCode 1, whose sign-in is auth.json alone', async () => {
        vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('1.18.31');
        plantCredentials(2);
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(false);
      });

      it('falls through to auth.json when OpenCode 2 has no database yet', async () => {
        const directory = path.join(fakeHome, '.local', 'share', 'opencode');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ anthropic: { type: 'api' } }));
        expect(fs.existsSync(path.join(directory, 'opencode.db'))).toBe(false);
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(true);
      });

      it('reports no sign-in for an OpenCode 2 database with no credential table and no auth.json', async () => {
        const DatabaseConstructor = loadBetterSqlite3();
        if (!DatabaseConstructor) throw new Error('better-sqlite3 should load in the unit tier');
        const directory = path.join(fakeHome, '.local', 'share', 'opencode');
        fs.mkdirSync(directory, { recursive: true });
        const database = new DatabaseConstructor(path.join(directory, 'opencode.db'));
        database.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
        database.close();
        expect(await adapter.probeAuth(LOCAL_CLI_PATH)).toBe(false);
      });

      it('never opens a database for a CLI in a WSL distro: its sign-in is the distro\'s auth.json', async () => {
        // The host holds a V2 credential database, and so does the distro's share;
        // neither may count. Opening the share's database from Windows is what the
        // distro path exists to avoid.
        distroHome.path = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-distro-home-'));
        const realPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
          plantCredentials(1);
          plantCredentials(1, distroHome.path);
          const distroCliPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.opencode\\bin\\opencode';
          expect(await adapter.probeAuth(distroCliPath)).toBe(false);
          // The distro's auth.json is still read, so a V2 sign-in of that shape counts.
          const distroDirectory = path.join(distroHome.path, '.local', 'share', 'opencode');
          fs.writeFileSync(path.join(distroDirectory, 'auth.json'), JSON.stringify({ anthropic: { type: 'api' } }));
          expect(await adapter.probeAuth(distroCliPath)).toBe(true);
        } finally {
          Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
          fs.rmSync(distroHome.path, { recursive: true, force: true });
        }
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Install a readFileSync spy whose impl is called with the resolved
     * path string. Wraps the overload-cast boilerplate so individual test
     * bodies stay focused on the case data.
     */
    function mockReadFileSync(impl: (filePath: string) => string): void {
      vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor) =>
        impl(String(filePath))
      ) as typeof fs.readFileSync);
    }

    // The CLI the project detected, which probeAuth is handed; a path on this machine.
    const LOCAL_CLI_PATH = '/usr/local/bin/opencode';

    it('targets ~/.local/share/opencode/auth.json under the home directory', async () => {
      let probedPath: string | null = null;
      mockReadFileSync((filePath) => {
        probedPath = filePath;
        return JSON.stringify({ anthropic: { type: 'oauth' } });
      });
      await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(probedPath).not.toBeNull();
      expect(probedPath!).toBe(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
    });

    it('returns true for the realistic auth.json fixture (sanitized sample)', async () => {
      // Fixture replays the documented shape from the OpenCode docs:
      // a top-level object keyed by provider id, with OAuth and API-key
      // entries. Pins probeAuth against the real on-disk format so a
      // future schema change (e.g. envelope wrapper) trips this test.
      mockReadFileSync(() => opencodeAuthFixture);
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(true);
    });

    it('returns true when auth.json contains at least one provider', async () => {
      mockReadFileSync(() => JSON.stringify({ anthropic: { type: 'oauth', access: 'tok' } }));
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(true);
    });

    it('returns false when auth.json is the empty object', async () => {
      mockReadFileSync(() => '{}');
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(false);
    });

    it('returns false when auth.json is missing (ENOENT)', async () => {
      mockReadFileSync(() => {
        const error = new Error('no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(false);
    });

    it('returns null when auth.json contains malformed JSON', async () => {
      mockReadFileSync(() => 'not-json{{{');
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBeNull();
    });

    it('returns null when readFileSync throws a non-ENOENT error', async () => {
      mockReadFileSync(() => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBeNull();
    });

    it('returns false when auth.json is a JSON array (defensive: not the documented shape)', async () => {
      mockReadFileSync(() => '[]');
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(false);
    });

    it('returns false when auth.json contains a JSON null', async () => {
      mockReadFileSync(() => 'null');
      const result = await adapter.probeAuth(LOCAL_CLI_PATH);
      expect(result).toBe(false);
    });
  });

  describe('liveTelemetryUnsupported', () => {
    it('declares a label and a title, so the card shows a static pill instead of "Starting agent..."', () => {
      expect(adapter.liveTelemetryUnsupported).toBeDefined();
      expect(adapter.liveTelemetryUnsupported?.unavailableLabel).toBeTypeOf('string');
      expect(adapter.liveTelemetryUnsupported?.unavailableLabel.length).toBeGreaterThan(0);
      expect(adapter.liveTelemetryUnsupported?.unavailableTitle).toBeTypeOf('string');
      expect(adapter.liveTelemetryUnsupported?.unavailableTitle.length).toBeGreaterThan(0);
    });
  });

  describe('discoverCapabilities after a detection-cache miss', () => {
    afterEach(() => {
      helpReads.armed = false;
      helpReads.calls.length = 0;
      vi.restoreAllMocks();
    });

    it('detects the path again, and reports the model override for a V2 without reading help', async () => {
      helpReads.armed = true;
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue(null);
      const detectSpy = vi.spyOn(OpenCodeDetector.prototype, 'detect').mockResolvedValue({ found: true, path: '/opt/opencode2/bin/opencode', version: 'v2.2.5' });

      const capabilities = await adapter.discoverCapabilities('/opt/opencode2/bin/opencode');

      expect(detectSpy).toHaveBeenCalledWith('/opt/opencode2/bin/opencode');
      expect(capabilities).toEqual({ supportsModelOverride: true, effortLevels: [] });
      expect(helpReads.calls).toEqual([]);
    });

    it('takes the OpenCode 1 path, reading help, when the detection rejects', async () => {
      helpReads.armed = true;
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue(null);
      vi.spyOn(OpenCodeDetector.prototype, 'detect').mockRejectedValue(new Error('spawn ENOENT'));

      const capabilities = await adapter.discoverCapabilities('/usr/local/bin/opencode');

      expect(capabilities).toEqual({ supportsModelOverride: false, effortLevels: [] });
      expect(helpReads.calls).toHaveLength(1);
    });

    it('does not detect again when the cache answers', async () => {
      helpReads.armed = true;
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('v2.2.5');
      const detectSpy = vi.spyOn(OpenCodeDetector.prototype, 'detect');

      await adapter.discoverCapabilities('/opt/opencode2/bin/opencode');

      expect(detectSpy).not.toHaveBeenCalled();
    });
  });

  describe('models from `opencode models --verbose` (OpenCode 1)', () => {
    const MODELS = ['anthropic/claude-sonnet-4-5', '{', '  "name": "Claude Sonnet 4.5"', '}', 'openai/gpt-5', '{', '  "name": "GPT-5"', '}', ''].join('\n');

    beforeEach(() => {
      helpReads.armed = true;
      helpReads.helpText = '  -m, --model         model to use in the format of provider/model\n';
      helpReads.modelsOutput = MODELS;
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('1.18.31');
    });

    afterEach(() => {
      helpReads.armed = false;
      helpReads.calls.length = 0;
      helpReads.helpText = 'opencode [project]\n\nOptions:\n  --help  show help\n';
      helpReads.modelsOutput = '';
      helpReads.modelsGate = null;
      vi.restoreAllMocks();
    });

    const modelReads = (): number => helpReads.calls.filter((call) => call.includes('models')).length;

    /** Holds every `opencode models` answer until the returned function is called. */
    const holdModelReads = (): (() => void) => {
      let release: () => void = () => undefined;
      helpReads.modelsGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    };

    /** Lets the promise chains a finished read leaves behind settle. */
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    it('shares one read between a forced and an unforced call issued together', async () => {
      const release = holdModelReads();
      const both = Promise.all([
        adapter.discoverCapabilities('/usr/bin/opencode', true),
        adapter.discoverCapabilities('/usr/bin/opencode'),
      ]);
      await vi.waitFor(() => expect(modelReads()).toBe(1));
      await settle();
      release();
      const [forced, unforced] = await both;
      expect(modelReads()).toBe(1);
      expect(forced.models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
      expect(unforced.models).toBeUndefined();
    });

    it('does not keep a read that a re-detection overtook', async () => {
      const release = holdModelReads();
      const inFlight = adapter.discoverCapabilities('/usr/bin/opencode', true);
      await vi.waitFor(() => expect(modelReads()).toBe(1));
      adapter.invalidateDetectionCache();
      release();
      await inFlight;
      await settle();
      expect(adapter.modelDisplayName('openai/gpt-5')).toBeNull();
      await adapter.discoverCapabilities('/usr/bin/opencode');
      await vi.waitFor(() => expect(modelReads()).toBe(2));
    });

    it('remembers a failed first read, so an unforced call does not read again but a forced one does', async () => {
      helpReads.modelsOutput = '';
      await adapter.discoverCapabilities('/usr/bin/opencode');
      await vi.waitFor(() => expect(modelReads()).toBe(1));
      await settle();
      await adapter.discoverCapabilities('/usr/bin/opencode');
      await settle();
      expect(modelReads()).toBe(1);
      helpReads.modelsOutput = MODELS;
      const forced = await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(modelReads()).toBe(2);
      expect(forced.models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
    });

    it('reports no models key when a forced read fails and no list was ever read', async () => {
      helpReads.modelsOutput = '';
      const capabilities = await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(capabilities).toEqual({ supportsModelOverride: true, effortLevels: [] });
      expect('models' in capabilities).toBe(false);
    });

    it('does not answer one CLI path with the list read from another', async () => {
      await adapter.discoverCapabilities('/usr/bin/opencode', true);
      const other = await adapter.discoverCapabilities('/opt/bin/opencode');
      expect(other.models).toBeUndefined();
      await vi.waitFor(() => expect(modelReads()).toBe(2));
    });

    it('reads the model from a POSIX single-quoted or PowerShell-quoted command', () => {
      expect(adapter.configuredModelFromCommand("/usr/bin/opencode --model 'anthropic/claude-sonnet-4-5' --prompt 'go'")?.id).toBe('anthropic/claude-sonnet-4-5');
      expect(adapter.configuredModelFromCommand('& "C:\\opencode.cmd" --model "openai/gpt-5" --prompt "x"')?.id).toBe('openai/gpt-5');
    });

    it('starts the first read without holding the agent list, and lists the models once it is in', async () => {
      // Unforced, with no list yet: the answer comes without one, and the read runs on.
      expect(await adapter.discoverCapabilities('/usr/bin/opencode')).toEqual({ supportsModelOverride: true, effortLevels: [] });
      await vi.waitFor(() => expect(adapter.modelDisplayName('openai/gpt-5')).toBe('GPT-5'));
      expect((await adapter.discoverCapabilities('/usr/bin/opencode')).models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
      expect(modelReads()).toBe(1);
    });

    it('lists the models with the CLI\'s names, read once until a forced refresh', async () => {
      const capabilities = await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(capabilities).toEqual({
        supportsModelOverride: true,
        effortLevels: [],
        models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'],
        modelDisplayNames: { 'anthropic/claude-sonnet-4-5': 'Claude Sonnet 4.5', 'openai/gpt-5': 'GPT-5' },
      });
      await adapter.discoverCapabilities('/usr/bin/opencode');
      expect(modelReads()).toBe(1);
      await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(modelReads()).toBe(2);
      adapter.invalidateDetectionCache();
      await adapter.discoverCapabilities('/usr/bin/opencode');
      await vi.waitFor(() => expect(modelReads()).toBe(3));
    });

    it('keeps the last list when a forced refresh reads nothing', async () => {
      await adapter.discoverCapabilities('/usr/bin/opencode', true);
      helpReads.modelsOutput = '';
      const refreshed = await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(refreshed.models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
      expect(modelReads()).toBe(2);
    });

    it('asks for no list when the help has no --model, or on OpenCode 2', async () => {
      helpReads.helpText = 'opencode [project]\n';
      expect(await adapter.discoverCapabilities('/usr/bin/opencode')).toEqual({ supportsModelOverride: false, effortLevels: [] });
      vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue('v2.2.5');
      expect(await adapter.discoverCapabilities('/usr/bin/opencode')).toEqual({ supportsModelOverride: true, effortLevels: [] });
      expect(modelReads()).toBe(0);
    });

    it('seeds the card with the --model a V1 command names, by the CLI\'s name once the list was read', async () => {
      const command = adapter.buildCommand(makeOptions({ model: 'anthropic/claude-sonnet-4-5', prompt: 'go' }));
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'anthropic/claude-sonnet-4-5', displayName: 'anthropic/claude-sonnet-4-5' });
      await adapter.discoverCapabilities('/usr/bin/opencode', true);
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'anthropic/claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' });
      expect(adapter.modelDisplayName('openai/gpt-5')).toBe('GPT-5');
      expect(adapter.modelDisplayName('openai/unknown')).toBeNull();
    });

    it('seeds nothing for a command with no --model, such as an OpenCode 2 spawn', () => {
      expect(adapter.configuredModelFromCommand('/usr/bin/opencode --standalone --prompt \'use --model x in the text\'')).toBeNull();
      expect(adapter.configuredModelFromCommand('/usr/bin/opencode --agent build')).toBeNull();
      expect(adapter.configuredModelFromCommand('"C:\\opencode.cmd" --model "openai/gpt 5" --prompt x')?.id).toBe('openai/gpt 5');
    });
  });

  describe('transcript usage and tool counts', () => {
    it('answers null for a session with no id, a distro session, or a remote one, without reading', async () => {
      const distroPlace: CliPlace = {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath: '/home/dev/.opencode/bin/opencode',
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
      expect(await adapter.transcriptUsage({ agentSessionId: null, cwd: '/x' })).toBeNull();
      expect(await adapter.transcriptUsage({ agentSessionId: 'ses_x', cwd: '/x', place: distroPlace })).toBeNull();
      expect(await adapter.transcriptToolCounts({ agentSessionId: 'ses_x', cwd: '/x', place: distroPlace })).toBeNull();
      adapter.buildCommand(makeOptions({ cwd: '/srv/remote-cwd', executionTarget: { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: '/srv' } }));
      expect(await adapter.transcriptUsage({ agentSessionId: 'ses_x', cwd: '/srv/remote-cwd' })).toBeNull();
      expect(await adapter.transcriptToolCounts({ agentSessionId: 'ses_x', cwd: '/srv/remote-cwd' })).toBeNull();
    });

    describe('local reads and the non-local shapes', () => {
      const distroPlace: CliPlace = {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath: '/home/dev/.opencode/bin/opencode',
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
      const remoteCwd = '/srv/remote-cwd-reads';

      beforeEach(() => {
        toolReads.counts.mockClear();
        toolReads.resultTokens.mockClear();
        adapter.buildCommand(makeOptions({ cwd: remoteCwd, executionTarget: { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: '/srv' } }));
      });

      it('hands a local session\'s time window to both tool reads', async () => {
        await adapter.transcriptToolCounts({ agentSessionId: 'ses_x', cwd: '/x', sinceMs: 100, untilMs: 200 });
        await adapter.transcriptToolResultTokens({ agentSessionId: 'ses_x', cwd: '/x', sinceMs: 100, untilMs: 200 });
        expect(toolReads.counts).toHaveBeenCalledWith(openCodeTranscriptSourcePath(), 'ses_x', { sinceMs: 100, untilMs: 200 });
        expect(toolReads.resultTokens).toHaveBeenCalledWith(openCodeTranscriptSourcePath(), 'ses_x', { sinceMs: 100, untilMs: 200 });
      });

      it('answers tool result tokens with null for a remote or distro session, without reading', async () => {
        expect(await adapter.transcriptToolResultTokens({ agentSessionId: 'ses_x', cwd: remoteCwd })).toBeNull();
        expect(await adapter.transcriptToolResultTokens({ agentSessionId: 'ses_x', cwd: '/x', place: distroPlace })).toBeNull();
        expect(await adapter.transcriptToolResultTokens({ agentSessionId: null, cwd: '/x' })).toBeNull();
        expect(toolReads.resultTokens).not.toHaveBeenCalled();
      });

      it('has no subagent signature for a remote or distro session', () => {
        expect(adapter.statSubagentTranscripts('ses_x', remoteCwd)).toBeNull();
        expect(adapter.statSubagentTranscripts('ses_x', '/x', distroPlace)).toBeNull();
      });

      it('reads subagent usage as complete and empty for a remote or distro session', async () => {
        const expected = { directoryPresent: false, complete: true, sourcePath: openCodeTranscriptSourcePath(), turns: [], spawnLinks: [] };
        expect(await adapter.parseSubagentUsage('ses_x', remoteCwd)).toEqual(expected);
        expect(await adapter.parseSubagentUsage('ses_x', '/x', distroPlace)).toEqual(expected);
      });

      it('reads a transcript window as empty, at the offset it was asked from, for a remote or distro session', async () => {
        const expected = { entries: [], sourcePath: null, nextByteOffset: 50, totalBytes: 0, firstByteOffset: 50, endByte: 50 };
        expect(await adapter.parseTranscriptWindow('ses_x', remoteCwd, 50, 1000)).toEqual(expected);
        expect(await adapter.parseTranscriptWindow('ses_x', '/x', 50, 1000, undefined, distroPlace)).toEqual(expected);
      });
    });

    it('names edit and write as the file-changing tools, by filePath', () => {
      expect(adapter.fileChangeTools).toEqual([
        { tool: 'edit', pathField: 'filePath' },
        { tool: 'write', pathField: 'filePath' },
      ]);
    });
  });

  describe('invalidateDetectionCache', () => {
    it('makes the next distro version check ask the CLI for --version again', async () => {
      const distroTarget: CliTarget = {
        kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.opencode/bin/opencode',
        facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '/tmp/unused', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
      };
      const versions = ['1.18.31', 'v2.2.5'];
      const askVersion = vi.fn(async () => ({ stdout: versions.shift() ?? '', stderr: '' }));

      adapter.invalidateDetectionCache();
      expect(await isDistroOpenCodeV2(distroTarget, askVersion)).toBe(false);
      // Kept: a second check does not ask.
      expect(await isDistroOpenCodeV2(distroTarget, askVersion)).toBe(false);
      expect(askVersion).toHaveBeenCalledTimes(1);

      adapter.invalidateDetectionCache();
      // The CLI was upgraded in the distro, and the reset lets the check see it.
      expect(await isDistroOpenCodeV2(distroTarget, askVersion)).toBe(true);
      expect(askVersion).toHaveBeenCalledTimes(2);
    });
  });

  describe('template interpolation', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate('Hello {{name}}!', { name: 'world' });
      expect(result).toBe('Hello world!');
    });
  });

  describe('buildEnv - Kangentic MCP injection', () => {
    const fullMcpOptions = (): SpawnCommandOptions =>
      makeOptions({
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-abc',
        mcpServerToken: 'token-deadbeef',
      });

    it('returns null when MCP is disabled', () => {
      const env = adapter.buildEnv(makeOptions({
        mcpServerEnabled: false,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-abc',
        mcpServerToken: 'token-deadbeef',
      }));
      expect(env).toBeNull();
    });

    it('returns null when mcpServerUrl is missing', () => {
      const env = adapter.buildEnv(makeOptions({
        mcpServerEnabled: true,
        mcpServerToken: 'token-deadbeef',
      }));
      expect(env).toBeNull();
    });

    it('returns null when mcpServerToken is missing', () => {
      const env = adapter.buildEnv(makeOptions({
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-abc',
      }));
      expect(env).toBeNull();
    });

    it('emits OPENCODE_CONFIG_CONTENT when MCP is fully configured', () => {
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      expect(env).toHaveProperty('OPENCODE_CONFIG_CONTENT');
    });

    it('emits a parseable JSON payload', () => {
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      expect(() => JSON.parse(env!.OPENCODE_CONFIG_CONTENT)).not.toThrow();
    });

    it('emits the kangentic mcp entry with type "remote" (not "http")', () => {
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
      // /anomalyco/opencode docs use type:"remote" for HTTP MCP servers.
      // Claude's mcp.json uses type:"http" - do not confuse the two.
      expect(config.mcp.kangentic.type).toBe('remote');
    });

    it('forwards the URL and token verbatim', () => {
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
      expect(config.mcp.kangentic.url).toBe('http://127.0.0.1:51234/mcp/proj-abc');
      expect(config.mcp.kangentic.headers['X-Kangentic-Token']).toBe('token-deadbeef');
    });

    it('marks the kangentic entry as enabled', () => {
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
      expect(config.mcp.kangentic.enabled).toBe(true);
    });

    it('emits no other mcp.* keys (deep-merge preserves user entries)', () => {
      // The injected payload must contain ONLY kangentic. OpenCode's
      // multi-source config loader deep-merges by key, so any user
      // entries (mcp.filesystem, mcp.github, ...) in opencode.json are
      // preserved automatically. We must not echo unknown keys back.
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
      expect(Object.keys(config.mcp)).toEqual(['kangentic']);
    });

    it('emits no top-level keys other than mcp', () => {
      // Anything we add here would override user settings on merge.
      // Today the only key we touch is `mcp`.
      const env = adapter.buildEnv(fullMcpOptions());
      expect(env).not.toBeNull();
      const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
      expect(Object.keys(config)).toEqual(['mcp']);
    });
  });

  describe('locateSessionHistoryFile', () => {
    it('returns null when no session file exists for the given ID', async () => {
      // No real OpenCode install in CI, so the scan finds nothing.
      // The contract is: null on miss, never throws.
      const result = await adapter.locateSessionHistoryFile(
        'ses_nonexistent_test_id_12345',
        '/tmp/no-such-cwd',
      );
      expect(result).toBeNull();
    }, 12_000); // polling budget is ~5s
  });
});

describe('OpenCodeAdapter - removeHooks holds deferral', () => {
  // Tests the per-session holds in OpenCodeAdapter.removeHooks. When two
  // concurrent sessions in the same project both call buildCommand with
  // eventsOutputPath, each holds the project root under its own session id.
  // The plugin file must remain until the LAST holder calls removeHooks.
  //
  // Strategy: use a real temp directory as the project root so buildCommand
  // actually installs the plugin (via buildHooks). The plugin source file at
  // src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs is present
  // in the dev tree, so resolvePluginScript finds it and the copy succeeds. It
  // installs as `.js`, the extension OpenCode's plugin glob loads.

  let projectDir: string;
  let concurrentAdapter: OpenCodeAdapter;

  function pluginPath(): string {
    return path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.js');
  }

  function makeBuildOptions(ptySessionId: string, overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
    return {
      agentPath: '/usr/bin/opencode',
      taskId: `task-of-${ptySessionId}`,
      ptySessionId,
      cwd: projectDir,
      projectRoot: projectDir,
      permissionMode: 'default',
      eventsOutputPath: path.join(projectDir, 'events.jsonl'),
      ...overrides,
    };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-opencode-refcount-'));
    concurrentAdapter = new OpenCodeAdapter();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('plugin file is still present after first removeHooks when two sessions share the project', () => {
    // Simulate two concurrent OpenCode sessions in the same project.
    concurrentAdapter.buildCommand(makeBuildOptions('session-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('session-beta'));

    // Plugin must be installed after both buildCommand calls.
    expect(fs.existsSync(pluginPath())).toBe(true);

    // First holder releases. Plugin must stay.
    concurrentAdapter.removeHooks(projectDir, 'session-alpha');
    expect(fs.existsSync(pluginPath())).toBe(true);
  });

  it('plugin file is removed after the last holder calls removeHooks', () => {
    concurrentAdapter.buildCommand(makeBuildOptions('session-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('session-beta'));

    concurrentAdapter.removeHooks(projectDir, 'session-alpha');
    // alpha is gone, beta still holds - plugin present.
    expect(fs.existsSync(pluginPath())).toBe(true);

    concurrentAdapter.removeHooks(projectDir, 'session-beta');
    // Last holder released - plugin must be gone.
    expect(fs.existsSync(pluginPath())).toBe(false);
  });

  it('an older session of the same task releasing late keeps the newer session\'s plugin', () => {
    concurrentAdapter.buildCommand(makeBuildOptions('old-session', { taskId: 'task-a' }));
    concurrentAdapter.buildCommand(makeBuildOptions('new-session', { taskId: 'task-a' }));

    concurrentAdapter.removeHooks(projectDir, 'old-session');
    expect(fs.existsSync(pluginPath())).toBe(true);

    concurrentAdapter.removeHooks(projectDir, 'new-session');
    expect(fs.existsSync(pluginPath())).toBe(false);
  });

  it('a worktree session\'s release removes the plugin its build installed in the project root', () => {
    // The plugin lands in `<projectRoot>/.opencode/plugins/`, while the session
    // layer releases with the worktree the session ran in.
    const worktree = path.join(projectDir, '.kangentic', 'worktrees', 'task-a');
    fs.mkdirSync(worktree, { recursive: true });
    concurrentAdapter.buildCommand(makeBuildOptions('session-a', { cwd: worktree }));
    expect(fs.existsSync(pluginPath())).toBe(true);

    concurrentAdapter.removeHooks(worktree, 'session-a');
    expect(fs.existsSync(pluginPath())).toBe(false);
  });

  it('double removeHooks call for the same session is idempotent and does not throw', () => {
    concurrentAdapter.buildCommand(makeBuildOptions('session-solo'));

    concurrentAdapter.removeHooks(projectDir, 'session-solo');
    // Plugin is gone after the only holder releases.
    expect(fs.existsSync(pluginPath())).toBe(false);

    // Calling removeHooks again for the same session must not throw.
    expect(() => concurrentAdapter.removeHooks(projectDir, 'session-solo')).not.toThrow();
  });

  it('removeHooks without a session id removes the plugin whoever holds it', () => {
    // The id-less path is the forced cleanup (project delete), after every
    // session is gone.
    concurrentAdapter.buildCommand(makeBuildOptions('session-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('session-beta'));

    expect(fs.existsSync(pluginPath())).toBe(true);

    concurrentAdapter.removeHooks(projectDir, undefined);
    expect(fs.existsSync(pluginPath())).toBe(false);
  });
});

/**
 * OpenCode 2 (GitHub #720). Its TUI command rejects `--agent` and `--model`
 * ("Unrecognized flag: --agent"), and without `--standalone` it joins one shared
 * background service per user that never reads this spawn's
 * `OPENCODE_CONFIG_CONTENT`. So a V2 spawn is `opencode --standalone`, and the
 * agent and model ride in the inline config. Gated on the detected version: an
 * OpenCode 1 spawn must come out exactly as before.
 */
describe('OpenCode 2 spawns', () => {
  const V2 = 'v2.2.5';
  const builder = new OpenCodeCommandBuilder();
  const base = { opencodePath: '/usr/bin/opencode', taskId: 'task-001', cwd: '/home/dev/project' };
  const mcp = { mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-abc', mcpServerToken: 'token-deadbeef' };
  const configOf = (env: Record<string, string> | null): Record<string, unknown> => JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? 'null');

  describe('openCodeMajorVersion', () => {
    it('reads the major from each version shape the detector hands over', () => {
      expect(openCodeMajorVersion('v2.2.5')).toBe(2); // `opencode v2.2.5` after the detector's prefix strip
      expect(openCodeMajorVersion('opencode v2.2.5')).toBe(2);
      expect(openCodeMajorVersion('2.0.0')).toBe(2);
      expect(openCodeMajorVersion('1.18.31')).toBe(1);
    });

    it('reads a bare major, with or without the v', () => {
      expect(openCodeMajorVersion('2')).toBe(2);
      expect(openCodeMajorVersion('v2')).toBe(2);
      expect(isOpenCodeV2('v2')).toBe(true);
      expect(isOpenCodeV2('2')).toBe(true);
      expect(isOpenCodeV2('1')).toBe(false);
    });

    it('does not read a major out of a digit run that is not followed by a dot or the end', () => {
      expect(openCodeMajorVersion('2beta')).toBeNull();
      expect(isOpenCodeV2('2beta')).toBe(false);
    });

    it('reads nothing from no version or one it does not know, which means OpenCode 1', () => {
      expect(openCodeMajorVersion(null)).toBeNull();
      expect(openCodeMajorVersion('')).toBeNull();
      expect(openCodeMajorVersion('dev build')).toBeNull();
      expect(isOpenCodeV2(null)).toBe(false);
      expect(isOpenCodeV2('dev build')).toBe(false);
      expect(isOpenCodeV2('1.19.5')).toBe(false);
      expect(isOpenCodeV2('v2.2.5')).toBe(true);
      expect(isOpenCodeV2('3.0.0')).toBe(true);
    });
  });

  describe('command', () => {
    it('starts a fresh Build or Plan session with --standalone and the prompt, never --agent or --model', () => {
      for (const permissionMode of ['acceptEdits', 'plan'] as PermissionMode[]) {
        const command = builder.buildOpenCodeCommand({ ...base, permissionMode, model: 'anthropic/claude-sonnet', prompt: 'fix the bug', cliVersion: V2 });
        expect(command).toBe(`/usr/bin/opencode --standalone --prompt ${q('fix the bug')}`);
      }
    });

    it('starts with --standalone alone when there is no prompt', () => {
      const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'plan', cliVersion: V2 });
      expect(command).toBe('/usr/bin/opencode --standalone');
    });

    it('resumes with --standalone --session and no prompt', () => {
      const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'plan', resume: true, sessionId: 'ses_abc123def456', prompt: 'dropped', cliVersion: V2 });
      expect(command).toBe('/usr/bin/opencode --standalone --session ses_abc123def456');
    });

    it('keeps the OpenCode 1 command for a V1 or unknown version', () => {
      for (const cliVersion of ['1.18.31', null]) {
        const command = builder.buildOpenCodeCommand({ ...base, permissionMode: 'plan', model: 'anthropic/claude-sonnet', prompt: 'fix the bug', cliVersion });
        expect(command).toBe(`/usr/bin/opencode --agent plan --model anthropic/claude-sonnet --prompt ${q('fix the bug')}`);
      }
    });

    it('blocks a remote-mode spawn with the reason, since attach is OpenCode 1\'s', () => {
      const executionTarget = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' as const }, workingDirectory: '/srv/project' };
      expect(() => builder.buildOpenCodeCommand({ ...base, permissionMode: 'plan', executionTarget, cliVersion: V2 }))
        .toThrow(/remote mode needs OpenCode 1/);
    });
  });

  describe('env', () => {
    it('names the agent, the model and the Kangentic MCP server on a fresh spawn', () => {
      const plan = configOf(builder.buildOpenCodeEnv({ ...base, ...mcp, permissionMode: 'plan', model: ' anthropic/claude-sonnet ', cliVersion: V2 }));
      expect(plan.default_agent).toBe('plan');
      expect(plan.model).toBe('anthropic/claude-sonnet');
      expect(plan.mcp).toEqual({ kangentic: { type: 'remote', url: mcp.mcpServerUrl, enabled: true, headers: { 'X-Kangentic-Token': mcp.mcpServerToken } } });

      const build = configOf(builder.buildOpenCodeEnv({ ...base, ...mcp, permissionMode: 'acceptEdits', cliVersion: V2 }));
      expect(build.default_agent).toBe('build');
      expect(build).not.toHaveProperty('model');
    });

    it('names no agent or model on a resume, so the session keeps the agent picked with Tab', () => {
      const config = configOf(builder.buildOpenCodeEnv({ ...base, ...mcp, permissionMode: 'plan', model: 'anthropic/claude-sonnet', resume: true, sessionId: 'ses_abc123def456', cliVersion: V2 }));
      expect(Object.keys(config)).toEqual(['mcp']);
    });

    it('still names the agent with MCP off, and gives no config when there is nothing to name', () => {
      const config = configOf(builder.buildOpenCodeEnv({ ...base, permissionMode: 'plan', cliVersion: V2 }));
      expect(config).toEqual({ default_agent: 'plan' });
      expect(builder.buildOpenCodeEnv({ ...base, permissionMode: 'default', cliVersion: V2 })).toBeNull();
    });

    it('keeps the OpenCode 1 config to the MCP entry alone', () => {
      const config = configOf(builder.buildOpenCodeEnv({ ...base, ...mcp, permissionMode: 'plan', model: 'anthropic/claude-sonnet', cliVersion: '1.18.31' }));
      expect(Object.keys(config)).toEqual(['mcp']);
      expect(builder.buildOpenCodeEnv({ ...base, permissionMode: 'plan', cliVersion: '1.18.31' })).toBeNull();
    });
  });

  describe('adapter wiring', () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-opencode-v2-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('reads the detected version for the spawned path, and installs and holds the V2 plugin, not the V1 file', () => {
      const versionSpy = vi.spyOn(OpenCodeDetector.prototype, 'getCachedVersion').mockReturnValue(V2);
      const adapter = new OpenCodeAdapter();
      const options = makeOptions({
        agentPath: '/opt/opencode2/bin/opencode',
        cwd: projectDir,
        projectRoot: projectDir,
        ptySessionId: 'session-v2',
        permissionMode: 'plan',
        prompt: 'go',
        eventsOutputPath: path.join(projectDir, 'events.jsonl'),
      });

      const command = adapter.buildCommand(options);
      const env = adapter.buildEnv(options);

      expect(versionSpy).toHaveBeenCalledWith('/opt/opencode2/bin/opencode');
      expect(command).toContain('--standalone');
      expect(command).not.toContain('--agent');
      expect(configOf(env).default_agent).toBe('plan');
      // OpenCode 2 does not run V1 plugins: it gets its own, as a directory entry.
      const v2Plugin = path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity', 'index.js');
      expect(fs.existsSync(v2Plugin)).toBe(true);
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.js'))).toBe(false);
      // Held for the session like the V1 file, and gone once it releases.
      adapter.removeHooks(projectDir, 'session-v2');
      expect(fs.existsSync(v2Plugin)).toBe(false);
    });
  });
});

describe('OpenCodeDetector - parseVersion', () => {
  // Access parseVersion via the public detect() method is not testable
  // without a real binary, so we construct the detector and invoke the
  // parseVersion logic indirectly via the private config. Instead, we
  // extract the normalisation behaviour by calling the detector's
  // internal parser through a thin wrapper that replicates the exact
  // lambda registered in the constructor.
  //
  // The lambda is: (raw) => raw.replace(/^opencode\s+/i, '').trim() || null
  function callParseVersion(raw: string): string | null {
    const trimmed = raw.replace(/^opencode\s+/i, '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  it('strips "opencode " prefix from version output', () => {
    expect(callParseVersion('opencode 1.14.25')).toBe('1.14.25');
  });

  it('strips "opencode " prefix case-insensitively', () => {
    expect(callParseVersion('OpenCode 2.0.0')).toBe('2.0.0');
  });

  it('returns a bare version string unchanged when there is no prefix', () => {
    expect(callParseVersion('1.14.25')).toBe('1.14.25');
  });

  it('returns null for a whitespace-only string', () => {
    expect(callParseVersion('  ')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(callParseVersion('')).toBeNull();
  });

  it('OpenCodeDetector can be instantiated without throwing', () => {
    // Confirm the class is exported and constructable independently of
    // OpenCodeAdapter (used by the registry to probe binary availability).
    expect(() => new OpenCodeDetector()).not.toThrow();
  });
});

describe('OpenCodeCommandBuilder - Windows quote replacement', () => {
  // The command builder replaces double quotes with single quotes in the
  // prompt text when targeting a non-Unix shell (cmd.exe, PowerShell).
  // This branch is NOT exercised by the existing tests which use a
  // Unix-style path and rely on process.platform detection.

  it('replaces double quotes in prompt with single quotes for cmd.exe', () => {
    const builder = new OpenCodeCommandBuilder();
    const command = builder.buildOpenCodeCommand({
      opencodePath: 'opencode',
      taskId: 'task-001',
      cwd: 'C:\\Users\\dev\\project',
      permissionMode: 'default',
      prompt: 'fix "all" the bugs',
      shell: 'cmd.exe',
    });
    // The double quotes in the prompt must become single quotes before quoting.
    expect(command).toContain("fix 'all' the bugs");
    expect(command).not.toContain('fix "all" the bugs');
  });

  it('replaces double quotes in prompt with single quotes for PowerShell', () => {
    const builder = new OpenCodeCommandBuilder();
    const command = builder.buildOpenCodeCommand({
      opencodePath: 'opencode',
      taskId: 'task-001',
      cwd: 'C:\\Users\\dev\\project',
      permissionMode: 'default',
      prompt: 'add "verbose" logging',
      shell: 'powershell.exe',
    });
    expect(command).toContain("add 'verbose' logging");
    expect(command).not.toContain('add "verbose" logging');
  });

  it('preserves double quotes in prompt on Unix-like shells', () => {
    const builder = new OpenCodeCommandBuilder();
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: '/home/dev/project',
      permissionMode: 'default',
      prompt: 'add "verbose" logging',
      shell: '/bin/bash',
    });
    // Unix shells do not need the replacement - the prompt is quoted
    // with single quotes by quoteArg, which handles the content safely.
    expect(command).toContain('add "verbose" logging');
  });

  it('does not emit --session on fresh session with cmd.exe shell', () => {
    const builder = new OpenCodeCommandBuilder();
    const command = builder.buildOpenCodeCommand({
      opencodePath: 'opencode',
      taskId: 'task-001',
      cwd: 'C:\\Users\\dev\\project',
      permissionMode: 'default',
      prompt: 'hello',
      shell: 'cmd.exe',
    });
    expect(command).not.toContain('--session');
    expect(command).toContain('--prompt');
  });
});

describe('agent-display-name - opencode entry', () => {
  // Inline the functions here to avoid introducing a renderer-only
  // import into the unit test environment. The display-name module has
  // no Node-side dependencies and the logic is trivial, so the risk of
  // divergence from the source is low.
  //
  // If agent-display-name.ts changes its API, this test will fail and
  // alert the developer to update both the source and this test.

  // Re-import from source so the test is always in sync.
  it('agentDisplayName("opencode") returns "OpenCode"', async () => {
    const { agentDisplayName } = await import('../../src/renderer/utils/agent-display-name');
    expect(agentDisplayName('opencode')).toBe('OpenCode');
  });

  it('agentShortName("opencode") returns "OpenCode"', async () => {
    const { agentShortName } = await import('../../src/renderer/utils/agent-display-name');
    expect(agentShortName('opencode')).toBe('OpenCode');
  });

  it('agentInstallUrl("opencode") returns "https://opencode.ai/docs"', async () => {
    const { agentInstallUrl } = await import('../../src/renderer/utils/agent-display-name');
    expect(agentInstallUrl('opencode')).toBe('https://opencode.ai/docs');
  });

  it('agentLoginCommand("opencode") returns "opencode auth login"', async () => {
    // Pairs with the OpenCodeAdapter.probeAuth implementation: when the
    // adapter reports authenticated:false, the welcome-screen
    // DetectionCard renders this command behind a "Copy" button.
    const { agentLoginCommand } = await import('../../src/renderer/utils/agent-display-name');
    expect(agentLoginCommand('opencode')).toBe('opencode auth login');
  });
});
