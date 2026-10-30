/**
 * The KNOWLEDGE_GRAPH_RELATED_TO_TASK handler: the task window's "N earlier
 * conversations about this" line.
 *
 * The ranking itself is tested where it lives (`related-work.test.ts` for the
 * search, `related-rank-prior-work.test.ts` for the worker handler that scopes
 * it to earlier tasks, `retrieval-queries.test.ts` for main's side of the
 * call). `rankRelatedWork` is mocked here, so what is only true of the handler
 * is pinned: the request it builds out of the task, the short circuits that
 * keep a query from running, and how a ranked row becomes the hit the line
 * reads.
 *
 * Mock strategy mirrors `knowledge-graph-answer-handler.test.ts`: capture the
 * handlers off a mocked `ipcMain.handle`, then drive one channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Embedder } from '../../src/main/retrieval/types';
import type { KnowledgeGraphQueryHit } from '../../src/shared/types';
import type { RelatedWork, RelatedWorkTask } from '../../src/main/retrieval/related-work';
import type { RankedRelatedWork } from '../../src/main/retrieval/worker/methods';
import type { RankRelatedWorkRequest } from '../../src/main/retrieval/retrieval-queries';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

const { rankSpy, getTaskById, getEmbedderSpy } = vi.hoisted(() => ({
  rankSpy: vi.fn(),
  getTaskById: vi.fn(),
  getEmbedderSpy: vi.fn(),
}));

// Only the ranking is replaced; `INDEX_RESTARTING` and the other queries stay real.
vi.mock('../../src/main/retrieval/retrieval-queries', async (importActual) => ({
  ...(await importActual<typeof import('../../src/main/retrieval/retrieval-queries')>()),
  rankRelatedWork: rankSpy,
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { getById = getTaskById; },
}));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { getEmbedder: getEmbedderSpy, prewarmEmbedWorker: vi.fn(), refreshRecords: vi.fn() },
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: { on: () => undefined, call: vi.fn() },
}));
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));

import { registerSearchHandlers } from '../../src/main/ipc/handlers/search';
import { TASK_TEXT_CHARS } from '../../src/main/retrieval/related-query-text';
import { IPC } from '../../src/shared/ipc-channels';

const SENTINEL_EMBEDDER = { embed: vi.fn(), dimensions: 384, modelTag: 'sentinel', noiseFloor: 0.4 } as unknown as Embedder;

const CREATED_AT = '2026-03-01T10:00:00.000Z';

interface TaskFields {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
}

function taskFor(overrides: Partial<TaskFields> = {}): TaskFields {
  return {
    id: 'task-1',
    title: 'Fix the sphere framing',
    description: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

/** One handed row, as `searchRelatedWork` ranks it. `score` and `relevance` differ on purpose. */
function handedRow(overrides: Partial<RelatedWorkTask> = {}): RelatedWorkTask {
  return {
    key: 'task-early',
    taskId: 'task-early',
    displayId: 12,
    title: 'Sphere fit framing',
    score: 0.9,
    relevance: 0.4,
    strength: 1,
    matches: 7,
    firstMs: 1_750_000_000_000,
    lastMs: 1_760_000_000_000,
    docKeys: ['conversation::doc-a', 'conversation::doc-b'],
    bestChunkId: 42,
    sessionId: 'session-b',
    turnUuid: 'turn-7',
    ...overrides,
  };
}

interface RankedOptions {
  passages?: Array<[number, string]>;
  sessionIdByDocKey?: Array<[string, string]>;
}

/** What the worker answers: the handed rows, the passages they carry, and the session each doc key opens. */
function rankedWith(handed: RelatedWorkTask[], options: RankedOptions = {}): RankedRelatedWork {
  const related: RelatedWork = {
    ranked: handed,
    handed,
    passages: new Map(options.passages ?? [[42, 'we dropped the sphere fit because it circumscribes']]),
    code: [],
    semantic: true,
    elapsedMs: 5,
  };
  return {
    related,
    // doc-a opens a different conversation than the row's best passage; doc-b is the passage's own.
    sessionIdByDocKey: new Map(options.sessionIdByDocKey ?? [
      ['conversation::doc-a', 'session-a'],
      ['conversation::doc-b', 'session-b'],
    ]),
    factsByTaskId: new Map(),
    summaryByTaskId: new Map(),
  };
}

