/**
 * What the Knowledge Graph knows about a task, and the commit search
 * `kangentic_search` runs, read from a REAL project database.
 *
 * Covers `readTaskKnowledge` (summary, linked commits, changed files),
 * `RetrievalStore.commitsForTask` / `commitsByShaPrefix`, `searchCommits`, and
 * that `readSummaryCandidates` still reads the changed files the way it did.
 * The real project migrations and the real RetrievalStore run against real
 * better-sqlite3, the driver production uses, so the SQL, the full-text index
 * and the `doc_id` range are the shipped ones.
 */

import { afterEach, describe, it, expect } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { SummaryStore } from '../../src/main/retrieval/summary/summary-store';
import { readSummaryCandidates } from '../../src/main/retrieval/summary/summary-sources';
import { commitChunks, subjectForAgents } from '../../src/main/retrieval/commit/commit-record';
import { COMMIT_HITS, searchCommits } from '../../src/main/retrieval/commit/commit-search';
import {
  readTaskKnowledge,
  TASK_KNOWLEDGE_COMMITS,
  TASK_KNOWLEDGE_FILES,
} from '../../src/main/retrieval/task-knowledge';

import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const DAY = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 8, 1);
const LATER_ISO = '2026-09-20T18:30:00.000Z';

/** A 40 digit sha that starts with `prefix`, padded with zeros. */
function shaStartingWith(prefix: string, ending = ''): string {
  return `${prefix}${'0'.repeat(40 - prefix.length - ending.length)}${ending}`;
}

/** A project database with a Done lane and an In Progress lane, and helpers to fill it. */
function project() {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const store = new RetrievalStore(database);
  const now = '2026-09-01T00:00:00.000Z';
  let sessionCount = 0;

  database.prepare('INSERT INTO swimlanes (id, name, role, position, created_at) VALUES (?, ?, ?, ?, ?)').run('lane-done', 'Done', 'done', 1, now);
  database.prepare('INSERT INTO swimlanes (id, name, role, position, created_at) VALUES (?, ?, ?, ?, ?)').run('lane-work', 'In Progress', null, 0, now);

  const addTask = (taskId: string, displayId: number, title: string, laneId = 'lane-work'): void => {
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at, display_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, title, 'A description.', laneId, displayId, now, now, displayId);
  };
  const addSession = (taskId: string, agentSessionId: string | null): void => {
    sessionCount += 1;
    database
      .prepare('INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`session-${sessionCount}`, taskId, 'task_agent', agentSessionId, 'claude', '/mock/repo', 'exited', new Date(BASE_MS + sessionCount * 60_000).toISOString());
  };
  /** A session-changes document, as the change indexer writes it: a header line, then a file per line. */
  const addChangeDocument = (agentSessionId: string, taskId: string, files: string[]): void => {
    store.upsertDocument(
      { corpus: 'change', docId: agentSessionId, sessionId: null, taskId, agentSessionId, metaJson: null },
      [{
        seq: 0, text: `Files changed:\n${files.join('\n')}`, contentHash: `change-${agentSessionId}`,
        tokenEstimate: 10, role: 'change', tsStart: 1, tsEnd: 1, turnUuidStart: null, turnUuidEnd: null,
      }],
    );
  };
  const addCommit = (sha: string, subject: string, committedMs: number, taskId: string | null, body = ''): void => {
    store.upsertDocument(
      { corpus: 'commit', docId: sha, sessionId: null, taskId, agentSessionId: null, metaJson: null },
      commitChunks({ sha, committedMs, subject, body }),
    );
  };
  return { database, store, addTask, addSession, addChangeDocument, addCommit };
}

describe('subjectForAgents', () => {
  it('spells a squash-merge\'s pull request number as PR, so it never reads as a task', () => {
    expect(subjectForAgents('fix(relay): back off on reconnect (#812)')).toBe('fix(relay): back off on reconnect (PR 812)');
  });

  it('rewrites every parenthesized number and leaves other hashes alone', () => {
    expect(subjectForAgents('Revert "feat: pair (#12)" (#13)')).toBe('Revert "feat: pair (PR 12)" (PR 13)');
    expect(subjectForAgents('fix: closes #42 for good')).toBe('fix: closes #42 for good');
    expect(subjectForAgents('fix: odd (#abc) tag')).toBe('fix: odd (#abc) tag');
  });
});

