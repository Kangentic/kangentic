/**
 * Unit tests for QwenCommandBuilder - verifies flag mapping,
 * permission modes, session resume, prompt delivery, and template
 * interpolation.
 *
 * Mirrors gemini-command-builder.test.ts. Key delta: Qwen Code uses
 * `--approval-mode auto-edit` (HYPHEN), where Gemini uses `auto_edit`
 * (UNDERSCORE). The fork verification ran against the published yargs
 * choices array in packages/cli/src/config/config.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { QwenCommandBuilder, supportsMcpConfigFlag } from '../../src/main/agent/adapters/qwen-code';
import type { QwenCommandOptions } from '../../src/main/agent/adapters/qwen-code';
import {
  QWEN_BACKGROUND_COMMAND_SPEC,
  QWEN_BRIDGE_COPY_NAME,
  QWEN_HINT_BRIDGE_COPY_NAME,
} from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { backgroundShellHintSpecOf } from '../../src/main/agent/shared/background-command-hooks';
import { EVENTS_PATH_FROM_ENVIRONMENT, isKangenticHookCommand } from '../../src/main/agent/shared/hook-utils';
import {
  buildForPlatform,
  CLI_ENVIRONMENT_REFERENCE,
  HOOK_PROBE_SEGMENT,
  installedShOrPowerShellHosts,
  runAsHookShell,
  type HookShellHost,
} from './helpers/shell-argv-probe';

/** Minimal options for tests that don't need hooks/settings. */
function baseOptions(overrides: Partial<QwenCommandOptions> = {}): QwenCommandOptions {
  return {
    qwenPath: '/usr/bin/qwen',
    taskId: 'task-1',
    cwd: '/project',
    permissionMode: 'default',
    ...overrides,
  };
}

/**
 * Build command without side effects (no file writes).
 * Omits eventsOutputPath to skip createMergedSettings.
 */
function buildCommand(overrides: Partial<QwenCommandOptions> = {}): string {
  const builder = new QwenCommandBuilder();
  return builder.buildQwenCommand(baseOptions(overrides));
}

