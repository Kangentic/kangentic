/**
 * Unit tests for AiderAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { adaptCommandForShell, quoteArg } from '../../src/shared/paths';
import {
  createShellArgvProbe,
  installedPowerShellHosts,
  lineWithPrinterHead,
  typeAtCmdPrompt,
  typeAtPowerShellPrompt,
  type ShellArgvProbe,
} from './helpers/shell-argv-probe';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// Mock which, fs, and exec-version before importing adapter
let mockWhichResult: string | Error = '/usr/bin/aider';
let mockExecVersionStdout = 'aider v0.50.1\n';
let mockExecVersionShouldFail = false;
let execVersionCallCount = 0;

vi.mock('which', () => ({
  default: async () => {
    if (mockWhichResult instanceof Error) throw mockWhichResult;
    return mockWhichResult;
  },
}));

let mockExistsSyncReturnValue = true;

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

// A fixed bridge path, so the notifications command does not depend on where
// the repository is checked out.
const BRIDGE_SCRIPT_PATH = 'C:\\Users\\dev\\kangentic\\event-bridge.js';
const EVENTS_PATH = 'C:\\Users\\dev\\project\\.kangentic\\sessions\\s1\\events.jsonl';
const SPACED_EVENTS_PATH = 'C:\\Users\\dev\\My Project\\.kangentic\\sessions\\s1\\events.jsonl';
/** The notifications command for BRIDGE_SCRIPT_PATH and EVENTS_PATH, both bare once forward-slashed. */
const BARE_COMMAND = 'node C:/Users/dev/kangentic/event-bridge.js C:/Users/dev/project/.kangentic/sessions/s1/events.jsonl idle';

/** Run with `process.platform` reading as `platform`, restored afterwards. */
function withPlatform<Result>(platform: NodeJS.Platform, run: () => Result): Result {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
}

/** What the mocked `resolveBridgeScript` returns. A test that needs a non-bare bridge path sets it and resets it. */
let mockBridgeScriptPath = BRIDGE_SCRIPT_PATH;

vi.mock('../../src/main/agent/shared/bridge-utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/bridge-utils')>();
  return { ...original, resolveBridgeScript: () => mockBridgeScriptPath };
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

// Import after mocks are set up
const { AiderAdapter } = await import('../../src/main/agent/adapters/aider');
const { aiderAnswerUsage } = await import('../../src/main/agent/adapters/aider/aider-adapter');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/aider',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── AiderAdapter ─────────────────────────────────────────────────────────────