describe('commit lookups in the retrieval store', () => {
  it('lists a task\'s linked commits newest first, and never an unlinked one or another task\'s', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'feat: oldest linked commit', BASE_MS, 'task-a');
    fixture.addCommit(shaStartingWith('a2'), 'feat: newest linked commit', BASE_MS + 2 * DAY, 'task-a');
    fixture.addCommit(shaStartingWith('a3'), 'feat: middle linked commit', BASE_MS + DAY, 'task-a');
    fixture.addCommit(shaStartingWith('b1'), 'feat: another task commit', BASE_MS + DAY, 'task-b');
    fixture.addCommit(shaStartingWith('c1'), 'feat: an unlinked commit', BASE_MS + DAY, null);

    const commits = fixture.store.commitsForTask('task-a');

    expect(commits.map((commit) => commit.sha)).toEqual([shaStartingWith('a2'), shaStartingWith('a3'), shaStartingWith('a1')]);
    expect(commits[0]).toMatchObject({ text: 'feat: newest linked commit', committedMs: BASE_MS + 2 * DAY });
    expect(fixture.store.commitsForTask('task-with-none')).toEqual([]);
  });

  describe('commitsByShaPrefix', () => {
    function withPrefixedShas() {
      const fixture = project();
      // Three commits share the prefix "abcdef", one of them continuing with
      // the highest hex digit. The neighbours on either side of its range
      // ("abcdee" below, "abcdf0" above) must stay out of it.
      fixture.addCommit(shaStartingWith('abcdef01'), 'feat: first of the group', BASE_MS, 'task-a');
      fixture.addCommit(shaStartingWith('abcdef02'), 'feat: second of the group', BASE_MS + DAY, null);
      fixture.addCommit(shaStartingWith('abcdeff5'), 'feat: continues with the highest hex digit', BASE_MS - DAY, null);
      fixture.addCommit(shaStartingWith('abcdee09'), 'feat: sorts just below the range', BASE_MS + 2 * DAY, null);
      fixture.addCommit(shaStartingWith('abcdf003'), 'feat: sorts just above the range', BASE_MS + 3 * DAY, null);
      return fixture;
    }

    it('returns every commit the prefix starts, newest first, and none from either neighbour', () => {
      const { store } = withPrefixedShas();
      const found = store.commitsByShaPrefix('abcdef', 10);
      expect(found.map((commit) => commit.sha)).toEqual([
        shaStartingWith('abcdef02'),
        shaStartingWith('abcdef01'),
        shaStartingWith('abcdeff5'),
      ]);
    });

    it('carries the task each commit is linked to, null for an unlinked one', () => {
      const { store } = withPrefixedShas();
      const found = store.commitsByShaPrefix('abcdef', 10);
      expect(found.map((commit) => commit.taskId)).toEqual([null, 'task-a', null]);
    });

    it('narrows to one commit with a longer prefix, and to none with one that matches nothing', () => {
      const { store } = withPrefixedShas();
      expect(store.commitsByShaPrefix('abcdef01', 10).map((commit) => commit.sha)).toEqual([shaStartingWith('abcdef01')]);
      expect(store.commitsByShaPrefix('fffffff', 10)).toEqual([]);
    });

    it('reads a prefix typed in capitals', () => {
      const { store } = withPrefixedShas();
      expect(store.commitsByShaPrefix('ABCDEF01', 10).map((commit) => commit.sha)).toEqual([shaStartingWith('abcdef01')]);
    });

    it('stops at the limit, keeping the newest', () => {
      const { store } = withPrefixedShas();
      expect(store.commitsByShaPrefix('abcdef', 1).map((commit) => commit.sha)).toEqual([shaStartingWith('abcdef02')]);
    });

    it('never matches a document from another corpus', () => {
      const fixture = withPrefixedShas();
      fixture.store.upsertDocument(
        { corpus: 'conversation', docId: 'abcdef77', sessionId: null, taskId: null, agentSessionId: 'abcdef77', metaJson: null },
        [{ seq: 0, text: 'a conversation', contentHash: 'h', tokenEstimate: 1, role: 'assistant', tsStart: 1, tsEnd: 1, turnUuidStart: null, turnUuidEnd: null }],
      );
      expect(fixture.store.commitsByShaPrefix('abcdef7', 10)).toEqual([]);
    });
  });
});

