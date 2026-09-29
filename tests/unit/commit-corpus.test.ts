/**
 * The `commit` corpus: the default branch's commits, each tied to the task
 * whose conversation first wrote its subject.
 *
 * The record half is pure. The sweep runs the REAL project migrations and the
 * REAL RetrievalStore against node:sqlite, so the full-text link lookup, the
 * diff-upsert and the index-state bookkeeping are the shipped ones; only git is
 * scripted. node:sqlite rather than better-sqlite3 on purpose: better-sqlite3
 * is compiled for Electron's Node ABI, so every suite gated on it skips.
 */

import { describe, it, expect } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import {
  COMMIT_LOG_FORMAT,
  commitChunks,
  commitLinkPhrase,
  commitSubjectOf,
  parseCommitLog,
  withoutTrailers,
  type CommitEntry,
} from '../../src/main/retrieval/commit/commit-record';
import { sweepCommitRecords, RELINK_WINDOW_MS, type BranchHead, type CommitIndexerDeps } from '../../src/main/retrieval/commit/commit-indexer';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;
type NodeDatabase = InstanceType<SqliteModule['DatabaseSync']>;

describe('commit records', () => {
  it('reads the records git log prints in the shipped format', () => {
    expect(COMMIT_LOG_FORMAT).toBe('%H%x1f%ct%x1f%s%x1f%b%x1e');
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const stdout = `${sha}\x1f1790000000\x1ffeat(pty): keep the resize debounce\x1fBody line.\n\x1e\n${other}\x1f1790000100\x1ffix: one\x1f\x1e\n`;
    expect(parseCommitLog(stdout)).toEqual([
      { sha, committedMs: 1_790_000_000_000, subject: 'feat(pty): keep the resize debounce', body: 'Body line.' },
      { sha: other, committedMs: 1_790_000_100_000, subject: 'fix: one', body: '' },
    ]);
    expect(parseCommitLog('not a record\x1e')).toEqual([]);
  });

  it('drops the trailer block, and only a block that is one', () => {
    expect(withoutTrailers('Why it changed.\n\nCo-Authored-By: Someone <dev@example.com>\nClaude-Session: https://example.com/s/1\n'))
      .toBe('Why it changed.');
    // A "Key: value" line inside the prose is not a trailer block.
    expect(withoutTrailers('Note: this keeps the old path.\nSecond line.')).toBe('Note: this keeps the old path.\nSecond line.');
    expect(withoutTrailers('Signed-off-by: Someone <dev@example.com>')).toBe('');
  });

  it('holds a commit as one chunk: subject, then body, at its commit time', () => {
    const commit: CommitEntry = { sha: 'c'.repeat(40), committedMs: 42, subject: 'fix(pty): hold the grid', body: 'Replay into a held grid.\n\nCo-Authored-By: Someone <dev@example.com>' };
    const [chunk] = commitChunks(commit);
    expect(chunk.text).toBe('fix(pty): hold the grid\n\nReplay into a held grid.');
    expect(chunk.role).toBe('commit');
    expect(chunk.tsStart).toBe(42);
    expect(commitSubjectOf(chunk.text)).toBe('fix(pty): hold the grid');
    expect(commitChunks({ ...commit, subject: '', body: '' })).toEqual([]);
  });

  it('finds a task by the first eight words of the subject, as a literal phrase', () => {
    expect(commitLinkPhrase('feat(memory): statuses read Done and Open, and the Projects row always shows'))
      .toBe('"feat memory statuses read Done and Open and"');
    // Operators are words inside a phrase, and punctuation separates as the index's tokenizer does.
    expect(commitLinkPhrase('fix: NOT "quoted" OR near_by thing')).toBe('"fix NOT quoted OR near by thing"');
    expect(commitLinkPhrase('wip')).toBeNull();
    expect(commitLinkPhrase('chore: bump')).toBeNull();
  });
});

/** node:sqlite behind the slice of better-sqlite3 the store uses, with nested
 *  transactions as savepoints (a slice's transaction wraps the upsert's own). */
