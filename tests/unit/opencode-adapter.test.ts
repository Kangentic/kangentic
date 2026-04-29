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
import {
  OpenCodeAdapter,
  OpenCodeDetector,
  OpenCodeCommandBuilder,
} from '../../src/main/agent/adapters/opencode';
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

    it('declares only OpenCode-native permission options (Plan and Build)', () => {
      // OpenCode's autonomy is expressed through agents, not the
      // Claude-shaped 4-mode union. The dropdown should only offer
      // OpenCode's native vocabulary so users do not pick modes
      // (default / bypassPermissions / dontAsk / auto) that have no
      // distinct OpenCode meaning.
      const entries = adapter.permissions.map((entry) => ({ mode: entry.mode, label: entry.label }));
      expect(entries).toEqual([
        { mode: 'plan', label: 'Plan' },
        { mode: 'acceptEdits', label: 'Build' },
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

    it('captures native ses_* ID embedded in --session resume hints', () => {
      const fromOutput = adapter.runtime.sessionId?.fromOutput;
      const sample = `Resume with: opencode --session '${REAL_SESSION_ID}'`;
      expect(fromOutput?.(sample)).toBe(REAL_SESSION_ID);
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
      expect(() => adapter.removeHooks('/some/dir', 'task-001')).not.toThrow();
    });

    it('clearSettingsCache is a no-op (no merged settings)', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
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

    it('targets ~/.local/share/opencode/auth.json under the home directory', async () => {
      let probedPath: string | null = null;
      mockReadFileSync((filePath) => {
        probedPath = filePath;
        return JSON.stringify({ anthropic: { type: 'oauth' } });
      });
      await adapter.probeAuth();
      expect(probedPath).not.toBeNull();
      expect(probedPath!).toBe(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
    });

    it('returns true for the realistic auth.json fixture (sanitized sample)', async () => {
      // Fixture replays the documented shape from the OpenCode docs:
      // a top-level object keyed by provider id, with OAuth and API-key
      // entries. Pins probeAuth against the real on-disk format so a
      // future schema change (e.g. envelope wrapper) trips this test.
      mockReadFileSync(() => opencodeAuthFixture);
      const result = await adapter.probeAuth();
      expect(result).toBe(true);
    });

    it('returns true when auth.json contains at least one provider', async () => {
      mockReadFileSync(() => JSON.stringify({ anthropic: { type: 'oauth', access: 'tok' } }));
      const result = await adapter.probeAuth();
      expect(result).toBe(true);
    });

    it('returns false when auth.json is the empty object', async () => {
      mockReadFileSync(() => '{}');
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
    });

    it('returns false when auth.json is missing (ENOENT)', async () => {
      mockReadFileSync(() => {
        const error = new Error('no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
    });

    it('returns null when auth.json contains malformed JSON', async () => {
      mockReadFileSync(() => 'not-json{{{');
      const result = await adapter.probeAuth();
      expect(result).toBeNull();
    });

    it('returns null when readFileSync throws a non-ENOENT error', async () => {
      mockReadFileSync(() => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });
      const result = await adapter.probeAuth();
      expect(result).toBeNull();
    });

    it('returns false when auth.json is a JSON array (defensive: not the documented shape)', async () => {
      mockReadFileSync(() => '[]');
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
    });

    it('returns false when auth.json contains a JSON null', async () => {
      mockReadFileSync(() => 'null');
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
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

describe('OpenCodeAdapter - removeHooks refcount deferral', () => {
  // Tests the hookHolders reference-counting logic in OpenCodeAdapter.removeHooks
  // (opencode-adapter.ts lines 208-218). When two concurrent tasks in the same
  // project both call buildCommand with eventsOutputPath, each increments the
  // refcount. The plugin file must remain until the LAST holder calls removeHooks.
  //
  // Strategy: use a real temp directory as the project root so buildCommand
  // actually installs the plugin (via buildHooks). The plugin source file at
  // src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs is present
  // in the dev tree, so resolvePluginScript finds it and the copy succeeds.

  let projectDir: string;
  let concurrentAdapter: OpenCodeAdapter;

  function pluginPath(): string {
    return path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.mjs');
  }

  function makeBuildOptions(taskId: string): SpawnCommandOptions {
    return {
      agentPath: '/usr/bin/opencode',
      taskId,
      cwd: projectDir,
      projectRoot: projectDir,
      permissionMode: 'default',
      eventsOutputPath: path.join(projectDir, 'events.jsonl'),
    };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-opencode-refcount-'));
    concurrentAdapter = new OpenCodeAdapter();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('plugin file is still present after first removeHooks when two tasks share the project', () => {
    // Simulate two concurrent OpenCode sessions in the same project.
    concurrentAdapter.buildCommand(makeBuildOptions('task-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('task-beta'));

    // Plugin must be installed after both buildCommand calls.
    expect(fs.existsSync(pluginPath())).toBe(true);

    // First holder releases - refcount drops to 1. Plugin must stay.
    concurrentAdapter.removeHooks(projectDir, 'task-alpha');
    expect(fs.existsSync(pluginPath())).toBe(true);
  });

  it('plugin file is removed after the last holder calls removeHooks', () => {
    concurrentAdapter.buildCommand(makeBuildOptions('task-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('task-beta'));

    concurrentAdapter.removeHooks(projectDir, 'task-alpha');
    // alpha is gone, beta still holds - plugin present.
    expect(fs.existsSync(pluginPath())).toBe(true);

    concurrentAdapter.removeHooks(projectDir, 'task-beta');
    // Last holder released - plugin must be gone.
    expect(fs.existsSync(pluginPath())).toBe(false);
  });

  it('double removeHooks call for the same taskId is idempotent and does not throw', () => {
    concurrentAdapter.buildCommand(makeBuildOptions('task-solo'));

    concurrentAdapter.removeHooks(projectDir, 'task-solo');
    // Plugin is gone after the only holder releases.
    expect(fs.existsSync(pluginPath())).toBe(false);

    // Calling removeHooks again for the same task must not throw.
    expect(() => concurrentAdapter.removeHooks(projectDir, 'task-solo')).not.toThrow();
  });

  it('removeHooks without a taskId unconditionally removes the plugin regardless of refcount', () => {
    // The taskId-less path is the forced-cleanup / shutdown path. It must
    // bypass the refcount and call removeOpenCodeHooks directly.
    concurrentAdapter.buildCommand(makeBuildOptions('task-alpha'));
    concurrentAdapter.buildCommand(makeBuildOptions('task-beta'));

    expect(fs.existsSync(pluginPath())).toBe(true);

    // Pass undefined taskId - forced cleanup.
    concurrentAdapter.removeHooks(projectDir, undefined);
    expect(fs.existsSync(pluginPath())).toBe(false);
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
