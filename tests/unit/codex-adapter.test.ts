/**
 * Unit tests for CodexAdapter - command building, permission mapping,
 * hook management, event parsing, and template interpolation.
 *
 * These test the adapter's public API which exercises the internal
 * buildCodexCommand, mapPermissionMode, buildHooks, and
 * removeHooks functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { CodexSessionHistoryParser } from '../../src/main/agent/adapters/codex/session-history-parser';
import type { AgentInfo, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { cliPathForTarget, type CliPlace } from '../../src/main/agent/shared/cli-target';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// Use a platform-aware quote helper for assertions. quoteArg uses
// single quotes on Unix-like shells and double quotes on Windows/PowerShell.
const isWindows = process.platform === 'win32';
const q = (str: string) => (isWindows ? `"${str}"` : `'${str}'`);

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/codex',
    taskId: 'task-001',
    cwd: '/home/dev/project',
    permissionMode: 'default',
    ...overrides,
  };
}

/**
 * The adapter's private collaborators, narrowed to what the trust wiring tests
 * replace. `detector` would otherwise probe the machine's own Codex, and
 * `hookTrust` would start a real `codex app-server`.
 */
interface CodexAdapterInternals {
  detector: { detect: (overridePath?: string | null) => Promise<AgentInfo> };
  hookTrust: {
    start: (codexPath: string) => void;
    settle: (timeoutMs: number) => Promise<void>;
    stateOverrideFor: (codexPath: string) => string | null;
  };
}

function internalsOf(adapter: CodexAdapter): CodexAdapterInternals {
  return adapter as unknown as CodexAdapterInternals;
}

