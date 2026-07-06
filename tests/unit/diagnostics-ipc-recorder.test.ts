/**
 * Unit tests for `src/main/diagnostics/ipc-recorder.ts`.
 *
 * Verifies:
 *   - The exported `SAFE_CHANNELS` allowlist is a default-deny set: only
 *     read-only channels appear; nothing that writes settings, MCP config,
 *     or auth credentials.
 *   - When `enabled()` returns false, the recorder is a pass-through and
 *     does not write to disk.
 *   - When `enabled()` returns true, an entry is appended to
 *     `<projectRoot>/.kangentic/logs/ipc-<date>.jsonl` with the channel,
 *     duration, and either args+result (safe channel) or
 *     `{ redacted: true, channel }` placeholders (default-deny).
 *   - Handler errors are captured as `error: { name, message }` instead
 *     of `result`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let registeredHandler: ((event: unknown, ...args: unknown[]) => Promise<unknown>) | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((_channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandler = handler;
    }),
    on: vi.fn(),
  },
}));

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-recorder-test-'));
  registeredHandler = null;
  vi.resetModules();
  // The mocked `ipcMain` object survives `vi.resetModules` (the mock
  // factory only runs once per file). Each test's `installIpcRecorder`
  // call wraps `ipcMain.handle`; without resetting the property to a
  // fresh `vi.fn`, subsequent tests see the previous test's wrapper
  // still attached, causing duplicate writes per request.
  const electron = await import('electron');
  electron.ipcMain.handle = vi.fn((_channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    registeredHandler = handler;
  }) as unknown as typeof electron.ipcMain.handle;
  // Drain any leftover queue state from the prior test.
  const { resetForTest } = await import('../../src/main/diagnostics/async-file-queue');
  resetForTest();
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function readJsonlEntries(channelOrAny?: string): Promise<unknown[]> {
  // Writes are async-buffered through the file queue; await pending
  // flushes before reading.
  const { flushAllForTest } = await import('../../src/main/diagnostics/async-file-queue');
  await flushAllForTest();
  const directory = path.join(tempDirectory, '.kangentic', 'logs');
  if (!fs.existsSync(directory)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(directory, `ipc-${today}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((entry) => !channelOrAny || (entry as { channel: string }).channel === channelOrAny);
}

describe('ipc-recorder', () => {
  it('SAFE_CHANNELS allowlist contains only read-only channels', async () => {
    const { __INTERNAL } = await import('../../src/main/diagnostics/ipc-recorder');
    // Spot-check a couple of representative entries: read-only project /
    // session lookups belong; mutating channels do not.
    expect(__INTERNAL.SAFE_CHANNELS.has('project:list')).toBe(true);
    expect(__INTERNAL.SAFE_CHANNELS.has('session:getActivityStats')).toBe(true);
    expect(__INTERNAL.SAFE_CHANNELS.has('search:everything')).toBe(true);

    // Mutating channels must NOT be on the allowlist.
    expect(__INTERNAL.SAFE_CHANNELS.has('task:create')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('config:set')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('attachment:add')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('boards:asana:setPat')).toBe(false);
  });

  it('does not write to disk when enabled() is false', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => false,
    });

    // Have a handler register through the patched `ipcMain.handle`. The
    // patch wraps the user's handler; passing a stub captures the wrap.
    ipcMain.handle('project:list', async () => ['project-a']);

    expect(registeredHandler).not.toBeNull();
    const result = await registeredHandler!({});
    expect(result).toEqual(['project-a']);

    expect(await readJsonlEntries()).toEqual([]);
  });

  it('logs args + result for safe channels when enabled', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('project:list', async (_event: unknown, _arg: string) => ['project-a']);
    await registeredHandler!({}, 'unused');

    const entries = await readJsonlEntries('project:list');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      channel: string;
      args: unknown;
      result: unknown;
      durationMs: number;
    };
    expect(entry.channel).toBe('project:list');
    expect(entry.args).toEqual(['unused']);
    expect(entry.result).toEqual(['project-a']);
    expect(typeof entry.durationMs).toBe('number');
  });

  it('redacts args + result for non-safe channels', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('config:set', async (_event: unknown, _settings: unknown) => 'ok');
    await registeredHandler!({}, { apiKey: 'sk-secret', other: 'data' });

    const entries = await readJsonlEntries('config:set');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      args: { redacted: boolean; channel: string };
      result: { redacted: boolean; channel: string };
    };
    expect(entry.args).toEqual({ redacted: true, channel: 'config:set' });
    expect(entry.result).toEqual({ redacted: true, channel: 'config:set' });
  });

  it('captures errors thrown by the handler', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('project:list', async () => {
      throw new Error('database locked');
    });

    await expect(registeredHandler!({})).rejects.toThrow('database locked');

    const entries = await readJsonlEntries('project:list');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      error: { name: string; message: string };
      result?: unknown;
    };
    expect(entry.error).toEqual({ name: 'Error', message: 'database locked' });
    expect(entry.result).toBeUndefined();
  });

  it('truncates an oversized safe-channel result to a marker, leaving small args intact', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({ getProjectRoot: () => tempDirectory, enabled: () => true });

    const huge = 'x'.repeat(40_000); // JSON well over the 32KB cap
    ipcMain.handle('project:list', async (_event: unknown, _arg: string) => [huge]);
    await registeredHandler!({}, 'small-arg');

    const entries = await readJsonlEntries('project:list');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      args: unknown;
      result: { truncated: boolean; serializedChars: number; preview: string };
    };
    // Small args pass through unchanged.
    expect(entry.args).toEqual(['small-arg']);
    // The oversized result is replaced with a compact marker; the line still
    // parsed as valid JSON (readJsonlEntries did the JSON.parse).
    expect(entry.result.truncated).toBe(true);
    expect(entry.result.serializedChars).toBeGreaterThan(32 * 1024);
    expect(entry.result.preview).toHaveLength(2 * 1024);
  });

  it('truncates oversized args independently of a small result', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({ getProjectRoot: () => tempDirectory, enabled: () => true });

    ipcMain.handle('project:list', async () => ['ok']);
    await registeredHandler!({}, 'y'.repeat(40_000));

    const entries = await readJsonlEntries('project:list');
    const entry = entries[0] as {
      args: { truncated: boolean; serializedChars: number };
      result: unknown;
    };
    expect(entry.args.truncated).toBe(true);
    expect(entry.args.serializedChars).toBeGreaterThan(32 * 1024);
    // The small result is untouched.
    expect(entry.result).toEqual(['ok']);
  });

  it('rotates the daily log to <file>.1 when it exceeds the configured cap, keeping whole JSON lines', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    const { flushAllForTest } = await import('../../src/main/diagnostics/async-file-queue');
    // Tiny cap so a handful of entries forces a rotation.
    installIpcRecorder({ getProjectRoot: () => tempDirectory, enabled: () => true, maxLogFileBytes: 256 });

    ipcMain.handle('project:list', async () => ['project-a']);
    for (let index = 0; index < 12; index += 1) {
      await registeredHandler!({});
      await flushAllForTest(); // separate flush batches so rotation can trigger between them
    }

    const today = new Date().toISOString().slice(0, 10);
    const directory = path.join(tempDirectory, '.kangentic', 'logs');
    const primary = path.join(directory, `ipc-${today}.jsonl`);
    const rotated = `${primary}.1`;
    expect(fs.existsSync(rotated)).toBe(true);

    // Every non-empty line in both files must be complete, valid JSON.
    for (const file of [rotated, primary]) {
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it('prunes ipc log files older than the retention window, sparing recent and non-ipc files', async () => {
    const { installIpcRecorder, __INTERNAL } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    const directory = path.join(tempDirectory, '.kangentic', 'logs');
    fs.mkdirSync(directory, { recursive: true });

    const ancientPrimary = path.join(directory, 'ipc-2020-01-01.jsonl');
    const ancientRotated = path.join(directory, 'ipc-2020-01-01.jsonl.1');
    const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentPrimary = path.join(directory, `ipc-${recentDate}.jsonl`);
    const logMirror = path.join(directory, '2020-01-01.log'); // not an ipc file
    fs.writeFileSync(ancientPrimary, '{}\n');
    fs.writeFileSync(ancientRotated, '{}\n');
    fs.writeFileSync(recentPrimary, '{}\n');
    fs.writeFileSync(logMirror, 'stale\n');

    installIpcRecorder({ getProjectRoot: () => tempDirectory, enabled: () => true });
    ipcMain.handle('project:list', async () => ['project-a']);
    await registeredHandler!({}); // triggers the one-shot prune
    await __INTERNAL.awaitPendingPruneForTest();

    // Ancient ipc files (primary + rotated) are gone.
    expect(fs.existsSync(ancientPrimary)).toBe(false);
    expect(fs.existsSync(ancientRotated)).toBe(false);
    // In-retention ipc file and the non-ipc log mirror survive.
    expect(fs.existsSync(recentPrimary)).toBe(true);
    expect(fs.existsSync(logMirror)).toBe(true);
  });
});

describe('ipc-recorder - outbound push recording', () => {
  it('SAFE_PUSH_CHANNELS contains the agent-driven board-invalidation channels', async () => {
    const { __INTERNAL } = await import('../../src/main/diagnostics/ipc-recorder');
    expect(__INTERNAL.SAFE_PUSH_CHANNELS.has('task:createdByAgent')).toBe(true);
    expect(__INTERNAL.SAFE_PUSH_CHANNELS.has('swimlane:updatedByAgent')).toBe(true);
    expect(__INTERNAL.SAFE_PUSH_CHANNELS.has('backlog:changedByAgent')).toBe(true);
    // A mutating inbound channel is not a safe push channel.
    expect(__INTERNAL.SAFE_PUSH_CHANNELS.has('config:set')).toBe(false);
  });

  it('records a push with direction "out", full args, and zero duration when enabled', async () => {
    const { installIpcRecorder, recordPush } = await import('../../src/main/diagnostics/ipc-recorder');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    recordPush('task:createdByAgent', ['task-id', 'Fix the bug', 'To Do', 'project-id']);

    const entries = await readJsonlEntries('task:createdByAgent');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      direction: string;
      args: unknown;
      durationMs: number;
      error?: unknown;
    };
    expect(entry.direction).toBe('out');
    expect(entry.args).toEqual(['task-id', 'Fix the bug', 'To Do', 'project-id']);
    expect(entry.durationMs).toBe(0);
    expect(entry.error).toBeUndefined();
  });

  it('does not write a push when enabled() is false', async () => {
    const { installIpcRecorder, recordPush } = await import('../../src/main/diagnostics/ipc-recorder');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => false,
    });

    recordPush('task:createdByAgent', ['task-id', 'Fix the bug', 'To Do', 'project-id']);

    expect(await readJsonlEntries()).toEqual([]);
  });

  it('marks a dropped push (window destroyed) with a PushDropped error', async () => {
    const { installIpcRecorder, recordPush } = await import('../../src/main/diagnostics/ipc-recorder');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    recordPush('task:createdByAgent', ['task-id', 'Fix the bug', 'To Do', 'project-id'], { dropped: true });

    const entries = await readJsonlEntries('task:createdByAgent');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { direction: string; error: { name: string; message: string } };
    expect(entry.direction).toBe('out');
    expect(entry.error.name).toBe('PushDropped');
  });

  it('redacts args for a push channel not on the SAFE_PUSH_CHANNELS allowlist', async () => {
    const { installIpcRecorder, recordPush } = await import('../../src/main/diagnostics/ipc-recorder');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    recordPush('session:data', ['secret terminal output']);

    const entries = await readJsonlEntries('session:data');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { args: { redacted: boolean; channel: string } };
    expect(entry.args).toEqual({ redacted: true, channel: 'session:data' });
  });

  it('is a no-op when recordPush is called before installIpcRecorder', async () => {
    const { recordPush } = await import('../../src/main/diagnostics/ipc-recorder');
    // No install in this test; vi.resetModules in beforeEach gives a fresh
    // module with recorderOptions still null.
    recordPush('task:createdByAgent', ['task-id', 'Fix the bug', 'To Do', 'project-id']);
    expect(await readJsonlEntries()).toEqual([]);
  });
});
