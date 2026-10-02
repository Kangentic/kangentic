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

import { describe, it, expect, vi } from 'vitest';
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
import { sweepCommitRecords, RELINK_WINDOW_MS, type CommitIndexerDeps } from '../../src/main/retrieval/commit/commit-indexer';
import { SLICE_ROWS } from '../../src/main/retrieval/timed-slices';
import type { BranchHead } from '../../src/main/retrieval/branch-git';

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

import { adaptDatabase } from './helpers/node-sqlite-database';

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
  // A conversation belongs to a task on the board, as every real one does: a
  // commit linked to a task that is gone is unlinked by the sweep.
  database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
  let taskCount = 0;
  const ensureTask = (taskId: string): void => {
    if (database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) return;
    taskCount += 1;
    database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
      VALUES (?, ?, ?, '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`).run(taskId, taskCount, taskId);
  };
  /** A conversation's text, without the index bookkeeping a real indexing pass writes. */
  const mentionTextOnly = (taskId: string, text: string, atMs: number): string => {
    ensureTask(taskId);
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

  it('unlinks a commit whose task was deleted, and ties it to another task that wrote it', async () => {
    const fixture = project();
    const landed = NOW - DAY;
    fixture.mention('task-first', 'git commit -m "fix(graph): keep region names across a relabel"', landed - 60_000);
    fixture.git.commits = [commit(1, 'fix(graph): keep region names across a relabel', landed)];
    await fixture.sweep();
    expect(fixture.taskOf(sha(1))).toBe('task-first');
    // The task is deleted; its conversations leave with it (the purge). A
    // second task had also written that subject.
    fixture.database.exec(`DELETE FROM memory_chunks WHERE corpus = 'conversation' AND task_id = 'task-first'`);
    fixture.database.exec(`DELETE FROM tasks WHERE id = 'task-first'`);
    fixture.mention('task-second', 'Tool: Bash {"command":"git commit -m \\"fix(graph): keep region names across a relabel\\""}', landed - 30_000);

    const result = await fixture.sweep();

    expect(fixture.taskOf(sha(1))).toBe('task-second');
    // Unlinked from the deleted task, then tied to the other one.
    expect(result.relinked).toBe(2);
  });

  // A cleanup that deletes hundreds of done tasks leaves a commit for each, and
  // the unlink is written a slice at a time (`writeInSlices`), a commit costing
  // two rows against `SLICE_ROWS` a slice. More orphans than one slice holds
  // must all be unlinked, and counted, across the slice boundaries and the
  // item each slice carries into the next. The commits are old, so the relink
  // pass after the unlink adds nothing and `relinked` is the unlink's own count.
  //
  // Red-green: the code before this change wrote the whole list in one
  // transaction, so this test passes against it too and does not pin the
  // slicing as such. What it pins is the sliced call site keeping every orphan:
  // drop the `await` before `writeInSlices` in `unlinkCommitsOfDeletedTasks` and
  // only the first slice (written before the first yield) is unlinked and
  // counted, so the totals below fall short; remove `unlinked += 1` and
  // `relinked` is 0; hand `writeInSlices` the list cut to one slice and the rest
  // stay linked. The yield count is the precondition that the sweep really did
  // write in more than one slice.
  it('unlinks, and counts, every commit of a deleted task though they take several write slices', async () => {
    const fixture = project();
    const orphans = SLICE_ROWS * 2 + 1;
    const landed = NOW - RELINK_WINDOW_MS - DAY;
    const subjectOf = (number: number): string => `fix(graph): relabel case ${number} keeps its region names`;
    const shas = Array.from({ length: orphans }, (_, index) => sha(index + 1));
    fixture.mention(
      'task-doomed',
      Array.from({ length: orphans }, (_, index) => `git commit -m "${subjectOf(index + 1)}"`).join('\n'),
      landed - 60_000,
    );
    // Newest first, as `git log` prints them.
    fixture.git.commits = shas.map((_, index) => commit(index + 1, subjectOf(index + 1), landed + index)).reverse();
    fixture.git.head = { ref: 'origin/main', sha: sha(orphans) };
    expect(await fixture.sweep()).toEqual({ indexed: orphans, removed: 0, relinked: 0, deferred: false });
    // Precondition: every commit found its task, so the deletion below orphans each.
    expect(shas.map((commitSha) => fixture.taskOf(commitSha))).toEqual(shas.map(() => 'task-doomed'));
    const linkedCount = (entryCount: number): number => (fixture.database
      .prepare("SELECT COUNT(*) AS count FROM memory_index_state WHERE corpus = 'commit' AND entry_count = ?")
      .get(entryCount) as { count: number }).count;
    expect(linkedCount(1)).toBe(orphans);

    // The task is deleted and its conversation leaves with it (the purge).
    fixture.database.exec(`DELETE FROM memory_chunks WHERE corpus = 'conversation' AND task_id = 'task-doomed'`);
    fixture.database.exec(`DELETE FROM tasks WHERE id = 'task-doomed'`);
    const yields = vi.spyOn(fixture.deps, 'yieldToEventLoop');

    const result = await fixture.sweep();

    expect(yields.mock.calls.length).toBeGreaterThan(1);
    expect(result).toEqual({ indexed: 0, removed: 0, relinked: orphans, deferred: false });
    expect(shas.map((commitSha) => fixture.taskOf(commitSha))).toEqual(shas.map(() => null));
    expect(linkedCount(0)).toBe(orphans);
    expect(linkedCount(1)).toBe(0);
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

  describe('a commit that fails to index', () => {
    /**
     * Fail the next attempt at the middle commit (sha 2), once, then behave as
     * the real store does: at the write (`upsertDocument`) or while the commit
     * is prepared (`firstTaskMentioning`, its task lookup). Returns what puts
     * the store back.
     */
    function failOnce(stage: 'write' | 'prepare'): () => void {
      let failuresLeft = 1;
      if (stage === 'write') {
        const realUpsert = RetrievalStore.prototype.upsertDocument;
        const spy = vi.spyOn(RetrievalStore.prototype, 'upsertDocument').mockImplementation(function (this: RetrievalStore, ...args: Parameters<RetrievalStore['upsertDocument']>) {
          const [ref] = args;
          if (ref.corpus === 'commit' && ref.docId === sha(2) && failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('database is locked');
          }
          return realUpsert.apply(this, args);
        });
        return () => spy.mockRestore();
      }
      const realLookup = RetrievalStore.prototype.firstTaskMentioning;
      const spy = vi.spyOn(RetrievalStore.prototype, 'firstTaskMentioning').mockImplementation(function (this: RetrievalStore, ...args: Parameters<RetrievalStore['firstTaskMentioning']>) {
        // The subject of sha 2 is "feat: second thing on the branch".
        if (args[0].includes('second') && failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('database is locked');
        }
        return realLookup.apply(this, args);
      });
      return () => spy.mockRestore();
    }

    it.each(['write', 'prepare'] as const)('is retried from the old head by the next sweep, because the head is not stored after a failed %s', async (stage) => {
      const fixture = project();
      const storedHeadSha = (): string | undefined => (JSON.parse(fixture.store.getMeta('commit_index_head') ?? '{}') as { sha?: string }).sha;
      fixture.git.commits = [commit(1, 'feat: first thing on the branch', NOW - 3 * DAY)];
      fixture.git.head = { ref: 'origin/main', sha: sha(1) };
      await fixture.sweep();
      expect(storedHeadSha()).toBe(sha(1));
      // The branch moves forward by two commits, the middle one the one that fails.
      fixture.git.commits = [
        commit(3, 'feat: third thing on the branch', NOW - DAY),
        commit(2, 'feat: second thing on the branch', NOW - 2 * DAY),
        ...fixture.git.commits,
      ];
      fixture.git.head = { ref: 'origin/main', sha: sha(3) };
      fixture.git.ancestors.add(sha(1));
      fixture.git.logCalls.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const restoreStore = failOnce(stage);
      try {
        const failed = await fixture.sweep();

        // The failure was logged and skipped: the other commit was written.
        expect(warn.mock.calls.some((call) => String(call[0]).includes('failed'))).toBe(true);
        expect(failed.indexed).toBe(1);
        expect(fixture.indexedShas()).toEqual([sha(1), sha(3)]);
        // The head stays where it was, so the failed commit is not left behind the next read.
        expect(storedHeadSha()).toBe(sha(1));
        expect(fixture.git.logCalls).toEqual([{ head: sha(3), sinceSha: sha(1) }]);

        // The failure has cleared: the next sweep reads from the old head again.
        const retried = await fixture.sweep();

        expect(fixture.git.logCalls).toEqual([
          { head: sha(3), sinceSha: sha(1) },
          { head: sha(3), sinceSha: sha(1) },
        ]);
        // Only what is still missing: sha 3 is current, so it is not written again.
        expect(retried.indexed).toBe(1);
        expect([...fixture.indexedShas()].sort()).toEqual([sha(1), sha(2), sha(3)].sort());
        expect(storedHeadSha()).toBe(sha(3));
      } finally {
        restoreStore();
        warn.mockRestore();
      }
    });
  });
});