describe('Codex Adapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  describe('adapter identity', () => {
    it('has correct name and sessionType', () => {
      expect(adapter.name).toBe('codex');
      expect(adapter.sessionType).toBe('codex_agent');
    });
  });

  describe('buildCommand - new session', () => {
    it('builds basic command with working directory and approval flags', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('/usr/bin/codex');
      expect(command).toContain('-C');
      expect(command).toContain('/home/dev/project');
      expect(command).toContain('--sandbox');
      expect(command).toContain('--ask-for-approval');
    });

    it('includes prompt as positional argument', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'fix the bug' }));
      expect(command).toContain('fix the bug');
      // Prompt should NOT be preceded by -- (unlike Claude which uses end-of-options)
      expect(command).not.toContain(' -- ');
    });

    it('adds -q and --json flags for non-interactive mode', () => {
      const command = adapter.buildCommand(makeOptions({ nonInteractive: true }));
      expect(command).toContain('-q');
      expect(command).toContain('--json');
    });

    it('adds --disable apps when the disableApps launch option is enabled', () => {
      const command = adapter.buildCommand(makeOptions({ launchOptions: { disableApps: true } }));
      expect(command).toContain('--disable apps');
    });

    it('omits --disable apps when the disableApps launch option is false', () => {
      const command = adapter.buildCommand(makeOptions({ launchOptions: { disableApps: false } }));
      expect(command).not.toContain('--disable');
    });

    it('omits --disable apps when no launch options are provided', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--disable');
    });
  });

  describe('buildCommand - task process tag', () => {
    // A user's `shell_environment_policy` can strip inherited variables from the
    // shells Codex starts, which would hide KANGENTIC_TASK_ID from the reap.
    const TASK_TAG = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
    const TAG_OVERRIDE = `shell_environment_policy.set.KANGENTIC_TASK_ID=${TASK_TAG}`;

    it('re-injects the task tag into tool shells through shell_environment_policy.set', () => {
      const command = adapter.buildCommand(makeOptions({ taskProcessTag: TASK_TAG, shell: 'bash' }));
      expect(command).toContain(`-c '${TAG_OVERRIDE}'`);
    });

    // The override carries an `=`, which is outside quoteArg's bare-token set, so
    // it is always quoted, and in the form the target shell parses. The expected
    // strings are derived from quoteArg's rules in src/shared/paths.ts and
    // escapeForDoubleQuotedShell in src/shared/shell-quote.ts: PowerShell and cmd
    // both use a flat double-quoted token, and neither escaper changes this
    // payload (no backslash, double quote, backtick or `$` in it), so the two
    // come out identical. The test does not call quoteArg to build its answer.
    it.each(['powershell', 'cmd'])('quotes the override as one double-quoted token for %s', (shell) => {
      const command = adapter.buildCommand(makeOptions({ taskProcessTag: TASK_TAG, shell }));
      expect(command).toContain(`-c "${TAG_OVERRIDE}"`);
      expect(command).not.toContain(`'${TAG_OVERRIDE}'`);
    });

    it('re-injects it on a resume too, before the positional prompt grammar', () => {
      const command = adapter.buildCommand(makeOptions({
        taskProcessTag: TASK_TAG,
        resume: true,
        sessionId: 'sess-abc-123',
        shell: 'bash',
      }));
      expect(command).toContain(TAG_OVERRIDE);
    });

    it('emits nothing without a tag (a Command Terminal) or with a value that is not a task id', () => {
      expect(adapter.buildCommand(makeOptions())).not.toContain('shell_environment_policy');
      expect(adapter.buildCommand(makeOptions({ taskProcessTag: 'x; rm -rf /' }))).not.toContain('shell_environment_policy');
    });
  });

  describe('buildCommand - resume session', () => {
    it('builds resume subcommand with session ID', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
      }));
      expect(command).toContain('resume');
      expect(command).toContain('sess-abc-123');
      expect(command).toContain('-C');
      expect(command).toContain('/home/dev/project');
    });

    it('resume command carries the column permission mode', () => {
      // The resume branch used to early-return right after -C, silently
      // dropping the permission mode from every resumed session. `codex
      // resume --help` accepts -s/--sandbox and -a/--ask-for-approval, so
      // both branches now share one flag-emission path.
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        permissionMode: 'bypassPermissions',
      }));
      expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
      // The retired pre-0.128 flag spellings must not come back.
      expect(command).not.toContain('--approval-mode');
      expect(command).not.toContain('--full-auto');
    });

    it('resume command carries the per-column model override', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        model: 'gpt-5.5',
      }));
      expect(command).toContain('--model');
      expect(command).toContain('gpt-5.5');
    });

    it('resume command omits prompt even if provided', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        prompt: 'this should be ignored',
      }));
      expect(command).not.toContain('this should be ignored');
    });

    it('resume command adds --disable apps when the disableApps launch option is enabled', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        launchOptions: { disableApps: true },
      }));
      expect(command).toContain('--disable apps');
    });

    it('resume command omits --disable apps when the disableApps launch option is false', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        launchOptions: { disableApps: false },
      }));
      expect(command).not.toContain('--disable');
    });
  });

  describe('Kangentic MCP wiring', () => {
    const TOKEN = 'tok-deadbeef-0123';
    const URL = 'http://127.0.0.1:51733/mcp/proj-abc/sess-xyz';
    const URL_OVERRIDE = `mcp_servers.kangentic.url=${URL}`;
    const HEADER_OVERRIDE
      = 'mcp_servers.kangentic.env_http_headers.X-Kangentic-Token=KANGENTIC_MCP_TOKEN';

    const withMcp = (overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions =>
      makeOptions({
        mcpServerEnabled: true,
        mcpServerUrl: URL,
        mcpServerToken: TOKEN,
        ...overrides,
      });

    it('emits both -c overrides when MCP is fully configured', () => {
      const command = adapter.buildCommand(withMcp());
      expect(command).toContain(URL_OVERRIDE);
      expect(command).toContain(HEADER_OVERRIDE);
    });

    it('emits the overrides when mcpServerEnabled is undefined (default-on, matching Claude)', () => {
      const command = adapter.buildCommand(withMcp({ mcpServerEnabled: undefined }));
      expect(command).toContain(URL_OVERRIDE);
    });

    it('omits the overrides when mcpServerEnabled is false', () => {
      const command = adapter.buildCommand(withMcp({ mcpServerEnabled: false }));
      expect(command).not.toContain('mcp_servers');
    });

    it('omits the overrides when mcpServerUrl is missing', () => {
      const command = adapter.buildCommand(withMcp({ mcpServerUrl: undefined }));
      expect(command).not.toContain('mcp_servers');
    });

    it('omits the overrides when mcpServerToken is missing', () => {
      // Without a token there is nothing for env_http_headers to resolve, so
      // Codex would connect unauthenticated and get a 401.
      const command = adapter.buildCommand(withMcp({ mcpServerToken: undefined }));
      expect(command).not.toContain('mcp_servers');
    });

    it('never places the MCP token in the command string', () => {
      for (const options of [
        withMcp(),
        withMcp({ resume: true, sessionId: 'sess-abc-123' }),
        withMcp({ nonInteractive: true }),
      ]) {
        expect(adapter.buildCommand(options)).not.toContain(TOKEN);
      }
    });

    it('emits the overrides on the codex resume branch', () => {
      const command = adapter.buildCommand(withMcp({
        resume: true,
        sessionId: 'sess-abc-123',
        launchOptions: { disableApps: true },
      }));
      expect(command).toContain(URL_OVERRIDE);
      expect(command).toContain(HEADER_OVERRIDE);
      expect(command).toContain('--disable apps');
    });

    it('emits the overrides before the positional prompt', () => {
      // Codex's grammar is `codex [OPTIONS] [PROMPT]`; flags after the
      // positional would be parsed as extra positionals.
      const command = adapter.buildCommand(withMcp({ prompt: 'fix the bug' }));
      expect(command.indexOf('mcp_servers')).toBeLessThan(command.indexOf('fix the bug'));
    });

    // --- Shell portability. See command-builder.ts's QUOTING CONTRACT. ---
    // These pin the quote-free payloads. quoteArg cannot deliver an embedded
    // double quote on Windows (it writes one as '), so the natural TOML
    // inline-table form cannot arrive as written. The regression these were
    // added for made Codex exit 2 under PowerShell with
    // `error: unexpected argument 'http://...\' found`.

    it('emits -c payloads free of quote, brace, and whitespace characters', () => {
      for (const shell of ['powershell', 'cmd.exe', 'bash', 'nu']) {
        const command = adapter.buildCommand(withMcp({ shell }));
        for (const payload of [URL_OVERRIDE, HEADER_OVERRIDE]) {
          expect(payload, `payload must stay shell-safe for ${shell}`)
            .not.toMatch(/["'`${}\s]/);
          expect(command).toContain(payload);
        }
      }
    });

    it('does not emit a backslash-escaped quote under powershell', () => {
      const command = adapter.buildCommand(withMcp({ shell: 'powershell' }));
      expect(command).not.toContain('\\"');
    });

    it('wraps each -c payload in exactly one pair of shell quotes', () => {
      const powershellCommand = adapter.buildCommand(withMcp({ shell: 'powershell' }));
      expect(powershellCommand).toContain(`-c "${URL_OVERRIDE}"`);
      expect(powershellCommand).toContain(`-c "${HEADER_OVERRIDE}"`);

      const bashCommand = adapter.buildCommand(withMcp({ shell: 'bash' }));
      expect(bashCommand).toContain(`-c '${URL_OVERRIDE}'`);
      expect(bashCommand).toContain(`-c '${HEADER_OVERRIDE}'`);
    });

    it('emits identical payloads across shells, modulo the outer quote character', () => {
      const payloadsFor = (shell: string) =>
        [...adapter.buildCommand(withMcp({ shell })).matchAll(/-c ["']([^"']+)["']/g)]
          .map((match) => match[1]);
      const baseline = payloadsFor('powershell');
      expect(baseline).toEqual([URL_OVERRIDE, HEADER_OVERRIDE, 'check_for_update_on_startup=false']);
      for (const shell of ['cmd.exe', 'bash', 'wsl', 'nu']) {
        expect(payloadsFor(shell), `payloads diverged for ${shell}`).toEqual(baseline);
      }
    });

    it('keeps Codex\'s startup update prompt out of every launch, new and resumed', () => {
      // A modal whose first option is "Update now": a typed auto_command or an
      // Enter meant for the agent would update and exit Codex (task #859).
      for (const options of [withMcp({ shell: 'powershell' }), withMcp({ shell: 'bash', sessionId: 'thr_1', resume: true }), makeOptions({ shell: 'cmd.exe' })]) {
        expect(adapter.buildCommand(options)).toMatch(/-c ["']check_for_update_on_startup=false["']/);
      }
    });

    // --- buildEnv, the other half of the pair ---

    it('buildEnv returns only the MCP token variable when fully configured', () => {
      const env = adapter.buildEnv(withMcp());
      expect(env).toEqual({ KANGENTIC_MCP_TOKEN: TOKEN });
    });

    it('buildEnv returns null when disabled or incompletely configured', () => {
      expect(adapter.buildEnv(withMcp({ mcpServerEnabled: false }))).toBeNull();
      expect(adapter.buildEnv(withMcp({ mcpServerUrl: undefined }))).toBeNull();
      expect(adapter.buildEnv(withMcp({ mcpServerToken: undefined }))).toBeNull();
    });

    it('the env_http_headers override names the same variable buildEnv sets', () => {
      // Renaming one side alone must fail loudly.
      const command = adapter.buildCommand(withMcp({ shell: 'bash' }));
      const headerValue = command.match(
        /mcp_servers\.kangentic\.env_http_headers\.X-Kangentic-Token=([A-Z_]+)/,
      )?.[1];
      expect(headerValue).toBe(Object.keys(adapter.buildEnv(withMcp())!)[0]);
    });

    it('flag emission and buildEnv agree across the whole gate matrix', () => {
      // One shared predicate backs both. This is what stops a future
      // hand-copied second condition from drifting them apart.
      for (const mcpServerEnabled of [true, false, undefined]) {
        for (const mcpServerUrl of [URL, undefined]) {
          for (const mcpServerToken of [TOKEN, undefined]) {
            const options = makeOptions({
              shell: 'bash',
              mcpServerEnabled,
              mcpServerUrl,
              mcpServerToken,
            });
            const cell = `enabled=${mcpServerEnabled} url=${!!mcpServerUrl} token=${!!mcpServerToken}`;
            expect(
              adapter.buildCommand(options).includes('mcp_servers'),
              `flag/env disagreement at ${cell}`,
            ).toBe(adapter.buildEnv(options) !== null);
          }
        }
      }
    });
  });

  describe('buildCommand - permission mode mapping', () => {
    it("maps 'plan' to --sandbox read-only --ask-for-approval on-request", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'plan' }));
      expect(command).toContain('--sandbox read-only');
      expect(command).toContain('--ask-for-approval on-request');
    });

    it("maps 'dontAsk' to --sandbox read-only --ask-for-approval never", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'dontAsk' }));
      expect(command).toContain('--sandbox read-only');
      expect(command).toContain('--ask-for-approval never');
    });

    it("maps 'default' to --sandbox workspace-write --ask-for-approval on-request, never the untrusted Codex 0.154 refuses", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'default' }));
      expect(command).toContain('--sandbox workspace-write');
      expect(command).toContain('--ask-for-approval on-request');
      expect(command).not.toContain('untrusted');
    });

    // Codex 0.154.0's own possible values; anything else exits 2 before the TUI starts.
    it('passes only an --ask-for-approval value Codex accepts, in every mode', () => {
      const modes = ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
      for (const permissionMode of modes) {
        const command = adapter.buildCommand(makeOptions({ permissionMode }));
        const match = /--ask-for-approval (\S+)/.exec(command);
        if (match) expect(['on-request', 'never']).toContain(match[1]);
      }
    });

    it("maps 'acceptEdits' to --sandbox workspace-write --ask-for-approval never", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'acceptEdits' }));
      expect(command).toContain('--sandbox workspace-write');
      expect(command).toContain('--ask-for-approval never');
    });

    it("maps 'auto' to --sandbox workspace-write --ask-for-approval on-request", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'auto' }));
      expect(command).toContain('--sandbox workspace-write');
      expect(command).toContain('--ask-for-approval on-request');
    });

    it("maps 'bypassPermissions' to --dangerously-bypass-approvals-and-sandbox", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'bypassPermissions' }));
      expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('buildCommand - shell-aware quoting', () => {
    it('replaces double quotes in prompt for PowerShell', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'fix the "bug" here',
        shell: 'powershell',
      }));
      // Double quotes should be replaced with single quotes for PowerShell safety
      expect(command).not.toContain('"bug"');
      expect(command).toContain("'bug'");
    });

    it('preserves double quotes in prompt for bash', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'fix the "bug" here',
        shell: 'bash',
      }));
      expect(command).toContain('"bug"');
    });
  });

  describe('hook management', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // Codex 0.128 redesigned the hook system; project-local `.codex/hooks.json`
    // is no longer recognized and emits a "trailing characters" warning at
    // session start. Kangentic does not write that file any more - the spawn
    // path only sweeps stale entries left over by older Kangentic installs.

    it('does not create .codex/hooks.json on spawn (Codex 0.128 redesign)', () => {
      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      const hooksFile = path.join(tempDir, '.codex', 'hooks.json');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('does not create .codex/hooks.json when eventsOutputPath is omitted', () => {
      adapter.buildCommand(makeOptions({ cwd: tempDir }));
      const hooksFile = path.join(tempDir, '.codex', 'hooks.json');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('leaves existing user hooks untouched on spawn', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'PreToolUse', command: 'echo user-hook', timeout_secs: 5 };
      const original = JSON.stringify([userHook]);
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), original);

      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      // The existing user file is left exactly as it was - we do not append
      // entries any more, and a file with no Kangentic-owned commands is
      // signaled as "no change" by safelyUpdateSettingsFile.
      expect(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe(original);
    });

    it('cleans up stale Kangentic-owned legacy entries on spawn', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      // Pre-existing legacy file written by an older Kangentic build.
      const staleHook = {
        event: 'PreToolUse',
        command: 'node "/path/.kangentic/event-bridge.js" "/old/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify([staleHook]));

      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      // Only Kangentic-owned entries existed, so the file should be deleted
      // outright (no resurrection of the warning-producing format).
      expect(fs.existsSync(path.join(codexDir, 'hooks.json'))).toBe(false);
    });

    it('strips Kangentic-owned legacy entries while keeping user entries', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'Stop', command: 'echo done', timeout_secs: 5 };
      const staleHook = {
        event: 'PreToolUse',
        command: 'node "/path/.kangentic/event-bridge.js" "/old/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(
        path.join(codexDir, 'hooks.json'),
        JSON.stringify([userHook, staleHook]),
      );

      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      const remaining = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
      expect(remaining).toEqual([userHook]);
    });

    it('does not touch a non-array user config (Codex 0.128+ migrated format)', () => {
      // REGRESSION GUARD: a Codex 0.128 user (or third-party tooling) may
      // already have migrated `.codex/hooks.json` to the new object-shape
      // format (e.g. `{ "hooks": [...] }`). The legacy cleanup path must
      // not destroy that config - the `!Array.isArray(parsed)` guard in
      // `cleanupLegacyHooks` should signal "no change" so the file stays
      // byte-identical. Without this test, a future refactor that removes
      // or weakens the array check would silently overwrite user data on
      // every spawn.
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const migratedConfig = JSON.stringify(
        {
          hooks: [
            { eventName: 'pre_tool_use', command: 'echo user-hook', timeoutSec: 5 },
          ],
        },
        null,
        2,
      );
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), migratedConfig);

      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      expect(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe(migratedConfig);
    });

    it('removeHooks removes Kangentic entries and preserves user hooks', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'Stop', command: 'echo done', timeout_secs: 5 };
      const kangenticHook = {
        event: 'PreToolUse',
        command: 'node "/path/.kangentic/event-bridge.js" "/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(
        path.join(codexDir, 'hooks.json'),
        JSON.stringify([userHook, kangenticHook]),
      );

      adapter.removeHooks(tempDir);

      const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
      expect(hooks.length).toBe(1);
      expect(hooks[0]).toEqual(userHook);
    });

    it('removeHooks removes file when only Kangentic hooks remain', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const kangenticHook = {
        event: 'PreToolUse',
        command: 'node "/path/.kangentic/event-bridge.js" "/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify([kangenticHook]));

      adapter.removeHooks(tempDir);

      expect(fs.existsSync(path.join(codexDir, 'hooks.json'))).toBe(false);
    });

    it('removeHooks is a no-op when hooks.json does not exist', () => {
      // Should not throw
      adapter.removeHooks(tempDir);
    });

    it('removeHooks is a no-op when no Kangentic hooks present', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'Stop', command: 'echo done', timeout_secs: 5 };
      const original = JSON.stringify([userHook], null, 2);
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), original);

      adapter.removeHooks(tempDir);

      // File should be unchanged
      expect(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe(original);
    });
  });

  describe('interpolateTemplate', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('leaves unmatched placeholders intact', () => {
      const result = adapter.interpolateTemplate(
        '{{title}} - {{missing}}',
        { title: 'Hello' },
      );
      expect(result).toBe('Hello - {{missing}}');
    });
  });

  describe('ensureTrust', () => {
    // Codex's ensureTrust is NOT a no-op: it appends a `[projects.'<path>']`
    // trust table to config.toml. Redirect CODEX_HOME to a temp dir for the
    // duration, or this suite writes into the developer's real ~/.codex and
    // leaves one dead entry behind per run - the exact pollution that had
    // accumulated 463 entries before agent-pty-detection.test.ts was fixed.
    let trustHome: string;
    const originalCodexHome = process.env.CODEX_HOME;

    beforeEach(() => {
      trustHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-trust-'));
      process.env.CODEX_HOME = trustHome;
    });

    afterEach(() => {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(trustHome, { recursive: true, force: true });
    });

    it('records directory trust so the spawn does not stop on the prompt', async () => {
      const worktree = path.join(trustHome, 'project', '.kangentic', 'worktrees', '1');
      await expect(adapter.ensureTrust(worktree)).resolves.toBeUndefined();

      const config = fs.readFileSync(path.join(trustHome, 'config.toml'), 'utf-8');
      expect(config).toContain(`[projects.'${path.resolve(worktree)}']`);
      expect(config).toContain('trust_level = "trusted"');
    });

    it('waits for the hook trust read, bounded at 8 seconds, before the spawn goes on', async () => {
      // Every spawn path awaits ensureTrust before buildCommand, which reads the
      // trust result synchronously, so a read still running must be waited on.
      let releaseSettle: () => void = () => undefined;
      const settle = vi.spyOn(internalsOf(adapter).hookTrust, 'settle').mockImplementation(
        () => new Promise<void>((resolve) => { releaseSettle = resolve; }),
      );
      let resolved = false;
      const pending = adapter
        .ensureTrust(path.join(trustHome, 'project', '.kangentic', 'worktrees', '1'))
        .then(() => { resolved = true; });
      await expect.poll(() => settle.mock.calls.length, { timeout: 2000 }).toBe(1);
      expect(settle).toHaveBeenCalledWith(8000);
      // Intentional fixed wait: a missing await cannot be polled for, so give it
      // a tick to resolve before asserting it has not.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolved).toBe(false);
      releaseSettle();
      await pending;
      expect(resolved).toBe(true);
    });
  });

  describe('hook trust wiring', () => {
    const CODEX_PATH = '/usr/bin/codex';
    const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'PreCompact'];
    const TRUSTED_HASH = `sha256:${'c'.repeat(64)}`;
    const TRUST_STATE = `hooks.state={'C:\\<session-flags>\\config.toml:stop:0:0'={trusted_hash='${TRUSTED_HASH}'}}`;

    let workspace: string;

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-wiring-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('starts the trust read for the binary detect finds, and passes the override path on', async () => {
      const { detector, hookTrust } = internalsOf(adapter);
      const found: AgentInfo = { found: true, path: CODEX_PATH, version: '0.163.0' };
      const detect = vi.spyOn(detector, 'detect').mockResolvedValue(found);
      const start = vi.spyOn(hookTrust, 'start').mockImplementation(() => undefined);
      await expect(adapter.detect('/opt/custom/codex')).resolves.toEqual(found);
      expect(detect).toHaveBeenCalledWith('/opt/custom/codex');
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(CODEX_PATH);
    });

    it('starts no trust read when detect finds no binary', async () => {
      const { detector, hookTrust } = internalsOf(adapter);
      vi.spyOn(detector, 'detect').mockResolvedValue({ found: false, path: null, version: null });
      const start = vi.spyOn(hookTrust, 'start').mockImplementation(() => undefined);
      await adapter.detect();
      expect(start).not.toHaveBeenCalled();
    });

    /** A spawn that asks for hooks: an events file in a real folder, the shell fixed so quoting is predictable. */
    function hookedOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
      return makeOptions({
        cwd: workspace,
        shell: 'bash',
        eventsOutputPath: path.join(workspace, 'sessions', 's1', 'events.jsonl'),
        ...overrides,
      });
    }

    /** The names of the `-c hooks.<name>=...` overrides a command carries, in order. */
    function hookOverrideNames(command: string): string[] {
      return [...command.matchAll(/ -c '?"?hooks\.(\w+)=/g)].map((match) => match[1]);
    }

    it('wires the seven hooks and the trust state when the trust check confirmed this binary', () => {
      const stateOverrideFor = vi.spyOn(internalsOf(adapter).hookTrust, 'stateOverrideFor')
        .mockImplementation((codexPath) => (codexPath === CODEX_PATH ? TRUST_STATE : null));
      const command = adapter.buildCommand(hookedOptions());
      expect(stateOverrideFor).toHaveBeenCalledWith(CODEX_PATH);
      expect(hookOverrideNames(command)).toEqual([...HOOK_EVENTS, 'state']);
      expect(command).toContain(TRUSTED_HASH);
    });

    it('wires no hooks at all when the trust check did not confirm this binary', () => {
      vi.spyOn(internalsOf(adapter).hookTrust, 'stateOverrideFor').mockReturnValue(null);
      const command = adapter.buildCommand(hookedOptions());
      expect(command).not.toContain('hooks.');
      // The rest of the command is still built, so an empty string cannot pass.
      expect(command).toContain('check_for_update_on_startup=false');
    });

    it('wires no hooks without an events file even when the trust check confirmed the binary', () => {
      vi.spyOn(internalsOf(adapter).hookTrust, 'stateOverrideFor').mockReturnValue(TRUST_STATE);
      const command = adapter.buildCommand(hookedOptions({ eventsOutputPath: undefined }));
      expect(command).not.toContain('hooks.');
      expect(command).toContain('check_for_update_on_startup=false');
    });
  });

  describe('onWorktreeRemoved', () => {
    // Same CODEX_HOME sandboxing as the ensureTrust block above - this writes
    // to and reads back the same config.toml. Codex trust is keyed per
    // directory and cannot be inherited, so a worktree Kangentic deletes must
    // have its trust table dropped or ~/.codex/config.toml accumulates one
    // dead entry per task forever (463 entries on one developer machine
    // before this existed - see codex-trust-manager.test.ts).
    //
    // notify-adapters-worktree-removed.test.ts proves the fan-out calls
    // whatever `onWorktreeRemoved` a mocked adapter exposes; this proves the
    // REAL CodexAdapter method is actually wired to removeWorktreeTrust,
    // which nothing else in the suite exercises together.
    let trustHome: string;
    const originalCodexHome = process.env.CODEX_HOME;

    beforeEach(() => {
      trustHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-trust-removed-'));
      process.env.CODEX_HOME = trustHome;
    });

    afterEach(() => {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(trustHome, { recursive: true, force: true });
    });

    it('drops the trust table recorded by ensureTrust for the same directory', async () => {
      const worktree = path.join(trustHome, 'project', '.kangentic', 'worktrees', '1');
      await adapter.ensureTrust(worktree);
      const configPath = path.join(trustHome, 'config.toml');
      expect(fs.readFileSync(configPath, 'utf-8')).toContain(`[projects.'${path.resolve(worktree)}']`);

      await expect(adapter.onWorktreeRemoved!(worktree)).resolves.toBeUndefined();

      expect(fs.readFileSync(configPath, 'utf-8')).not.toContain(`[projects.'${path.resolve(worktree)}']`);
    });

    it('drops the table a distro Codex\'s trust step wrote in the distro\'s config.toml, given that place', async () => {
      const distroHome = path.join(trustHome, 'distro-home');
      const place: CliPlace = {
        kind: 'wsl',
        distro: 'Ubuntu',
        facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
      };
      const worktree = path.join(trustHome, 'project', '.kangentic', 'worktrees', '2');
      await adapter.ensureTrust(worktree, place);
      const distroConfig = path.join(distroHome, '.codex', 'config.toml');
      const distroKey = `[projects.'${cliPathForTarget(path.resolve(worktree), place)}']`;
      expect(fs.readFileSync(distroConfig, 'utf-8')).toContain(distroKey);

      // The call for this machine leaves the distro's file alone.
      await adapter.onWorktreeRemoved!(worktree);
      expect(fs.readFileSync(distroConfig, 'utf-8')).toContain(distroKey);

      await adapter.onWorktreeRemoved!(worktree, place);
      expect(fs.readFileSync(distroConfig, 'utf-8')).not.toContain(distroKey);
    });
  });

  describe('captureSessionIdFromOutput', () => {
    it('captures UUID from Codex v0.118+ startup header', () => {
      const output = 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n--------';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('captures UUID from multi-line startup header block', () => {
      const output = [
        'OpenAI Codex v0.118.0 (research preview)',
        '--------',
        'workdir: C:\\Users\\dev\\project',
        'model: gpt-5.3-codex',
        'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38',
        '--------',
      ].join('\n');
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('captures legacy thr_ format from resume hint', () => {
      const output = 'To continue this session, run: codex resume thr_abc123def';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('thr_abc123def');
    });

    it('prefers UUID header over legacy thr_ format', () => {
      const output = [
        'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38',
        'codex resume thr_oldformat',
      ].join('\n');
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('returns null for unrelated output', () => {
      expect(adapter.runtime.sessionId!.fromOutput!('Hello world')).toBeNull();
      expect(adapter.runtime.sessionId!.fromOutput!('')).toBeNull();
    });
  });

  describe('captureSessionIdFromFilesystem', () => {
    // Writes synthetic rollout files into the real ~/.codex/sessions
    // layout and verifies capture-by-cwd. Each test uses a unique UUID
    // and cleans up after itself so real Codex sessions are untouched.
    const createdFiles: string[] = [];
    let sessionsDir: string;

    function writeRollout(uuid: string, cwd: string, createdAt: Date = new Date()): string {
      const iso = createdAt.toISOString();
      const fileName = `rollout-${iso.replace(/[:.]/g, '-').replace('Z', '')}-${uuid}.jsonl`;
      const filepath = path.join(sessionsDir, fileName);
      fs.writeFileSync(filepath, JSON.stringify({
        timestamp: iso,
        type: 'session_meta',
        // payload.timestamp is the authoritative session creation time
        // used by captureSessionIdFromFilesystem's precise filter.
        payload: { id: uuid, cli_version: '0.118.0', cwd, timestamp: iso },
      }) + '\n');
      createdFiles.push(filepath);
      return filepath;
    }

    beforeEach(() => {
      const iso = new Date().toISOString();
      sessionsDir = path.join(os.homedir(), '.codex', 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
      fs.mkdirSync(sessionsDir, { recursive: true });
    });

    afterEach(() => {
      for (const filepath of createdFiles) {
        try { fs.unlinkSync(filepath); } catch { /* ignore */ }
      }
      createdFiles.length = 0;
    });

    it('captures the UUID for a rollout file whose session_meta.cwd matches', async () => {
      writeRollout('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee', '/tmp/task-a');
      const result = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(Date.now() - 2000),
        cwd: '/tmp/task-a',
        maxAttempts: 2,
      });
      expect(result).toBe('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('disambiguates concurrent spawns by cwd (prevents task A from stealing task B\'s session)', async () => {
      // REGRESSION: two fresh rollout files in the same dir. Without
      // cwd matching, picking "newest by mtime" would cross-contaminate.
      writeRollout('aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '/tmp/task-a');
      writeRollout('bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '/tmp/task-b');

      const resultA = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(Date.now() - 2000), cwd: '/tmp/task-a', maxAttempts: 2,
      });
      const resultB = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(Date.now() - 2000), cwd: '/tmp/task-b', maxAttempts: 2,
      });
      expect(resultA).toBe('aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(resultB).toBe('bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    });

    it('ignores rollout files with mtime before spawnedAt', async () => {
      const filepath = writeRollout('cccc3333-cccc-cccc-cccc-cccccccccccc', '/tmp/stale');
      const pastTime = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(filepath, pastTime, pastTime);

      const result = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(), cwd: '/tmp/stale', maxAttempts: 1,
      });
      expect(result).toBeNull();
    });

    it('ignores an actively-running prior session in the same cwd (fresh mtime but old session_meta.timestamp)', async () => {
      // REGRESSION: file mtime alone is unreliable - a long-running
      // Codex session appending events to its rollout keeps mtime
      // fresh. The precise filter is payload.timestamp, which is
      // written once at session start. Simulate the hole:
      //   1. Write an "old" session with payload.timestamp 2 minutes ago
      //   2. Touch its mtime to NOW (as if it just appended an event)
      //   3. Our spawn happens NOW; scanner must NOT pick up the old one.
      const oldSessionCreated = new Date(Date.now() - 120_000);
      const oldFilepath = writeRollout(
        'dddd4444-dddd-dddd-dddd-dddddddddddd',
        '/tmp/shared-cwd',
        oldSessionCreated,
      );
      const now = new Date();
      fs.utimesSync(oldFilepath, now, now);

      const result = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd: '/tmp/shared-cwd',
        maxAttempts: 1,
      });
      expect(result).toBeNull();
    });
  });

  describe('runtime.statusFile', () => {
    it('is defined with parseStatus, parseEvent, and isFullRewrite', () => {
      const statusFile = adapter.runtime.statusFile;
      expect(statusFile).toBeDefined();
      expect(statusFile!.parseStatus).toBeTypeOf('function');
      expect(statusFile!.parseEvent).toBeTypeOf('function');
      expect(statusFile!.isFullRewrite).toBe(false);
    });

    it('parseStatus returns null (Codex has no statusline)', () => {
      expect(adapter.runtime.statusFile!.parseStatus('')).toBeNull();
      expect(adapter.runtime.statusFile!.parseStatus('{"some":"data"}')).toBeNull();
    });

    it('parseEvent parses valid event-bridge JSONL into SessionEvent', () => {
      const line = JSON.stringify({ ts: 1234567890, type: 'tool_start', tool: 'bash' });
      const event = adapter.runtime.statusFile!.parseEvent(line);
      expect(event).toEqual({ ts: 1234567890, type: 'tool_start', tool: 'bash' });
    });

    it('parseEvent returns null for malformed JSON', () => {
      expect(adapter.runtime.statusFile!.parseEvent('not json')).toBeNull();
      expect(adapter.runtime.statusFile!.parseEvent('')).toBeNull();
    });
  });

  describe('extractSessionId', () => {
    it('extracts thread_id from hookContext JSON', () => {
      const hookContext = JSON.stringify({ thread_id: 'thr_abc123' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('thr_abc123');
    });

    it('extracts threadId (camelCase) from hookContext JSON', () => {
      const hookContext = JSON.stringify({ threadId: '019d60ac-b67c-7a22-bcbb-af55c8295c38' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('prefers thread_id over threadId', () => {
      const hookContext = JSON.stringify({ thread_id: 'preferred', threadId: 'fallback' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('preferred');
    });

    it('reads session_id, the field Codex 0.163.0 SessionStart payloads carry, ahead of thread_id', () => {
      const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-hooks', 'codex-0.154.0-session-start.json'), 'utf-8');
      expect(adapter.runtime.sessionId!.fromHook!(fixture)).toBe('00000000-0000-4000-8000-4216b01c397e');
      const both = JSON.stringify({ session_id: 'from-session-id', thread_id: 'from-thread-id' });
      expect(adapter.runtime.sessionId!.fromHook!(both)).toBe('from-session-id');
    });

    it('returns null when hookContext has no session or thread id', () => {
      const hookContext = JSON.stringify({ cwd: 'C:/Users/dev/repo' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(adapter.runtime.sessionId!.fromHook!('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(adapter.runtime.sessionId!.fromHook!('')).toBeNull();
    });
  });

  describe('activity detection strategy', () => {
    it('is hook-driven with a PTY fallback that has no detectIdle', () => {
      const strategy = adapter.runtime.activity;
      expect(strategy.kind).toBe('hooks_and_pty');
      // Codex does NOT use detectIdle. The guillemet (›) is always
      // visible in the Ink TUI prompt area, even during active work,
      // so it causes false idle transitions. The silence timer
      // (PTY_SILENCE_THRESHOLD_MS) is the fallback's only idle signal.
      expect((strategy as { detectIdle?: unknown }).detectIdle).toBeUndefined();
    });

    it('keeps its rollout from turning the PTY fallback off, and reports turn ends', () => {
      // The rollout carries no turn starts or ends (task #859), so a session
      // whose hooks Codex did not confirm keeps the PTY tracker.
      expect(adapter.runtime.sessionHistory?.suppressesPtyFallback).toBe(false);
      expect(adapter.runtime.reportsTurnEnd).toBe(true);
    });
  });

  describe('concurrent-session hook holds', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-codex-refcount-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const seedHooksFile = (directory: string): string => {
      const codexDir = path.join(directory, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const hooksFile = path.join(codexDir, 'hooks.json');
      const kangenticHook = {
        event: 'PreToolUse',
        command: 'node "/seed/.kangentic/event-bridge.js" "/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(hooksFile, JSON.stringify([kangenticHook]));
      return hooksFile;
    };

    // Holds are keyed by the session's own id (`ptySessionId`), never by its
    // task, and record the project root the build swept.
    const buildFor = (cwd: string, ptySessionId: string, extra: Partial<SpawnCommandOptions> = {}) => {
      adapter.buildCommand(makeOptions({
        cwd,
        taskId: `task-of-${ptySessionId}`,
        ptySessionId,
        eventsOutputPath: path.join(cwd, '.kangentic', 'sessions', ptySessionId, 'events.jsonl'),
        ...extra,
      }));
    };

    it('strips hooks only after the last live session releases', () => {
      // Two concurrent sessions in the same cwd, distinct tasks.
      buildFor(tempDir, 'session-a');
      buildFor(tempDir, 'session-b');

      // Replace the real buildHooks output with a deterministic seed that
      // carries a recognizable Kangentic signature so we can assert strip vs keep.
      const hooksFile = seedHooksFile(tempDir);

      // session-a releases: hooks must remain because session-b is still live.
      adapter.removeHooks(tempDir, 'session-a');
      expect(fs.existsSync(hooksFile)).toBe(true);
      const afterFirst = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
      expect(afterFirst.length).toBe(1);

      // session-b releases: now hooks are stripped. With only Kangentic hooks
      // remaining, safelyUpdateSettingsFile deletes the whole file.
      adapter.removeHooks(tempDir, 'session-b');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('double-release for the same session is idempotent (suspend + onExit)', () => {
      buildFor(tempDir, 'session-a');
      buildFor(tempDir, 'session-b');
      const hooksFile = seedHooksFile(tempDir);

      // session-manager.suspend() calls removeHooks explicitly, then the
      // PTY's onExit handler calls it again for the same session. Both
      // calls must be absorbed without stripping hooks while session-b is live.
      adapter.removeHooks(tempDir, 'session-a');
      adapter.removeHooks(tempDir, 'session-a');

      expect(fs.existsSync(hooksFile)).toBe(true);
      const afterDoubleRelease = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
      expect(afterDoubleRelease.length).toBe(1);
    });

    it('an older session of the same task releasing late keeps the newer session\'s hold', () => {
      buildFor(tempDir, 'old-session', { taskId: 'task-a' });
      buildFor(tempDir, 'new-session', { taskId: 'task-a' });
      const hooksFile = seedHooksFile(tempDir);

      adapter.removeHooks(tempDir, 'old-session');
      expect(fs.existsSync(hooksFile)).toBe(true);

      adapter.removeHooks(tempDir, 'new-session');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('a worktree session\'s release sweeps the project root its build held', () => {
      // The build sweeps `<projectRoot>/.codex/hooks.json`, while the session
      // layer releases with the worktree it ran in.
      const worktree = path.join(tempDir, '.kangentic', 'worktrees', 'task-a');
      fs.mkdirSync(worktree, { recursive: true });
      buildFor(worktree, 'session-a', { projectRoot: tempDir });
      const hooksFile = seedHooksFile(tempDir);

      adapter.removeHooks(worktree, 'session-a');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('decouples holds across different cwds', () => {
      const tempDirTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-codex-refcount-b-'));
      try {
        buildFor(tempDir, 'session-a');
        buildFor(tempDirTwo, 'session-b');

        seedHooksFile(tempDir);
        const hooksFileTwo = seedHooksFile(tempDirTwo);

        // Releasing session-a in tempDir does not touch tempDirTwo.
        adapter.removeHooks(tempDir, 'session-a');
        expect(fs.existsSync(hooksFileTwo)).toBe(true);
        const stillThere = JSON.parse(fs.readFileSync(hooksFileTwo, 'utf-8'));
        expect(stillThere.length).toBe(1);
      } finally {
        fs.rmSync(tempDirTwo, { recursive: true, force: true });
      }
    });

    it('tolerates removeHooks with no prior retain (crash/restart path)', () => {
      seedHooksFile(tempDir);
      expect(() => adapter.removeHooks(tempDir, 'orphan-session')).not.toThrow();
    });

    it('a call without a session id still strips (project delete sweep)', () => {
      // The project-delete sweep passes no session id and runs after every
      // session is gone.
      buildFor(tempDir, 'session-a');
      const hooksFile = seedHooksFile(tempDir);
      adapter.removeHooks(tempDir);
      expect(fs.existsSync(hooksFile)).toBe(false);
    });
  });
});

// -- agent-display-name - codex entry ----------------------------------------

describe('agent-display-name - codex entry', () => {
  it('agentDisplayName returns "Codex CLI" for "codex"', () => {
    expect(agentDisplayName('codex')).toBe('Codex CLI');
  });

  it('agentShortName returns "Codex" for "codex"', () => {
    expect(agentShortName('codex')).toBe('Codex');
  });

  it('agentInstallUrl returns the OpenAI Codex repo URL for "codex"', () => {
    expect(agentInstallUrl('codex')).toBe('https://github.com/openai/codex');
  });
});
