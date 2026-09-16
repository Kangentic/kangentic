/**
 * Unit tests for the DESKTOP-16 additions to crash-capture.ts: the last host
 * memory sample attaches to a `render-process-gone` record's context, and a
 * crash with no project open falls back to the app config dir instead of
 * being dropped.
 *
 * Tier: Unit (vitest; electron is mocked, host-memory's sample and
 * config/paths' configDir are stubbed, real fs writes go under os.tmpdir()).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostMemorySample } from '../../src/shared/types';

let mockHostMemorySample: HostMemorySample | null = null;

vi.mock('../../src/main/diagnostics/host-memory', () => ({
  getLastHostMemorySample: () => mockHostMemorySample,
}));

// vi.mock factories are hoisted above top-level statements (and are
// evaluated once, at crash-capture.ts's own import time, well before any
// beforeAll runs). A getter defers the read to each ACCESS instead - the
// real call site (writeRecord, inside crash-capture.ts) reads
// `PATHS.configDir` at crash time, not at import time - so the holder's
// value can still be set from a normal beforeAll below.
const configDirHolder = vi.hoisted(() => ({ value: '' }));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    get configDir() { return configDirHolder.value; },
  },
}));

interface FakeWebContents {
  getURL: () => string;
  on: (event: string, callback: (event: unknown, details: { reason: string; exitCode: number }) => void) => void;
}

let renderProcessGoneHandler: ((event: unknown, details: { reason: string; exitCode: number }) => void) | null = null;

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.41.0',
    on: (event: string, listener: (event: unknown, webContents: FakeWebContents) => void) => {
      if (event !== 'web-contents-created') return;
      const fakeWebContents: FakeWebContents = {
        getURL: () => 'http://localhost:5173/',
        on: (innerEvent, callback) => {
          if (innerEvent === 'render-process-gone') renderProcessGoneHandler = callback;
        },
      };
      listener({}, fakeWebContents);
    },
  },
  ipcMain: { handle: vi.fn() },
}));

import { startCrashCapture } from '../../src/main/diagnostics/crash-capture';

function readCrashRecords(directory: string): Array<{ kind: string; context: Record<string, unknown> | null }> {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf-8')));
}

describe('crash-capture: host memory attachment (Sentry DESKTOP-16)', () => {
  let projectRoot: string | null = null;

  beforeAll(() => {
    configDirHolder.value = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crash-capture-configdir-'));
    // startCrashCapture is idempotent (module-scope `installed` guard), so it
    // is registered exactly once here; `getProjectRoot` reads the outer `let`
    // live on every event, so mutating it per-test still routes each crash.
    startCrashCapture({ getProjectRoot: () => projectRoot });
  });

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crash-capture-project-'));
    mockHostMemorySample = null;
  });

  // Each test mkdtemps its own projectRoot, so without this they accumulate in
  // the OS temp directory for every local run. `force` keeps a Windows file
  // lock from failing the whole suite over cleanup.
  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  afterAll(() => {
    fs.rmSync(configDirHolder.value, { recursive: true, force: true });
  });

  function crashDirectory(root: string): string {
    return path.join(root, '.kangentic', 'logs', 'crashes');
  }

  it('attaches the last host memory sample to a render-process-gone record', () => {
    mockHostMemorySample = {
      ts: '2026-09-16T14:24:24.000Z',
      platform: 'win32',
      commitLimitBytes: 96_432_717_824,
      commitRemainingBytes: 2_256_896,
      physicalTotalBytes: 34_060_931_072,
      physicalFreeBytes: 5_005_045_760,
    };

    expect(renderProcessGoneHandler).not.toBeNull();
    renderProcessGoneHandler!({}, { reason: 'oom', exitCode: 1 });

    const records = readCrashRecords(crashDirectory(projectRoot!));
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('render-process-gone');
    expect(records[0].context?.hostMemory).toEqual(mockHostMemorySample);
  });

  it('writes a null hostMemory rather than failing when no sample exists yet', () => {
    mockHostMemorySample = null;

    renderProcessGoneHandler!({}, { reason: 'crashed', exitCode: 1 });

    const records = readCrashRecords(crashDirectory(projectRoot!));
    expect(records).toHaveLength(1);
    expect(records[0].context?.hostMemory).toBeNull();
  });

  it('falls back to the app config dir when no project is open, instead of dropping the crash', () => {
    projectRoot = null;
    mockHostMemorySample = {
      ts: '2026-09-16T14:24:24.000Z',
      platform: 'win32',
      commitLimitBytes: 96_432_717_824,
      commitRemainingBytes: 2_256_896,
      physicalTotalBytes: 34_060_931_072,
      physicalFreeBytes: 5_005_045_760,
    };

    renderProcessGoneHandler!({}, { reason: 'oom', exitCode: 1 });

    const records = readCrashRecords(path.join(configDirHolder.value, 'logs', 'crashes'));
    expect(records.length).toBeGreaterThan(0);
    expect(records[records.length - 1].context?.hostMemory).toEqual(mockHostMemorySample);
  });
});
