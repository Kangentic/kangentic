/**
 * The retrieval worker's `related.rank` handler, scoped to a task's prior work.
 *
 * The same handler ranks `kangentic_search`'s tasks and Ask's related work over
 * the whole board. Given `priorWorkBefore` it ranks the task window's prior
 * work instead: only tasks created before the cutoff, each through a
 * conversation, with the task itself left out. This file pins how the handler
 * builds that scope and what it hands the search. The search is tested where it
 * lives (`related-work.test.ts`) and so is the store's cutoff query, so both
 * are doubled here and the search's input is captured.
 *
 * Mock strategy follows `search-everything-mcp.test.ts`: the related-work reads
 * are replaced one by one, the module's constants stay real, and the handler is
 * called directly with a worker context.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type {
  IndexedConversationNode,
  RelatedWork,
  RelatedWorkRecordTask,
  SearchRelatedWorkInput,
} from '../../src/main/retrieval/related-work';

const {
  mockSearchRelatedWork,
  mockIndexedConversationNodes,
  mockBoardRecordTasks,
  mockReadBoardTaskFacts,
  mockTaskIdsCreatedBefore,
  storeDatabases,
} = vi.hoisted(() => ({
  mockSearchRelatedWork: vi.fn(),
  mockIndexedConversationNodes: vi.fn(() => [] as unknown[]),
  mockBoardRecordTasks: vi.fn(() => [] as unknown[]),
  mockReadBoardTaskFacts: vi.fn(() => [] as unknown[]),
  mockTaskIdsCreatedBefore: vi.fn(),
  storeDatabases: [] as unknown[],
}));

vi.mock('../../src/main/retrieval/related-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/retrieval/related-work')>();
  return {
    ...actual,
    searchRelatedWork: mockSearchRelatedWork,
    indexedConversationNodes: mockIndexedConversationNodes,
    boardRecordTasks: mockBoardRecordTasks,
    readBoardTaskFacts: mockReadBoardTaskFacts,
  };
});

// Its constants stay real; the cutoff query is the one thing doubled, and the
// database each store is opened over is recorded.
vi.mock('../../src/main/retrieval/retrieval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-store')>()),
  RetrievalStore: class {
    constructor(database: unknown) {
      storeDatabases.push(database);
    }
    taskIdsCreatedBefore = mockTaskIdsCreatedBefore;
  },
}));

import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';

const PROJECT_ID = 'project-1';
const CUTOFF = '2026-03-01T10:00:00.000Z';

function conversation(docKey: string, taskId: string | null, sessionId: string): IndexedConversationNode {
  return { docKey, taskId, displayId: null, title: taskId, sessionId };
}

// Four owners: one task created before the cutoff, one after it, a
// conversation of no task at all, and the task the prior work is FOR. That last
// task is inside the earlier set on purpose (see `EARLIER_TASK_IDS`).
const EARLY = conversation('conversation::early', 'task-early', 'session-early');
const LATE = conversation('conversation::late', 'task-late', 'session-late');
const ORPHAN = conversation('conversation::orphan', null, 'session-orphan');
const SELF = conversation('conversation::self', 'task-self', 'session-self');

const BOARD_RECORDS: RelatedWorkRecordTask[] = [
  { taskId: 'task-early', displayId: 1, title: 'Early' },
  { taskId: 'task-self', displayId: 2, title: 'Self' },
  { taskId: 'task-late', displayId: 3, title: 'Late' },
];

/**
 * The tasks the store reports as created before the cutoff. It holds the task
 * the prior work is for, as the real store does for a cutoff that is ITS OWN
 * creation time plus a moment (a retry, a clock tick). Without it in here,
 * dropping the explicit "leave the task out" clause would stay green, because
 * the cutoff alone would drop it.
 */
const EARLIER_TASK_IDS = ['task-early', 'task-self'];

