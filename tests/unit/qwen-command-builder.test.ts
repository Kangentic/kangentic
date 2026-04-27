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
import { quoteArg } from '../../src/shared/paths';
import { QwenCommandBuilder } from '../../src/main/agent/adapters/qwen-code';
import type { QwenCommandOptions } from '../../src/main/agent/adapters/qwen-code';

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
    it('interactive prompt is a positional argument', () => {
      const command = buildCommand({ prompt: 'Fix the bug' });
      expect(command).toContain(quoteArg('Fix the bug'));
      expect(command).not.toContain('-p');
    });

    it('non-interactive prompt uses -p flag', () => {
      const command = buildCommand({ nonInteractive: true, prompt: 'Fix the bug' });
      expect(command).toContain('-p');
      expect(command).toContain(quoteArg('Fix the bug'));
    });

    it('no prompt produces no positional argument', () => {
      const command = buildCommand();
      expect(command).toBe('/usr/bin/qwen');
    });

    it('non-interactive without prompt produces no -p flag', () => {
      const command = buildCommand({ nonInteractive: true });
      expect(command).not.toContain('-p');
    });
  });

  describe('flag ordering', () => {
    it('permission mode comes before resume and prompt', () => {
      const command = buildCommand({
        permissionMode: 'plan',
        resume: true,
        sessionId: 'sess-1',
        prompt: 'Do something',
      });

      const approvalIndex = command.indexOf('--approval-mode');
      const resumeIndex = command.indexOf('--resume');
      const promptIndex = command.indexOf(quoteArg('Do something'));

      expect(approvalIndex).toBeLessThan(resumeIndex);
      expect(resumeIndex).toBeLessThan(promptIndex);
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

  /**
   * MCP server config tests touch the filesystem (`createMergedSettings`
   * writes `.qwen/settings.json` into options.cwd), so each test gets a
   * fresh tmpdir as cwd.
   */
  describe('MCP server config', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-mcp-'));
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

    function buildWithCwd(overrides: Partial<QwenCommandOptions> = {}): void {
      const builder = new QwenCommandBuilder();
      builder.buildQwenCommand({
        ...baseOptions(),
        cwd: tmpDir,
        projectRoot: tmpDir,
        ...overrides,
      });
    }

    it('writes mcpServers.kangentic with httpUrl and X-Kangentic-Token header', () => {
      buildWithCwd({
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'test-token-abc',
      });

      const settings = readSettings();
      const mcpServers = settings.mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>;
      expect(mcpServers.kangentic).toBeDefined();
      expect(mcpServers.kangentic.httpUrl).toBe('http://127.0.0.1:51234/mcp/proj-1');
      expect(mcpServers.kangentic.headers['X-Kangentic-Token']).toBe('test-token-abc');
    });

    it('omits mcpServers entirely when mcpServerEnabled is false', () => {
      buildWithCwd({
        eventsOutputPath: path.join(tmpDir, 'events.jsonl'),
        mcpServerEnabled: false,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'test-token-abc',
      });

      const settings = readSettings();
      expect(settings.mcpServers).toBeUndefined();
    });

    it('omits mcpServers when token is missing', () => {
      buildWithCwd({
        eventsOutputPath: path.join(tmpDir, 'events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        // mcpServerToken intentionally missing
      });

      expect(settingsExists()).toBe(true);
      const settings = readSettings();
      expect(settings.mcpServers).toBeUndefined();
    });

    it('omits mcpServers when url is missing', () => {
      buildWithCwd({
        eventsOutputPath: path.join(tmpDir, 'events.jsonl'),
        mcpServerEnabled: true,
        // mcpServerUrl intentionally missing
        mcpServerToken: 'test-token-abc',
      });

      expect(settingsExists()).toBe(true);
      const settings = readSettings();
      expect(settings.mcpServers).toBeUndefined();
    });

    it('preserves user-defined mcpServers alongside the kangentic entry', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'user-server': { httpUrl: 'http://example.com/mcp', headers: { Authorization: 'Bearer xyz' } },
          },
        }, null, 2),
      );

      buildWithCwd({
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'fresh-token',
      });

      const settings = readSettings();
      const mcpServers = settings.mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>;
      expect(mcpServers['user-server']).toBeDefined();
      expect(mcpServers['user-server'].httpUrl).toBe('http://example.com/mcp');
      expect(mcpServers.kangentic).toBeDefined();
      expect(mcpServers.kangentic.httpUrl).toBe('http://127.0.0.1:51234/mcp/proj-1');
      expect(mcpServers.kangentic.headers['X-Kangentic-Token']).toBe('fresh-token');
    });

    it('writes settings file when only MCP is configured (no events output)', () => {
      buildWithCwd({
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'token-only',
        // eventsOutputPath intentionally missing
      });

      expect(settingsExists()).toBe(true);
      const settings = readSettings();
      expect(settings.hooks).toBeUndefined();
      const mcpServers = settings.mcpServers as Record<string, { httpUrl: string }>;
      expect(mcpServers.kangentic.httpUrl).toBe('http://127.0.0.1:51234/mcp/proj-1');
    });

    it('does not write settings when neither MCP nor events are configured', () => {
      buildWithCwd();
      expect(settingsExists()).toBe(false);
    });

    it('mcpServerEnabled defaults to true when undefined', () => {
      buildWithCwd({
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'token-default-on',
      });

      const settings = readSettings();
      const mcpServers = settings.mcpServers as Record<string, unknown>;
      expect(mcpServers.kangentic).toBeDefined();
    });

    it('gap-3: reads user baseline from projectRoot, writes merged settings to cwd when they differ', () => {
      // Two separate tmpdirs: one is the project root (where the user's
      // .qwen/settings.json lives) and one is a worktree cwd (where the
      // merged result must be written). This exercises the two-directory
      // split that is currently untested for the MCP path.
      const projectRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cmd-mcp-root-'));
      try {
        // Seed the user's baseline in projectRoot - a user-defined MCP
        // server that must survive the merge.
        const projectQwenDir = path.join(projectRootDir, '.qwen');
        fs.mkdirSync(projectQwenDir, { recursive: true });
        fs.writeFileSync(
          path.join(projectQwenDir, 'settings.json'),
          JSON.stringify({
            mcpServers: {
              'user-server': { httpUrl: 'http://example.com/mcp' },
            },
          }, null, 2),
        );

        // tmpDir (from the outer beforeEach) is the worktree cwd.
        const builder = new QwenCommandBuilder();
        builder.buildQwenCommand({
          ...baseOptions(),
          cwd: tmpDir,
          projectRoot: projectRootDir,
          mcpServerEnabled: true,
          mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-99',
          mcpServerToken: 'token-gap3',
        });

        // Merged file must be written to cwd (tmpDir), not to projectRoot.
        expect(settingsExists()).toBe(true);
        expect(
          fs.existsSync(path.join(projectRootDir, '.qwen', 'settings.json')),
        ).toBe(true);

        // cwd settings contains both the user-server (from projectRoot
        // baseline) and the injected kangentic entry.
        const cwdSettings = readSettings();
        const mcpServers = cwdSettings.mcpServers as Record<string, { httpUrl: string }>;
        expect(mcpServers['user-server']).toBeDefined();
        expect(mcpServers['user-server'].httpUrl).toBe('http://example.com/mcp');
        expect(mcpServers.kangentic).toBeDefined();
        expect(mcpServers.kangentic.httpUrl).toBe('http://127.0.0.1:51234/mcp/proj-99');

        // The user's projectRoot settings.json must remain untouched - no
        // kangentic injection written back into the source file.
        const rootSettings = JSON.parse(
          fs.readFileSync(path.join(projectRootDir, '.qwen', 'settings.json'), 'utf-8'),
        ) as { mcpServers?: Record<string, unknown> };
        expect(rootSettings.mcpServers?.kangentic).toBeUndefined();
        expect(rootSettings.mcpServers?.['user-server']).toBeDefined();
      } finally {
        fs.rmSync(projectRootDir, { recursive: true, force: true });
      }
    });

    it('gap-4: second buildQwenCommand for the same projectRoot does not see first spawn\'s mcpServers.kangentic in baseline', () => {
      // Two sequential spawns with MCP options for the same projectRoot
      // (tmpDir). The cache must store the user's pre-injection snapshot
      // so the second spawn does not inherit the first spawn's injected
      // kangentic entry in its baseSettings.
      //
      // If the cache stored the merged result instead of the original
      // baseline, readBaseSettings() on the second call would return an
      // object that already contains mcpServers.kangentic, and the
      // spread in createMergedSettings would carry it forward - producing
      // a second kangentic key or stale token.
      //
      // To make the cache-vs-disk distinction visible, we seed the user
      // baseline BEFORE the first spawn so the cache captures it. After
      // the first spawn, the merged file on disk contains kangentic. The
      // second spawn must NOT read kangentic back from disk - it must use
      // the cached snapshot (user-server only).

      // Seed user baseline in projectRoot before any spawn.
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'user-server': { httpUrl: 'http://example.com/mcp' },
          },
        }, null, 2),
      );

      const builder = new QwenCommandBuilder();

      // First spawn - cache is populated from the file above (user-server
      // only). Merged result written to disk: user-server + kangentic.
      builder.buildQwenCommand({
        ...baseOptions(),
        cwd: tmpDir,
        projectRoot: tmpDir,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'first-token',
      });

      // Second spawn with a rotated token on the same builder instance
      // (same cache). readBaseSettings returns the cached snapshot
      // (user-server only, no kangentic). The merge overwrites the disk
      // file with: user-server + kangentic(second-token).
      builder.buildQwenCommand({
        ...baseOptions(),
        cwd: tmpDir,
        projectRoot: tmpDir,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
        mcpServerToken: 'second-token',
      });

      const settings = readSettings();
      const mcpServers = settings.mcpServers as Record<string, { httpUrl: string; headers: Record<string, string> }>;

      // Exactly one kangentic entry - the first-spawn entry must not
      // bleed through the cache and produce a duplicate.
      expect(Object.keys(mcpServers).filter((key) => key === 'kangentic')).toHaveLength(1);

      // The entry carries the second spawn's token, not the first.
      expect(mcpServers.kangentic.headers['X-Kangentic-Token']).toBe('second-token');

      // User server preserved from the original snapshot.
      expect(mcpServers['user-server']).toBeDefined();
    });
  });
});
