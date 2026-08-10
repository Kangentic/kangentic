/**
 * Tests for the Claude slash-command JSONL verifier.
 *
 * Background: between `/model X` and `/effort Y` writes, an overlay or
 * autocomplete sometimes swallows the Enter, causing the next command's
 * text to concatenate into the previous prompt buffer. Claude then records
 * a single combined invocation like `<command-args>X\n/effort Y</command-args>`
 * which fails as "Model 'X\n/effort Y' not found". The verifier reads the
 * session JSONL and only confirms when an entry matches the EXACT command
 * we sent (single-line args, no embedded next-command).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSlashCommandVerifier,
  clearTranscriptTailCache,
} from '../../src/main/agent/adapters/claude/slash-command-verifier';

let tmpDir: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-verifier-'));
  jsonlPath = path.join(tmpDir, 'session.jsonl');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function appendEntry(entry: Record<string, unknown>): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('createSlashCommandVerifier', () => {
  it('returns null when no jsonlPath is provided (caller falls back to time-based settle)', () => {
    expect(createSlashCommandVerifier(null)).toBeNull();
    expect(createSlashCommandVerifier('')).toBeNull();
  });

  it('confirms a slash command when an exact-args entry appears after sentAt', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 1000, pollIntervalMs: 25 })!;
    const sentAt = Date.now();

    // Simulate Claude writing the success entry shortly after we sent.
    setTimeout(() => {
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-4-7</command-args>',
        timestamp: nowIso(),
      });
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Set model to Opus 4.7</local-command-stdout>',
        timestamp: nowIso(),
      });
    }, 100);

    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(true);
  });

  it('returns false on timeout when no matching entry appears', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('rejects a combined-args entry: /model with concatenated /effort args is treated as a non-match', async () => {
    // This is the canonical failure mode from the real-world bug. The
    // verifier MUST NOT accept this as confirmation, otherwise the burst
    // would advance to /effort while Claude was reporting "model not found".
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-4-7\n/effort xhigh</command-args>',
      timestamp: nowIso(10),
    });
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('ignores entries with timestamps older than sentAt (stale match from a prior schedule)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    // Pre-existing matching entry from a prior burst (1 second ago).
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n            <command-args>claude-opus-4-7</command-args>',
      timestamp: nowIso(-1000),
    });
    const sentAt = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('matches user-message form (where slash entries appear under message.content instead of top-level content)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 1000, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    setTimeout(() => {
      appendEntry({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>xhigh</command-args>',
        },
        timestamp: nowIso(),
      });
    }, 50);
    const result = await verifier('/effort xhigh', sentAt);
    expect(result).toBe(true);
  });

  it('returns true immediately for non-slash text (no JSONL signal expected)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 5000, pollIntervalMs: 25 })!;
    const start = Date.now();
    const result = await verifier('analyze the failing test', Date.now());
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('returns false gracefully when the jsonl file does not exist yet', async () => {
    const verifier = createSlashCommandVerifier(path.join(tmpDir, 'missing.jsonl'), {
      timeoutMs: 200,
      pollIntervalMs: 25,
    })!;
    const result = await verifier('/model opus', Date.now());
    expect(result).toBe(false);
  });

  it('matches a no-arg slash command (e.g. /clear) when the entry has empty args', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 500, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    setTimeout(() => {
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>',
        timestamp: nowIso(),
      });
    }, 50);
    const result = await verifier('/clear', sentAt);
    expect(result).toBe(true);
  });
});

describe('createSlashCommandVerifier - single-scan mode (no timeoutMs)', () => {
  // Production path: injection-plan.ts calls createSlashCommandVerifier(filePath)
  // with NO options. TerminalSubmit.pollWithRetries drives the cadence; the
  // verifier must do exactly ONE immediate scan and return without blocking.

  it('returns true on a single scan when a matching entry is already present', async () => {
    const sentAt = Date.now() - 100;
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-args>claude-opus-4-7</command-args>',
      timestamp: nowIso(),
    });

    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const start = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    // Single-scan: must not internally poll. Real polls would need ~25ms minimum
    // between iterations. 20ms is a generous ceiling for one fs.readFile call.
    expect(elapsed).toBeLessThan(200);
  });

  it('returns false immediately when no matching entry exists (does not block)', async () => {
    // File exists but has no matching content - single-scan must return false
    // without any internal wait loop.
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/effort</command-name>\n<command-args>low</command-args>',
      timestamp: nowIso(),
    });

    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const sentAt = Date.now();
    const start = Date.now();
    const result = await verifier('/model opus', sentAt);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // Without internal polling this should be fast (one fs.readFile).
    expect(elapsed).toBeLessThan(200);
  });

  it('returns false immediately when the file does not exist (does not block)', async () => {
    const verifier = createSlashCommandVerifier(path.join(tmpDir, 'nonexistent.jsonl'))!;
    const start = Date.now();
    const result = await verifier('/model opus', Date.now());
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(200);
  });

  it('returns true immediately for non-slash text in single-scan mode', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const start = Date.now();
    const result = await verifier('run the tests', Date.now());
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('still respects the sentAt window in single-scan mode (stale entry is rejected)', async () => {
    // Append a matching entry whose timestamp predates sentAt.
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-args>claude-opus-4-7</command-args>',
      timestamp: nowIso(-2000),
    });

    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const sentAt = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);

    // The entry is older than sentAt - 50ms tolerance, so it must be rejected.
    expect(result).toBe(false);
  });
});

/**
 * Cost of verification, which is a main-process concern rather than a cosmetic
 * one: `pollForConfirmation` asks every 25ms for up to ~2s per command, and
 * injection concurrency is per task, so dragging several tasks into one column
 * runs several of these loops at once. Re-reading a multi-megabyte transcript
 * 40 times a second per task blocks the main process, and a blocked main process
 * stalls IPC and therefore the UI.
 */