function adaptDatabase(database: NodeDatabase): DatabaseType.Database {
  let depth = 0;
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        const savepoint = `sp_${depth}`;
        database.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const result = body(...args);
          depth -= 1;
          database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          depth -= 1;
          database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function sha(seed: number): string {
  return seed.toString(16).padStart(40, '0');
}

/** A project with conversations that mention commit subjects, and a scripted git. */
function project() {
  const database = new sqlite!.DatabaseSync(':memory:');
  const db = adaptDatabase(database);
  runProjectMigrations(db);
  const store = new RetrievalStore(db);
  let conversationCount = 0;
  /** A conversation's text, without the index bookkeeping a real indexing pass writes. */
  const mentionTextOnly = (taskId: string, text: string, atMs: number): string => {
    conversationCount += 1;
    const docId = `agent-${conversationCount}`;
    store.upsertDocument(
      { corpus: 'conversation', docId, sessionId: null, taskId, agentSessionId: docId, metaJson: null },
      [{ seq: 0, text, contentHash: `hash-${conversationCount}`, tokenEstimate: 10, role: 'assistant', tsStart: atMs, tsEnd: atMs, turnUuidStart: null, turnUuidEnd: null }],
    );
    return docId;
  };
  /** Its index state, as an indexing pass records it: this is what moves the relink marker. */
  const recordIndexed = (docId: string): void => {
    store.setIndexState({
      corpus: 'conversation', docId, sessionId: null, sourcePath: 'transcript.jsonl', sourceMtimeMs: 1, sourceSize: 1,
      entryCount: 1, chunkCount: 1, status: 'ok', indexedAt: new Date(NOW + conversationCount * 1000).toISOString(),
    });
  };
  const mention = (taskId: string, text: string, atMs: number): void => {
    recordIndexed(mentionTextOnly(taskId, text, atMs));
  };
  const git = {
    head: { ref: 'origin/main', sha: sha(1) } as BranchHead | null,
    /** Every commit on the branch, newest first. */
    commits: [] as CommitEntry[],
    ancestors: new Set<string>(),
    logCalls: [] as Array<{ head: string; sinceSha: string | null }>,
  };
  const deps: CommitIndexerDeps = {
    getDb: () => db,
    readHead: async () => git.head,
    readLog: async (_path, head, sinceSha) => {
      git.logCalls.push({ head, sinceSha });
      const all = git.commits;
      if (!sinceSha) return all;
      const stop = all.findIndex((commit) => commit.sha === sinceSha);
      return stop === -1 ? all : all.slice(0, stop);
    },
    isAncestor: async (_path, ancestor) => git.ancestors.has(ancestor),
    now: () => NOW,
    clock: () => 0,
    yieldToEventLoop: async () => undefined,
  };
  const taskOf = (commitSha: string): string | null => {
    const row = database.prepare("SELECT task_id AS taskId FROM memory_chunks WHERE corpus = 'commit' AND doc_id = ?").get(commitSha) as { taskId: string | null } | undefined;
    return row ? row.taskId : null;
  };
  const indexedShas = (): string[] => (database.prepare("SELECT doc_id AS docId FROM memory_chunks WHERE corpus = 'commit' ORDER BY id").all() as Array<{ docId: string }>).map((row) => row.docId);
  const sweep = (allowFullRead = true) => sweepCommitRecords('project', '/mock/repo', 'main', { allowFullRead }, deps);
  return { database, db, store, mention, mentionTextOnly, recordIndexed, git, deps, taskOf, indexedShas, sweep };
}

function commit(seed: number, subject: string, committedMs: number): CommitEntry {
  return { sha: sha(seed), committedMs, subject, body: '' };
}

describeWithSqlite('sweepCommitRecords', () => {
  it('ties each commit to the task that wrote its subject first, not one that quoted it later', async () => {
    const fixture = project();
    const landed = NOW - 2 * DAY;
    fixture.mention('task-writer', 'Tool: Write {"content":"feat(pty): keep the resize debounce on reattach"}', landed - 60_000);
    // A later review quotes it from `git log`.
    fixture.mention('task-reviewer', 'abc1234 feat(pty): keep the resize debounce on reattach', landed + DAY);
    // A subject nobody wrote in a conversation.
    fixture.git.commits = [
      commit(3, 'chore: tidy the release notes wording here', landed + 10),
      commit(2, 'feat(pty): keep the resize debounce on reattach', landed),
    ];
    fixture.git.head = { ref: 'origin/main', sha: sha(3) };

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 2, removed: 0, relinked: 0, deferred: false });
    expect(fixture.taskOf(sha(2))).toBe('task-writer');
    expect(fixture.taskOf(sha(3))).toBeNull();
    // Written oldest first, so an interrupted first sweep leaves a contiguous history.
    expect(fixture.indexedShas()).toEqual([sha(2), sha(3)]);
    expect(JSON.parse(fixture.store.getMeta('commit_index_head') ?? '{}')).toMatchObject({ ref: 'origin/main', sha: sha(3) });
  });

  it('reads nothing when the branch has not moved', async () => {
    const fixture = project();
    fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - DAY)];
    await fixture.sweep();
    fixture.git.logCalls.length = 0;

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 0, removed: 0, relinked: 0, deferred: false });
    expect(fixture.git.logCalls).toEqual([]);
  });

  it('reads only the new commits when the branch moved forward', async () => {
    const fixture = project();
    fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - 2 * DAY)];
    fixture.git.head = { ref: 'origin/main', sha: sha(1) };
    await fixture.sweep();
    fixture.git.commits = [commit(2, 'feat: second thing on the branch', NOW - DAY), ...fixture.git.commits];
    fixture.git.head = { ref: 'origin/main', sha: sha(2) };
    fixture.git.ancestors.add(sha(1));
    fixture.git.logCalls.length = 0;

    const result = await fixture.sweep();

    expect(fixture.git.logCalls).toEqual([{ head: sha(2), sinceSha: sha(1) }]);
    expect(result.indexed).toBe(1);
    expect(fixture.indexedShas()).toEqual([sha(1), sha(2)]);
  });

  it('reconciles a rewritten branch: a commit no longer on it leaves the index', async () => {
    const fixture = project();
    fixture.git.commits = [commit(2, 'feat: a commit that gets rewritten', NOW - DAY), commit(1, 'feat: first thing on the branch', NOW - 2 * DAY)];
    fixture.git.head = { ref: 'origin/main', sha: sha(2) };
    await fixture.sweep();
    // Force-pushed: 2 replaced by 3, and the old head is no ancestor of the new one.
    fixture.git.commits = [commit(3, 'feat: the rewritten commit instead', NOW - DAY), commit(1, 'feat: first thing on the branch', NOW - 2 * DAY)];
    fixture.git.head = { ref: 'origin/main', sha: sha(3) };

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 1, removed: 1, relinked: 0, deferred: false });
    expect(fixture.indexedShas().sort()).toEqual([sha(1), sha(3)].sort());
  });

  it('ties a young unlinked commit to its task once its conversation is indexed', async () => {
    const fixture = project();
    const landed = NOW - DAY;
    fixture.git.commits = [commit(1, 'fix(memory): drop the stale coverage cache', landed)];
    await fixture.sweep();
    expect(fixture.taskOf(sha(1))).toBeNull();
    fixture.mention('task-late', 'git commit -m "fix(memory): drop the stale coverage cache"', landed - 1000);

    const result = await fixture.sweep();

    expect(result.relinked).toBe(1);
    expect(fixture.taskOf(sha(1))).toBe('task-late');
  });

  it('does not retry an unlinked commit until a conversation has been indexed since the last try', async () => {
    const fixture = project();
    const landed = NOW - DAY;
    fixture.git.commits = [commit(1, 'fix(memory): drop the stale coverage cache', landed)];
    await fixture.sweep();
    // The text is there, but no indexing pass recorded it, so the marker the
    // retry waits on has not moved: a retry now would be a lookup for nothing.
    const docId = fixture.mentionTextOnly('task-late', 'fix(memory): drop the stale coverage cache', landed - 1000);

    expect((await fixture.sweep()).relinked).toBe(0);
    expect(fixture.taskOf(sha(1))).toBeNull();

    fixture.recordIndexed(docId);
    expect((await fixture.sweep()).relinked).toBe(1);
    expect(fixture.taskOf(sha(1))).toBe('task-late');
  });

  it('leaves an old unlinked commit alone', async () => {
    const fixture = project();
    const landed = NOW - RELINK_WINDOW_MS - DAY;
    fixture.git.commits = [commit(1, 'fix(memory): drop the stale coverage cache', landed)];
    await fixture.sweep();
    fixture.mention('task-late', 'fix(memory): drop the stale coverage cache', landed - 1000);

    expect((await fixture.sweep()).relinked).toBe(0);
    expect(fixture.taskOf(sha(1))).toBeNull();
  });

  it('reads the branch again after the index was cleared, though its head did not move', async () => {
    const fixture = project();
    fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - DAY)];
    await fixture.sweep();
    fixture.store.resetIndexState();
    fixture.git.logCalls.length = 0;

    const result = await fixture.sweep();

    expect(fixture.git.logCalls).toHaveLength(1);
    expect(result.indexed).toBe(1);
  });

  it('ranks keyword matches per corpus from one scan exactly as a query per corpus does', () => {
    const fixture = project();
    const add = (corpus: 'task' | 'commit', docId: string, text: string): void => {
      fixture.store.upsertDocument(
        { corpus, docId, sessionId: null, taskId: `task-${docId}`, agentSessionId: null, metaJson: null },
        [{ seq: 0, text, contentHash: `hash-${corpus}-${docId}`, tokenEstimate: 10, role: corpus, tsStart: 1, tsEnd: 1, turnUuidStart: null, turnUuidEnd: null }],
      );
    };
    add('task', 'one', 'Relay reconnect after the router restarts');
    add('task', 'two', 'Relay relay relay pairing and the mobile relay');
    add('task', 'three', 'Terminal renderer only');
    add('commit', 'a', 'fix(mobile-bridge): reconnect the relay with backoff');
    add('commit', 'b', 'feat(mobile-bridge): relay pairing, relay status and relay retries');
    fixture.mention('task-one', 'we talked about the relay here too', 1);

    const perCorpus = fixture.store.searchLexicalPerCorpus('"relay"', new Map([['task', 200], ['commit', 200]]));

    for (const corpus of ['task', 'commit'] as const) {
      const separate = fixture.store.searchLexical('"relay"', 200, [corpus]).map((hit) => ({ chunkId: hit.chunkId, rank: hit.rank }));
      expect(perCorpus.get(corpus)).toEqual(separate);
      expect(separate.length).toBe(2);
    }
    // Conversations were not asked for, so none come back.
    expect(perCorpus.has('conversation')).toBe(false);
  });

  it('does nothing for a project that is not a repository, or has no path', async () => {
    const fixture = project();
    fixture.git.head = null;
    fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - DAY)];
    expect(await fixture.sweep()).toEqual({ indexed: 0, removed: 0, relinked: 0, deferred: false });
    expect(await sweepCommitRecords('project', null, 'main', {}, fixture.deps)).toEqual({ indexed: 0, removed: 0, relinked: 0, deferred: false });
    expect(fixture.git.logCalls).toEqual([]);
  });

  it('puts off a whole-branch read when asked, but still follows a branch that only moved forward', async () => {
    const fixture = project();
    fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - 2 * DAY)];

    // The first read is the whole branch: put off, nothing read or written.
    expect(await fixture.sweep(false)).toEqual({ indexed: 0, removed: 0, relinked: 0, deferred: true });
    expect(fixture.git.logCalls).toEqual([]);
    expect(fixture.indexedShas()).toEqual([]);

    await fixture.sweep(true);
    fixture.git.commits = [commit(2, 'feat: second thing on the branch', NOW - DAY), ...fixture.git.commits];
    fixture.git.head = { ref: 'origin/main', sha: sha(2) };
    fixture.git.ancestors.add(sha(1));

    // A forward move is small, so it runs even while whole reads wait.
    const forward = await fixture.sweep(false);
    expect(forward).toMatchObject({ indexed: 1, deferred: false });
  });
});