describe('searchCommits', () => {
  it('finds a commit by a word in its subject, with the task it came from', () => {
    const fixture = project();
    fixture.addTask('task-a', 561, 'Relay config');
    fixture.addCommit(shaStartingWith('a1'), 'fix(relay): back off on reconnect', BASE_MS, 'task-a');
    fixture.addCommit(shaStartingWith('b1'), 'feat(terminal): repaint after resize', BASE_MS + DAY, null);

    const hits = searchCommits(fixture.database, 'reconnect');

    expect(hits).toEqual([{
      sha: shaStartingWith('a1'),
      subject: 'fix(relay): back off on reconnect',
      committedMs: BASE_MS,
      taskId: 'task-a',
      displayId: 561,
      taskTitle: 'Relay config',
    }]);
  });

  it('finds a commit by a word in its body', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'fix: quiet the noise', BASE_MS, null, 'The watchdog fired twice when the router restarted.');
    expect(searchCommits(fixture.database, 'watchdog').map((hit) => hit.sha)).toEqual([shaStartingWith('a1')]);
  });

  it('shows a squash-merge\'s pull request as PR, not as a task mark', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'fix(relay): back off on reconnect (#812)', BASE_MS, null);
    expect(searchCommits(fixture.database, 'reconnect')[0].subject).toBe('fix(relay): back off on reconnect (PR 812)');
  });

  it('reports an unlinked commit with no task', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'chore: tidy the release notes wording', BASE_MS, null);
    expect(searchCommits(fixture.database, 'tidy')[0]).toMatchObject({ taskId: null, displayId: null, taskTitle: null });
  });

  it('reports a commit linked to a task that no longer exists as unlinked', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'chore: tidy the release notes wording', BASE_MS, 'task-deleted');
    expect(searchCommits(fixture.database, 'tidy')[0]).toMatchObject({ taskId: null, displayId: null, taskTitle: null });
  });

  it('keeps only one task\'s commits when given its id', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    fixture.addTask('task-b', 2, 'Two');
    fixture.addCommit(shaStartingWith('a1'), 'fix(relay): reconnect for one', BASE_MS, 'task-a');
    fixture.addCommit(shaStartingWith('b1'), 'fix(relay): reconnect for two', BASE_MS + DAY, 'task-b');
    fixture.addCommit(shaStartingWith('c1'), 'fix(relay): reconnect for nobody', BASE_MS + 2 * DAY, null);

    expect(searchCommits(fixture.database, 'reconnect', { taskId: 'task-a' }).map((hit) => hit.sha)).toEqual([shaStartingWith('a1')]);
    expect(searchCommits(fixture.database, 'reconnect').map((hit) => hit.sha).sort()).toEqual(
      [shaStartingWith('a1'), shaStartingWith('b1'), shaStartingWith('c1')].sort(),
    );
  });

  it('looks a sha prefix up as a sha, newest first, narrowed by task', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    fixture.addCommit(shaStartingWith('abcdef01'), 'feat: first of the pair', BASE_MS, 'task-a');
    fixture.addCommit(shaStartingWith('abcdef02'), 'feat: second of the pair', BASE_MS + DAY, null);
    fixture.addCommit(shaStartingWith('abcdf003'), 'feat: outside the prefix', BASE_MS + 2 * DAY, null);

    expect(searchCommits(fixture.database, 'abcdef0').map((hit) => hit.sha)).toEqual([shaStartingWith('abcdef02'), shaStartingWith('abcdef01')]);
    expect(searchCommits(fixture.database, ' ABCDEF01 ').map((hit) => hit.sha)).toEqual([shaStartingWith('abcdef01')]);
    expect(searchCommits(fixture.database, 'abcdef0', { taskId: 'task-a' }).map((hit) => hit.sha)).toEqual([shaStartingWith('abcdef01')]);
    expect(searchCommits(fixture.database, 'fffffff')).toEqual([]);
  });

  it('does not take a prefix shorter than seven digits for a sha', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('abcdef01'), 'feat: first of the pair', BASE_MS, null);
    expect(searchCommits(fixture.database, 'abcdef')).toEqual([]);
  });

  it('keeps a bare number\'s keyword matches beside the commits whose sha starts with it', () => {
    const fixture = project();
    // X's sha starts with the digits. Y only says them in its subject. Z does both.
    fixture.addCommit(shaStartingWith('1234567', '1'), 'chore: tidy the wording', BASE_MS, null);
    fixture.addCommit(shaStartingWith('ffffffff'), 'fix(relay): give up after 1234567 ms', BASE_MS + DAY, null);
    fixture.addCommit(shaStartingWith('1234567', '2'), 'perf: cache 1234567 rows', BASE_MS + 2 * DAY, null);

    const shas = searchCommits(fixture.database, '1234567').map((hit) => hit.sha);

    expect(shas).toEqual([shaStartingWith('1234567', '2'), shaStartingWith('1234567', '1'), shaStartingWith('ffffffff')]);
    // The commit that is both is one hit, not two.
    expect(new Set(shas).size).toBe(shas.length);
  });

  it('stops at the hit cap, and at a limit it is given', () => {
    const fixture = project();
    for (let index = 0; index < COMMIT_HITS + 2; index += 1) {
      fixture.addCommit(shaStartingWith('d', index.toString(16)), `fix(relay): reconnect attempt number ${index}`, BASE_MS + index * DAY, null);
    }
    expect(searchCommits(fixture.database, 'reconnect')).toHaveLength(COMMIT_HITS);
    expect(searchCommits(fixture.database, 'reconnect', { limit: 3 })).toHaveLength(3);
  });

  it('returns nothing for a blank query, and does not choke on full-text syntax', () => {
    const fixture = project();
    fixture.addCommit(shaStartingWith('a1'), 'fix(relay): back off on reconnect', BASE_MS, null);
    expect(searchCommits(fixture.database, '   ')).toEqual([]);
    expect(() => searchCommits(fixture.database, '"reconnect" OR (NEAR')).not.toThrow();
    expect(searchCommits(fixture.database, 'nothingwritesthisword')).toEqual([]);
  });
});

