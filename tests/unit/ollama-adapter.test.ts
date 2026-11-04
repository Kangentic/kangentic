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

// Capability discovery: `ollama list` and `ollama run --help` via node:child_process.
let mockListStdout = '';
let mockListShouldFail = false;
let mockHelpStdout = '';
let mockHelpShouldFail = false;

/**
 * `ollama run --help` at v0.40.14, the flag block of
 * https://github.com/ollama/ollama/blob/v0.40.14/cmd/cmd.go as cobra prints it.
 *
 * Reconstructed, not captured: the binary was never run. The flag usage
 * strings were checked byte for byte against the signed v0.40.14
 * `ollama.exe` (from the release's ollama-windows-amd64.zip, signer Ollama
 * Inc.), which carries "Enable thinking mode: true/false or high/medium/low
 * for supported models", "Hide thinking output (if provided)" and "Show
 * timings for response". The column layout and the stream the help goes to
 * (stdout, which readCliOutput reads) are cobra's and are still unconfirmed
 * until a real `ollama run --help` is captured into tests/fixtures/.
 */
const RUN_HELP_V0_40_14 = [
  'Run a model',
  '',
  'Usage:',
  '  ollama run MODEL [PROMPT] [flags]',
  '',
  'Flags:',
  '      --dimensions int     Truncate output embeddings to specified dimension (embedding models only)',
  '      --format string      Response format (e.g. json)',
  '  -h, --help               help for run',
  '      --hidethinking       Hide thinking output (if provided)',
  '      --insecure           Use an insecure registry',
  '      --keepalive string   Duration to keep a model loaded (e.g. 5m)',
  '      --nowordwrap         Don\'t wrap words to the next line automatically',
  '      --think string[="true"]   Enable thinking mode: true/false or high/medium/low for supported models',
  '      --verbose            Show timings for response',
  '',
].join('\n');
/** The same help with the `--think` line removed (a CLI before 0.9.0). */
const RUN_HELP_WITHOUT_THINK = RUN_HELP_V0_40_14.split('\n').filter((line) => !line.includes('--think')).join('\n');
// Records which node:child_process function capability-discovery.ts last invoked.
// Lets platform-routing tests distinguish exec (win32 shell path) from execFile
// (non-win32 direct path) without spawning a real process.
let lastChildProcessCall: 'exec' | 'execFile' | null = null;
// Every command string / arg list the child_process mock was asked to run, in order.
let childProcessInvocations: string[] = [];

// WSL routing: a CLI path under `\\wsl.localhost\` resolves to a target, and
// the target's exec is recorded here instead of spawning wsl.exe.
const WSL_PATH_PREFIX = '\\\\wsl.localhost\\';
const WSL_LINUX_CLI_PATH = '/usr/bin/ollama';
let execCliForTargetCalls: string[][] = [];
// Every runCliPrintAnswer call the adapter makes (the answer run's CLI args).
let answerRunCalls: Array<{ args: string[] }> = [];

vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    resolveCliTarget: async (cliPath: string | null | undefined) => {
      if (!cliPath || !cliPath.startsWith(WSL_PATH_PREFIX)) return null;
      return { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: WSL_LINUX_CLI_PATH, facts: {} };
    },
    execCliForTarget: async (_target: unknown, args: string[]) => {
      execCliForTargetCalls.push(args);
      return { stdout: args.includes('--help') ? mockHelpStdout : mockListStdout, stderr: '' };
    },
  };
});

vi.mock('../../src/main/agent/shared/cli-answer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-answer')>();
  return {
    ...original,
    runCliPrintAnswer: async (options: { args: string[] }) => {
      answerRunCalls.push({ args: options.args });
      return 'answered';
    },
  };
});

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
    (execStub as unknown as Record<symbol, unknown>)[promisifyCustom] = async (command: string, args?: unknown) => {
      lastChildProcessCall = callType;
      // exec gets one command string; execFile gets the file and an args array.
      const invocation = Array.isArray(args) ? args.join(' ') : command;
      childProcessInvocations.push(invocation);
      if (invocation.includes('--help')) {
        if (mockHelpShouldFail) throw new Error('ollama run --help failed');
        return { stdout: mockHelpStdout, stderr: '' };
      }
      if (mockListShouldFail) throw new Error('ollama list failed');
      return { stdout: mockListStdout, stderr: '' };
    };
    return execStub;
  };
  return { exec: makeExec('exec'), execFile: makeExec('execFile') };
});

