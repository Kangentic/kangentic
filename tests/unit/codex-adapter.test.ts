/**
 * Unit tests for CodexAdapter - command building, permission mapping,
 * hook management, event parsing, and template interpolation.
 *
 * These test the adapter's public API which exercises the internal
 * buildCodexCommand, mapPermissionMode, writeCodexHooks, and
 * stripCodexHooks functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

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
    it('builds basic command with working directory and approval mode', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('/usr/bin/codex');
      expect(command).toContain('-C');
      expect(command).toContain('/home/dev/project');
      expect(command).toContain('--approval-mode');
      expect(command).toContain('suggest');
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

    it('resume command does not include approval mode', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        permissionMode: 'bypassPermissions',
      }));
      expect(command).not.toContain('--approval-mode');
      expect(command).not.toContain('--full-auto');
    });

    it('resume command omits prompt even if provided', () => {
      const command = adapter.buildCommand(makeOptions({
        resume: true,
        sessionId: 'sess-abc-123',
        prompt: 'this should be ignored',
      }));
      expect(command).not.toContain('this should be ignored');
    });
  });

  describe('buildCommand - permission mode mapping', () => {
    const permissionCases: Array<{ mode: PermissionMode; expectedFlag: string }> = [
      { mode: 'default', expectedFlag: 'suggest' },
      { mode: 'plan', expectedFlag: 'suggest' },
      { mode: 'dontAsk', expectedFlag: 'suggest' },
      { mode: 'acceptEdits', expectedFlag: 'auto-edit' },
      { mode: 'auto', expectedFlag: 'auto-edit' },
      { mode: 'bypassPermissions', expectedFlag: 'full-auto' },
    ];

    for (const { mode, expectedFlag } of permissionCases) {
      it(`maps '${mode}' to '--approval-mode ${expectedFlag}'`, () => {
        const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
        expect(command).toContain(`--approval-mode ${expectedFlag}`);
      });
    }
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

    it('writes hooks.json when eventsOutputPath is provided', () => {
      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      const hooksFile = path.join(tempDir, '.codex', 'hooks.json');
      expect(fs.existsSync(hooksFile)).toBe(true);

      const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
      expect(Array.isArray(hooks)).toBe(true);
      expect(hooks.length).toBe(5); // SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop

      // Verify hook event names
      const eventNames = hooks.map((hook: { event: string }) => hook.event);
      expect(eventNames).toContain('SessionStart');
      expect(eventNames).toContain('UserPromptSubmit');
      expect(eventNames).toContain('PreToolUse');
      expect(eventNames).toContain('PostToolUse');
      expect(eventNames).toContain('Stop');

      // Each hook should have a command referencing event-bridge
      for (const hook of hooks) {
        expect(hook.command).toContain('event-bridge');
        expect(hook.timeout_secs).toBe(10);
      }
    });

    it('does not write hooks.json when eventsOutputPath is omitted', () => {
      adapter.buildCommand(makeOptions({ cwd: tempDir }));
      const hooksFile = path.join(tempDir, '.codex', 'hooks.json');
      expect(fs.existsSync(hooksFile)).toBe(false);
    });

    it('preserves existing user hooks when writing', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'PreToolUse', command: 'echo user-hook', timeout_secs: 5 };
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify([userHook]));

      const eventsPath = path.join(tempDir, '.kangentic', 'sessions', 'task-001', 'events.jsonl');
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        eventsOutputPath: eventsPath,
      }));

      const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
      // User hook should be preserved + 5 Kangentic hooks
      expect(hooks.length).toBe(6);
      expect(hooks[0]).toEqual(userHook);
    });

    it('replaces stale Kangentic hooks on re-write', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      // Simulate stale Kangentic hook from a previous session
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

      const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
      // Stale hook should be replaced, not duplicated
      expect(hooks.length).toBe(5);
    });

    it('stripHooks removes Kangentic entries and preserves user hooks', () => {
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

      adapter.stripHooks(tempDir);

      const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
      expect(hooks.length).toBe(1);
      expect(hooks[0]).toEqual(userHook);
    });

    it('stripHooks removes file when only Kangentic hooks remain', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const kangenticHook = {
        event: 'PreToolUse',
        command: 'node "/path/.kangentic/event-bridge.js" "/events.jsonl" tool_start',
        timeout_secs: 10,
      };
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify([kangenticHook]));

      adapter.stripHooks(tempDir);

      expect(fs.existsSync(path.join(codexDir, 'hooks.json'))).toBe(false);
    });

    it('stripHooks is a no-op when hooks.json does not exist', () => {
      // Should not throw
      adapter.stripHooks(tempDir);
    });

    it('stripHooks is a no-op when no Kangentic hooks present', () => {
      const codexDir = path.join(tempDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const userHook = { event: 'Stop', command: 'echo done', timeout_secs: 5 };
      const original = JSON.stringify([userHook], null, 2);
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), original);

      adapter.stripHooks(tempDir);

      // File should be unchanged
      expect(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe(original);
    });
  });

  describe('parseEvent', () => {
    it('parses valid JSONL event', () => {
      const event = adapter.parseEvent('{"ts":1234567890,"type":"tool_start","tool":"Bash"}');
      expect(event).toEqual({ ts: 1234567890, type: 'tool_start', tool: 'Bash' });
    });

    it('returns null for invalid JSON', () => {
      expect(adapter.parseEvent('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(adapter.parseEvent('')).toBeNull();
    });
  });

  describe('parseStatus', () => {
    it('always returns null (Codex has no statusLine)', () => {
      expect(adapter.parseStatus('{"anything": true}')).toBeNull();
      expect(adapter.parseStatus('')).toBeNull();
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
    it('is a no-op (resolves without error)', async () => {
      await expect(adapter.ensureTrust('/some/path')).resolves.toBeUndefined();
    });
  });

  describe('clearSettingsCache', () => {
    it('is a no-op (does not throw)', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
    });
  });
});
