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

// Sentry DESKTOP-36 and DESKTOP-4C on 0.62.0: the folder holds every run of the
// day, so an earlier run made `present` true for a session that had no
// conversation of its own. Asked with the spawn time, the answer is about this
// session's rollout.
describe('Codex storeEvidence about one session (spawnedAt)', () => {
  let codexHome: string;
  let projectFolder: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const spawnedAt = new Date(Date.now() - 60_000);

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-session-'));
    projectFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-project-'));
    process.env.CODEX_HOME = codexHome;
    fs.mkdirSync(codexSessionsDirForToday(), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  /** A rollout Codex wrote, with the `session_meta` its first line carries. */
  function writeRollout(options: { id: string; cwd: string; createdAtMs: number; parentThreadId?: string }): void {
    const createdAt = new Date(options.createdAtMs).toISOString();
    const meta = {
      type: 'session_meta',
      payload: {
        id: options.id,
        cwd: options.cwd.replace(/\\/g, '/'),
        timestamp: createdAt,
        ...(options.parentThreadId ? { parent_thread_id: options.parentThreadId } : {}),
      },
    };
    const fileName = `rollout-${createdAt.replace(/[:.]/g, '-')}-${options.id}.jsonl`;
    fs.writeFileSync(path.join(codexSessionsDirForToday(), fileName), `${JSON.stringify(meta)}\n`);
  }

  const storeEvidence = (claimedSessionIds?: ReadonlySet<string>) => {
    const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
    if (!check) throw new Error('Codex declares no store evidence');
    return check({ cwd: projectFolder, spawnedAt, ...(claimedSessionIds ? { claimedSessionIds } : {}) });
  };

  // Sentry DESKTOP-36 on 0.63.0: an untouched Command Terminal read `present` from the rollout of
  // a Codex started 13 s later in the same folder. That id was another session's.
  it('reads absent for a later same-folder rollout whose id another session of this run holds', async () => {
    const siblingId = '88888888-8888-4888-8888-888888888888';
    writeRollout({ id: siblingId, cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 13_000 });
    await expect(storeEvidence(new Set([siblingId]))).resolves.toBe('absent');
  });

  it('still reads present for this session\'s own rollout beside a claimed sibling\'s', async () => {
    const siblingId = '88888888-8888-4888-8888-888888888888';
    writeRollout({ id: siblingId, cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 13_000 });
    writeRollout({ id: '99999999-9999-4999-8999-999999999999', cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 3_000 });
    await expect(storeEvidence(new Set([siblingId]))).resolves.toBe('present');
  });

  it('reads absent for a subagent\'s rollout, which is some parent\'s child and no conversation of this session', async () => {
    writeRollout({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd: projectFolder,
      createdAtMs: spawnedAt.getTime() + 20_000,
      parentThreadId: '88888888-8888-4888-8888-888888888888',
    });
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  // The real shape Codex 0.171.0 wrote for a spawn_agent child: parent_thread_id and
  // source.subagent both present. Only the cwd, the timestamps and the folder are rewritten.
  describe('a rollout built from the real 0.171.0 subagent session_meta', () => {
    const fixtureLines = fs
      .readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-0.171.0-subagent-session-meta.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    function writeFixtureRollout(mutatePayload: (payload: Record<string, unknown>) => void): void {
      const subagentLine = fixtureLines.map((line) => JSON.parse(line) as { payload: Record<string, unknown> })
        .find((parsed) => typeof parsed.payload.parent_thread_id === 'string');
      if (!subagentLine) throw new Error('the fixture holds no subagent session_meta');
      const createdAt = new Date(spawnedAt.getTime() + 20_000).toISOString();
      subagentLine.payload.cwd = projectFolder.replace(/\\/g, '/');
      subagentLine.payload.timestamp = createdAt;
      mutatePayload(subagentLine.payload);
      const id = subagentLine.payload.id as string;
      const fileName = `rollout-${createdAt.replace(/[:.]/g, '-')}-${id}.jsonl`;
      fs.writeFileSync(path.join(codexSessionsDirForToday(), fileName), `${JSON.stringify(subagentLine)}\n`);
    }

    it('reads absent with both subagent markers in place', async () => {
      writeFixtureRollout(() => undefined);
      await expect(storeEvidence()).resolves.toBe('absent');
    });

    it('reads absent on source.subagent alone, with parent_thread_id removed', async () => {
      writeFixtureRollout((payload) => { delete payload.parent_thread_id; });
      await expect(storeEvidence()).resolves.toBe('absent');
    });

    it('reads present once both markers are stripped, so the cases above read absent for the subagent reason', async () => {
      writeFixtureRollout((payload) => {
        delete payload.parent_thread_id;
        delete payload.source;
      });
      await expect(storeEvidence()).resolves.toBe('present');
    });
  });

  it('reads absent when the folder holds only runs from before this spawn', async () => {
    writeRollout({ id: '11111111-1111-4111-8111-111111111111', cwd: projectFolder, createdAtMs: spawnedAt.getTime() - 600_000 });
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('reads absent for a folder with no rollout in it, though the folder exists', async () => {
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('reads present for a rollout this session made, even minutes after its spawn', async () => {
    writeRollout({ id: '22222222-2222-4222-8222-222222222222', cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 240_000 });
    await expect(storeEvidence()).resolves.toBe('present');
  });

  it('reads present for a rollout made just after the spawn, as the capture window finds one', async () => {
    writeRollout({ id: '33333333-3333-4333-8333-333333333333', cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 2_000 });
    await expect(storeEvidence()).resolves.toBe('present');
  });

  it('reads absent for a rollout made since the spawn in another folder', async () => {
    writeRollout({ id: '44444444-4444-4444-8444-444444444444', cwd: path.join(projectFolder, 'other'), createdAtMs: spawnedAt.getTime() + 5_000 });
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('skips a file whose first line is not a session_meta, and one whose id disagrees with its name', async () => {
    const folder = codexSessionsDirForToday();
    fs.writeFileSync(path.join(folder, 'rollout-2026-11-23T10-00-00-55555555-5555-4555-8555-555555555555.jsonl'), 'not json\n');
    writeRollout({ id: '66666666-6666-4666-8666-666666666666', cwd: projectFolder, createdAtMs: spawnedAt.getTime() + 5_000 });
    const written = fs.readdirSync(folder).find((name) => name.includes('66666666'))!;
    fs.renameSync(path.join(folder, written), path.join(folder, written.replace('66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777')));
    await expect(storeEvidence()).resolves.toBe('absent');
  });

  it('reads unknown, not absent, when a folder could not be read and no rollout was found', async () => {
    const todayFolder = codexSessionsDirForToday();
    const yesterdayFolder = codexSessionsDirForYesterday();
    const directoryStats = fs.statSync(codexHome);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target) => {
      if (String(target) === todayFolder) return directoryStats;
      if (String(target) === yesterdayFolder) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(storeEvidence()).resolves.toBe('unknown');
  });

  it('keeps the folder-only answer when no spawn time is given', async () => {
    const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
    await expect(check?.({ cwd: projectFolder })).resolves.toBe('present');
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
