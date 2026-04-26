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
import { describe, it, expect } from 'vitest';
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
});
