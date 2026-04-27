/**
 * Qwen Code adapter - end-to-end integration harness.
 *
 * Heavyweight integration test that wires every layer of the Qwen
 * adapter together against a real `child_process.spawn` of the mock
 * Qwen CLI fixture. Unlike the per-component unit tests, this file:
 *
 *   1. Looks up the adapter through the actual `agentRegistry` singleton
 *      (proves registration is wired up).
 *   2. Runs the real `QwenDetector.detect()` against the mock CLI shim
 *      (proves --version parsing).
 *   3. Asserts each command-builder permission/resume/prompt branch
 *      formats the documented flags into the rendered command string.
 *   4. Spawns the mock CLI directly with argv it would receive after a
 *      successful shell parse (no shell layer involved - the unit tests
 *      already cover quoting), passes a caller-owned UUID via
 *      `--session-id`, asserts the mock wrote the JSONL at the path
 *      our adapter expects, then resumes that exact UUID via `--resume`.
 *   5. Exercises hook injection (writes to .qwen/settings.json) and
 *      cleanup (refcount-aware removeHooks) on real on-disk files using
 *      a kangentic-style path so the `isKangenticHookCommand` filter
 *      correctly identifies our entries.
 *   6. Confirms the activity detector and PTY output regex against
 *      realistic TUI byte streams.
 *
 * The harness sets MOCK_QWEN_KEEP_SESSION_FILE=1 so the mock does not
 * delete its session JSON when /quit lands - the test reads it after
 * the child exits and cleans up itself in afterEach.
 *
 * Run locally:
 *   npx vitest run tests/unit/qwen-integration.test.ts
 *
 * The harness is self-contained: every artifact lives under a fresh
 * mkdtemp sandbox plus a sandbox-scoped ~/.qwen/tmp/<basename>/
 * directory, deleted in afterEach so reruns are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import {
  QwenAdapter,
  QwenCommandBuilder,
  QwenDetector,
  buildHooks,
  removeHooks,
} from '../../src/main/agent/adapters/qwen-code';
import {
  QwenSessionHistoryParser,
  qwenChatsDir,
} from '../../src/main/agent/adapters/qwen-code/session-history-parser';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MOCK_QWEN_JS = path.join(REPO_ROOT, 'tests', 'fixtures', 'mock-qwen.js');
const MOCK_QWEN_CMD = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'tests', 'fixtures', 'mock-qwen.cmd')
  : MOCK_QWEN_JS;

interface SpawnResult {
  stdout: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Run `node mock-qwen.js <argv>` and resolve once the process exits.
 *
 * The mock prints its markers within ~10ms of spawn, then idles waiting
 * for stdin. Once both the `Session ID:` header and the
 * `MOCK_QWEN_SESSION:` / `MOCK_QWEN_RESUMED:` marker are visible in
 * stdout we send `/quit\r` (the mock listens for it) and fall back to
 * SIGTERM after 1s. The MOCK_QWEN_KEEP_SESSION_FILE env var is on so
 * the mock leaves its session JSON file in place for the harness to
 * read after exit.
 */
