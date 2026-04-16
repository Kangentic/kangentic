/**
 * Unit tests for CursorAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const aboutCallLog: Array<{ path: string; args: readonly string[] }> = [];

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
  type LogEntry = { path: string; args: readonly string[] };

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
      [promisifyCustom]: (firstArg: string, secondArg?: readonly string[] | unknown): ExecResult => {
        const pathArg = firstArg;
        const args = Array.isArray(secondArg) ? (secondArg as readonly string[]) : [];
        recordCall({ path: pathArg, args });
        if (mockAboutShouldFail) {
          return Promise.reject(new Error('agent about failed'));
        }
        return Promise.resolve({ stdout: mockAboutStdout, stderr: '' });
      },
    },
  );

  // `execFile(path, args)` on unix → aboutCallLog entry preserves args.
  const mockExecFile = makeMock(({ path: pathArg, args }) => {
    aboutCallLog.push({ path: pathArg, args });
  });

  // `exec(cmdString)` on Windows → parse the quoted path + args back
  // out of the single command string so tests can still assert on them
  // uniformly. Expected shape: `"<path>" about --format json`.
  const mockExec = makeMock(({ path: cmdString }) => {
    const match = cmdString.match(/^"([^"]+)"\s+(.*)$/);
    if (match) {
      aboutCallLog.push({ path: match[1], args: match[2].split(/\s+/) });
    } else {
      aboutCallLog.push({ path: cmdString, args: [] });
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
      expect(command).toContain('Fix the bug');
    });

    it('omits prompt when none provided', () => {
      const command = adapter.buildCommand(makeOptions());
      const parts = command.split(' ');
      // Only the agent path
      expect(parts.length).toBe(1);
    });

    // ── Non-interactive mode (bypassPermissions) ────────────────────────

    it('adds -p and --output-format stream-json for bypassPermissions', () => {
      const command = adapter.buildCommand(makeOptions({
        permissionMode: 'bypassPermissions',
        prompt: 'Fix the bug',
      }));
      expect(command).toContain('-p');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
    });

    it('adds -p and --output-format stream-json for nonInteractive flag', () => {
      const command = adapter.buildCommand(makeOptions({
        nonInteractive: true,
        prompt: 'Fix the bug',
      }));
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

    // ── Permission mode mapping ─────────────────────────────────────────

    describe('permission mode mapping', () => {
      // Only `default` explicitly means "interactive TUI, user confirms".
      // Every other mode (bypassPermissions + any Kangentic-level mode
      // like project-settings, plan, acceptEdits, ...) must emit
      // `--output-format stream-json`. Cursor's docs say stream-json
      // only works with --print, so without this the init event never
      // lands and ContextBar is stuck on "Starting agent..." forever.
      const streamJsonModes: PermissionMode[] = [
        'bypassPermissions', 'plan', 'dontAsk', 'acceptEdits', 'auto',
      ];
      const interactiveModes: PermissionMode[] = ['default'];

      for (const mode of streamJsonModes) {
        it(`emits -p and --output-format stream-json for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({
            permissionMode: mode,
            prompt: 'test',
          }));
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
        });
      }

      it('uses stream-json when nonInteractive is explicitly requested', () => {
        const command = adapter.buildCommand(makeOptions({
          permissionMode: 'default',
          nonInteractive: true,
          prompt: 'test',
        }));
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
    it('uses pty activity detection', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
    });

    it('has session ID capture via fromOutput', () => {
      expect(adapter.runtime.sessionId).toBeDefined();
      expect(adapter.runtime.sessionId!.fromOutput).toBeDefined();
    });

    it('has no session history', () => {
      expect(adapter.runtime.sessionHistory).toBeUndefined();
    });

    it('has no status file', () => {
      expect(adapter.runtime.statusFile).toBeUndefined();
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

    it('applies usage with model from the about payload', async () => {
      mockAboutStdout = JSON.stringify({
        cliVersion: '2026.04.15-dccdccd',
        model: 'Auto',
      });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toEqual([{ model: { id: 'auto', displayName: 'Auto' } }]);
    });

    it('lowercases the id but preserves the displayName casing', async () => {
      mockAboutStdout = JSON.stringify({ model: 'Claude 4.6 Sonnet' });
      const { context, applied } = makeContext();
      adapter.attachSession!(context);
      await flushPromises();
      expect(applied).toEqual([
        { model: { id: 'claude 4.6 sonnet', displayName: 'Claude 4.6 Sonnet' } },
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
      const previous = (cp.exec as unknown as Record<symbol, unknown>)[promisifyCustom];
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
        (cp.exec as unknown as Record<symbol, unknown>)[promisifyCustom] = previous;
        (cp.execFile as unknown as Record<symbol, unknown>)[promisifyCustom] = previous;
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
      expect(appliedB).toEqual([{ model: { id: 'auto', displayName: 'Auto' } }]);

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

    it('clearSettingsCache does not throw', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
    });

    it('locateSessionHistoryFile returns null', async () => {
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
