/**
 * Codex's answer to "did it write any rollout at all", which the session-id
 * report sends as `id_store` (Sentry DESKTOP-36 could not say whether the
 * rollout folder the capture scans existed). Runs the adapter's real check on a
 * sandboxed CODEX_HOME, so no test reads or writes the developer's ~/.codex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import {
  codexSessionsDirForToday,
  codexSessionsDirForYesterday,
} from '../../src/main/agent/adapters/codex/session-history-parser';
import { pathStoreEvidence } from '../../src/main/agent/shared/store-evidence';

describe('Codex session id store evidence', () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-evidence-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  const storeEvidence = () => {
    const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
    if (!check) throw new Error('Codex declares no store evidence');
    return check({ cwd: codexHome });
  };

  it('reads absent when Codex has written no rollout folder for today or yesterday', async () => {
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('reads present once today\'s rollout folder exists', async () => {
    fs.mkdirSync(codexSessionsDirForToday(), { recursive: true });
    await expect(storeEvidence()).resolves.toBe('present');
  });

  it('reads present when only yesterday\'s rollout folder exists', async () => {
    fs.mkdirSync(codexSessionsDirForYesterday(), { recursive: true });
    await expect(storeEvidence()).resolves.toBe('present');
  });

  it('reads absent when today\'s path is a file rather than a folder', async () => {
    const todayPath = codexSessionsDirForToday();
    fs.mkdirSync(path.dirname(todayPath), { recursive: true });
    fs.writeFileSync(todayPath, '');
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('answers unknown for a Codex on an SSH host, whose folders are not here', async () => {
    const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
    await expect(check?.({ cwd: codexHome, cliTarget: { kind: 'ssh', hostId: 'host-1', roots: [] } as never })).resolves.toBe('unknown');
  });
});

// Codex reduces today's and yesterday's folder answers: present > unknown > absent.
describe('Codex storeEvidence reduction of the two folder answers', () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-reduce-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  /** Answer each folder's stat by its path: a rejection with the given code, or a real directory's stats. */
  function stubFolderStats(todayAnswer: 'EACCES' | 'ENOENT' | 'exists', yesterdayAnswer: 'EACCES' | 'ENOENT' | 'exists'): void {
    const todayFolder = codexSessionsDirForToday();
    const yesterdayFolder = codexSessionsDirForYesterday();
    const directoryStats = fs.statSync(codexHome);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target) => {
      const answer = String(target) === todayFolder ? todayAnswer : String(target) === yesterdayFolder ? yesterdayAnswer : 'ENOENT';
      if (answer === 'exists') return directoryStats;
      throw Object.assign(new Error(answer), { code: answer });
    });
  }

  const storeEvidence = () => {
    const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
    if (!check) throw new Error('Codex declares no store evidence');
    return check({ cwd: codexHome });
  };

  it('reads unknown when one folder is unreadable and the other is missing', async () => {
    stubFolderStats('EACCES', 'ENOENT');
    await expect(storeEvidence()).resolves.toBe('unknown');
  });

  it('reads unknown when yesterday is unreadable and today is missing', async () => {
    stubFolderStats('ENOENT', 'EACCES');
    await expect(storeEvidence()).resolves.toBe('unknown');
  });

  it('reads present when one folder is unreadable and the other exists', async () => {
    stubFolderStats('EACCES', 'exists');
    await expect(storeEvidence()).resolves.toBe('present');
  });

  it('reads present when today exists and yesterday is unreadable', async () => {
    stubFolderStats('exists', 'EACCES');
    await expect(storeEvidence()).resolves.toBe('present');
  });
});

describe('pathStoreEvidence error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a stat failure other than a missing path to unknown', async () => {
    const accessDenied = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(accessDenied);
    await expect(pathStoreEvidence(path.join(os.tmpdir(), 'store-evidence-denied'), 'directory')).resolves.toBe('unknown');
  });

  it('maps a missing path to absent', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(missing);
    await expect(pathStoreEvidence(path.join(os.tmpdir(), 'store-evidence-missing'), 'file')).resolves.toBe('absent');
  });
});