describe('transcript scanning cost', () => {
  beforeEach(() => {
    clearTranscriptTailCache();
  });

  it('reads the file once across repeated polls while it is unchanged', async () => {
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-args>opus</command-args>',
      timestamp: nowIso(-5000),
    });

    // Count real reads by watching atime-independent access: spy on the promises
    // API the verifier uses. `stat` is allowed (that is the cheap gate); `open`
    // and `readFile` are the expensive paths that must not repeat.
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const openSpy = vi.spyOn(fsPromises, 'open');

    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const sentAt = Date.now();
    for (let poll = 0; poll < 12; poll++) {
      await verifier('/model opus', sentAt);
    }

    // Twelve polls, one read: every subsequent poll was served from the
    // content-identity cache after a `stat`.
    expect(readSpy.mock.calls.length + openSpy.mock.calls.length).toBe(1);

    readSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('re-reads once the transcript actually grows, and still finds the new entry', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const sentAt = Date.now();

    appendEntry({ type: 'user', message: { role: 'user', content: 'unrelated' }, timestamp: nowIso(-5000) });
    expect(await verifier('/pull-request', sentAt, 'submitted')).toBe(false);

    // A real append changes size, which invalidates the cache.
    appendEntry({
      type: 'user',
      message: { role: 'user', content: '/pull-request' },
      timestamp: nowIso(10),
    });
    expect(await verifier('/pull-request', sentAt, 'submitted')).toBe(true);
  });

  it('keeps every concurrent burst cached rather than evicting them into a thrash', async () => {
    // The burst case the whole cache exists for: several tasks dragged into an
    // auto_command column at once, each polling its OWN transcript at 40Hz.
    //
    // This is a regression test for a real defect in the first version of the
    // cache, which cleared ALL entries on overflow. Past the limit that inverts
    // the optimization: each insert wipes every other burst's entry, they all
    // miss on their next poll, re-read, and evict each other again - so the
    // cache became pure overhead at exactly the concurrency it was added for.
    //
    // THE WORKLOAD HAS TO EXCEED THE CAP TO PROVE ANYTHING. An earlier version
    // of this test polled 12 transcripts against a cap of 32, so the eviction
    // branch never executed and a clear-all implementation passed it too - it
    // demonstrated caching, not LRU. Here a few HOT transcripts are polled every
    // round while fresh cold ones keep arriving, which is what a real board does
    // (several bursts in flight amid session churn) and is the pattern that
    // separates the two policies: LRU ages out the cold entries and keeps the
    // hot ones resident, whereas clear-all discards the hot ones on every
    // overflow and forces them to be re-read.
    const hotPaths: string[] = [];
    for (let session = 0; session < 4; session++) {
      const sessionPath = path.join(tmpDir, `hot-${session}.jsonl`);
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '/pull-request' },
          timestamp: nowIso(10),
        }) + '\n',
      );
      hotPaths.push(sessionPath);
    }

    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const openSpy = vi.spyOn(fsPromises, 'open');

    const sentAt = Date.now();
    const rounds = 8;
    const coldPerRound = 8;
    for (let round = 0; round < rounds; round++) {
      for (const sessionPath of hotPaths) {
        const verifier = createSlashCommandVerifier(sessionPath)!;
        expect(await verifier('/pull-request', sentAt, 'submitted')).toBe(true);
      }
      // Cold traffic: distinct transcripts that are read once and never again.
      // 4 hot + 8 per round passes the 32-entry cap partway through, so the
      // eviction branch runs repeatedly - which is the point.
      for (let cold = 0; cold < coldPerRound; cold++) {
        const coldPath = path.join(tmpDir, `cold-${round}-${cold}.jsonl`);
        fs.writeFileSync(coldPath, JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '/other' },
          timestamp: nowIso(10),
        }) + '\n');
        const verifier = createSlashCommandVerifier(coldPath)!;
        await verifier('/other', sentAt, 'submitted');
      }
    }

    // The guarantee, stated directly: an actively-polling burst is read ONCE,
    // however much unrelated churn passes through the cache around it. Under
    // clear-all each hot transcript is re-read after every overflow instead.
    const readsOf = (target: string) =>
      readSpy.mock.calls.filter((call) => call[0] === target).length
      + openSpy.mock.calls.filter((call) => call[0] === target).length;
    for (const hotPath of hotPaths) {
      expect(readsOf(hotPath)).toBe(1);
    }

    readSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('finds an entry at the tail of a transcript far larger than the read window', async () => {
    // The scan only ever needs the last few hundred ms of entries, so it reads a
    // bounded tail rather than the whole file. This is the case that bound
    // guards: a long session's JSONL is megabytes, and reading all of it per
    // poll is what made bursts expensive.
    const filler = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(400) },
      timestamp: nowIso(-60_000),
    });
    // Comfortably past the 256KB window.
    for (let line = 0; line < 2000; line++) appendEntry(JSON.parse(filler));
    expect(fs.statSync(jsonlPath).size).toBeGreaterThan(256 * 1024);

    const verifier = createSlashCommandVerifier(jsonlPath)!;
    const sentAt = Date.now();
    appendEntry({
      type: 'user',
      message: { role: 'user', content: '/merge-pull-request' },
      timestamp: nowIso(10),
    });

    expect(await verifier('/merge-pull-request', sentAt, 'submitted')).toBe(true);
  });
});