function runMockQwen(argv: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // Spawn `node mock-qwen.js` directly so the harness is identical on
    // every OS (no .cmd / .ps1 quirks). Pass MOCK_QWEN_KEEP_SESSION_FILE
    // so the session JSON survives /quit for post-exit reads.
    const child = spawn(process.execPath, [MOCK_QWEN_JS, ...argv], {
      cwd,
      env: { ...process.env, MOCK_QWEN_KEEP_SESSION_FILE: '1' },
      windowsHide: true,
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => { /* drop - mock only writes to stdout */ });

    const checkInterval = setInterval(() => {
      const headerSeen = stdout.includes('Session ID:');
      const markerSeen = stdout.includes('MOCK_QWEN_SESSION:') || stdout.includes('MOCK_QWEN_RESUMED:');
      if (headerSeen && markerSeen) {
        clearInterval(checkInterval);
        try { child.stdin.write('/quit\r'); } catch { /* already closed */ }
        try { child.stdin.end(); } catch { /* already closed */ }
        // Backstop: if the mock didn't honor /quit within 1s, kill it.
        setTimeout(() => { if (!child.killed) child.kill('SIGTERM'); }, 1000);
      }
    }, 25);

    // Hard timeout in case markers never arrive (real bug, not flake).
    const hardTimeout = setTimeout(() => {
      clearInterval(checkInterval);
      if (!child.killed) child.kill('SIGKILL');
      reject(new Error(`mock-qwen did not emit markers within 10s. stdout: ${stdout}`));
    }, 10000);

    child.on('close', (code) => {
      clearInterval(checkInterval);
      clearTimeout(hardTimeout);
      resolve({ stdout, exitCode: code, durationMs: Date.now() - startedAt });
    });

    child.on('error', (error) => {
      clearInterval(checkInterval);
      clearTimeout(hardTimeout);
      reject(error);
    });
  });
}

