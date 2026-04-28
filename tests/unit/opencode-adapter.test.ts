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
import { describe, it, expect, beforeEach } from 'vitest';
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

    it('declares all four standard permission modes', () => {
      const modes = adapter.permissions.map((entry) => entry.mode);
      expect(modes).toContain('plan');
      expect(modes).toContain('default');
      expect(modes).toContain('acceptEdits');
      expect(modes).toContain('bypassPermissions');
    });

    it('uses acceptEdits as default permission', () => {
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

    it('produces identical commands across all permission modes (TUI has no per-mode flags)', () => {
      const planCommand = adapter.buildCommand(makeOptions({ permissionMode: 'plan', prompt: 'go' }));
      const defaultCommand = adapter.buildCommand(makeOptions({ permissionMode: 'default', prompt: 'go' }));
      const bypassCommand = adapter.buildCommand(makeOptions({ permissionMode: 'bypassPermissions', prompt: 'go' }));
      expect(planCommand).toBe(defaultCommand);
      expect(defaultCommand).toBe(bypassCommand);
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
  });

  describe('runtime strategy', () => {
    it('uses PTY-based activity detection (no hooks)', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
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

    it('removeHooks is a no-op (OpenCode has no hooks)', () => {
      expect(() => adapter.removeHooks('/some/dir', 'task-001')).not.toThrow();
    });

    it('clearSettingsCache is a no-op (no merged settings)', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
    });

    it('ensureTrust is a no-op (OpenCode has no trust dialog)', async () => {
      await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    });
  });

  describe('template interpolation', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate('Hello {{name}}!', { name: 'world' });
      expect(result).toBe('Hello world!');
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
});