describe('readTaskKnowledge', () => {
  it('reads nothing for no tasks', () => {
    expect(readTaskKnowledge(project().database, []).size).toBe(0);
  });

  it('knows nothing about a task the index has nothing for', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    expect(readTaskKnowledge(fixture.database, ['task-a']).get('task-a')).toEqual({
      summary: null,
      commits: [],
      commitCount: 0,
      changedFiles: [],
      changedFileCount: 0,
    });
  });

  it('carries a written summary with the moment it was written', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One', 'lane-done');
    fixture.addTask('task-b', 2, 'Two', 'lane-done');
    new SummaryStore(fixture.database).write({
      taskId: 'task-a', summary: 'Made the relay reconnect after a router restart.', inputHash: 'hash',
      agent: 'claude', model: null, effort: null, createdAt: LATER_ISO,
    });

    const knowledge = readTaskKnowledge(fixture.database, ['task-a', 'task-b']);

    expect(knowledge.get('task-a')?.summary).toEqual({ text: 'Made the relay reconnect after a router restart.', writtenAt: LATER_ISO });
    expect(knowledge.get('task-b')?.summary).toBeNull();
  });

  it('lists the three newest linked commits with a count of them all, and rewrites a pull request number', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    for (let index = 0; index < 5; index += 1) {
      fixture.addCommit(shaStartingWith('a', String(index)), `feat(relay): step ${index} of the rework (#8${index})`, BASE_MS + index * DAY, 'task-a');
    }
    fixture.addCommit(shaStartingWith('b'), 'feat: an unlinked commit', BASE_MS + 9 * DAY, null);
    fixture.addCommit(shaStartingWith('c'), 'feat: another task commit', BASE_MS + 9 * DAY, 'task-b');

    const knowledge = readTaskKnowledge(fixture.database, ['task-a']).get('task-a');

    expect(TASK_KNOWLEDGE_COMMITS).toBe(3);
    expect(knowledge?.commitCount).toBe(5);
    expect(knowledge?.commits).toEqual([
      { sha: shaStartingWith('a', '4'), subject: 'feat(relay): step 4 of the rework (PR 84)', committedAt: new Date(BASE_MS + 4 * DAY).toISOString() },
      { sha: shaStartingWith('a', '3'), subject: 'feat(relay): step 3 of the rework (PR 83)', committedAt: new Date(BASE_MS + 3 * DAY).toISOString() },
      { sha: shaStartingWith('a', '2'), subject: 'feat(relay): step 2 of the rework (PR 82)', committedAt: new Date(BASE_MS + 2 * DAY).toISOString() },
    ]);
  });

  it('ranks the changed files by how many sessions changed each, counting a resumed session once', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    // Two session rows share one transcript (a resume): its files count once.
    fixture.addSession('task-a', 'agent-first');
    fixture.addSession('task-a', 'agent-first');
    fixture.addSession('task-a', 'agent-second');
    fixture.addSession('task-a', 'agent-third');
    fixture.addSession('task-a', null);
    fixture.addChangeDocument('agent-first', 'task-a', ['src/a.ts', 'src/c.ts']);
    fixture.addChangeDocument('agent-second', 'task-a', ['src/b.ts', 'src/d.ts']);
    fixture.addChangeDocument('agent-third', 'task-a', ['src/b.ts']);

    const knowledge = readTaskKnowledge(fixture.database, ['task-a']).get('task-a');

    // src/b.ts was changed by two sessions, every other file by one.
    expect(knowledge?.changedFiles[0]).toBe('src/b.ts');
    expect([...(knowledge?.changedFiles ?? [])].slice(1).sort()).toEqual(['src/a.ts', 'src/c.ts', 'src/d.ts']);
    expect(knowledge?.changedFileCount).toBe(4);
  });

  it('lists at most eight changed files and counts them all', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    fixture.addSession('task-a', 'agent-first');
    fixture.addChangeDocument('agent-first', 'task-a', Array.from({ length: 11 }, (_unused, index) => `src/file-${index}.ts`));

    const knowledge = readTaskKnowledge(fixture.database, ['task-a']).get('task-a');

    expect(TASK_KNOWLEDGE_FILES).toBe(8);
    expect(knowledge?.changedFiles).toHaveLength(8);
    expect(knowledge?.changedFileCount).toBe(11);
  });

  it('keeps each task\'s knowledge apart when asked for several', () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One');
    fixture.addTask('task-b', 2, 'Two');
    fixture.addSession('task-a', 'agent-a');
    fixture.addSession('task-b', 'agent-b');
    fixture.addChangeDocument('agent-a', 'task-a', ['src/only-a.ts']);
    fixture.addChangeDocument('agent-b', 'task-b', ['src/only-b.ts']);
    fixture.addCommit(shaStartingWith('a1'), 'feat: commit for the first task', BASE_MS, 'task-a');

    const knowledge = readTaskKnowledge(fixture.database, ['task-a', 'task-b']);

    expect(knowledge.get('task-a')?.changedFiles).toEqual(['src/only-a.ts']);
    expect(knowledge.get('task-b')?.changedFiles).toEqual(['src/only-b.ts']);
    expect(knowledge.get('task-a')?.commitCount).toBe(1);
    expect(knowledge.get('task-b')?.commitCount).toBe(0);
  });

  it('names the same changed files a summary is written from', async () => {
    const fixture = project();
    fixture.addTask('task-a', 1, 'One', 'lane-done');
    fixture.addSession('task-a', 'agent-first');
    fixture.addSession('task-a', 'agent-second');
    fixture.addSession('task-a', 'agent-third');
    // Distinct counts (3, 2, 1), so the order does not depend on which session is read first.
    fixture.addChangeDocument('agent-first', 'task-a', ['src/three.ts', 'src/two.ts', 'src/one.ts']);
    fixture.addChangeDocument('agent-second', 'task-a', ['src/three.ts', 'src/two.ts']);
    fixture.addChangeDocument('agent-third', 'task-a', ['src/three.ts']);
    fixture.addCommit(shaStartingWith('a1'), 'fix(relay): back off on reconnect (#812)', BASE_MS, 'task-a');

    const [candidate] = await readSummaryCandidates(fixture.database, async () => undefined);
    const knowledge = readTaskKnowledge(fixture.database, ['task-a']).get('task-a');

    expect(candidate.input.changedFiles).toEqual(['src/three.ts', 'src/two.ts', 'src/one.ts']);
    expect(knowledge?.changedFiles).toEqual(candidate.input.changedFiles);
    // The summary reads the subject as committed. Only the agent-facing read rewrites it.
    expect(candidate.input.commits).toEqual(['fix(relay): back off on reconnect (#812)']);
    expect(knowledge?.commits[0].subject).toBe('fix(relay): back off on reconnect (PR 812)');
  });
});
