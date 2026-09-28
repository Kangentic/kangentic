/**
 * Lifecycle tests for the /model picker probe's scan bookkeeping, added by a
 * red-green review of the scroll-completeness change:
 *
 *  - an INCOMPLETE scroll (rows still below when the scroll stopped) is never
 *    persisted, never displaces an earlier complete scan, and is retried after
 *    the failure backoff instead of being served for the 12 hour success TTL;
 *  - a stale (older than the success TTL) seeded scan is served at once, a probe
 *    spawns, and the file is rewritten when that probe completes;
 *  - the `↑` scroll marker keeps its row through the frame merge and the parser.
 *
 * The frame helpers are file-local copies of the ones in
 * claude-model-picker-probe.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

// The probe pre-trusts its scratch cwd by writing ~/.claude.json - never
// touch the real file from a unit test.
vi.mock('../../src/main/agent/adapters/claude/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(async () => undefined),
}));

import * as pty from 'node-pty';
import {
  parseModelPickerScreen,
  mergePickerFrames,
  probeModelPickerModels,
  getCachedModelPickerModels,
  resetModelPickerProbeForTests,
  setModelPickerProbeTimingsForTests,
  setModelPickerProbeScanFileForTests,
  type ModelPickerScan,
} from '../../src/main/agent/adapters/claude/model-picker-probe';

const spawnMock = pty.spawn as unknown as ReturnType<typeof vi.fn>;

interface FakePtyProcess {
  emitData: (data: string) => void;
  writes: string[];
  killMock: ReturnType<typeof vi.fn>;
}

/** A scripted fake PTY: `onWrite` sees every chunk the probe sends and can emit response frames. */
function installFakePty(
  onSpawn?: (fake: FakePtyProcess) => void,
  onWrite?: (input: string, fake: FakePtyProcess) => void,
): FakePtyProcess {
  let dataCallback: ((data: string) => void) | null = null;
  const fake: FakePtyProcess = {
    emitData: (data: string) => dataCallback?.(data),
    writes: [],
    killMock: vi.fn(),
  };
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => onSpawn?.(fake));
    return {
      onData: (callback: (data: string) => void) => {
        dataCallback = callback;
      },
      onExit: () => undefined,
      write: (input: string) => {
        fake.writes.push(input);
        onWrite?.(input, fake);
      },
      kill: fake.killMock,
    };
  });
  return fake;
}

const PROMPT_FRAME = '❯ Try "how does <filepath> work?"\r\n';
const ARROW_DOWN = '\x1b[B';

/** Repaint the fake screen from the top with these lines, each cleared to its end. */
function repaint(lines: string[]): string {
  return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\r\n')}`;
}

/** A picker that fits on one screen: no rows below, so the scroll reports complete. */
const COMPLETE_PICKER_LINES = [
  '  Select model',
  '  ❯ 1.  Default (recommended) ✔  Fable 5.1 · Best for everyday, complex tasks',
  '    2.  Fable 5.1                For your toughest challenges',
  '    3.  Haiku 4.5                Fastest for quick answers',
  '',
];

/** A picker whose "… +2 models" row never goes away, however far the highlight moves. */
const NEVER_ENDING_PICKER_LINES = [
  '  Select model',
  '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
  '    2.  Sonnet 5.5               Most efficient for simpler tasks',
  '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
  '     … +2 models',
];