describe('AiderAdapter', () => {
  let adapter: AiderAdapter;

  beforeEach(() => {
    adapter = new AiderAdapter();
    mockWhichResult = '/usr/bin/aider';
    mockExecVersionStdout = 'aider v0.50.1\n';
    mockExecVersionShouldFail = false;
    execVersionCallCount = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "aider"', () => {
    expect(adapter.name).toBe('aider');
  });

  it('has sessionType "aider_agent"', () => {
    expect(adapter.sessionType).toBe('aider_agent');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await adapter.detect('/custom/aider');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/aider');
      expect(result.version).toBe('v0.50.1');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/aider');
    });

    it('returns found: false when which fails', async () => {
      mockWhichResult = new Error('not found');
      try {
        mockExistsSyncReturnValue = false;
        const result = await adapter.detect();
        expect(result.found).toBe(false);
        expect(result.path).toBeNull();
        expect(result.version).toBeNull();
      } finally {
        mockExistsSyncReturnValue = true;
      }
    });

    it('returns found: false with the configured path when --version fails on an override', async () => {
      // When the user configures an explicit override path and it fails,
      // the detector reports {found: false, path: <override>} so the
      // user can see WHICH configured path failed. This does NOT fall
      // through to PATH lookup - masking the user's explicit choice
      // would hide the misconfiguration. Shared with all four adapters
      // via AgentDetector.
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/aider');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/aider');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/aider');
      const second = await adapter.detect('/custom/aider');

      expect(first).toBe(second); // Same object reference (cached)
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/aider');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/aider');

      // Called twice because cache was invalidated
      expect(execVersionCallCount).toBe(2);
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    it('builds basic command with --no-auto-commits', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('--no-auto-commits');
    });

    it('includes --message when prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).toContain('--message');
      expect(command).toContain('Fix the bug');
    });

    it('omits --message when no prompt', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--message');
    });

    it('always includes --no-auto-commits', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'test' }));
      expect(command).toContain('--no-auto-commits');
    });

    it('always includes --no-suggest-shell-commands', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('--no-suggest-shell-commands');
    });

    // ── Permission mode mapping ──────────────────────────────────────────

    describe('permission mode mapping', () => {
      const yesPermissionModes: PermissionMode[] = ['bypassPermissions'];
      const noYesPermissionModes: PermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits', 'auto'];

      for (const mode of yesPermissionModes) {
        it(`adds --yes-always for ${mode}`, () => {
          // aider/args.py defines `--yes-always` and no `--yes` alias.
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command.split(' ')).toContain('--yes-always');
          expect(command.split(' ')).not.toContain('--yes');
        });
      }

      for (const mode of noYesPermissionModes) {
        it(`omits --yes for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).not.toContain('--yes');
        });
      }
    });

    // ── Shell quoting ────────────────────────────────────────────────────

    describe('shell quoting', () => {
      it('replaces double quotes with single quotes for non-unix shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'powershell',
        }));
        // Double quotes in prompt should be replaced with single quotes
        expect(command).not.toContain('"broken"');
        expect(command).toContain("'broken'");
      });

      it('preserves double quotes for unix-like shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'bash',
        }));
        // Single-quoted on bash, double quotes preserved literally inside
        expect(command).toContain('"broken"');
      });
    });

    // ── Session history and resume ───────────────────────────────────────
    //
    // Aider has no session id; Kangentic names each session's history file
    // with the id it mints (`--chat-history-file`) and resumes by restoring it
    // (`--restore-chat-history`), https://aider.chat/docs/config/options.html.

    const SESSION_ID = '3f1c2b7e-1d2a-4c55-9a7e-0b5e1c9d8f00';

    it("names the session's own history file by its id, by absolute path", () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, shell: 'bash' }));
      const expectedPath = path.join('/projects/my-app', `.aider.chat.history.${SESSION_ID}.md`).replace(/\\/g, '/');
      expect(command).toContain(`--chat-history-file ${quoteArg(expectedPath, 'bash')}`);
    });

    it("keeps Aider's default history file for a session with no id", () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--chat-history-file');
    });

    it('restores the history on resume', () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: true }));
      expect(command).toContain('--restore-chat-history');
      expect(command).toContain(`.aider.chat.history.${SESSION_ID}.md`);
    });

    it('omits --restore-chat-history when resume is false or absent', () => {
      expect(adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: false }))).not.toContain('--restore-chat-history');
      expect(adapter.buildCommand(makeOptions())).not.toContain('--restore-chat-history');
    });

    it("carries a resume's message on --message with the restored history, never typed", () => {
      // A typed message waits only for the PTY to go quiet, and Aider is quiet
      // at a confirm prompt that would take it as an answer.
      const command = adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: true, prompt: 'Continue', shell: 'bash' }));
      expect(command).toContain('--restore-chat-history');
      expect(command).toContain('--message Continue');
      expect(adapter.resumePromptDelivery).toBe('command-line');
    });

    it('opens a resume with no message interactive', () => {
      const command = adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: true }));
      expect(command).toContain('--restore-chat-history');
      expect(command).not.toContain('--message');
    });

    it('declares a caller-owned id and no Aider resume flag of its own', () => {
      expect(adapter.supportsCallerSessionId).toBe(true);
      const command = adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: true }));
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
    });

    it("locates the session's own history file, and Aider's default with no id", async () => {
      mockExistsSyncReturnValue = true;
      expect(await adapter.locateSessionHistoryFile(SESSION_ID, '/projects/my-app'))
        .toBe(path.join('/projects/my-app', `.aider.chat.history.${SESSION_ID}.md`));
      expect(await adapter.locateSessionHistoryFile('', '/projects/my-app'))
        .toBe(path.join('/projects/my-app', '.aider.chat.history.md'));
    });

    // ── Model and effort ─────────────────────────────────────────────────

    it('passes the column model and effort as --model and --reasoning-effort', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'gpt-5', effort: 'high', shell: 'bash' }));
      expect(command).toContain('--model gpt-5');
      expect(command).toContain('--reasoning-effort high');
    });

    it('omits both flags when neither is set', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--model');
      expect(command).not.toContain('--reasoning-effort');
    });

    it('puts --model ahead of the prompt', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'gpt-5', prompt: 'use --model other', shell: 'bash' }));
      expect(command).toContain('--model gpt-5');
      expect(command.indexOf('--model gpt-5')).toBeLessThan(command.indexOf('--message'));
    });

    it('puts --reasoning-effort ahead of the prompt', () => {
      const command = adapter.buildCommand(makeOptions({ effort: 'low', prompt: 'use --reasoning-effort high', shell: 'bash' }));
      expect(command).toContain('--reasoning-effort low');
      expect(command.indexOf('--reasoning-effort low')).toBeLessThan(command.indexOf('--message'));
    });

    it('ignores nonInteractive flag', () => {
      const command = adapter.buildCommand(makeOptions({ nonInteractive: true }));
      expect(command).not.toContain('--print');
    });

    it('starts with quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/aider',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/aider', 'bash'))).toBe(true);
    });

    // ── Notifications command ────────────────────────────────────────────
    //
    // Aider runs this string through its own shell (cmd.exe on Windows,
    // /bin/sh elsewhere), so it carries a quoting layer of its own inside the
    // one quoteArg adds for the shell Kangentic types into.

    describe('notifications command', () => {
      it('writes bare paths, so the command holds no quote of its own on any shell', () => {
        for (const shell of ['pwsh', 'powershell', 'cmd.exe']) {
          const command = adapter.buildCommand(makeOptions({ shell, eventsOutputPath: EVENTS_PATH }));
          expect(command, shell).toContain(`--notifications --notifications-command "${BARE_COMMAND}"`);
        }
        const bashCommand = adapter.buildCommand(makeOptions({ shell: 'bash', eventsOutputPath: EVENTS_PATH }));
        expect(bashCommand).toContain(`--notifications --notifications-command '${BARE_COMMAND}'`);
      });

      it('omits both flags under a Windows double-quote shell when a path holds a space', () => {
        // Its inner quotes would need a `"` the outer double-quoted argument
        // cannot carry. --notifications alone would make Aider fall back to its
        // own PowerShell message box, so neither flag is sent.
        withPlatform('win32', () => {
          for (const shell of ['pwsh', 'powershell', 'cmd.exe']) {
            const command = adapter.buildCommand(makeOptions({ shell, eventsOutputPath: SPACED_EVENTS_PATH }));
            expect(command, shell).not.toContain('--notifications');
          }
        });
      });

      it('keeps the inner quotes under a unix-like shell, which delivers them inside single quotes', () => {
        const command = adapter.buildCommand(makeOptions({ shell: 'bash', eventsOutputPath: SPACED_EVENTS_PATH }));
        expect(command).toContain(
          `--notifications-command 'node C:/Users/dev/kangentic/event-bridge.js "C:/Users/dev/My Project/.kangentic/sessions/s1/events.jsonl" idle'`,
        );
      });

      it('sends neither flag without an events path', () => {
        const command = adapter.buildCommand(makeOptions({ shell: 'pwsh' }));
        expect(command).not.toContain('--notifications');
      });

      // The bridge path other tests resolve is bare. Reset it so a test that
      // sets a non-bare one cannot leak into a later test or describe block.
      afterEach(() => {
        mockBridgeScriptPath = BRIDGE_SCRIPT_PATH;
      });

      const SPACED_POSIX_EVENTS_PATH = '/home/dev/My Project/.kangentic/sessions/s1/events.jsonl';
      const SPACED_BRIDGE_SCRIPT_PATH = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic App\\resources\\event-bridge.js';

      // ── No shell given: the outer shell is guessed from the platform ──────

      describe('without a shell', () => {
        it('omits both flags on Windows when a path holds a space', () => {
          // No shell reads as the Windows PowerShell form, which cannot carry
          // the inner double quotes a spaced path needs.
          withPlatform('win32', () => {
            const command = adapter.buildCommand(makeOptions({ eventsOutputPath: SPACED_EVENTS_PATH }));
            expect(command).not.toContain('--notifications');
          });
        });

        it('keeps the inner double quotes inside the outer single quotes off Windows', () => {
          withPlatform('linux', () => {
            const command = adapter.buildCommand(makeOptions({ eventsOutputPath: SPACED_POSIX_EVENTS_PATH }));
            expect(command).toContain(
              `--notifications --notifications-command 'node C:/Users/dev/kangentic/event-bridge.js "/home/dev/My Project/.kangentic/sessions/s1/events.jsonl" idle'`,
            );
          });
        });

        it('sends a bare command on every platform, in the outer quote that platform defaults to', () => {
          withPlatform('win32', () => {
            const command = adapter.buildCommand(makeOptions({ eventsOutputPath: EVENTS_PATH }));
            expect(command).toContain(`--notifications --notifications-command "${BARE_COMMAND}"`);
          });
          withPlatform('linux', () => {
            const command = adapter.buildCommand(makeOptions({ eventsOutputPath: EVENTS_PATH }));
            expect(command).toContain(`--notifications --notifications-command '${BARE_COMMAND}'`);
          });
        });
      });

      // ── A non-bare bridge path (an install directory with a space) ────────

      describe('with a bridge path that holds a space', () => {
        it('quotes the bridge path and leaves a bare events path alone under a unix-like shell', () => {
          mockBridgeScriptPath = SPACED_BRIDGE_SCRIPT_PATH;
          const command = adapter.buildCommand(makeOptions({ shell: 'bash', eventsOutputPath: EVENTS_PATH }));
          expect(command).toContain(
            `--notifications-command 'node "C:/Users/dev/AppData/Local/Programs/Kangentic App/resources/event-bridge.js" C:/Users/dev/project/.kangentic/sessions/s1/events.jsonl idle'`,
          );
        });

        it('omits both flags under a Windows double-quote shell', () => {
          mockBridgeScriptPath = SPACED_BRIDGE_SCRIPT_PATH;
          withPlatform('win32', () => {
            for (const shell of ['pwsh', 'powershell', 'cmd.exe']) {
              const command = adapter.buildCommand(makeOptions({ shell, eventsOutputPath: EVENTS_PATH }));
              expect(command, shell).not.toContain('--notifications');
            }
          });
        });
      });

      // ── A path holding a character /bin/sh still reads inside `"` ─────────

      describe('under a unix-like shell, with a path /bin/sh would expand inside double quotes', () => {
        const hostileEventsPaths: Record<string, string> = {
          'command substitution': '/home/dev/a$(touch x)/events.jsonl',
          'double quote': '/home/dev/a"b/events.jsonl',
          'backtick': '/home/dev/a`b/events.jsonl',
        };

        for (const [label, hostileEventsPath] of Object.entries(hostileEventsPaths)) {
          it(`omits both flags for an events path holding a ${label}`, () => {
            const command = adapter.buildCommand(makeOptions({ shell: 'bash', eventsOutputPath: hostileEventsPath }));
            expect(command).not.toContain('--notifications');
          });
        }

        it('omits both flags for a bridge path holding a dollar sign', () => {
          mockBridgeScriptPath = '/opt/Kangentic App/$HOME/resources/event-bridge.js';
          const command = adapter.buildCommand(makeOptions({ shell: 'bash', eventsOutputPath: EVENTS_PATH }));
          expect(command).not.toContain('--notifications');
        });
      });

      // ── PowerShell off Windows: single quotes inside the outer double quotes ──

      describe('under PowerShell off Windows', () => {
        for (const platform of ['linux', 'darwin'] as const) {
          it(`quotes a spaced events path in single quotes on ${platform}`, () => {
            withPlatform(platform, () => {
              const command = adapter.buildCommand(makeOptions({ shell: 'pwsh', eventsOutputPath: SPACED_POSIX_EVENTS_PATH }));
              expect(command).toContain(
                `--notifications --notifications-command "node C:/Users/dev/kangentic/event-bridge.js '/home/dev/My Project/.kangentic/sessions/s1/events.jsonl' idle"`,
              );
            });
          });
        }

        it('escapes an embedded single quote as quote, backslash, quote, quote', () => {
          withPlatform('linux', () => {
            const command = adapter.buildCommand(makeOptions({
              shell: 'pwsh',
              eventsOutputPath: "/home/dev/O'Brien Project/.kangentic/sessions/s1/events.jsonl",
            }));
            expect(command).toContain(
              `--notifications-command "node C:/Users/dev/kangentic/event-bridge.js '/home/dev/O'\\''Brien Project/.kangentic/sessions/s1/events.jsonl' idle"`,
            );
          });
        });

        it('carries a dollar sign inside the single quotes and lets the outer double quotes escape it', () => {
          // The inner single quotes keep /bin/sh from expanding the `$`. The outer
          // PowerShell double quotes would expand it first, so quoteArg writes a
          // backtick before it.
          withPlatform('linux', () => {
            const command = adapter.buildCommand(makeOptions({
              shell: 'pwsh',
              eventsOutputPath: '/home/dev/My $Project/.kangentic/sessions/s1/events.jsonl',
            }));
            expect(command).toContain(
              `--notifications-command "node C:/Users/dev/kangentic/event-bridge.js '/home/dev/My \`$Project/.kangentic/sessions/s1/events.jsonl' idle"`,
            );
          });
        });
      });
    });
  });

  // ── Model seed and live swap ─────────────────────────────────────────────

  describe('configuredModelFromCommand', () => {
    it("reads the builder's --model, on every quoting", () => {
      for (const shell of ['bash', 'pwsh']) {
        const command = adapter.buildCommand(makeOptions({ model: 'openrouter/anthropic/claude-sonnet-4-5', shell }));
        expect(adapter.configuredModelFromCommand(command), shell)
          .toEqual({ id: 'openrouter/anthropic/claude-sonnet-4-5', displayName: 'Sonnet 4.5' });
      }
    });

    it('shows a non-Anthropic name as written, without its provider', () => {
      const command = adapter.buildCommand(makeOptions({ model: 'openai/gpt-5', shell: 'bash' }));
      expect(adapter.configuredModelFromCommand(command)).toEqual({ id: 'openai/gpt-5', displayName: 'gpt-5' });
    });

    it('never reads a --model out of the prompt', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'run it with --model other', shell: 'bash' }));
      expect(adapter.configuredModelFromCommand(command)).toBeNull();
    });

    it('reads a double-quoted, single-quoted and unquoted id from a command string', () => {
      expect(adapter.configuredModelFromCommand('aider --model "openrouter/x-y" --message hi'))
        .toEqual({ id: 'openrouter/x-y', displayName: 'x-y' });
      expect(adapter.configuredModelFromCommand("aider --model 'x/y' --message hi"))
        .toEqual({ id: 'x/y', displayName: 'y' });
      expect(adapter.configuredModelFromCommand('aider --model gpt-5 --message hi'))
        .toEqual({ id: 'gpt-5', displayName: 'gpt-5' });
    });

    it('reads --model as the last flag when there is no --message', () => {
      expect(adapter.configuredModelFromCommand('aider --no-auto-commits --model gpt-5'))
        .toEqual({ id: 'gpt-5', displayName: 'gpt-5' });
    });

    it('returns null when the command has no --model', () => {
      expect(adapter.configuredModelFromCommand('aider --message hi')).toBeNull();
    });
  });

  describe('getInjectionSequence', () => {
    it('switches the model and the reasoning effort with their slash commands', () => {
      expect(adapter.getInjectionSequence({ model: 'gpt-5', modelChanged: true, effort: 'low', effortChanged: true }))
        .toEqual(['/model gpt-5', '/reasoning-effort low']);
    });

    it('writes nothing for an unchanged or empty field', () => {
      expect(adapter.getInjectionSequence({ model: 'gpt-5', modelChanged: false, effort: null, effortChanged: true })).toEqual([]);
    });

    it('switches only the effort when only the effort changed', () => {
      expect(adapter.getInjectionSequence({ modelChanged: true, model: null, effortChanged: true, effort: 'low' }))
        .toEqual(['/reasoning-effort low']);
    });

    it('switches only the model when only the model changed', () => {
      expect(adapter.getInjectionSequence({ model: 'gpt-5', modelChanged: true, effort: 'low', effortChanged: false }))
        .toEqual(['/model gpt-5']);
    });

    it('drops a model carrying a control character, so it cannot submit a second command', () => {
      expect(adapter.getInjectionSequence({ model: 'gpt-4o\r/run echo hi', modelChanged: true, effort: null, effortChanged: false }))
        .toEqual([]);
      expect(adapter.getInjectionSequence({ model: 'gpt-4o\r/run echo hi', modelChanged: true, effort: 'low', effortChanged: true }))
        .toEqual(['/reasoning-effort low']);
    });

    it('drops an effort carrying a control character', () => {
      expect(adapter.getInjectionSequence({ model: 'gpt-5', modelChanged: true, effort: 'low\n/run echo hi', effortChanged: true }))
        .toEqual(['/model gpt-5']);
    });
  });

  // ── Exit sequence ────────────────────────────────────────────────────────

  describe('getExitSequence', () => {
    it('sends Ctrl+C then /exit for graceful shutdown', () => {
      const sequence = adapter.getExitSequence();
      expect(sequence).toEqual(['\x03', '/exit\r']);
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

// ── Notifications command through real Windows shells ───────────────────────
//
// The command lines typed into real PowerShell hosts and cmd.exe, read back as
// the argv a node process received. An inner `"` in the command splits it there
// into `node \` and a stray positional argument. Windows only; the string pins
// above are what CI's Linux runner checks.

describe.skipIf(process.platform !== 'win32')('AiderAdapter notifications command round trip', () => {
  let probe: ShellArgvProbe;

  beforeAll(() => {
    probe = createShellArgvProbe();
  });

  afterAll(() => {
    probe.dispose();
  });

  it('delivers the command as one argument on every PowerShell host', () => {
    for (const host of installedPowerShellHosts()) {
      const command = new AiderAdapter().buildCommand(makeOptions({
        agentPath: 'aider',
        shell: host,
        eventsOutputPath: EVENTS_PATH,
      }));

      const run = typeAtPowerShellPrompt(probe, host, [lineWithPrinterHead(probe, host, command, 'aider')]);

      expect(run.strayLines, host).toEqual([]);
      expect(run.printed, host).toHaveLength(1);
      // Last, so no stray positional argument follows it.
      expect(run.printed[0].slice(-2), host).toEqual(['--notifications-command', BARE_COMMAND]);
    }
  }, 60_000);

  it('delivers the command as one argument under cmd, through an npm-style shim', () => {
    const command = new AiderAdapter().buildCommand(makeOptions({
      agentPath: probe.shimPath,
      shell: 'cmd.exe',
      eventsOutputPath: EVENTS_PATH,
    }));

    const printed = typeAtCmdPrompt([adaptCommandForShell(command, 'cmd.exe')]);

    expect(printed).toHaveLength(1);
    expect(printed[0].slice(-2)).toEqual(['--notifications-command', BARE_COMMAND]);
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe('Agent Registry', () => {
  it('has aider adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('aider')).toBe(true);
  });

  it('getOrThrow returns AiderAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('aider');
    expect(adapter.name).toBe('aider');
    expect(adapter.sessionType).toBe('aider_agent');
  });

  it('lists aider among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('aider');
  });
});

// -- agent-display-name - aider entry ----------------------------------------

describe('agent-display-name - aider entry', () => {
  it('agentDisplayName returns "Aider" for "aider"', () => {
    expect(agentDisplayName('aider')).toBe('Aider');
  });

  it('agentShortName returns "Aider" for "aider"', () => {
    expect(agentShortName('aider')).toBe('Aider');
  });

  it('agentInstallUrl returns the Aider homepage URL for "aider"', () => {
    expect(agentInstallUrl('aider')).toBe('https://aider.chat');
  });
});

// -- aiderAnswerUsage --------------------------------------------------------

describe('aiderAnswerUsage', () => {
  it('reads a single-line Tokens and Cost report', () => {
    const stdout = [
      'Aider v0.86.1',
      'Model: gpt-4o with diff edit format',
      'The answer.',
      '',
      'Tokens: 12k sent, 40 received. Cost: $0.02 message, $0.07 session.',
    ].join('\n');
    expect(aiderAnswerUsage(stdout)).toEqual({
      model: 'gpt-4o',
      inputTokens: 12000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 40,
      costUsd: 0.02,
    });
  });

  it('reads the model from a plain Model banner line', () => {
    const stdout = 'Model: gpt-4o with diff edit format\nThe answer.\nTokens: 500 sent, 20 received.';
    expect(aiderAnswerUsage(stdout)?.model).toBe('gpt-4o');
  });

  it('reports a null model when the banner announces none', () => {
    const stdout = 'Aider v0.86.1\nThe answer.\nTokens: 500 sent, 20 received.';
    expect(aiderAnswerUsage(stdout)?.model).toBeNull();
  });

  it('reports a null cost for a Tokens report with no Cost', () => {
    const usage = aiderAnswerUsage('The answer.\nTokens: 500 sent, 20 received.');
    expect(usage).toMatchObject({ inputTokens: 500, outputTokens: 20, costUsd: null });
  });

  it('returns null when there is no Tokens report', () => {
    expect(aiderAnswerUsage('Aider v0.86.1\nJust an answer.')).toBeNull();
  });
});
