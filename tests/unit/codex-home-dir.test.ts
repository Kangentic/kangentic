import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { codexHomeDir } from '../../src/main/agent/adapters/codex/config-toml';
import {
  CodexSessionHistoryParser,
  codexSessionsDirForToday,
  codexSessionsDirForYesterday,
} from '../../src/main/agent/adapters/codex/session-history-parser';
import { locateCodexTranscriptFile } from '../../src/main/agent/adapters/codex/transcript-parser';

/**
 * Codex's home is `$CODEX_HOME` when set, else `~/.codex` (task #859). Every
 * reader of Codex's own files (rollout telemetry, the transcript viewer) must
 * resolve through it: with `~/.codex` hard-coded, a user who relocated Codex's
 * config dir got no rollout telemetry and no Conversation tab. Each test points
 * CODEX_HOME at a throwaway directory under os.tmpdir() and plants a rollout
 * where the code is meant to look, so a locator that ignored the variable
 * would look in the real home and miss it.
 */

// Synthetic on purpose: a real session id could exist in the developer's own
// ~/.codex and let a locator that ignored CODEX_HOME pass by finding that file.
const SESSION_ID = '00000000-0000-4000-8000-000000000859';
const ROLLOUT_CWD = 'C:/Users/dev/project';

/** The fixed UTC instant the date-directory tests run at. */
const NOW = new Date('2026-10-20T12:00:00.000Z');

let originalCodexHome: string | undefined;
let codexHome: string;

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  codexHome = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-dir-')));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(codexHome, { recursive: true, force: true });
});

describe('codexHomeDir', () => {
  it('is CODEX_HOME when it is set', () => {
    expect(codexHomeDir()).toBe(codexHome);
  });

  it('resolves a relative CODEX_HOME to an absolute path', () => {
    process.env.CODEX_HOME = 'relative-codex-home';
    expect(path.isAbsolute(codexHomeDir())).toBe(true);
    expect(codexHomeDir()).toBe(path.resolve('relative-codex-home'));
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('is ~/.codex when CODEX_HOME is %s', (_label, value) => {
    if (value === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = value;
    expect(codexHomeDir()).toBe(path.join(os.homedir(), '.codex'));
  });

  it('reads the variable on every call rather than caching the first value', () => {
    const otherHome = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-dir-other-')));
    try {
      expect(codexHomeDir()).toBe(codexHome);
      process.env.CODEX_HOME = otherHome;
      expect(codexHomeDir()).toBe(otherHome);
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

describe('rollout locators follow CODEX_HOME', () => {
  // Only Date is faked: locate() and the capture scan sleep on a real setTimeout
  // between attempts, and a faked timer would hang them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  /** Plant a rollout named like Codex's own under `<CODEX_HOME>/sessions/<year>/<month>/<day>`. */
  function plantRollout(year: string, month: string, day: string, sessionId: string): string {
    const directory = path.join(codexHome, 'sessions', year, month, day);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `rollout-${year}-${month}-${day}T12-00-00-${sessionId}.jsonl`);
    const sessionMeta = {
      timestamp: NOW.toISOString(),
      type: 'session_meta',
      payload: { id: sessionId, timestamp: NOW.toISOString(), cwd: ROLLOUT_CWD, cli_version: '0.163.0' },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(sessionMeta)}\n`);
    // The capture scan pre-filters on mtime, read against the faked clock.
    fs.utimesSync(filePath, NOW, NOW);
    return filePath;
  }

  it('builds today\'s and yesterday\'s session directories under <CODEX_HOME>/sessions/YYYY/MM/DD in UTC', () => {
    expect(codexSessionsDirForToday()).toBe(path.join(codexHome, 'sessions', '2026', '10', '20'));
    expect(codexSessionsDirForYesterday()).toBe(path.join(codexHome, 'sessions', '2026', '10', '19'));
  });

  it('locate finds the rollout of a session planted under <CODEX_HOME>/sessions/YYYY/MM/DD', async () => {
    const planted = plantRollout('2026', '10', '20', SESSION_ID);
    const found = await CodexSessionHistoryParser.locate({ agentSessionId: SESSION_ID, cwd: ROLLOUT_CWD });
    expect(found).toBe(planted);
  }, 15_000);

  it('captureSessionIdFromFilesystem finds the session whose session_meta was planted under CODEX_HOME', async () => {
    plantRollout('2026', '10', '20', SESSION_ID);
    const captured = await CodexSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: NOW,
      cwd: ROLLOUT_CWD,
      maxAttempts: 1,
    });
    expect(captured).toBe(SESSION_ID);
  }, 15_000);

  it('locateCodexTranscriptFile walks the dated tree under <CODEX_HOME>/sessions to an older day', () => {
    const planted = plantRollout('2026', '03', '14', SESSION_ID);
    expect(locateCodexTranscriptFile(SESSION_ID)).toBe(planted);
  });

  it('locateCodexTranscriptFile finds nothing in a CODEX_HOME that holds no rollout of that session', () => {
    plantRollout('2026', '03', '14', SESSION_ID);
    const emptyHome = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-dir-empty-')));
    try {
      process.env.CODEX_HOME = emptyHome;
      expect(locateCodexTranscriptFile(SESSION_ID)).toBeNull();
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