describe('QwenCommandBuilder', () => {
  describe('basic command', () => {
    it('produces qwen path as first argument', () => {
      const command = buildCommand();
      expect(command).toBe('/usr/bin/qwen');
    });

    it('quotes qwen path with spaces', () => {
      const command = buildCommand({ qwenPath: '/path with spaces/qwen' });
      expect(command).toContain(quoteArg('/path with spaces/qwen'));
    });
  });

  describe('permission modes', () => {
    it('default mode produces no flags', () => {
      const command = buildCommand({ permissionMode: 'default' });
      expect(command).not.toContain('--approval-mode');
    });

    it('plan mode maps to --approval-mode plan', () => {
      const command = buildCommand({ permissionMode: 'plan' });
      expect(command).toContain('--approval-mode plan');
    });

    it('dontAsk maps to --approval-mode plan (safest restrictive fallback)', () => {
      const command = buildCommand({ permissionMode: 'dontAsk' });
      expect(command).toContain('--approval-mode plan');
    });

    it('acceptEdits maps to --approval-mode auto-edit (HYPHEN, fork delta from Gemini)', () => {
      const command = buildCommand({ permissionMode: 'acceptEdits' });
      expect(command).toContain('--approval-mode auto-edit');
      // Guard against the Gemini-style underscore creeping back in.
      expect(command).not.toContain('auto_edit');
    });

    it('auto maps to --approval-mode auto-edit', () => {
      const command = buildCommand({ permissionMode: 'auto' });
      expect(command).toContain('--approval-mode auto-edit');
      expect(command).not.toContain('auto_edit');
    });

    it('bypassPermissions maps to --approval-mode yolo', () => {
      const command = buildCommand({ permissionMode: 'bypassPermissions' });
      expect(command).toContain('--approval-mode yolo');
    });
  });

  describe('session id flags', () => {
    it('resume with sessionId produces --resume flag', () => {
      const command = buildCommand({ resume: true, sessionId: 'abc-123' });
      expect(command).toContain('--resume');
      expect(command).toContain('abc-123');
      expect(command).not.toContain('--session-id');
    });

    it('new session with sessionId produces --session-id flag (caller-owned)', () => {
      const command = buildCommand({ resume: false, sessionId: 'abc-123' });
      expect(command).toContain('--session-id');
      expect(command).toContain('abc-123');
      expect(command).not.toContain('--resume');
    });

    it('new session without sessionId produces no session flag', () => {
      const command = buildCommand();
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
    });

    it('resume without sessionId produces no flag', () => {
      const command = buildCommand({ resume: true });
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
    });
  });

  describe('prompt delivery', () => {
    // Use word-boundary regexes (or space-padded substrings) to test for
    // the -i / -p flags rather than bare `toContain('-i')`. The substring
    // `-i` appears inside `--session-id`, so a naive `toContain` would
    // silently false-positive whenever a session id is present.
    const hasInteractiveFlag = (command: string) => / -i /.test(command);
    const hasOneShotFlag = (command: string) => / -p /.test(command);

    it('interactive prompt uses -i flag (--prompt-interactive launches TUI)', () => {
      const command = buildCommand({ prompt: 'Fix the bug' });
      expect(hasInteractiveFlag(command)).toBe(true);
      expect(command).toContain(quoteArg('Fix the bug'));
      // A bare positional prompt would be treated as one-shot by Qwen Code,
      // so we must never emit one. Also guard against -p creeping into the
      // interactive branch.
      expect(hasOneShotFlag(command)).toBe(false);
    });

    it('non-interactive prompt uses -p flag', () => {
      const command = buildCommand({ nonInteractive: true, prompt: 'Fix the bug' });
      expect(hasOneShotFlag(command)).toBe(true);
      expect(command).toContain(quoteArg('Fix the bug'));
      expect(hasInteractiveFlag(command)).toBe(false);
    });

    it('no prompt produces no prompt flag', () => {
      const command = buildCommand();
      expect(command).toBe('/usr/bin/qwen');
    });

    it('non-interactive without prompt produces no -p flag', () => {
      const command = buildCommand({ nonInteractive: true });
      expect(hasOneShotFlag(command)).toBe(false);
      expect(hasInteractiveFlag(command)).toBe(false);
    });
  });

  describe('flag ordering', () => {
    it('permission mode comes before resume, resume before -i prompt', () => {
      const command = buildCommand({
        permissionMode: 'plan',
        resume: true,
        sessionId: 'sess-1',
        prompt: 'Do something',
      });

      const approvalIndex = command.indexOf('--approval-mode');
      const resumeIndex = command.indexOf('--resume');
      // Match ` -i ` (space-padded) so this never collides with the `-i`
      // substring inside `--session-id` if a future test combines flags.
      const interactiveFlagIndex = command.indexOf(' -i ');
      const promptIndex = command.indexOf(quoteArg('Do something'));

      expect(approvalIndex).toBeLessThan(resumeIndex);
      expect(resumeIndex).toBeLessThan(interactiveFlagIndex);
      expect(interactiveFlagIndex).toBeLessThan(promptIndex);
    });
  });

  describe('interpolateTemplate', () => {
    it('replaces placeholders with values', () => {
      const builder = new QwenCommandBuilder();
      const result = builder.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('replaces multiple occurrences of same placeholder', () => {
      const builder = new QwenCommandBuilder();
      const result = builder.interpolateTemplate(
        '{{name}} is {{name}}',
        { name: 'test' },
      );
      expect(result).toBe('test is test');
    });
  });

  describe('clearSettingsCache', () => {
    it('does not throw', () => {
      const builder = new QwenCommandBuilder();
      expect(() => builder.clearSettingsCache()).not.toThrow();
    });
  });

  describe('git-exclude seeding', () => {
    let tmpDir: string;

    const excludePath = () => path.join(tmpDir, '.git', 'info', 'exclude');
    const sessionFile = (name: string) => path.join(tmpDir, '.kangentic', 'sessions', 's1', name);

    const build = (overrides: Partial<QwenCommandOptions> = {}) =>
      new QwenCommandBuilder().buildQwenCommand(baseOptions({
        cwd: tmpDir,
        projectRoot: tmpDir,
        statusOutputPath: sessionFile('status.json'),
        eventsOutputPath: sessionFile('events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'test-token-abc',
        ...overrides,
      }));

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-exclude-'));
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('seeds .qwen/settings.json and .kangentic/ when Kangentic creates the file', () => {
      build();
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.qwen/settings.json');
      expect(content).toContain('.kangentic/');
    });

    it('never excludes a pre-existing user settings.json (created-by-us carve-out)', () => {
      // Also pins the seed-BEFORE-write ordering: after the build the merged
      // file always exists, so a post-write existence check could never
      // distinguish the user's file from ours.
      fs.mkdirSync(path.join(tmpDir, '.qwen'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.qwen', 'settings.json'),
        JSON.stringify({ mcpServers: { 'user-server': { httpUrl: 'http://example.com/mcp' } } }),
      );
      build();
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).not.toContain('.qwen/settings.json');
      expect(content).toContain('.kangentic/');
    });

    it('seeds nothing when nothing is written', () => {
      build({ mcpServerEnabled: false, statusOutputPath: undefined, eventsOutputPath: undefined });
      expect(fs.existsSync(excludePath())).toBe(false);
    });

    it('an events-only spawn (no MCP) still seeds .qwen/settings.json and .kangentic/', () => {
      build({
        mcpServerEnabled: false,
        mcpServerUrl: undefined,
        mcpServerToken: undefined,
      });
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.qwen/settings.json');
      expect(content).toContain('.kangentic/');
    });

    it('an MCP-only spawn seeds .kangentic/ but not .qwen/settings.json, which it never writes', () => {
      build({ eventsOutputPath: undefined });
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.kangentic/');
      expect(content).not.toContain('.qwen/settings.json');
      expect(fs.existsSync(path.join(tmpDir, '.qwen', 'settings.json'))).toBe(false);
    });
  });

  describe('supportsMcpConfigFlag', () => {
    it.each([
      ['0.15.3', false],
      ['v0.14.1', false],
      ['0.16.0', true],
      ['0.21.7', true],
      ['0.25.2', true],
      ['0.16.0-nightly.20260101', true],
      ['1.0.0', true],
    ] as const)('%s -> %s', (version, expected) => {
      expect(supportsMcpConfigFlag(version)).toBe(expected);
    });

    it('takes the flag when the version is unknown or unreadable', () => {
      expect(supportsMcpConfigFlag(null)).toBe(true);
      expect(supportsMcpConfigFlag(undefined)).toBe(true);
      expect(supportsMcpConfigFlag('')).toBe(true);
      expect(supportsMcpConfigFlag('unknown')).toBe(true);
    });
  });

  /**
   * MCP server config tests touch the filesystem (the session's `mcp.json`,
   * and `createMergedSettings` writes `.qwen/settings.json` into
   * options.cwd), so each test gets a fresh tmpdir as cwd.
   *
   * Qwen 0.20 and later hold every server from `.qwen/settings.json` (scope
   * `workspace`) behind an "Untrusted MCP server" dialog until an approval of
   * its exact config is recorded. Kangentic's URL and token change every
   * spawn, so its server goes through `--mcp-config`, whose servers carry no
   * scope and are never gated.
   */
  describe('MCP server config', () => {
    const MCP_URL = 'http://127.0.0.1:51234/mcp/proj-1';
    let tmpDir: string;
    let sessionDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-mcp-'));
      sessionDir = path.join(tmpDir, '.kangentic', 'sessions', 's1');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function readSettings(): Record<string, unknown> {
      return JSON.parse(fs.readFileSync(path.join(tmpDir, '.qwen', 'settings.json'), 'utf-8'));
    }

    function settingsExists(): boolean {
      return fs.existsSync(path.join(tmpDir, '.qwen', 'settings.json'));
    }

    function mcpConfigPath(): string {
      return path.join(sessionDir, 'mcp.json');
    }

    function readMcpConfig(): { mcpServers: Record<string, Record<string, unknown>> } {
      return JSON.parse(fs.readFileSync(mcpConfigPath(), 'utf-8'));
    }

    function seedUserSettings(mcpServers: Record<string, unknown>): void {
      fs.mkdirSync(path.join(tmpDir, '.qwen'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.qwen', 'settings.json'), JSON.stringify({ mcpServers }, null, 2));
    }

    function buildWithCwd(overrides: Partial<QwenCommandOptions> = {}): string {
      const builder = new QwenCommandBuilder();
      return builder.buildQwenCommand({
        ...baseOptions(),
        cwd: tmpDir,
        projectRoot: tmpDir,
        statusOutputPath: path.join(sessionDir, 'status.json'),
        ...overrides,
      });
    }

    it('hands the kangentic server to --mcp-config as a session file, never as inline JSON', () => {
      const command = buildWithCwd({
        mcpServerEnabled: true,
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });

      expect(command).toContain(`--mcp-config ${quoteArg(toForwardSlash(mcpConfigPath()))}`);
      // The token and URL stay out of argv (process listings show it).
      expect(command).not.toContain('test-token-abc');
      expect(command).not.toContain(MCP_URL);

      const kangentic = readMcpConfig().mcpServers.kangentic;
      // Qwen's native shape: httpUrl is streamable HTTP, a bare `url` would be SSE.
      expect(kangentic).toEqual({ httpUrl: MCP_URL, headers: { 'X-Kangentic-Token': 'test-token-abc' } });
      // No scope key: a scoped server is the one the approval gate holds.
      expect(kangentic.scope).toBeUndefined();
    });

    it('passes --mcp-config on a resume too', () => {
      const command = buildWithCwd({
        resume: true,
        sessionId: 'abc-123',
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });
      expect(command).toContain('--resume');
      expect(command).toContain('--mcp-config');
      expect(fs.existsSync(mcpConfigPath())).toBe(true);
    });

    it('keeps the kangentic entry out of .qwen/settings.json', () => {
      buildWithCwd({
        eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });

      const settings = readSettings();
      expect(settings.hooks).toBeDefined();
      expect(settings.mcpServers).toBeUndefined();
      expect(fs.readFileSync(path.join(tmpDir, '.qwen', 'settings.json'), 'utf-8')).not.toContain('test-token-abc');
    });

    it('writes no settings file for an MCP-only spawn', () => {
      buildWithCwd({ mcpServerUrl: MCP_URL, mcpServerToken: 'token-only' });
      expect(settingsExists()).toBe(false);
      expect(fs.existsSync(mcpConfigPath())).toBe(true);
    });

    it('drops a stale kangentic entry from the baseline and keeps the user servers', () => {
      seedUserSettings({
        kangentic: { httpUrl: 'http://127.0.0.1:40000/mcp/old', headers: { 'X-Kangentic-Token': 'stale-token' } },
        'user-server': { httpUrl: 'http://example.com/mcp', headers: { Authorization: 'Bearer xyz' } },
      });

      buildWithCwd({
        eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'fresh-token',
      });

      const mcpServers = readSettings().mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>;
      expect(mcpServers.kangentic).toBeUndefined();
      expect(mcpServers['user-server'].httpUrl).toBe('http://example.com/mcp');
      expect(mcpServers['user-server'].headers.Authorization).toBe('Bearer xyz');
    });

    it('removes mcpServers when the stale kangentic entry was its only server', () => {
      seedUserSettings({ kangentic: { httpUrl: 'http://127.0.0.1:40000/mcp/old' } });
      buildWithCwd({ eventsOutputPath: path.join(sessionDir, 'events.jsonl') });
      expect(readSettings().mcpServers).toBeUndefined();
    });

    it('leaves a baseline with no kangentic entry as the user wrote it', () => {
      seedUserSettings({});
      buildWithCwd({ eventsOutputPath: path.join(sessionDir, 'events.jsonl') });
      expect(readSettings().mcpServers).toEqual({});
    });

    it('omits --mcp-config when mcpServerEnabled is false', () => {
      const command = buildWithCwd({
        mcpServerEnabled: false,
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });
      expect(command).not.toContain('--mcp-config');
      expect(fs.existsSync(mcpConfigPath())).toBe(false);
    });

    it('omits --mcp-config when the token is missing', () => {
      const command = buildWithCwd({ mcpServerEnabled: true, mcpServerUrl: MCP_URL });
      expect(command).not.toContain('--mcp-config');
      expect(fs.existsSync(mcpConfigPath())).toBe(false);
    });

    it('omits --mcp-config when the url is missing', () => {
      const command = buildWithCwd({ mcpServerEnabled: true, mcpServerToken: 'test-token-abc' });
      expect(command).not.toContain('--mcp-config');
      expect(fs.existsSync(mcpConfigPath())).toBe(false);
    });

    it('mcpServerEnabled defaults to true when undefined', () => {
      const command = buildWithCwd({ mcpServerUrl: MCP_URL, mcpServerToken: 'token-default-on' });
      expect(command).toContain('--mcp-config');
    });

    it('skips the wiring, without throwing, when the build has no session directory', () => {
      const command = buildWithCwd({
        statusOutputPath: undefined,
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });
      expect(command).not.toContain('--mcp-config');
      expect(settingsExists()).toBe(false);
    });

    it('writes mcp.json beside the events file when the build has no status file', () => {
      // The events file sits in its own directory, apart from the default sessionDir,
      // so the path pins `dirname(eventsOutputPath)` and not a coincidence.
      const eventsDir = path.join(tmpDir, '.kangentic', 'sessions', 'events-only');
      const command = buildWithCwd({
        cliVersion: '0.25.2',
        statusOutputPath: undefined,
        eventsOutputPath: path.join(eventsDir, 'events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: MCP_URL,
        mcpServerToken: 'test-token-abc',
      });

      const eventsDirMcpConfig = path.join(eventsDir, 'mcp.json');
      expect(command).toContain(`--mcp-config ${quoteArg(toForwardSlash(eventsDirMcpConfig))}`);
      expect(fs.existsSync(eventsDirMcpConfig)).toBe(true);
      expect(fs.existsSync(mcpConfigPath())).toBe(false);
    });

    it('does not write settings when neither MCP nor events are configured', () => {
      buildWithCwd();
      expect(settingsExists()).toBe(false);
    });

    it('reads the user baseline from projectRoot and writes merged settings to cwd when they differ', () => {
      const projectRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-mcp-root-'));
      try {
        fs.mkdirSync(path.join(projectRootDir, '.qwen'), { recursive: true });
        fs.writeFileSync(
          path.join(projectRootDir, '.qwen', 'settings.json'),
          JSON.stringify({ mcpServers: { 'user-server': { httpUrl: 'http://example.com/mcp' } } }, null, 2),
        );

        // tmpDir (from the outer beforeEach) is the worktree cwd.
        buildWithCwd({
          projectRoot: projectRootDir,
          eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
          mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-99',
          mcpServerToken: 'token-gap3',
        });

        const cwdServers = readSettings().mcpServers as Record<string, { httpUrl: string }>;
        expect(cwdServers['user-server'].httpUrl).toBe('http://example.com/mcp');
        expect(cwdServers.kangentic).toBeUndefined();

        // The user's projectRoot settings.json is never written back to.
        const rootSettings = JSON.parse(
          fs.readFileSync(path.join(projectRootDir, '.qwen', 'settings.json'), 'utf-8'),
        ) as { mcpServers?: Record<string, unknown> };
        expect(rootSettings.mcpServers?.kangentic).toBeUndefined();
        expect(rootSettings.mcpServers?.['user-server']).toBeDefined();
      } finally {
        fs.rmSync(projectRootDir, { recursive: true, force: true });
      }
    });

    describe('a Qwen before 0.16 (no --mcp-config)', () => {
      it('gets the kangentic entry in .qwen/settings.json and no flag', () => {
        const command = buildWithCwd({
          cliVersion: '0.15.3',
          mcpServerUrl: MCP_URL,
          mcpServerToken: 'legacy-token',
        });

        expect(command).not.toContain('--mcp-config');
        expect(fs.existsSync(mcpConfigPath())).toBe(false);
        const mcpServers = readSettings().mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>;
        expect(mcpServers.kangentic).toEqual({ httpUrl: MCP_URL, headers: { 'X-Kangentic-Token': 'legacy-token' } });
      });

      it('a second spawn for the same projectRoot does not carry the first spawn\'s entry from the cache', () => {
        // The cache holds the user's pre-injection snapshot, so the second
        // spawn writes exactly one kangentic entry with its own token.
        seedUserSettings({ 'user-server': { httpUrl: 'http://example.com/mcp' } });
        const builder = new QwenCommandBuilder();
        const legacyOptions = (token: string): QwenCommandOptions => ({
          ...baseOptions(),
          cwd: tmpDir,
          projectRoot: tmpDir,
          cliVersion: '0.15.3',
          mcpServerUrl: MCP_URL,
          mcpServerToken: token,
        });

        builder.buildQwenCommand(legacyOptions('first-token'));
        builder.buildQwenCommand(legacyOptions('second-token'));

        const mcpServers = readSettings().mcpServers as Record<string, { headers?: Record<string, string> }>;
        expect(Object.keys(mcpServers).sort()).toEqual(['kangentic', 'user-server']);
        expect(mcpServers.kangentic.headers?.['X-Kangentic-Token']).toBe('second-token');
      });
    });
  });

  /**
   * On Windows Qwen runs a hook as `%ComSpec% /d /s /c <command>` with Node's
   * normal argument escaping, so every `"` reaches node as part of the path
   * (QWEN_HOOK_SHELL). The command there carries bare tokens only: a copy of the
   * bridge relative to the cwd Qwen runs hooks in, and the events path from the
   * session's environment. On macOS and Linux it is `bash -c` and the paths are
   * quoted.
   */
  describe('event-bridge hook paths', () => {
    let tmpDir: string;
    let projectDirectory: string;
    let eventsOutput: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-hooks-'));
      projectDirectory = path.join(tmpDir, HOOK_PROBE_SEGMENT);
      fs.mkdirSync(projectDirectory, { recursive: true });
      eventsOutput = path.join(projectDirectory, '.kangentic', 'sessions', 's1', 'events.jsonl');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function buildHooksIn(platform: NodeJS.Platform): string[] {
      buildForPlatform(platform, () => new QwenCommandBuilder().buildQwenCommand({
        ...baseOptions(),
        cwd: projectDirectory,
        projectRoot: projectDirectory,
        eventsOutputPath: eventsOutput,
      }));
      const settings = JSON.parse(fs.readFileSync(path.join(projectDirectory, '.qwen', 'settings.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      return Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
    }

    it('on Windows names the workspace bridge copy and the events path from the environment, all bare', () => {
      const commands = buildHooksIn('win32');
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command.startsWith(`node .kangentic/${QWEN_BRIDGE_COPY_NAME} ${EVENTS_PATH_FROM_ENVIRONMENT} `), command).toBe(true);
        expect(command).not.toContain('"');
        expect(command).not.toMatch(CLI_ENVIRONMENT_REFERENCE);
        expect(isKangenticHookCommand(command)).toBe(true);
      }
      const copy = path.join(projectDirectory, '.kangentic', QWEN_BRIDGE_COPY_NAME);
      expect(fs.readFileSync(copy, 'utf-8')).toBe(fs.readFileSync(path.resolve(__dirname, '../../src/main/agent/event-bridge.js'), 'utf-8'));
    });

    it('on Windows a failed bridge copy throws out of buildQwenCommand instead of spawning without hooks', () => {
      // The throw is deliberate: the Windows hook command names the workspace
      // copy, so Qwen cannot run its hooks without it, and the throw reaches
      // spawnAgent's catch, which reports the blocked spawn. Swallowing it would
      // spawn Qwen with a session that reads as permanently idle.
      //
      // The failure is a FILE named .kangentic in the project: the copy cannot
      // create its directory. Nothing earlier in the build touches that path.
      // The git exclude seeding only looks for <cwd>/.git (absent here, and it
      // never throws), and no MCP server is configured, so the copy's mkdir is
      // the first step to reach .kangentic. The control at the end removes the
      // file and shows the same build then succeeds, so the throw is the copy's.
      const kangenticPath = path.join(projectDirectory, '.kangentic');
      const settingsPath = path.join(projectDirectory, '.qwen', 'settings.json');
      const buildOnWindows = (): string => buildForPlatform('win32', () => new QwenCommandBuilder().buildQwenCommand({
        ...baseOptions(),
        cwd: projectDirectory,
        projectRoot: projectDirectory,
        eventsOutputPath: eventsOutput,
      }));
      fs.writeFileSync(kangenticPath, 'a file, not a directory');

      expect(buildOnWindows).toThrow(/\.kangentic/);
      expect(fs.statSync(kangenticPath).isFile()).toBe(true);
      expect(fs.existsSync(settingsPath)).toBe(false);

      fs.rmSync(kangenticPath);
      expect(buildOnWindows).not.toThrow();
      expect(fs.existsSync(settingsPath)).toBe(true);
    });

    it('on macOS and Linux quotes the real paths, leaving no $NAME for Qwen to replace', () => {
      const commands = buildHooksIn('linux');
      for (const command of commands) {
        expect(command).toContain(`'$'"KNG_PROBE`);
        expect(command).not.toMatch(CLI_ENVIRONMENT_REFERENCE);
        expect(isKangenticHookCommand(command)).toBe(true);
      }
      expect(fs.existsSync(path.join(projectDirectory, '.kangentic', QWEN_BRIDGE_COPY_NAME))).toBe(false);
    });

    // The launch Qwen was measured to make, and Git Bash for a Qwen started
    // from an MSYS shell, with the real bridge copy writing the real events file.
    it.runIf(process.platform === 'win32')('a Windows hook writes its event through escaped cmd and Git Bash', () => {
      const preToolUse = buildHooksIn('win32').find((command) => command.includes(' tool_start '));
      expect(preToolUse).toBeDefined();
      const hosts: HookShellHost[] = ['cmd-escaped', ...installedShOrPowerShellHosts()];
      for (const host of hosts) {
        fs.rmSync(eventsOutput, { force: true });
        fs.mkdirSync(path.dirname(eventsOutput), { recursive: true });
        runAsHookShell(host, preToolUse!, {
          cwd: projectDirectory,
          input: JSON.stringify({ tool_name: 'read_file', tool_input: { file_path: 'a.ts' } }),
          env: { KANGENTIC_EVENTS_PATH: eventsOutput },
        });
        expect(fs.readFileSync(eventsOutput, 'utf-8'), host).toContain('"tool_start"');
      }
    }, 120_000);
  });

  /**
   * The background shell hint (task #859) names kangentic_mark_background_service,
   * so only a session offered that tool gets the hook: the MCP server on (not
   * switched off), a token, and an MCP URL that names a task session as its
   * caller (`/mcp/<project>/<session>`). On Windows the hint runs from a
   * workspace copy of its bridge, as the event bridge does, and that copy is
   * written only for a session that gets the hint.
   */
  describe('background shell hint', () => {
    const HINT_HOOK_NAME = 'kangentic-background-shell-hint';
    const SESSION_MCP_URL = 'http://127.0.0.1:51234/mcp/proj-1/sess-abc';
    let tmpDir: string;
    let eventsOutput: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-hint-'));
      eventsOutput = path.join(tmpDir, '.kangentic', 'sessions', 's1', 'events.jsonl');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function buildOn(platform: NodeJS.Platform, overrides: Partial<QwenCommandOptions>): void {
      buildForPlatform(platform, () => new QwenCommandBuilder().buildQwenCommand({
        ...baseOptions(),
        cwd: tmpDir,
        projectRoot: tmpDir,
        eventsOutputPath: eventsOutput,
        ...overrides,
      }));
    }

    function postToolUseEntries(): Array<{ matcher: string; hooks: Array<{ name: string; command: string }> }> {
      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.qwen', 'settings.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ name: string; command: string }> }>>;
      };
      return settings.hooks.PostToolUse;
    }

    function hintCommands(): string[] {
      return postToolUseEntries().flatMap((entry) => entry.hooks).filter((hook) => hook.name === HINT_HOOK_NAME).map((hook) => hook.command);
    }

    /** The hint spec the command carries: its last token is the base64 of the JSON spec. */
    function decodedSpec(command: string): unknown {
      const encodedSpec = command.split(' ').pop() ?? '';
      return JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
    }

    it.each([true, undefined])('wires the hint, built from the Qwen spec, for a session URL and a token (mcpServerEnabled %s)', (mcpServerEnabled) => {
      buildOn('linux', { mcpServerEnabled, mcpServerUrl: SESSION_MCP_URL, mcpServerToken: 'token-abc' });

      const commands = hintCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].startsWith('node ')).toBe(true);
      expect(commands[0]).toContain('background-shell-hint-bridge');
      expect(decodedSpec(commands[0])).toEqual(backgroundShellHintSpecOf(QWEN_BACKGROUND_COMMAND_SPEC));
      // Beside the event bridge's entry, not in place of it.
      expect(postToolUseEntries()).toHaveLength(2);
    });

    it.each([
      ['a project URL that names no session', { mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1', mcpServerToken: 'token-abc' }],
      ['a Knowledge Graph answer run URL', { mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1/answer-chat-1', mcpServerToken: 'token-abc' }],
      ['a workflow agent URL', { mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1/workflow-wf-1', mcpServerToken: 'token-abc' }],
      ['no URL', { mcpServerUrl: undefined, mcpServerToken: 'token-abc' }],
      ['no token', { mcpServerUrl: SESSION_MCP_URL, mcpServerToken: undefined }],
      ['the MCP server switched off', { mcpServerEnabled: false, mcpServerUrl: SESSION_MCP_URL, mcpServerToken: 'token-abc' }],
    ] as Array<[string, Partial<QwenCommandOptions>]>)('wires no hint with %s, leaving the event bridge entry alone', (_label, overrides) => {
      buildOn('linux', overrides);

      expect(hintCommands()).toEqual([]);
      const entries = postToolUseEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].hooks[0].command).toContain('event-bridge');
    });

    it('on Windows runs the hint from the workspace bridge copy by a bare relative path', () => {
      buildOn('win32', { mcpServerUrl: SESSION_MCP_URL, mcpServerToken: 'token-abc' });

      const copy = path.join(tmpDir, '.kangentic', QWEN_HINT_BRIDGE_COPY_NAME);
      expect(fs.readFileSync(copy, 'utf-8')).toBe(fs.readFileSync(path.resolve(__dirname, '../../src/main/agent/background-shell-hint-bridge.js'), 'utf-8'));

      const commands = hintCommands();
      expect(commands).toHaveLength(1);
      // `node <relative forward-slashed copy> <base64 spec>`, three bare tokens.
      const [nodeBinary, bridgePath, encodedSpec, ...rest] = commands[0].split(' ');
      expect(rest).toEqual([]);
      expect(nodeBinary).toBe('node');
      expect(bridgePath).toBe(`.kangentic/${QWEN_HINT_BRIDGE_COPY_NAME}`);
      expect(JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'))).toEqual(backgroundShellHintSpecOf(QWEN_BACKGROUND_COMMAND_SPEC));
      expect(commands[0]).not.toContain('"');
      expect(commands[0]).not.toContain('\\');
      expect(isKangenticHookCommand(commands[0])).toBe(true);
    });

    it('on Windows copies the hint bridge only for a session offered the tool', () => {
      buildOn('win32', { mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1', mcpServerToken: 'token-abc' });

      expect(hintCommands()).toEqual([]);
      // The event bridge copy shows the Windows path ran.
      expect(fs.existsSync(path.join(tmpDir, '.kangentic', QWEN_BRIDGE_COPY_NAME))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.kangentic', QWEN_HINT_BRIDGE_COPY_NAME))).toBe(false);
    });
  });

  // ── Multiline prompt preservation (regression guard) ─────────────────────
  // Regression guard: `{ multiline: true }` must be passed to quoteArg so
  // multi-line XML task envelopes survive shell delivery under bash.

  describe('multiline XML prompt under bash', () => {
    it('preserves newlines in the built command when shell is bash', () => {
      const xml = '<task>\n  <title>Fix login</title>\n  <description>\nStep 1.\n\nStep 2.\n  </description>\n</task>';
      const command = buildCommand({ prompt: xml, shell: 'bash' });
      expect(command).toContain('\n  <title>Fix login</title>');
    });
  });
});
