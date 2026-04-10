/**
 * Unit tests for CodexAdapter - command building, permission mapping,
 * hook management, event parsing, and template interpolation.
 *
 * These test the adapter's public API which exercises the internal
 * buildCodexCommand, mapPermissionMode, buildHooks, and
 * removeHooks functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { CodexSessionHistoryParser } from '../../src/main/agent/adapters/codex/session-history-parser';
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

    it("maps 'default' to --sandbox workspace-write --ask-for-approval untrusted", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'default' }));
      expect(command).toContain('--sandbox workspace-write');
      expect(command).toContain('--ask-for-approval untrusted');
    });

    it("maps 'acceptEdits' to --full-auto", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'acceptEdits' }));
      expect(command).toContain('--full-auto');
    });

    it("maps 'auto' to --full-auto", () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'auto' }));
      expect(command).toContain('--full-auto');
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
    it('is a no-op (resolves without error)', async () => {
      await expect(adapter.ensureTrust('/some/path')).resolves.toBeUndefined();
    });
  });

  describe('clearSettingsCache', () => {
    it('is a no-op (does not throw)', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
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

    it('returns null when hookContext has no thread ID fields', () => {
      const hookContext = JSON.stringify({ session_id: 'not-a-thread' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(adapter.runtime.sessionId!.fromHook!('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(adapter.runtime.sessionId!.fromHook!('')).toBeNull();
    });
  });
});
