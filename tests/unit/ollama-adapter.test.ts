/**
 * Unit tests for OllamaAdapter - detection, command building, capability
 * discovery, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC
 * dependencies. Ollama is modeled on the Warp adapter (a one-shot
 * `ollama run <model> "<prompt>"` that streams output then exits).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// ── Mocks (set up before importing the adapter) ───────────────────────────────

// Detection: AgentDetector calls which() + the shared exec-version helper.
let mockWhichResult: string | Error = '/usr/bin/ollama';
let mockExecVersionStdout = 'ollama version is 0.5.7\n';
let mockExecVersionShouldFail = false;
let mockExistsSyncReturnValue = true;
let execVersionCallCount = 0;

// Capability discovery: `ollama list` via node:child_process.
let mockListStdout = '';
let mockListShouldFail = false;
// Records which node:child_process function capability-discovery.ts last invoked.
// Lets platform-routing tests distinguish exec (win32 shell path) from execFile
// (non-win32 direct path) without spawning a real process.
let lastChildProcessCall: 'exec' | 'execFile' | null = null;

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
      existsSync: () => mockExistsSyncReturnValue,
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

// Mock node:child_process so capability discovery never spawns a real
// process. Attaching the promisify-custom symbol makes `promisify(exec)`
// return our async function directly (avoids the callback convention).
vi.mock('node:child_process', () => {
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const makeExec = (callType: 'exec' | 'execFile') => {
    const execStub = (): void => {};
    (execStub as unknown as Record<symbol, unknown>)[promisifyCustom] = async () => {
      lastChildProcessCall = callType;
      if (mockListShouldFail) throw new Error('ollama list failed');
      return { stdout: mockListStdout, stderr: '' };
    };
    return execStub;
  };
  return { exec: makeExec('exec'), execFile: makeExec('execFile') };
});

// Import after mocks are set up
const { OllamaAdapter, DEFAULT_OLLAMA_MODEL, parseOllamaModelList } = await import(
  '../../src/main/agent/adapters/ollama'
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/ollama',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── OllamaAdapter ──────────────────────────────────────────────────────────────

describe('OllamaAdapter', () => {
  let adapter: InstanceType<typeof OllamaAdapter>;

  beforeEach(() => {
    adapter = new OllamaAdapter();
    mockWhichResult = '/usr/bin/ollama';
    mockExecVersionStdout = 'ollama version is 0.5.7\n';
    mockExecVersionShouldFail = false;
    mockExistsSyncReturnValue = true;
    execVersionCallCount = 0;
    mockListStdout = '';
    mockListShouldFail = false;
    lastChildProcessCall = null;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "ollama"', () => {
    expect(adapter.name).toBe('ollama');
  });

  it('has displayName "Ollama"', () => {
    expect(adapter.displayName).toBe('Ollama');
  });

  it('has sessionType "ollama_agent"', () => {
    expect(adapter.sessionType).toBe('ollama_agent');
  });

  it('does not support caller session IDs', () => {
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  it('exposes a single "default" permission entry (no autonomy concept)', () => {
    expect(adapter.permissions).toHaveLength(1);
    expect(adapter.permissions[0].mode).toBe('default');
    expect(adapter.defaultPermission).toBe('default');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path and parsed version', async () => {
      const result = await adapter.detect('/custom/ollama');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/ollama');
      // parseVersion strips the "ollama version is " prefix
      expect(result.version).toBe('0.5.7');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/ollama');
    });

    it('returns found: false when which fails and no fallback path exists', async () => {
      mockWhichResult = new Error('not found');
      mockExistsSyncReturnValue = false;
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/ollama');
      const second = await adapter.detect('/custom/ollama');
      expect(first).toBe(second);
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/ollama');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/ollama');
      expect(execVersionCallCount).toBe(2);
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    it('builds command starting with "ollama run <model>"', () => {
      const command = adapter.buildCommand(makeOptions({ shell: 'bash' }));
      const expected = `${quoteArg('/usr/bin/ollama', 'bash')} run ${quoteArg(DEFAULT_OLLAMA_MODEL, 'bash')}`;
      expect(command.startsWith(expected)).toBe(true);
    });

    it('uses the per-column/task model override when provided', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'qwen2.5-coder:7b' }));
      expect(command).toContain('qwen2.5-coder:7b');
      expect(command).not.toContain(DEFAULT_OLLAMA_MODEL);
    });

    it('falls back to DEFAULT_OLLAMA_MODEL when the model is blank/whitespace', () => {
      const command = adapter.buildCommand(makeOptions({ model: '   ' }));
      expect(command).toContain(DEFAULT_OLLAMA_MODEL);
    });

    it('appends the prompt as a positional argument when provided', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Explain closures', shell: 'bash' }));
      expect(command).toContain('Explain closures');
    });

    it('omits the prompt argument when no prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ shell: 'bash' }));
      const expected = `${quoteArg('/usr/bin/ollama', 'bash')} run ${quoteArg(DEFAULT_OLLAMA_MODEL, 'bash')}`;
      expect(command).toBe(expected);
    });

    it('ignores resume flag (Ollama has no session resume)', () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: 'session-123', resume: true }));
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session');
      expect(command).not.toContain('session-123');
    });

    it('inserts a "--" end-of-options guard before a dash-prefixed prompt so it is not parsed as a flag', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: '- fix the bug', shell: 'bash' }));
      // The guard token must appear after the model and immediately before the
      // prompt positional: `... run <model> -- <prompt>`.
      expect(command).toMatch(/ run \S+ -- /);
      const guardIndex = command.indexOf(' -- ');
      expect(command.indexOf('- fix the bug')).toBeGreaterThan(guardIndex);
    });

    // ── Shell quoting ────────────────────────────────────────────────────

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

      // ── process.platform fallback (no shell provided) ─────────────────
      // buildCommand falls back to `process.platform === 'win32'` when no
      // shell is supplied. The two tests below cover the unreached arm on CI
      // (Linux) and the symmetrical arm on the team's Windows machines. Both
      // are needed to ensure the branch is correct in both directions.
      describe('process.platform fallback when no shell is specified', () => {
        let savedPlatformDescriptor: PropertyDescriptor | undefined;

        beforeEach(() => {
          savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        });

        afterEach(() => {
          if (savedPlatformDescriptor !== undefined) {
            Object.defineProperty(process, 'platform', savedPlatformDescriptor);
          }
        });

        it('replaces double quotes with single quotes on win32 when no shell is given', () => {
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
          const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the "broken" test' }));
          expect(command).not.toContain('"broken"');
          expect(command).toContain("'broken'");
        });

        it('preserves double quotes on non-win32 platforms when no shell is given', () => {
          Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
          const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the "broken" test' }));
          expect(command).toContain('"broken"');
        });
      });
    });
  });

  // ── Capability discovery ───────────────────────────────────────────────────

  describe('discoverCapabilities', () => {
    it('always reports model-override support', async () => {
      mockListStdout = 'NAME    ID    SIZE    MODIFIED\n';
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.supportsModelOverride).toBe(true);
      expect(capabilities.effortLevels).toEqual([]);
    });

    it('returns installed models parsed from `ollama list`', async () => {
      mockListStdout = [
        'NAME               ID              SIZE      MODIFIED',
        'llama3.2:latest    a80c4f17acd5    2.0 GB    2 days ago',
        'qwen2.5-coder:7b   2b0496514337    4.7 GB    1 week ago',
      ].join('\n');
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.models).toEqual(['llama3.2:latest', 'qwen2.5-coder:7b']);
    });

    it('never throws and falls back to undefined models when `ollama list` fails', async () => {
      mockListShouldFail = true;
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.supportsModelOverride).toBe(true);
      expect(capabilities.models).toBeUndefined();
    });

    // ── Platform-specific exec routing ───────────────────────────────────
    // capability-discovery.ts:readModelListOutput uses exec (shell invocation)
    // on win32 so that .cmd/.exe shims are resolved by the shell, and execFile
    // (direct invocation) on every other platform. These tests cover both arms
    // by stubbing process.platform, which is read at call time (not module load
    // time), so the stub is safe even though execAsync/execFileAsync are bound
    // at module evaluation.
    describe('platform-specific exec routing in readModelListOutput', () => {
      let savedPlatformDescriptor: PropertyDescriptor | undefined;

      beforeEach(() => {
        savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        lastChildProcessCall = null;
      });

      afterEach(() => {
        if (savedPlatformDescriptor !== undefined) {
          Object.defineProperty(process, 'platform', savedPlatformDescriptor);
        }
      });

      it('uses shell exec on win32 so .cmd and .exe shims are resolved', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        await adapter.discoverCapabilities('/usr/bin/ollama');
        expect(lastChildProcessCall).toBe('exec');
      });

      it('uses execFile on non-win32 platforms for direct process invocation', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        await adapter.discoverCapabilities('/usr/bin/ollama');
        expect(lastChildProcessCall).toBe('execFile');
      });
    });
  });

  // ── parseOllamaModelList (pure) ────────────────────────────────────────────

  describe('parseOllamaModelList', () => {
    it('skips the header row and extracts the first column, sorted', () => {
      const stdout = [
        'NAME               ID              SIZE      MODIFIED',
        'qwen2.5-coder:7b   2b0496514337    4.7 GB    1 week ago',
        'llama3.2:latest    a80c4f17acd5    2.0 GB    2 days ago',
      ].join('\n');
      expect(parseOllamaModelList(stdout)).toEqual(['llama3.2:latest', 'qwen2.5-coder:7b']);
    });

    it('returns an empty list for empty or header-only output', () => {
      expect(parseOllamaModelList('')).toEqual([]);
      expect(parseOllamaModelList('NAME    ID    SIZE    MODIFIED\n')).toEqual([]);
    });

    it('deduplicates repeated model names', () => {
      const stdout = 'gemma3:1b  aaa  1 GB  now\ngemma3:1b  aaa  1 GB  now\n';
      expect(parseOllamaModelList(stdout)).toEqual(['gemma3:1b']);
    });
  });

  // ── runtime strategy ───────────────────────────────────────────────────────

  describe('runtime', () => {
    it('uses PTY activity detection', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
    });

    it('detects the interactive REPL prompt as idle', () => {
      const activity = adapter.runtime.activity;
      expect(activity.kind).toBe('pty');
      if (activity.kind === 'pty') {
        expect(activity.detectIdle?.('thinking through the answer\n>>> ')).toBe(true);
        expect(activity.detectIdle?.('still generating output...')).toBe(false);
      }
    });

    it('strips ANSI escape codes before the idle prompt pattern check', () => {
      const activity = adapter.runtime.activity;
      expect(activity.kind).toBe('pty');
      if (activity.kind === 'pty') {
        // A CSI reset sequence immediately before the prompt must be stripped so
        // the pattern still matches. Removing the strip would cause this to return
        // false (the regex sees '\x1b' not '>' at the start-of-string anchor).
        expect(activity.detectIdle?.('\x1b[0m>>> ')).toBe(true);
        // ANSI colour codes wrapping non-prompt content must not produce a false
        // positive (no '>>>' anywhere after stripping).
        expect(activity.detectIdle?.('\x1b[32mstill working\x1b[0m')).toBe(false);
      }
    });

    it('declares no session history (no resume)', () => {
      expect(adapter.runtime.sessionHistory).toBeUndefined();
    });
  });

  // ── No-op methods ──────────────────────────────────────────────────────────

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

    it('getSubmissionVerifier returns null', () => {
      expect(adapter.getSubmissionVerifier('paste')).toBeNull();
      expect(adapter.getSubmissionVerifier('command-injection')).toBeNull();
    });
  });

  // ── detectFirstOutput ────────────────────────────────────────────────────

  describe('detectFirstOutput', () => {
    it('returns true for any non-empty data', () => {
      expect(adapter.detectFirstOutput('Hello')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  // ── getExitSequence ────────────────────────────────────────────────────────

  it('exit sequence is Ctrl+C then /bye', () => {
    expect(adapter.getExitSequence()).toEqual(['\x03', '/bye\r']);
  });

  // ── interpolateTemplate ────────────────────────────────────────────────────

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

  // ── permission mode mapping ──────────────────────────────────────────────

  describe('permission mode mapping', () => {
    const allModes: PermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'];

    for (const mode of allModes) {
      it(`adds no permission flags for ${mode} (Ollama has no autonomy controls)`, () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
        expect(command).not.toContain('--yes');
        expect(command).not.toContain('--permission');
        expect(command).not.toContain('--approval');
      });
    }
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe('Agent Registry', () => {
  it('has ollama adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('ollama')).toBe(true);
  });

  it('getOrThrow returns OllamaAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('ollama');
    expect(adapter.name).toBe('ollama');
    expect(adapter.sessionType).toBe('ollama_agent');
  });

  it('lists ollama among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('ollama');
  });

  it('getBySessionType finds ollama adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('ollama_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('ollama');
  });
});

// ── agent-display-name - ollama entry ─────────────────────────────────────────

describe('agent-display-name - ollama entry', () => {
  it('agentDisplayName returns "Ollama" for "ollama"', () => {
    expect(agentDisplayName('ollama')).toBe('Ollama');
  });

  it('agentShortName returns "Ollama" for "ollama"', () => {
    expect(agentShortName('ollama')).toBe('Ollama');
  });

  it('agentInstallUrl returns the Ollama download URL for "ollama"', () => {
    expect(agentInstallUrl('ollama')).toBe('https://ollama.com/download');
  });
});