const EMPTY_RELATED_WORK: RelatedWork = {
  ranked: [],
  handed: [],
  passages: new Map(),
  code: [],
  semantic: false,
  elapsedMs: 0,
};

const getDb = vi.fn((projectId: string) => ({ databaseOf: projectId }) as unknown as Database.Database);

const context: WorkerContext = {
  getDb,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};

function rank(overrides: Partial<Parameters<(typeof retrievalHandlers)['related.rank']>[0]> = {}) {
  return retrievalHandlers['related.rank'](
    {
      projectId: PROJECT_ID,
      question: 'Fix the sphere framing',
      queryVectors: null,
      withExtras: false,
      ...overrides,
    },
    context,
  );
}

/** What the handler handed `searchRelatedWork` on its one call. */
function searchInput(): SearchRelatedWorkInput {
  expect(mockSearchRelatedWork).toHaveBeenCalledTimes(1);
  return mockSearchRelatedWork.mock.calls[0][0] as SearchRelatedWorkInput;
}

describe('related.rank scoped to a task\'s prior work', () => {
  beforeEach(() => {
    mockSearchRelatedWork.mockReset();
    mockSearchRelatedWork.mockResolvedValue(EMPTY_RELATED_WORK);
    mockIndexedConversationNodes.mockReset();
    mockIndexedConversationNodes.mockReturnValue([EARLY, LATE, ORPHAN, SELF]);
    mockBoardRecordTasks.mockReset();
    mockBoardRecordTasks.mockReturnValue(BOARD_RECORDS);
    mockReadBoardTaskFacts.mockReset();
    mockReadBoardTaskFacts.mockReturnValue([]);
    mockTaskIdsCreatedBefore.mockReset();
    mockTaskIdsCreatedBefore.mockReturnValue(new Set(EARLIER_TASK_IDS));
    getDb.mockClear();
    storeDatabases.length = 0;
  });

  describe('with a cutoff', () => {
    // Red-green, one toggle at a time in `worker/methods.ts`: widen the nodes
    // filter's cutoff clause to `true` and the late task and the task-less
    // conversation stay in; drop the `node.taskId !== excludeTaskId` clause and
    // the task itself stays in.
    it('reaches only conversations of tasks created before the cutoff, and not the task the prior work is for', async () => {
      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      expect(searchInput().nodes.map((node) => node.docKey)).toEqual(['conversation::early']);
    });

    // Red-green: pass the ISO string through (or parse it nowhere) and the
    // store is asked for a string; the store compares millisecond times.
    it('asks the project\'s store for the tasks created before the cutoff, as a time in milliseconds', async () => {
      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      expect(mockTaskIdsCreatedBefore).toHaveBeenCalledTimes(1);
      expect(mockTaskIdsCreatedBefore).toHaveBeenCalledWith(Date.parse(CUTOFF));
      expect(typeof mockTaskIdsCreatedBefore.mock.calls[0][0]).toBe('number');
      // The project's own database, not another's.
      expect(getDb).toHaveBeenCalledWith(PROJECT_ID);
      expect(storeDatabases).toEqual([{ databaseOf: PROJECT_ID }]);
    });

    // Red-green: restore the board-wide `boardRecordTasks(...)` for the scoped
    // path and a record-only task (reachable with no conversation at all, and
    // by any creation time) reaches a search that must run on conversations.
    it('hands the search no record-only tasks, whatever the board holds', async () => {
      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      expect(searchInput().recordOnlyTasks).toEqual([]);
    });

    // Red-green: drop the `priorWork` field from the search call and the search
    // runs unscoped to the cutoff, so the first case sees `undefined`; hand it
    // the string, or a null task id for a task that was named, and the others go red.
    it('tells the search the cutoff as a time in milliseconds, with the task to leave out', async () => {
      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      expect(searchInput().priorWork).toEqual({ before: Date.parse(CUTOFF), taskId: 'task-self' });
    });

    it('tells the search no task to leave out when none was named', async () => {
      await rank({ priorWorkBefore: CUTOFF });

      expect(searchInput().priorWork).toEqual({ before: Date.parse(CUTOFF), taskId: null });
      // And the nodes are still only the earlier tasks', whichever they are.
      expect(searchInput().nodes.map((node) => node.docKey)).toEqual(['conversation::early', 'conversation::self']);
    });

    // The first task on a board has no earlier task. An empty set is still a
    // scope: reading it as "no scope" would hand a first task every later
    // task's work as its prior work.
    //
    // Red-green: replace the `!earlierTaskIds` / `earlierTaskIds ?` tests with
    // a size check and the empty set falls through to the board-wide ranking.
    it('reaches nothing when no task was created before the cutoff, rather than the whole board', async () => {
      mockTaskIdsCreatedBefore.mockReturnValue(new Set());

      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      const input = searchInput();
      expect(input.nodes).toEqual([]);
      expect(input.recordOnlyTasks).toEqual([]);
      expect(input.priorWork).toEqual({ before: Date.parse(CUTOFF), taskId: 'task-self' });
    });

    it('passes the question, the keyword text and the project on to the search unchanged', async () => {
      await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self', keywordText: 'sphere framing' });

      const input = searchInput();
      expect(input.question).toBe('Fix the sphere framing');
      expect(input.keywordText).toBe('sphere framing');
      expect(input.projectId).toBe(PROJECT_ID);
    });

    // The handler's answer opens a row by the session of its doc key, so the
    // map is built from the nodes the search was allowed to reach. A doc key
    // the search hands back that is outside them (here a later task's) names
    // no session.
    //
    // Red-green: build the map from the unfiltered owners and `late` is named.
    it('names the session of each handed doc key out of the nodes it reached, and no other', async () => {
      mockSearchRelatedWork.mockResolvedValue({
        ...EMPTY_RELATED_WORK,
        handed: [{
          key: 'task-early',
          taskId: 'task-early',
          displayId: 1,
          title: 'Early',
          score: 1,
          relevance: 1,
          strength: 1,
          matches: 1,
          firstMs: null,
          lastMs: null,
          docKeys: ['conversation::early', 'conversation::late'],
          bestChunkId: null,
          sessionId: 'session-early',
          turnUuid: null,
        }],
      } satisfies RelatedWork);

      const ranked = await rank({ priorWorkBefore: CUTOFF, excludeTaskId: 'task-self' });

      expect([...ranked.sessionIdByDocKey]).toEqual([['conversation::early', 'session-early']]);
    });
  });

  describe('without a cutoff', () => {
    // The control for every case above: the ranking `kangentic_search` and Ask
    // use is unchanged. Red-green: make the scoped path unconditional and the
    // late task and the task-less conversation drop out of the nodes, the
    // records come back empty, and `taskIdsCreatedBefore` is called.
    it('ranks the whole board minus the excluded task, with every record in reach, and no prior work scope', async () => {
      await rank({ excludeTaskId: 'task-self' });

      const input = searchInput();
      expect(input.nodes.map((node) => node.docKey)).toEqual(['conversation::early', 'conversation::late', 'conversation::orphan']);
      expect(input.recordOnlyTasks).toEqual([BOARD_RECORDS[0], BOARD_RECORDS[2]]);
      expect(input.priorWork).toBeUndefined();
      expect(mockTaskIdsCreatedBefore).not.toHaveBeenCalled();
    });

    it('leaves nothing out when no task is named', async () => {
      await rank();

      const input = searchInput();
      expect(input.nodes.map((node) => node.docKey)).toEqual([
        'conversation::early',
        'conversation::late',
        'conversation::orphan',
        'conversation::self',
      ]);
      expect(input.recordOnlyTasks).toEqual(BOARD_RECORDS);
      expect(input.priorWork).toBeUndefined();
    });
  });
});