describe('Qwen Code - integration harness', () => {
  let sandbox: string;
  let projectChatsRoot: string;
  let projectChatsParent: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-integration-'));
    // Real Qwen 0.15.3 writes session JSONL to
    //   ~/.qwen/projects/<sanitizeCwd(cwd)>/chats/<sessionId>.jsonl
    // Pre-create that path so the mock's mkdir doesn't race the test's
    // afterEach cleanup. Use the parser's helper so test path matches
    // the parser's path derivation byte-for-byte.
    projectChatsRoot = qwenChatsDir(sandbox);
    projectChatsParent = path.dirname(projectChatsRoot);
    fs.mkdirSync(projectChatsRoot, { recursive: true });
  });

  afterEach(() => {
    // Wipe the sandbox-scoped ~/.qwen/projects/<sanitized-sandbox>/ tree.
    // We never touch real user chats because basename(sandbox) is unique
    // per test (mkdtemp).
    try { fs.rmSync(projectChatsParent, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Layer 1: registry wiring', () => {
    it('agentRegistry.getOrThrow("qwen") returns a QwenAdapter instance', () => {
      const adapter = agentRegistry.getOrThrow('qwen');
      expect(adapter).toBeInstanceOf(QwenAdapter);
      expect(adapter.name).toBe('qwen');
      expect(adapter.displayName).toBe('Qwen Code');
      expect(adapter.sessionType).toBe('qwen_agent');
    });

    it('agentRegistry.getBySessionType("qwen_agent") finds the same adapter', () => {
      const adapter = agentRegistry.getBySessionType('qwen_agent');
      expect(adapter).toBeDefined();
      expect(adapter!.name).toBe('qwen');
    });

    it('agentRegistry.list() includes "qwen" alongside the other adapters', () => {
      const list = agentRegistry.list();
      expect(list).toContain('qwen');
      // Sanity: the existing adapters are still there.
      expect(list).toContain('claude');
      expect(list).toContain('gemini');
    });
  });

  describe('Layer 2: detector against the mock CLI', () => {
    it('detects the mock binary via overridePath and parses its version', async () => {
      const detector = new QwenDetector();
      const info = await detector.detect(MOCK_QWEN_CMD);
      expect(info.found).toBe(true);
      expect(info.path).toBe(MOCK_QWEN_CMD);
      // mock-qwen.js prints `mock-qwen 0.0.0-test` for --version. The
      // adapter's parseVersion is identity (raw trim), so the entire
      // line is preserved.
      expect(info.version).toBe('mock-qwen 0.0.0-test');
    });

    it('reports found:false when the override path does not exist', async () => {
      const detector = new QwenDetector();
      const info = await detector.detect('/nonexistent/qwen-binary');
      expect(info.found).toBe(false);
      expect(info.path).toBe('/nonexistent/qwen-binary');
      expect(info.version).toBeNull();
    });
  });

  describe('Layer 3: command builder formats the documented flag set', () => {
    // We assert against the rendered command STRING via substring matches
    // because cross-platform shell quoting (single vs double quotes) makes
    // tokenization brittle to test. Per-shell tokenization is already
    // covered by the unit tests in qwen-command-builder.test.ts.
    const builder = new QwenCommandBuilder();
    const baseOptions = {
      qwenPath: '/usr/bin/qwen',
      taskId: 'integration-task',
      cwd: '/project',
    };

    it('default permission mode emits no flags beyond the binary', () => {
      const command = builder.buildQwenCommand({ ...baseOptions, permissionMode: 'default' });
      expect(command).not.toContain('--approval-mode');
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('-p');
    });

    it('plan permission mode emits --approval-mode plan', () => {
      const command = builder.buildQwenCommand({ ...baseOptions, permissionMode: 'plan' });
      expect(command).toContain('--approval-mode plan');
    });

    it('acceptEdits emits --approval-mode auto-edit (HYPHEN, fork-specific)', () => {
      const command = builder.buildQwenCommand({ ...baseOptions, permissionMode: 'acceptEdits' });
      expect(command).toContain('--approval-mode auto-edit');
      // Defensive: the Gemini-style underscore must not creep back in.
      expect(command).not.toContain('auto_edit');
    });

    it('bypassPermissions emits --approval-mode yolo', () => {
      const command = builder.buildQwenCommand({ ...baseOptions, permissionMode: 'bypassPermissions' });
      expect(command).toContain('--approval-mode yolo');
    });

    it('new session with sessionId emits --session-id <sessionId> (caller-owned)', () => {
      const sessionId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      const command = builder.buildQwenCommand({
        ...baseOptions,
        permissionMode: 'default',
        resume: false,
        sessionId,
      });
      expect(command).toContain('--session-id');
      expect(command).toContain(sessionId);
      expect(command).not.toContain('--resume');
    });

    it('resume command emits --resume <sessionId>', () => {
      const sessionId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      const command = builder.buildQwenCommand({
        ...baseOptions,
        permissionMode: 'default',
        resume: true,
        sessionId,
      });
      expect(command).toContain('--resume');
      expect(command).toContain(sessionId);
      expect(command).not.toContain('--session-id');
    });

    it('non-interactive prompt uses -p (mutex with positional per Qwen yargs)', () => {
      const command = builder.buildQwenCommand({
        ...baseOptions,
        permissionMode: 'default',
        nonInteractive: true,
        prompt: 'Refactor utils',
      });
      expect(command).toContain('-p');
      expect(command).toContain('Refactor utils');
    });

    it('flag ordering: approval-mode comes before --resume comes before prompt', () => {
      const command = builder.buildQwenCommand({
        ...baseOptions,
        permissionMode: 'plan',
        resume: true,
        sessionId: 'sess-1',
        prompt: 'Do something',
      });
      const approvalIndex = command.indexOf('--approval-mode');
      const resumeIndex = command.indexOf('--resume');
      const promptIndex = command.indexOf('Do something');
      expect(approvalIndex).toBeGreaterThanOrEqual(0);
      expect(resumeIndex).toBeGreaterThan(approvalIndex);
      expect(promptIndex).toBeGreaterThan(resumeIndex);
    });
  });

  describe('Layer 4: hook injection writes .qwen/settings.json', () => {
    it('buildCommand with eventsOutputPath creates .qwen/settings.json with 11 hook events', () => {
      const adapter = new QwenAdapter();
      const eventsPath = path.join(sandbox, 'events.jsonl');
      adapter.buildCommand({
        agentPath: MOCK_QWEN_JS,
        taskId: 'task-hook-1',
        cwd: sandbox,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });

      const settingsPath = path.join(sandbox, '.qwen', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ name: string }> }>>;
      };
      const hookEventKeys = Object.keys(settings.hooks).sort();
      expect(hookEventKeys).toEqual([
        'AfterAgent',
        'AfterModel',
        'AfterTool',
        'BeforeAgent',
        'BeforeModel',
        'BeforeTool',
        'BeforeToolSelection',
        'Notification',
        'PreCompress',
        'SessionEnd',
        'SessionStart',
      ]);
      // Every entry must carry a kangentic- prefixed name (Qwen requires
      // named hooks; unnamed entries get rejected at parse time).
      for (const entries of Object.values(settings.hooks)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.name).toMatch(/^kangentic-/);
          }
        }
      }
    });

    it('removeHooks with matching taskId strips kangentic entries', () => {
      const adapter = new QwenAdapter();
      const eventsPath = path.join(sandbox, 'events.jsonl');
      adapter.buildCommand({
        agentPath: MOCK_QWEN_JS,
        taskId: 'task-cleanup',
        cwd: sandbox,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });

      const settingsPath = path.join(sandbox, '.qwen', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      adapter.removeHooks(sandbox, 'task-cleanup');

      // safelyUpdateSettingsFile deletes the file when hooks was the
      // only top-level key, then rmdirs the parent if empty.
      const stillExists = fs.existsSync(settingsPath);
      if (stillExists) {
        const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: unknown };
        expect(after.hooks).toBeUndefined();
      } else {
        expect(stillExists).toBe(false);
      }
    });

    it('two concurrent task holders prevent premature cleanup', () => {
      const adapter = new QwenAdapter();
      const eventsPath = path.join(sandbox, 'events.jsonl');
      adapter.buildCommand({
        agentPath: MOCK_QWEN_JS,
        taskId: 'task-a',
        cwd: sandbox,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });
      adapter.buildCommand({
        agentPath: MOCK_QWEN_JS,
        taskId: 'task-b',
        cwd: sandbox,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });

      const settingsPath = path.join(sandbox, '.qwen', 'settings.json');
      // Task A releases - hooks must remain because task B still holds.
      adapter.removeHooks(sandbox, 'task-a');
      expect(fs.existsSync(settingsPath)).toBe(true);
      const stillThere = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(stillThere.hooks).length).toBeGreaterThan(0);

      // Task B releases - now cleanup happens.
      adapter.removeHooks(sandbox, 'task-b');
      const afterBoth = fs.existsSync(settingsPath);
      if (afterBoth) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: unknown };
        expect(parsed.hooks).toBeUndefined();
      } else {
        expect(afterBoth).toBe(false);
      }
    });
  });

  describe('Layer 5: caller-owned --session-id -> resume cycle', () => {
    it('spawns mock CLI with --session-id <our-uuid>, mock writes JSONL at our path, then resumes with same UUID', async () => {
      const adapter = new QwenAdapter();
      const builder = new QwenCommandBuilder();

      // Caller pre-generates the UUID, just like prepare-spawn.ts does
      // for adapters with supportsCallerSessionId === true.
      const ourSessionId = randomUUID();

      // Step 1: confirm the command-builder formats --session-id <id>
      // for a new session (resume=false, sessionId set).
      const newCommand = builder.buildQwenCommand({
        qwenPath: MOCK_QWEN_JS,
        taskId: 'integration-lifecycle',
        cwd: sandbox,
        permissionMode: 'default',
        sessionId: ourSessionId,
        resume: false,
      });
      expect(newCommand).toContain('--session-id');
      expect(newCommand).toContain(ourSessionId);
      expect(newCommand).not.toContain('--resume');

      // Step 2: spawn the mock with --session-id <our-uuid>. The mock
      // (like real qwen) MUST honor the caller-owned UUID and write
      // its JSONL at exactly <ourSessionId>.jsonl.
      const newRun = await runMockQwen(['--session-id', ourSessionId], sandbox);

      // Mock prints MOCK_QWEN_SESSION:<uuid> for new sessions; the UUID
      // must equal the one we passed in.
      const sessionMatch = newRun.stdout.match(/MOCK_QWEN_SESSION:([0-9a-f-]+)/);
      expect(sessionMatch).not.toBeNull();
      expect(sessionMatch![1]).toBe(ourSessionId);
      expect(newRun.stdout).toContain(`Session ID: ${ourSessionId}`);
      expect(newRun.stdout).toContain('\x1b[?25l');

      // Step 3: the mock wrote the JSONL at the caller-owned path.
      const chatFilePath = path.join(projectChatsRoot, `${ourSessionId}.jsonl`);
      expect(fs.existsSync(chatFilePath)).toBe(true);
      const firstLine = fs.readFileSync(chatFilePath, 'utf-8').split('\n')[0];
      const firstEvent = JSON.parse(firstLine) as { sessionId: string; type: string };
      expect(firstEvent.sessionId).toBe(ourSessionId);
      expect(firstEvent.type).toBe('user');

      // Step 4: locate() resolves the same path from the known UUID.
      // No filesystem polling needed - we already know the UUID.
      const located = await adapter.locateSessionHistoryFile(ourSessionId, sandbox);
      expect(located).toBe(chatFilePath);

      // Step 5: parse the JSONL chat file and confirm we extract usage.
      const parsed = QwenSessionHistoryParser.parse(fs.readFileSync(located!, 'utf-8'), 'full');
      expect(parsed.usage).not.toBeNull();
      expect(parsed.usage!.model.id).toBe('claude-haiku-4-5-20251001');
      expect(parsed.usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(parsed.usage!.contextWindow.totalInputTokens).toBeGreaterThan(0);

      // Step 6: build a resume command and confirm --resume formatting.
      const resumeCommand = builder.buildQwenCommand({
        qwenPath: MOCK_QWEN_JS,
        taskId: 'integration-lifecycle',
        cwd: sandbox,
        permissionMode: 'default',
        resume: true,
        sessionId: ourSessionId,
      });
      expect(resumeCommand).toContain('--resume');
      expect(resumeCommand).toContain(ourSessionId);
      expect(resumeCommand).not.toContain('--session-id');

      // Step 7: spawn the mock with --resume <our-uuid>. The mock
      // reports MOCK_QWEN_RESUMED:<uuid> and NOT MOCK_QWEN_SESSION.
      const resumeRun = await runMockQwen(['--resume', ourSessionId], sandbox);
      const resumedMatch = resumeRun.stdout.match(/MOCK_QWEN_RESUMED:([0-9a-f-]+)/);
      expect(resumedMatch).not.toBeNull();
      expect(resumedMatch![1]).toBe(ourSessionId);
      expect(resumeRun.stdout).not.toContain('MOCK_QWEN_SESSION:');
    }, 30000);

    it('mock rejects --session-id and --resume passed together (mutex)', async () => {
      const sessionId = randomUUID();
      // The mock exits with code 1 when both flags are present; we still
      // race the marker-watcher in runMockQwen which expects the markers
      // to appear, so spawn directly instead.
      const result = await new Promise<{ exitCode: number | null; stderr: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [MOCK_QWEN_JS, '--session-id', sessionId, '--resume', sessionId],
            { cwd: sandbox, env: process.env, windowsHide: true },
          );
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
          child.on('close', (code) => resolve({ exitCode: code, stderr }));
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('mutually exclusive');
    }, 10000);
  });

  describe('Layer 6: PTY-output and TUI heuristics', () => {
    it('runtime.sessionId.fromOutput captures from a real shutdown summary', () => {
      const adapter = new QwenAdapter();
      const realisticShutdown = [
        'Agent powering down. Goodbye!',
        '',
        'Interaction Summary',
        'Session ID:           12345678-90ab-cdef-1234-567890abcdef',
        'Tool Calls:           3 ( 3 x 0 )',
        '',
        "To resume this session: qwen --resume '12345678-90ab-cdef-1234-567890abcdef'",
      ].join('\r\n');
      expect(adapter.runtime.sessionId!.fromOutput!(realisticShutdown))
        .toBe('12345678-90ab-cdef-1234-567890abcdef');
    });

    it('runtime.sessionId.fromOutput also captures from upstream-literal builds (gemini --resume)', () => {
      const adapter = new QwenAdapter();
      const upstreamShutdown = "To resume this session: gemini --resume '12345678-90ab-cdef-1234-567890abcdef'";
      expect(adapter.runtime.sessionId!.fromOutput!(upstreamShutdown))
        .toBe('12345678-90ab-cdef-1234-567890abcdef');
    });

    it('detectFirstOutput fires on the cursor-hide escape (mock writes this on spawn)', () => {
      const adapter = new QwenAdapter();
      const chunk = `Session ID: abc\nMOCK_QWEN_SESSION:abc\n\x1b[?25l`;
      expect(adapter.detectFirstOutput(chunk)).toBe(true);
    });

    it('activity detector flags the closed-box-border idle pattern', () => {
      const adapter = new QwenAdapter();
      if (adapter.runtime.activity.kind !== 'hooks_and_pty') {
        throw new Error('Expected hooks_and_pty activity strategy');
      }
      const detectIdle = adapter.runtime.activity.detectIdle!;
      // Real Qwen TUI prints a closed box border (U+2570 ... U+2500
      // ... U+256F) every time it finishes painting an interactive
      // surface and is waiting for user input.
      const idleFrame = 'some content above\n╰────────────────╯\n';
      expect(detectIdle(idleFrame)).toBe(true);
      // A frame still drawing (no closing border) must NOT trigger idle.
      const drawingFrame = 'partial output... no border yet';
      expect(detectIdle(drawingFrame)).toBe(false);
    });
  });

  describe('Layer 7: hook-manager API surface (independent of buildCommand)', () => {
    it('buildHooks + removeHooks roundtrip preserves user hooks', () => {
      const settingsDir = path.join(sandbox, '.qwen');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.json');

      // Pre-existing user hook (must survive both inject and cleanup).
      const userHook = {
        matcher: 'write_file',
        hooks: [{ name: 'security-check', type: 'command', command: 'echo user-defined' }],
      };
      const initial = {
        theme: 'dark',
        hooks: { BeforeTool: [userHook] },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2));

      // Inject kangentic hooks alongside the user's. The bridge path
      // MUST contain both `.kangentic` and `event-bridge` for the
      // `isKangenticHookCommand` filter to recognize and strip them
      // later. Real adapter spawn paths always use `.kangentic/...`.
      const fakeBridge = path.join('/fake', '.kangentic', 'event-bridge.js');
      const fakeEvents = path.join('/fake', '.kangentic', 'sessions', 'abc', 'events.jsonl');
      const merged = buildHooks(fakeBridge, fakeEvents, initial.hooks);
      const writtenSettings = { ...initial, hooks: merged };
      fs.writeFileSync(settingsPath, JSON.stringify(writtenSettings, null, 2));

      // Both kinds must coexist in BeforeTool.
      const afterInject = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ name: string }> }>>;
      };
      const beforeToolEntries = afterInject.hooks.BeforeTool;
      expect(beforeToolEntries).toHaveLength(2);
      expect(beforeToolEntries[0].matcher).toBe('write_file');
      expect(beforeToolEntries[1].matcher).toBe('*');

      // Strip Kangentic entries, user hook survives, theme survives.
      removeHooks(sandbox);
      const afterCleanup = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        theme: string;
        hooks: Record<string, Array<{ matcher: string }>>;
      };
      expect(afterCleanup.theme).toBe('dark');
      expect(afterCleanup.hooks.BeforeTool).toHaveLength(1);
      expect(afterCleanup.hooks.BeforeTool[0].matcher).toBe('write_file');
    });
  });
});
