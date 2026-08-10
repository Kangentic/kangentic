/**
 * Tests for Copilot's `command-injection` verifier.
 *
 * Copilot's adapter used to declare "no history file". It has one -
 * `~/.copilot/command-history-state.json` - and it is the FASTEST of any
 * adapter: measured 36-38ms, dead flat against turns of 3s, 12s, 23s and 32s
 * (`scripts/measure-injection-flush.mjs`, 2026-08-09). Slash commands are
 * recorded too, unlike Codex and OpenCode.
 *
 * It is not a transcript though, and every guard below exists because of one of
 * its differences: GLOBAL across all sessions and projects, NEWEST FIRST, no
 * timestamps, no session id, rewritten in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import {
  readRecentCopilotCommands,
  resolveCopilotHistoryPath,
  createCopilotCommandInjectionVerifier,
} from '../../src/main/agent/adapters/copilot/command-injection-verifier';

/** The real on-disk shape, newest first (verified against live probe data). */
function historyFile(commands: string[]): string {
  return JSON.stringify({ commandHistory: commands });
}

describe('readRecentCopilotCommands', () => {
  it('returns entries newest-first, as Copilot writes them', () => {
    // Verified empirically: after submitting short, then long, then slash
    // probes, index 0 held the SLASH probe - the most recent.
    const recent = readRecentCopilotCommands(historyFile(['newest', 'middle', 'oldest']));
    expect(recent).toEqual(['newest', 'middle', 'oldest']);
  });

  it('caps how far back a match may come from', () => {
    const many = Array.from({ length: 20 }, (_, index) => `command-${index}`);
    const recent = readRecentCopilotCommands(historyFile(many));
    expect(recent).toHaveLength(5);
    expect(recent?.[0]).toBe('command-0');
  });

  it('survives a partial write mid-flush', () => {
    // The file is rewritten in place, so a poll can catch it half-written.
    expect(readRecentCopilotCommands('{"commandHistory": ["a", "b"')).toBeNull();
    expect(readRecentCopilotCommands('')).toBeNull();
  });

  it('returns null when the shape is not what we expect', () => {
    expect(readRecentCopilotCommands('{}')).toBeNull();
    expect(readRecentCopilotCommands('{"commandHistory": "not-an-array"}')).toBeNull();
    expect(readRecentCopilotCommands('[]')).toBeNull();
  });

  it('drops non-string entries rather than throwing on them', () => {
    const raw = JSON.stringify({ commandHistory: ['ok', 42, null, 'also-ok'] });
    expect(readRecentCopilotCommands(raw)).toEqual(['ok', 'also-ok']);
  });
});

describe('exactness', () => {
  // The verifier compares `entry.trim() === text.trim()` over these entries.
  // These cases pin the property that comparison must preserve.
  it('a containing entry is NOT the command', () => {
    const recent = readRecentCopilotCommands(historyFile(['instead can we/pull-request']))!;
    const expected = '/pull-request';
    // The swallowed-Enter bug verbatim: a substring test would confirm exactly
    // the failure the verifier exists to catch.
    expect(recent.some((entry) => entry.trim() === expected)).toBe(false);
    expect(recent.some((entry) => entry.includes(expected))).toBe(true);
  });

  it('an exact entry among the newest few IS the command', () => {
    // Not always index 0: the file is global, so a concurrent injection from
    // another task can push ours down. Matching a few leading entries biases
    // the residual error toward a harmless false positive rather than a false
    // negative, which would escalate into a session restart.
    const recent = readRecentCopilotCommands(historyFile([
      'another task command',
      '/pull-request',
      'older thing',
    ]))!;
    expect(recent.some((entry) => entry.trim() === '/pull-request')).toBe(true);
  });
});

describe('createCopilotCommandInjectionVerifier', () => {
  // Drives the REAL assembled verifier, not just readRecentCopilotCommands.
  // This is the only place the mtime guard (command-injection-verifier.ts,
  // `if (mtimeMs < sentAt - SENT_AT_TOLERANCE_MS) return false;`) is exercised:
  // it is what stops the verifier from confirming a months-old identical entry
  // in Copilot's GLOBAL, no-per-record-timestamp history file as evidence for a
  // submission that never happened.
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-copilot-verifier-'));
    tmpHome = path.join(tmpBase, 'home');
    fs.mkdirSync(tmpHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /** Writes the history file and stamps its mtime explicitly, never relying on wall-clock ordering. */
  function writeHistoryFileWithMtime(commands: string[], mtimeMs: number): string {
    const filePath = resolveCopilotHistoryPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, historyFile(commands));
    const mtimeSeconds = mtimeMs / 1000;
    fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
  }

  it('does NOT confirm an exact match whose file predates this submission (the mtime guard)', async () => {
    // The hazard the guard exists for: the newest entry is an EXACT match for
    // the text we submitted, but the file itself was last written 90 days
    // before `sentAt` - so this could only be a leftover entry from an
    // earlier, unrelated submission (the "months-old identical entry" hazard
    // this guard exists to close). Without the mtime guard this reads as
    // confirmed even though nothing was written for THIS submission.
    const sentAt = Date.now();
    const ninetyDaysInMs = 90 * 24 * 60 * 60 * 1000;
    writeHistoryFileWithMtime(['/pull-request'], sentAt - ninetyDaysInMs);

    const verifier = createCopilotCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection',
      text: '/pull-request',
      sentAt,
      mode: 'submitted',
    })).toBe(false);
  });

  it('confirms the same exact match once the file was actually rewritten at/after sentAt', async () => {
    // Paired positive control: identical fixture content to the stale case
    // above, differing only in mtime. Proves the stale test fails for the
    // mtime guard specifically, not because the fixture never matches anything.
    const sentAt = Date.now();
    writeHistoryFileWithMtime(['/pull-request'], sentAt + 10);

    const verifier = createCopilotCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection',
      text: '/pull-request',
      sentAt,
      mode: 'submitted',
    })).toBe(true);
  });

  it('does not confirm when the file is fresh but the newest entries do not exactly match', async () => {
    // The swallowed-Enter bug verbatim, driven through the real verifier: a
    // freshly-rewritten file whose newest entry only CONTAINS the submitted
    // text must not confirm.
    const sentAt = Date.now();
    writeHistoryFileWithMtime(['instead can we/pull-request'], sentAt + 10);

    const verifier = createCopilotCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection',
      text: '/pull-request',
      sentAt,
      mode: 'submitted',
    })).toBe(false);
  });

  it('treats a missing history file as "keep polling", not a failure', async () => {
    const verifier = createCopilotCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection',
      text: '/pull-request',
      sentAt: Date.now(),
      mode: 'submitted',
    })).toBe(false);
  });
});