// Import after mocks are set up
const { OllamaAdapter, DEFAULT_OLLAMA_MODEL, parseOllamaModelList, parseOllamaThinkLevels } = await import(
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
    mockHelpStdout = RUN_HELP_V0_40_14;
    mockHelpShouldFail = false;
    lastChildProcessCall = null;
    childProcessInvocations = [];
    execCliForTargetCalls = [];
    answerRunCalls = [];
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

    // ── Effort (--think) ─────────────────────────────────────────────────

    it('passes effort as --think=<level> after the model and before the prompt guard', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'qwen3:8b', effort: 'high', prompt: 'Explain closures', shell: 'bash' }));
      const head = `${quoteArg('/usr/bin/ollama', 'bash')} run ${quoteArg('qwen3:8b', 'bash')} ${quoteArg('--think=high', 'bash')} -- `;
      expect(command.startsWith(head)).toBe(true);
      // The `=` form: `--think high` would make `high` a positional (pflag NoOptDefVal).
      expect(command).not.toMatch(/--think\s+high/);
      expect(command.indexOf('Explain closures')).toBeGreaterThan(command.indexOf(' -- '));
    });

    it('passes --think to a no-prompt REPL launch too', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'qwen3:8b', effort: 'low', shell: 'bash' }));
      expect(command).toBe(`${quoteArg('/usr/bin/ollama', 'bash')} run ${quoteArg('qwen3:8b', 'bash')} ${quoteArg('--think=low', 'bash')}`);
    });

    it('drops a level this CLI did not report, once discovery has run (a Claude xhigh left on the column)', async () => {
      await adapter.discoverCapabilities('/usr/bin/ollama');
      const command = adapter.buildCommand(makeOptions({ effort: 'xhigh', prompt: 'hi', shell: 'bash' }));
      expect(command).not.toContain('--think');
      expect(command).toContain('hi');
      expect(adapter.buildCommand(makeOptions({ effort: 'medium', shell: 'bash' }))).toContain('--think=medium');
    });

    it('passes no level to a CLI that reported none (before 0.9.0)', async () => {
      mockHelpStdout = RUN_HELP_WITHOUT_THINK;
      await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(adapter.buildCommand(makeOptions({ effort: 'high', shell: 'bash' }))).not.toContain('--think');
    });

    it('judges levels per CLI path, and passes a level through before that path is discovered', async () => {
      await adapter.discoverCapabilities('/opt/other/ollama');
      expect(adapter.buildCommand(makeOptions({ effort: 'xhigh', shell: 'bash' }))).toContain('--think=xhigh');
    });

    it('drops an effort whose case differs from the reported lowercase levels (current behavior)', async () => {
      await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(adapter.buildCommand(makeOptions({ effort: 'High', shell: 'bash' }))).not.toContain('--think');
    });

    it('passes no --think when no effort is set', () => {
      expect(adapter.buildCommand(makeOptions({ prompt: 'hi', shell: 'bash' }))).not.toContain('--think');
      expect(adapter.buildCommand(makeOptions({ effort: '  ', shell: 'bash' }))).not.toContain('--think');
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

      it('quotes the "--" end-of-options guard for PowerShell hosts', () => {
        // PowerShell's binder consumes a bare -- before a .ps1 shim sees
        // $args, so the guard must reach the process through quoteArg's
        // quoted form.
        const command = adapter.buildCommand(makeOptions({ prompt: 'fix the bug', shell: 'powershell' }));
        expect(command).toContain('"--"');
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
    });

    it('reports the --think levels `ollama run --help` names as effort levels', async () => {
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.effortLevels).toEqual(['high', 'medium', 'low']);
    });

    it('reports no effort levels when `ollama run --help` fails, without losing the model list', async () => {
      mockHelpShouldFail = true;
      mockListStdout = 'NAME  ID  SIZE  MODIFIED\nqwen3:8b  abc  5 GB  now\n';
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.effortLevels).toEqual([]);
      expect(capabilities.models).toEqual(['qwen3:8b']);
    });

    it('reports no effort levels for a CLI without --think (before 0.9.0)', async () => {
      mockHelpStdout = RUN_HELP_WITHOUT_THINK;
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
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
    // capability-discovery.ts:readCliOutput uses exec (shell invocation)
    // on win32 so that .cmd/.exe shims are resolved by the shell, and execFile
    // (direct invocation) on every other platform. These tests cover both arms
    // by stubbing process.platform, which is read at call time (not module load
    // time), so the stub is safe even though execAsync/execFileAsync are bound
    // at module evaluation.
    describe('platform-specific exec routing in readCliOutput', () => {
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

  // ── parseOllamaThinkLevels (pure) ──────────────────────────────────────────

  describe('parseOllamaThinkLevels', () => {
    it('reads the levels from the v0.40.14 --think line, dropping the true/false switch', () => {
      expect(parseOllamaThinkLevels(RUN_HELP_V0_40_14)).toEqual(['high', 'medium', 'low']);
    });

    it('takes whatever levels a later CLI lists, with no level list of its own', () => {
      const help = '      --think string   Enable thinking mode: true/false or max/high/medium/low for supported models\n';
      expect(parseOllamaThinkLevels(help)).toEqual(['max', 'high', 'medium', 'low']);
    });

    it('returns no levels for help without a --think line, or empty help', () => {
      expect(parseOllamaThinkLevels('      --verbose   Show timings for response\n')).toEqual([]);
      expect(parseOllamaThinkLevels('')).toEqual([]);
    });

    it('does not read --hidethinking as the --think line', () => {
      expect(parseOllamaThinkLevels('      --hidethinking   Hide thinking output (if provided)\n')).toEqual([]);
    });

    it('lowercases and dedups levels named in more than one slash group on the --think line', () => {
      const help = '      --think string   Enable thinking: true/false or High/medium, or medium/low\n';
      expect(parseOllamaThinkLevels(help)).toEqual(['high', 'medium', 'low']);
    });

    it('parses a --think line that has no `string` type token', () => {
      const help = '      --think   Enable thinking: true/false or high/low\n';
      expect(parseOllamaThinkLevels(help)).toEqual(['high', 'low']);
    });

    it('does not read --thinking or --think-budget lines, even with slash lists', () => {
      const help = [
        '      --thinking string   Mode: high/medium/low',
        '      --think-budget int   Budget: small/large',
      ].join('\n');
      expect(parseOllamaThinkLevels(help)).toEqual([]);
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

  // ── configuredModelFromCommand ───────────────────────────────────────────

  describe('configuredModelFromCommand', () => {
    it('reads the model from the command buildCommand builds, for every shell', () => {
      for (const shell of ['bash', 'powershell', 'cmd', 'fish']) {
        const command = adapter.buildCommand(makeOptions({ model: 'qwen2.5-coder:7b', effort: 'high', prompt: 'fix it', shell }));
        expect(adapter.configuredModelFromCommand(command), shell).toEqual({ id: 'qwen2.5-coder:7b', displayName: 'qwen2.5-coder:7b' });
        expect(command, shell).toContain(quoteArg('--think=high', shell));
      }
    });

    it('reads a double-quoted and a single-quoted model', () => {
      expect(adapter.configuredModelFromCommand('ollama run "my model" hi')?.id).toBe('my model');
      expect(adapter.configuredModelFromCommand("ollama run 'my model'")?.id).toBe('my model');
    });

    it('reads the model after an executable path holding an apostrophe and a space', () => {
      for (const shell of ['/bin/bash', 'fish']) {
        const command = adapter.buildCommand(makeOptions({
          agentPath: "/home/dev/o'brien tools/ollama",
          model: 'qwen3:8b',
          shell,
        }));
        expect(adapter.configuredModelFromCommand(command)?.id, shell).toBe('qwen3:8b');
      }
    });

    it('reads the default model when no override is set', () => {
      const command = adapter.buildCommand(makeOptions({ shell: 'bash' }));
      expect(adapter.configuredModelFromCommand(command)?.id).toBe(DEFAULT_OLLAMA_MODEL);
    });

    it('skips a quoted executable path that contains spaces', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Ollama App\\ollama.exe',
        model: 'gemma3:4b',
        shell: 'powershell',
      }));
      expect(adapter.configuredModelFromCommand(command)?.id).toBe('gemma3:4b');
    });

    it('never seeds a model from the prompt', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'llama3.2', prompt: 'please run mistral for me', shell: 'bash' }));
      expect(adapter.configuredModelFromCommand(command)?.id).toBe('llama3.2');
    });

    it('returns null for a command that is not an ollama run', () => {
      expect(adapter.configuredModelFromCommand('/usr/bin/ollama list')).toBeNull();
      expect(adapter.configuredModelFromCommand('')).toBeNull();
    });
  });

  // ── Think-level discovery, routing, cache key and answer-run gate ────────────

  describe('think levels: discovery isolation, parsing, routing, cache key', () => {
    let savedPlatformDescriptor: PropertyDescriptor | undefined;
    const stubPlatform = (platform: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    };

    beforeEach(() => {
      savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    });

    afterEach(() => {
      if (savedPlatformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', savedPlatformDescriptor);
      }
    });

    it('keeps the effort levels when `ollama list` fails (each read has its own fallback)', async () => {
      mockListShouldFail = true;
      const capabilities = await adapter.discoverCapabilities('/usr/bin/ollama');
      expect(capabilities.effortLevels).toEqual(['high', 'medium', 'low']);
      expect(capabilities.models).toBeUndefined();
    });

    it('runs the help read as `run --help` through the win32 shell exec', async () => {
      stubPlatform('win32');
      await adapter.discoverCapabilities('C:\\Users\\dev\\AppData\\Roaming\\npm\\ollama.cmd');
      const helpCommands = childProcessInvocations.filter((command) => command.includes('--help'));
      expect(helpCommands).toHaveLength(1);
      expect(helpCommands[0].endsWith('run --help')).toBe(true);
    });

    it('asks a WSL target for `list` and `run --help` as separate reads', async () => {
      mockListStdout = 'NAME  ID  SIZE  MODIFIED\nqwen3:8b  abc  5 GB  now\n';
      const capabilities = await adapter.discoverCapabilities('\\\\wsl.localhost\\Ubuntu\\usr\\bin\\ollama');
      expect(execCliForTargetCalls).toContainEqual(['list']);
      expect(execCliForTargetCalls).toContainEqual(['run', '--help']);
      expect(childProcessInvocations).toEqual([]);
      expect(capabilities.effortLevels).toEqual(['high', 'medium', 'low']);
      expect(capabilities.models).toEqual(['qwen3:8b']);
    });

    it('configuredModelFromCommand returns null when the token after `run` is a flag', () => {
      expect(adapter.configuredModelFromCommand('ollama run --think=high llama3.2')).toBeNull();
    });

    it('configuredModelFromCommand reads the model from a command built for a WSL target', () => {
      const cliTarget = {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath: '/home/dev/.local/bin/ollama',
        facts: {},
      } as unknown as SpawnCommandOptions['cliTarget'];
      const command = adapter.buildCommand(makeOptions({
        agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\ollama',
        cliTarget,
        model: 'qwen3:8b',
        shell: 'bash',
      }));
      expect(command).toContain('/home/dev/.local/bin/ollama');
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'qwen3:8b', displayName: 'qwen3:8b' });
    });

    it('applies levels discovered for a .cmd path to a .ps1 spelling of it on win32', async () => {
      stubPlatform('win32');
      await adapter.discoverCapabilities('C:\\Users\\dev\\AppData\\Roaming\\npm\\ollama.cmd');
      const ps1Path = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\OLLAMA.ps1';
      expect(adapter.buildCommand(makeOptions({ agentPath: ps1Path, effort: 'xhigh', shell: 'bash' }))).not.toContain('--think');
      expect(adapter.buildCommand(makeOptions({ agentPath: ps1Path, effort: 'high', shell: 'bash' }))).toContain('--think=high');
    });

    describe('a failed help read versus an answered one', () => {
      const cliPath = '/usr/bin/ollama';

      it('keeps the levels an earlier read reported when a later help read fails', async () => {
        await adapter.discoverCapabilities(cliPath);
        mockHelpShouldFail = true;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        expect(capabilities.effortLevels).toEqual(['high', 'medium', 'low']);
        expect(adapter.buildCommand(makeOptions({ effort: 'high', shell: 'bash' }))).toContain(quoteArg('--think=high', 'bash'));
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).toContain('--hidethinking');
      });

      it('has no cache when the very first help read fails: hides thinking and passes a level through', async () => {
        mockHelpShouldFail = true;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        expect(capabilities.effortLevels).toEqual([]);
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).toContain('--hidethinking');
        expect(adapter.buildCommand(makeOptions({ effort: 'xhigh', shell: 'bash' }))).toContain(quoteArg('--think=xhigh', 'bash'));
      });

      it('overwrites the cache when an answered help read names no --think line', async () => {
        await adapter.discoverCapabilities(cliPath);
        mockHelpStdout = RUN_HELP_WITHOUT_THINK;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        expect(capabilities.effortLevels).toEqual([]);
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).not.toContain('--hidethinking');
        expect(adapter.buildCommand(makeOptions({ effort: 'high', shell: 'bash' }))).not.toContain('--think');
      });

      it('looks up the answer run by shim-family key on win32 (.cmd discovered, .ps1 asked)', async () => {
        stubPlatform('win32');
        mockHelpStdout = RUN_HELP_WITHOUT_THINK;
        await adapter.discoverCapabilities('C:\\Users\\dev\\npm\\ollama.cmd');
        await adapter.answerFromContext('q', 'C:\\Users\\dev\\npm\\OLLAMA.ps1', 'C:\\projects\\my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).not.toContain('--hidethinking');
      });
    });

    describe('answerFromContext --hidethinking gate', () => {
      const cliPath = '/usr/bin/ollama';

      it('passes --hidethinking before any discovery has run', async () => {
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).toContain('--hidethinking');
      });

      it('leaves --hidethinking and --think out once discovery reported no levels', async () => {
        mockHelpStdout = RUN_HELP_WITHOUT_THINK;
        await adapter.discoverCapabilities(cliPath);
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        const args = answerRunCalls[0].args;
        expect(args).not.toContain('--hidethinking');
        expect(args.some((arg) => arg.startsWith('--think='))).toBe(false);
      });

      it('passes --hidethinking after discovery reported levels', async () => {
        await adapter.discoverCapabilities(cliPath);
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b');
        expect(answerRunCalls[0].args).toContain('--hidethinking');
      });

      it('passes --think=<level> for an effort, and nothing for a whitespace-only effort', async () => {
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b', { effort: ' high ' });
        expect(answerRunCalls[0].args).toContain('--think=high');
        await adapter.answerFromContext('q', cliPath, '/projects/my-app', 'qwen3:8b', { effort: '  ' });
        expect(answerRunCalls[1].args.some((arg) => arg.startsWith('--think='))).toBe(false);
      });
    });
  });

  // ── Live telemetry ───────────────────────────────────────────────────────

  it('declares that it has no live telemetry channel', () => {
    expect(adapter.liveTelemetryUnsupported.unavailableLabel.length).toBeGreaterThan(0);
    expect(adapter.liveTelemetryUnsupported.unavailableTitle).toContain('Ollama');
  });

  // ── getInjectionSequence (Command Terminal live swap) ──────────────────────

  describe('getInjectionSequence', () => {
    it('loads the new model before setting its thinking level', () => {
      expect(adapter.getInjectionSequence({ model: 'qwen3:8b', modelChanged: true, effort: 'high', effortChanged: true }))
        .toEqual(['/load qwen3:8b', '/set think high']);
    });

    it('types only what changed', () => {
      expect(adapter.getInjectionSequence({ model: 'qwen3:8b', modelChanged: false, effort: 'low', effortChanged: true }))
        .toEqual(['/set think low']);
      expect(adapter.getInjectionSequence({ model: 'qwen3:8b', modelChanged: true, effort: 'low', effortChanged: false }))
        .toEqual(['/load qwen3:8b']);
    });

    it('types nothing for empty-string model and effort even when flagged changed', () => {
      expect(adapter.getInjectionSequence({ model: '', modelChanged: true, effort: '', effortChanged: true })).toEqual([]);
    });

    it('types nothing for a cleared override', () => {
      expect(adapter.getInjectionSequence({ model: null, modelChanged: true, effort: null, effortChanged: true })).toEqual([]);
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