function makeContext(currentProjectId: string | null = 'project-1') {
  return {
    configManager: {
      load: vi.fn(() => ({ agent: { cliPaths: {} }, knowledgeGraph: {} })),
      getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: {} }, knowledgeGraph: {} })),
    },
    projectRepo: {
      list: vi.fn(() => [{ id: 'project-1', name: 'Kangentic', path: '/repo' }]),
      getById: vi.fn(),
    },
    currentProjectId,
    currentProjectPath: '/repo',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

/**
 * Asks for a task's prior work. A task and project are defaulted when left out
 * of the call, but a project passed as `undefined` stays undefined: the caller
 * that names none is a case of its own.
 */
async function priorWork(...args: [taskId?: string, projectId?: string | null]): Promise<KnowledgeGraphQueryHit[]> {
  const handler = capturedHandlers.get(IPC.KNOWLEDGE_GRAPH_RELATED_TO_TASK);
  if (!handler) throw new Error('knowledgeGraph:relatedToTask handler not registered');
  const taskId = args[0] ?? 'task-1';
  const projectId = args.length > 1 ? args[1] : 'project-1';
  return handler(undefined, taskId, projectId) as Promise<KnowledgeGraphQueryHit[]>;
}

function rankRequest(): RankRelatedWorkRequest {
  expect(rankSpy).toHaveBeenCalledTimes(1);
  return rankSpy.mock.calls[0][0] as RankRelatedWorkRequest;
}

