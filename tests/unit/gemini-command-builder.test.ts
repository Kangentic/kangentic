/**
 * Unit tests for GeminiCommandBuilder - verifies flag mapping,
 * permission modes, session resume, prompt delivery, and template
 * interpolation.
 *
 * Uses an inline test helper to avoid merged settings / hook injection
 * side effects (same pattern as command-builder.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quoteArg } from '../../src/shared/paths';
import { GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini';
import { removeHooks } from '../../src/main/agent/adapters/gemini/hook-manager';
import type { GeminiCommandOptions } from '../../src/main/agent/adapters/gemini';

/** Minimal options for tests that don't need hooks/settings. */
function baseOptions(overrides: Partial<GeminiCommandOptions> = {}): GeminiCommandOptions {
  return {
    geminiPath: '/usr/bin/gemini',
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
function buildCommand(overrides: Partial<GeminiCommandOptions> = {}): string {
  const builder = new GeminiCommandBuilder();
  return builder.buildGeminiCommand(baseOptions(overrides));
}

describe('GeminiCommandBuilder', () => {
  describe('basic command', () => {
    it('produces gemini path as first argument', () => {
      const command = buildCommand();
      expect(command).toBe('/usr/bin/gemini');
    });

    it('quotes gemini path with spaces', () => {
      const command = buildCommand({ geminiPath: '/path with spaces/gemini' });
      expect(command).toContain(quoteArg('/path with spaces/gemini'));
    });
  });

  describe('Kangentic MCP wiring', () => {
    const URL = 'http://127.0.0.1:5555/mcp/project-123/sess-xyz';
    const TOKEN = 'secret-token';
    let tmpDir: string;

    const settingsFile = () => path.join(tmpDir, '.gemini', 'settings.json');
    const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));

    const build = (overrides: Partial<GeminiCommandOptions> = {}) =>
      new GeminiCommandBuilder().buildGeminiCommand(baseOptions({
        cwd: tmpDir,
        mcpServerEnabled: true,
        mcpServerUrl: URL,
        mcpServerToken: TOKEN,
        ...overrides,
      }));

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-gemini-mcp-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes an mcpServers.kangentic entry using the Gemini-fork httpUrl key', () => {
      // Verified against gemini 0.54.4: `httpUrl` + `headers` connects.
      // Claude's `url` convention is NOT the Gemini-family spelling.
      build();
      expect(readSettings().mcpServers).toEqual({
        kangentic: {
          httpUrl: URL,
          headers: { 'X-Kangentic-Token': TOKEN },
        },
      });
    });

    it('writes the settings file for an MCP-only spawn with no eventsOutputPath', () => {
      // Regression: createMergedSettings used to be gated on eventsOutputPath
      // alone and returned early without it, so MCP config was never written.
      build();
      expect(fs.existsSync(settingsFile())).toBe(true);
    });

    it('preserves user-defined mcpServers alongside the kangentic entry', () => {
      fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
      fs.writeFileSync(
        settingsFile(),
        JSON.stringify({ mcpServers: { context7: { httpUrl: 'http://example.test/mcp' } } }),
      );
      // projectRoot is where base settings are READ from.
      build({ projectRoot: tmpDir });
      const written = readSettings().mcpServers;
      expect(written.context7).toEqual({ httpUrl: 'http://example.test/mcp' });
      expect(written.kangentic).toBeDefined();
    });

    it('omits the entry when mcpServerEnabled is false', () => {
      build({ mcpServerEnabled: false });
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('omits the entry when the url or token is missing', () => {
      build({ mcpServerUrl: undefined });
      expect(fs.existsSync(settingsFile())).toBe(false);
      build({ mcpServerToken: undefined });
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('removeHooks strips the entry so no token is left on disk', () => {
      build();
      expect(fs.readFileSync(settingsFile(), 'utf-8')).toContain(TOKEN);
      removeHooks(tmpDir);
      // With nothing else in it the whole file is removed; if a user had
      // other settings it survives, minus our entry. Either way the token
      // must be gone.
      const remaining = fs.existsSync(settingsFile())
        ? fs.readFileSync(settingsFile(), 'utf-8')
        : '';
      expect(remaining).not.toContain(TOKEN);
    });

    it('removeHooks leaves user-defined mcpServers intact', () => {
      fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
      fs.writeFileSync(
        settingsFile(),
        JSON.stringify({ mcpServers: { context7: { httpUrl: 'http://example.test/mcp' } } }),
      );
      build({ projectRoot: tmpDir });
      removeHooks(tmpDir);
      expect(readSettings().mcpServers).toEqual({
        context7: { httpUrl: 'http://example.test/mcp' },
      });
    });
  });

  describe('git-exclude seeding', () => {
    let tmpDir: string;

    const excludePath = () => path.join(tmpDir, '.git', 'info', 'exclude');

    const build = (overrides: Partial<GeminiCommandOptions> = {}) =>
      new GeminiCommandBuilder().buildGeminiCommand(baseOptions({
        cwd: tmpDir,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123/sess-xyz',
        mcpServerToken: 'secret-token',
        ...overrides,
      }));

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-gemini-exclude-'));
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('seeds .gemini/settings.json and .kangentic/ when Kangentic creates the file', () => {
      build();
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.gemini/settings.json');
      expect(content).toContain('.kangentic/');
    });

    it('never excludes a pre-existing user settings.json (created-by-us carve-out)', () => {
      // Also pins the seed-BEFORE-write ordering: after the build the merged
      // file always exists, so a post-write existence check could never
      // distinguish the user's file from ours.
      fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.gemini', 'settings.json'),
        JSON.stringify({ mcpServers: { context7: { httpUrl: 'http://example.test/mcp' } } }),
      );
      build({ projectRoot: tmpDir });
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).not.toContain('.gemini/settings.json');
      expect(content).toContain('.kangentic/');
    });

    it('seeds nothing when no settings write happens', () => {
      build({ mcpServerEnabled: false });
      expect(fs.existsSync(excludePath())).toBe(false);
    });

    it('an events-only spawn (no MCP) still seeds .gemini/settings.json and .kangentic/', () => {
      // shouldWriteMergedSettings / seedGitExcludes are OR-gated on
      // eventsOutputPath OR mcp wiring - either alone must trigger seeding.
      // Regression guard against the two conditions drifting apart.
      build({
        mcpServerEnabled: false,
        mcpServerUrl: undefined,
        mcpServerToken: undefined,
        eventsOutputPath: path.join(tmpDir, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      });
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.gemini/settings.json');
      expect(content).toContain('.kangentic/');
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

    it('acceptEdits maps to --approval-mode auto_edit', () => {
      const command = buildCommand({ permissionMode: 'acceptEdits' });
      expect(command).toContain('--approval-mode auto_edit');
    });

    it('auto maps to --approval-mode auto_edit', () => {
      const command = buildCommand({ permissionMode: 'auto' });
      expect(command).toContain('--approval-mode auto_edit');
    });

    it('bypassPermissions maps to --approval-mode yolo', () => {
      const command = buildCommand({ permissionMode: 'bypassPermissions' });
      expect(command).toContain('--approval-mode yolo');
    });
  });

  describe('session resume', () => {
    it('resume with sessionId produces --resume flag', () => {
      const command = buildCommand({ resume: true, sessionId: 'abc-123' });
      expect(command).toContain('--resume');
      expect(command).toContain('abc-123');
    });

    it('new session (resume=false) produces no session flag', () => {
      const command = buildCommand({ resume: false, sessionId: 'abc-123' });
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
      expect(command).not.toContain('abc-123');
    });

    it('resume without sessionId produces no flag', () => {
      const command = buildCommand({ resume: true });
      expect(command).not.toContain('--resume');
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
      expect(command).toBe('/usr/bin/gemini');
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
      const builder = new GeminiCommandBuilder();
      const result = builder.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('replaces multiple occurrences of same placeholder', () => {
      const builder = new GeminiCommandBuilder();
      const result = builder.interpolateTemplate(
        '{{name}} is {{name}}',
        { name: 'test' },
      );
      expect(result).toBe('test is test');
    });
  });

  describe('clearSettingsCache', () => {
    it('does not throw', () => {
      const builder = new GeminiCommandBuilder();
      expect(() => builder.clearSettingsCache()).not.toThrow();
    });
  });

  // ── Multiline prompt preservation (regression guard) ─────────────────────
  // Regression guard: `{ multiline: true }` must be passed to quoteArg on the
  // prompt arg so multi-line XML task envelopes survive shell delivery under
  // bash. If the option is dropped, the prompt is sanitized to a single line.

  describe('multiline XML prompt under bash', () => {
    it('preserves newlines in the built command when shell is bash', () => {
      const xml = '<task>\n  <title>Fix login</title>\n  <description>\nStep 1.\n\nStep 2.\n  </description>\n</task>';
      const command = buildCommand({ prompt: xml, shell: 'bash' });
      expect(command).toContain('\n  <title>Fix login</title>');
    });
  });
});