const COMPLETE_SCAN: ModelPickerScan = {
  models: ['claude-fable-5-1', 'claude-haiku-4-5'],
  aliases: [
    { id: 'fable', resolvesTo: 'claude-fable-5-1' },
    { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
  ],
};
const PARTIAL_MODELS = ['claude-sonnet-5-5', 'claude-sonnet-5'];

/** A fake CLI whose picker renders `pickerLines` and does not change on Arrow Down. */
function installStaticPickerPty(pickerLines: string[]): FakePtyProcess {
  return installFakePty(
    (self) => self.emitData(PROMPT_FRAME),
    (input, self) => {
      if (input === '\r') self.emitData(repaint(pickerLines));
    },
  );
}

const CLI_PATH = '/usr/bin/claude';
const FAILURE_BACKOFF_PLUS_ONE_MINUTE_MS = 11 * 60 * 1000;
const THIRTEEN_HOURS_MS = 13 * 60 * 60 * 1000;

const GOOD_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const GOOD_ALIASES = [
  { id: 'opus', resolvesTo: 'claude-opus-5-5' },
  { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
];

function scanTimings(): void {
  // Every field is restated: the setter merges onto the defaults, and a slow
  // scrollSettleMs would let 40 presses run into the overall deadline first.
  setModelPickerProbeTimingsForTests({
    pollIntervalMs: 2,
    typeDelayMs: 2,
    settleIntervalMs: 2,
    overallTimeoutMs: 10000,
    exitGraceMs: 5,
    scrollSettleMs: 2,
  });
}

/** The teardown is detached from the result, so poll for its fallback kill. */
function expectFallbackKill(fake: FakePtyProcess): Promise<void> {
  return vi.waitFor(() => expect(fake.killMock).toHaveBeenCalled());
}

/**
 * A write that should NOT happen cannot be polled for. Give any stray async
 * write a fixed budget before the caller inspects the file.
 */
function allowStrayWriteBudget(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  spawnMock.mockReset();
  resetModelPickerProbeForTests();
  scanTimings();
});

describe('an incomplete scroll', () => {
  let tempDirectory: string;
  let scanFile: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-probe-lifecycle-'));
    scanFile = path.join(tempDirectory, 'last-scan.json');
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  function writeGoodSeed(): string {
    fs.writeFileSync(scanFile, JSON.stringify({
      cliPath: CLI_PATH,
      fetchedAtMs: Date.now() - 1000,
      scan: { models: [...GOOD_MODELS], aliases: GOOD_ALIASES.map((alias) => ({ ...alias })) },
    }));
    return fs.readFileSync(scanFile, 'utf8');
  }

  it('returns the partial scan but never writes the last-scan file when nothing earlier exists', async () => {
    setModelPickerProbeScanFileForTests(scanFile);
    const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

    const scan = await probeModelPickerModels(CLI_PATH);
    expect(scan?.models).toEqual(PARTIAL_MODELS);
    await expectFallbackKill(fake);
    // The scroll ran the whole 40 press cap and still saw rows below.
    expect(fake.writes.filter((write) => write === ARROW_DOWN)).toHaveLength(40);

    await allowStrayWriteBudget();
    expect(fs.existsSync(scanFile)).toBe(false);
  });

  it('does write the file for a complete scan (the control that makes the absent-file check meaningful)', async () => {
    setModelPickerProbeScanFileForTests(scanFile);
    installStaticPickerPty(COMPLETE_PICKER_LINES);

    expect(await probeModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(scanFile, 'utf8')).scan).toEqual(COMPLETE_SCAN));
  });

  it('keeps the earlier complete scan from an earlier probe when a forced probe ends incomplete', async () => {
    setModelPickerProbeScanFileForTests(scanFile);
    installStaticPickerPty(COMPLETE_PICKER_LINES);
    expect(await probeModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(scanFile, 'utf8')).scan).toEqual(COMPLETE_SCAN));
    const fileBefore = fs.readFileSync(scanFile, 'utf8');

    const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);
    const scanAfterIncomplete = await probeModelPickerModels(CLI_PATH, true);
    expect(scanAfterIncomplete).toEqual(COMPLETE_SCAN);
    await expectFallbackKill(fake);
    expect(fake.writes.filter((write) => write === ARROW_DOWN)).toHaveLength(40);
    // Later reads still get the complete scan, not the truncated one.
    expect(getCachedModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);

    await allowStrayWriteBudget();
    expect(fs.readFileSync(scanFile, 'utf8')).toBe(fileBefore);
  });

  it('keeps a scan seeded from the file when a forced probe ends incomplete, and leaves the file alone', async () => {
    const fileBefore = writeGoodSeed();
    setModelPickerProbeScanFileForTests(scanFile);
    const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

    const scan = await probeModelPickerModels(CLI_PATH, true);
    expect(scan).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expectFallbackKill(fake);
    expect(fake.writes.filter((write) => write === ARROW_DOWN)).toHaveLength(40);

    await allowStrayWriteBudget();
    expect(fs.readFileSync(scanFile, 'utf8')).toBe(fileBefore);
  });

  it('retries a partial scan with nothing earlier after the failure backoff, not the 12 hour success TTL', async () => {
    const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

    const first = await probeModelPickerModels(CLI_PATH);
    expect(first?.models).toEqual(PARTIAL_MODELS);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expectFallbackKill(fake);

    // Inside the backoff: the partial scan is served, no respawn.
    const second = await probeModelPickerModels(CLI_PATH);
    expect(second?.models).toEqual(PARTIAL_MODELS);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Eleven minutes on: past the 10 minute failure backoff, far inside the
    // 12 hour success TTL a complete scan would still be under.
    const originalDateNow = Date.now;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => originalDateNow() + FAILURE_BACKOFF_PLUS_ONE_MINUTE_MS);
    try {
      installStaticPickerPty(COMPLETE_PICKER_LINES);
      const retried = await probeModelPickerModels(CLI_PATH);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      // The retry saw the whole picker and replaces the partial scan.
      expect(retried).toEqual(COMPLETE_SCAN);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('retries after the failure backoff when an incomplete probe kept an earlier complete scan', async () => {
    writeGoodSeed();
    setModelPickerProbeScanFileForTests(scanFile);
    installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

    await probeModelPickerModels(CLI_PATH, true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Inside the backoff: served from the kept scan, no respawn.
    expect(await probeModelPickerModels(CLI_PATH)).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const originalDateNow = Date.now;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => originalDateNow() + FAILURE_BACKOFF_PLUS_ONE_MINUTE_MS);
    try {
      const retried = await probeModelPickerModels(CLI_PATH);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      // Incomplete again: the earlier complete scan is still what callers get.
      expect(retried).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('reports a scroll whose settle never lands before the deadline as incomplete too', async () => {
    // A churn that never settles ends the scroll early; the first frame still
    // shows rows below, so the result must not be persisted.
    setModelPickerProbeScanFileForTests(scanFile);
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 2,
      typeDelayMs: 2,
      settleIntervalMs: 5,
      overallTimeoutMs: 400,
      exitGraceMs: 5,
      scrollSettleMs: 40,
    });
    let churnTimer: ReturnType<typeof setInterval> | undefined;
    const stopChurn = () => {
      if (churnTimer !== undefined) clearInterval(churnTimer);
      churnTimer = undefined;
    };
    try {
      const fake = installFakePty(
        (self) => self.emitData(PROMPT_FRAME),
        (input, self) => {
          if (input === '\r') self.emitData(repaint(NEVER_ENDING_PICKER_LINES));
          if (input === ARROW_DOWN) {
            // A strictly increasing counter: two reads never see the same frame.
            let tick = 0;
            churnTimer = setInterval(() => {
              tick += 1;
              self.emitData(repaint([
                '  Select model',
                `    2.  Sonnet 5.5               churn ${tick}`,
                '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
                '     … +2 models',
              ]));
            }, 5);
          }
          if (input === '\x1b') stopChurn();
        },
      );

      const scan = await probeModelPickerModels(CLI_PATH);
      expect(scan?.models).toEqual(PARTIAL_MODELS);
      await expectFallbackKill(fake);
      await allowStrayWriteBudget();
      expect(fs.existsSync(scanFile)).toBe(false);
    } finally {
      stopChurn();
    }
  });
});

describe('a stale seeded scan', () => {
  let tempDirectory: string;
  let scanFile: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-probe-stale-'));
    scanFile = path.join(tempDirectory, 'last-scan.json');
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('is served on the first call while a probe spawns, and the file is rewritten with the new scan', async () => {
    const staleFetchedAtMs = Date.now() - THIRTEEN_HOURS_MS;
    fs.writeFileSync(scanFile, JSON.stringify({
      cliPath: CLI_PATH,
      fetchedAtMs: staleFetchedAtMs,
      scan: { models: [...GOOD_MODELS], aliases: GOOD_ALIASES.map((alias) => ({ ...alias })) },
    }));
    setModelPickerProbeScanFileForTests(scanFile);
    const fake = installStaticPickerPty(COMPLETE_PICKER_LINES);

    // Older than the 12 hour TTL, yet still served immediately.
    expect(getCachedModelPickerModels(CLI_PATH)).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    // And the staleness kicked a probe.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    // Ride the in-flight probe to its end (a second spawn would fail the count below).
    expect(await probeModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expectFallbackKill(fake);

    await vi.waitFor(() => {
      const record = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
      expect(record.scan).toEqual(COMPLETE_SCAN);
      expect(record.fetchedAtMs).toBeGreaterThan(staleFetchedAtMs);
    });
  });
});

describe('the up-arrow scroll marker', () => {
  const SCROLLED_FRAME = [
    '  Select model',
    '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
    '    3.  Haiku 4.5                Fastest for quick answers',
    '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
  ].join('\n');
  const TOP_FRAME = [
    '  Select model',
    '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
    '    2.  Sonnet 5.5               Most efficient for simpler tasks',
    '  ↓ 3.  Haiku 4.5                Fastest for quick answers',
    '     … +1 models',
  ].join('\n');

  it('mergePickerFrames keeps the marked row once, in row order', () => {
    expect(mergePickerFrames([TOP_FRAME, SCROLLED_FRAME])).toBe([
      'Select model',
      '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '  ↓ 3.  Haiku 4.5                Fastest for quick answers',
      '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
    ].join('\n'));
    // The frame that shows row 2 only through its marker still contributes it.
    expect(mergePickerFrames([SCROLLED_FRAME, TOP_FRAME])).toBe([
      'Select model',
      '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
      '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Haiku 4.5                Fastest for quick answers',
      '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
    ].join('\n'));
  });

  it('mergePickerFrames keeps a marked row that no other frame shows', () => {
    expect(mergePickerFrames([SCROLLED_FRAME])).toContain('  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks');
  });

  it('parseModelPickerScreen reads the marked row as a model exactly once, in row order', () => {
    const scan = parseModelPickerScreen([
      'Select model',
      '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
      '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Haiku 4.5                Fastest for quick answers',
    ].join('\n'));
    expect(scan.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
    expect(scan.aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ]);
  });
});