describe('the task prior work handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    rankSpy.mockReset();
    getTaskById.mockReset();
    getEmbedderSpy.mockReset();
    getEmbedderSpy.mockReturnValue(SENTINEL_EMBEDDER);
    getTaskById.mockReturnValue(taskFor());
    rankSpy.mockResolvedValue(rankedWith([]));
    registerSearchHandlers(makeContext() as unknown as Parameters<typeof registerSearchHandlers>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the request it ranks', () => {
    // Red-green: change `excludeTaskId`, `priorWorkBefore`, `keywordText` or
    // `withExtras` in the handler's `rankRelatedWork` call and the matching
    // field below goes red.
    it('ranks the task\'s own words in its project, leaving the task out, from before it was created', async () => {
      getTaskById.mockReturnValue(taskFor({ description: 'The sphere circumscribes the box.' }));

      await priorWork('task-1', 'project-1');

      const request = rankRequest();
      const expectedQuestion = 'Fix the sphere framing\nThe sphere circumscribes the box.';
      expect(request.projectId).toBe('project-1');
      expect(request.question).toBe(expectedQuestion);
      // The keyword search runs on the title alone, not the whole body.
      expect(request.keywordText).toBe('Fix the sphere framing');
      expect(request.excludeTaskId).toBe('task-1');
      // The task's own creation time, as stored, is the cutoff for prior work.
      expect(request.priorWorkBefore).toBe(CREATED_AT);
      // One query vector, embedded from the whole text, by the embedder main holds.
      expect(request.vectorTexts).toEqual([expectedQuestion]);
      expect(request.embedder).toBe(SENTINEL_EMBEDDER);
      // The line shows no facts or summaries, so the worker is not asked to read them.
      expect(request.withExtras).toBe(false);
    });

    // The text is trimmed first and cut second, so a padded title does not
    // spend the cut's characters on blanks the ranking then throws away.
    //
    // Red-green: cut first and trim after (`.slice(...).trim()`) and the question
    // is two characters short of TASK_TEXT_CHARS.
    it('trims before it cuts, so padding does not take characters from the description', async () => {
      getTaskById.mockReturnValue(taskFor({ title: '  Fix the sphere framing', description: 'x'.repeat(2_000) }));

      await priorWork();

      expect(rankRequest().question).toHaveLength(TASK_TEXT_CHARS);
    });

    it('opens the task by the id it was asked for, in the project it was asked for', async () => {
      getTaskById.mockReturnValue(taskFor({ id: 'task-9' }));

      await priorWork('task-9', 'project-1');

      expect(getTaskById).toHaveBeenCalledWith('task-9');
      expect(rankRequest().excludeTaskId).toBe('task-9');
    });

    it('falls back to the open project when the caller names none', async () => {
      await priorWork('task-1', undefined);

      expect(rankRequest().projectId).toBe('project-1');
    });

    // Red-green: drop the `.trim()` and a task with no description ranks
    // 'Fix the sphere framing\n', which no longer equals its title.
    it.each([
      ['no description', null],
      ['an empty description', ''],
      ['a blank description', '   \n  '],
    ])('trims the text, so a task with %s ranks its title alone', async (_label, description) => {
      getTaskById.mockReturnValue(taskFor({ description }));

      await priorWork();

      const request = rankRequest();
      expect(request.question).toBe('Fix the sphere framing');
      expect(request.vectorTexts).toEqual(['Fix the sphere framing']);
    });

    // Red-green: drop `.slice(0, TASK_TEXT_CHARS)` and the question is the
    // whole 2,000-character description plus the title.
    it('cuts a long description to TASK_TEXT_CHARS, and embeds the cut text', async () => {
      getTaskById.mockReturnValue(taskFor({ description: 'x'.repeat(2_000) }));

      await priorWork();

      const request = rankRequest();
      expect(request.question).toHaveLength(TASK_TEXT_CHARS);
      expect(request.question.startsWith('Fix the sphere framing\nxxx')).toBe(true);
      expect(request.vectorTexts).toEqual([request.question]);
      // The title is cut by nothing: the keyword search still gets all of it.
      expect(request.keywordText).toBe('Fix the sphere framing');
    });
  });

  describe('when there is nothing to rank', () => {
    // Red-green: drop the empty-text guard and the ranking runs on '' (a call
    // that can only come back empty), so `rankSpy` is called.
    it.each([
      ['an empty title and no description', '', null],
      ['a blank title and a blank description', '  ', '\n '],
    ])('answers nothing, without ranking, for a task with %s', async (_label, title, description) => {
      getTaskById.mockReturnValue(taskFor({ title, description }));

      expect(await priorWork()).toEqual([]);
      expect(rankSpy).not.toHaveBeenCalled();
    });

    it('answers nothing, without ranking, when the task does not exist', async () => {
      getTaskById.mockReturnValue(null);

      expect(await priorWork('task-gone')).toEqual([]);
      expect(rankSpy).not.toHaveBeenCalled();
    });

    it('answers nothing, without opening a task or ranking, for a project the repository does not list', async () => {
      expect(await priorWork('task-1', 'deleted-project')).toEqual([]);
      expect(getTaskById).not.toHaveBeenCalled();
      expect(rankSpy).not.toHaveBeenCalled();
    });

    it('answers nothing, without ranking, when no task is named, or no project is named or open', async () => {
      expect(await priorWork('', 'project-1')).toEqual([]);

      capturedHandlers.clear();
      registerSearchHandlers(makeContext(null) as unknown as Parameters<typeof registerSearchHandlers>[0]);
      expect(await priorWork('task-1', undefined)).toEqual([]);

      expect(getTaskById).not.toHaveBeenCalled();
      expect(rankSpy).not.toHaveBeenCalled();
    });

    // Recall is never a blocker: a failure reads as no line, not an error in the task window.
    it('answers nothing when the ranking throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      rankSpy.mockRejectedValue(new Error('no such table: memory_chunks'));

      await expect(priorWork()).resolves.toEqual([]);
    });

    it('answers nothing when the worker cannot answer (the ranking is null)', async () => {
      rankSpy.mockResolvedValue(null);

      await expect(priorWork()).resolves.toEqual([]);
    });

    it('answers nothing when no earlier task was handed', async () => {
      rankSpy.mockResolvedValue(rankedWith([]));

      await expect(priorWork()).resolves.toEqual([]);
    });
  });

  describe('the hit a handed row becomes', () => {
    // The row's two doc keys are in an order that makes the first one WRONG:
    // `doc-a` opens `session-a`, and only `doc-b` opens the row's own session.
    //
    // Red-green: take `row.docKeys[0]` outright and the doc key is `doc-a`;
    // read `row.score` for `score` and it is 0.9; hardcode another `matchKind`
    // or fill `agentName` / `turnTs` and the whole-object match goes red.
    it('maps every field, opening the conversation the best passage is in and scoring by relevance', async () => {
      rankSpy.mockResolvedValue(rankedWith([handedRow()]));

      const hits = await priorWork();

      expect(hits).toEqual([{
        docKey: 'conversation::doc-b',
        sessionId: 'session-b',
        taskId: 'task-early',
        taskTitle: 'Sphere fit framing',
        agentName: null,
        snippet: 'we dropped the sphere fit because it circumscribes',
        // `relevance` (0.4), not `score` (0.9): the line reads how near the passage is.
        score: 0.4,
        matchKind: 'semantic',
        matchCount: 7,
        turnTs: null,
      }]);
    });

    // Red-green: drop the `?? row.docKeys[0]` and the hit has no doc key (or
    // the handler's `!docKey` guard drops the row), so the hit is missing.
    it('falls back to the first doc key when none of the row\'s conversations opens its session', async () => {
      rankSpy.mockResolvedValue(rankedWith(
        [handedRow({ sessionId: 'session-unmapped' })],
        { sessionIdByDocKey: [['conversation::doc-a', 'session-a'], ['conversation::doc-b', 'session-b']] },
      ));

      const hits = await priorWork();

      expect(hits).toHaveLength(1);
      expect(hits[0].docKey).toBe('conversation::doc-a');
      expect(hits[0].sessionId).toBe('session-unmapped');
    });

    it('keeps the handed order, one hit per row, each by its own session', async () => {
      rankSpy.mockResolvedValue(rankedWith(
        [
          handedRow({ key: 'task-first', taskId: 'task-first', title: 'First', docKeys: ['conversation::first-a', 'conversation::first-b'], sessionId: 'session-first-b', bestChunkId: 1 }),
          handedRow({ key: 'task-second', taskId: 'task-second', title: 'Second', docKeys: ['conversation::second-a', 'conversation::second-b'], sessionId: 'session-second-a', bestChunkId: 2 }),
        ],
        {
          passages: [[1, 'first passage'], [2, 'second passage']],
          sessionIdByDocKey: [
            ['conversation::first-a', 'session-first-a'],
            ['conversation::first-b', 'session-first-b'],
            ['conversation::second-a', 'session-second-a'],
            ['conversation::second-b', 'session-second-b'],
          ],
        },
      ));

      const hits = await priorWork();

      expect(hits.map((hit) => [hit.taskTitle, hit.docKey, hit.snippet])).toEqual([
        ['First', 'conversation::first-b', 'first passage'],
        ['Second', 'conversation::second-a', 'second passage'],
      ]);
    });

    // Red-green: show `related.passages.get(bestChunkId)` unguarded and a
    // missing chunk reads 'undefined' on the line; index with a null chunk id
    // and the null case throws.
    it.each([
      ['the passage text, when the chunk has one', 42, 'we dropped the sphere fit because it circumscribes'],
      ['nothing, when the chunk\'s text was not kept', 99, ''],
      ['nothing, when the row was matched with no chunk', null, ''],
    ])('shows %s', async (_label, bestChunkId, expectedSnippet) => {
      rankSpy.mockResolvedValue(rankedWith([handedRow({ bestChunkId })]));

      const hits = await priorWork();

      expect(hits).toHaveLength(1);
      expect(hits[0].snippet).toBe(expectedSnippet);
    });

    // Red-green: drop the `!row.sessionId` guard and a row matched through
    // its record alone reaches the line with a null session it cannot open.
    it('skips a row with no conversation to open, and still shows the others', async () => {
      rankSpy.mockResolvedValue(rankedWith([
        handedRow({ key: 'task-record-only', taskId: 'task-record-only', title: 'Record only', sessionId: null }),
        handedRow(),
      ]));

      const hits = await priorWork();

      expect(hits.map((hit) => hit.taskTitle)).toEqual(['Sphere fit framing']);
    });

    it('skips a row that names no conversation at all', async () => {
      rankSpy.mockResolvedValue(rankedWith([handedRow({ docKeys: [] })]));

      await expect(priorWork()).resolves.toEqual([]);
    });
  });
});
