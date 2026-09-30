/**
 * The work related to one task, shared by the task window's prior work and
 * `kangentic_search relatedToTask` so the two name the same tasks.
 *
 * The rollup itself is tested where it lives; here the related-work module is
 * mocked, and what is pinned is what this module adds: the task left out of what
 * is ranked, one embedding, and the window's rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelatedWork, RelatedWorkTask } from '../../src/main/retrieval/related-work';
import type { Embedder } from '../../src/main/retrieval/types';

const { mockSearchRelatedWork, mockIndexedConversationNodes, mockBoardRecordTasks } = vi.hoisted(() => ({
  mockSearchRelatedWork: vi.fn(),
  mockIndexedConversationNodes: vi.fn(),
  mockBoardRecordTasks: vi.fn(),
}));

vi.mock('../../src/main/retrieval/related-work', () => ({
  searchRelatedWork: mockSearchRelatedWork,
  indexedConversationNodes: mockIndexedConversationNodes,
  boardRecordTasks: mockBoardRecordTasks,
}));

import { priorWorkHits, rankWorkRelatedToTask, TASK_TEXT_CHARS } from '../../src/main/retrieval/task-related-work';

const TARGET = { id: 'task-target', title: 'Relay config', description: 'Make the relay reconnect after the router restarts.' };
const NODES = [
  { docKey: 'conversation::own', taskId: 'task-target', displayId: 561, title: 'Relay config', sessionId: 'session-own' },
  { docKey: 'conversation::a', taskId: 'task-a', displayId: 1, title: 'Relay pairing', sessionId: 'session-a' },
  { docKey: 'conversation::b', taskId: 'task-b', displayId: 2, title: 'Relay reaper', sessionId: 'session-b' },
  { docKey: 'conversation::loose', taskId: null, displayId: null, title: null, sessionId: 'session-loose' },
];

function rankedTask(overrides: Partial<RelatedWorkTask>): RelatedWorkTask {
  return {
    key: overrides.taskId ?? 'task',
    taskId: 'task',
    displayId: null,
    title: 'A task',
    score: 1,
    strength: 1,
    matches: 1,
    firstMs: null,
    lastMs: null,
    docKeys: [],
    bestChunkId: null,
    sessionId: null,
    turnUuid: null,
    ...overrides,
  };
}

function relatedWork(handed: RelatedWorkTask[], passages: Array<[number, string]> = []): RelatedWork {
  return { ranked: handed, handed, passages: new Map(passages), code: [], semantic: true, elapsedMs: 3 };
}

beforeEach(() => {
  mockSearchRelatedWork.mockReset();
  mockIndexedConversationNodes.mockReturnValue(NODES);
  mockBoardRecordTasks.mockReturnValue([
    { taskId: 'task-target', displayId: 561, title: 'Relay config' },
    { taskId: 'task-quiet', displayId: 14, title: 'A task with no conversation' },
  ]);
  mockSearchRelatedWork.mockResolvedValue(relatedWork([]));
});

describe('ranking the work related to a task', () => {
  it('leaves the task out of the conversations and records it ranks', async () => {
    const work = await rankWorkRelatedToTask({ projectId: 'project-1', task: TARGET, embedder: null });

    const input = mockSearchRelatedWork.mock.calls[0][0] as { nodes: Array<{ taskId: string | null }>; recordOnlyTasks: Array<{ taskId: string }> };
    expect(input.nodes.map((node) => node.taskId)).toEqual(['task-a', 'task-b', null]);
    expect(input.recordOnlyTasks.map((record) => record.taskId)).toEqual(['task-quiet']);
    expect(work.nodes.map((node) => node.docKey)).not.toContain('conversation::own');
  });

  it('embeds the task once and searches keywords by the focus and title, cut at the text budget', async () => {
    const embed = vi.fn(async () => [new Float32Array([1, 0])]);
    const embedder = { embed } as unknown as Embedder;
    const task = { ...TARGET, description: 'word '.repeat(2000) };

    await rankWorkRelatedToTask({ projectId: 'project-1', task, focus: ' reconnect ', embedder });

    expect(embed).toHaveBeenCalledOnce();
    const [[embedded]] = embed.mock.calls[0] as unknown as [[string]];
    expect(embedded).toHaveLength(TASK_TEXT_CHARS);
    expect(embedded.startsWith('reconnect. Relay config\nword')).toBe(true);
    const input = mockSearchRelatedWork.mock.calls[0][0] as { keywordText: string; queryVectors: Float32Array[] };
    expect(input.keywordText).toBe('reconnect Relay config');
    expect(input.queryVectors).toHaveLength(1);
  });

  it('ranks by keyword alone, with an empty vector list, when the model does not answer', async () => {
    const embedder = { embed: vi.fn(async () => { throw new Error('timed out'); }) } as unknown as Embedder;

    await rankWorkRelatedToTask({ projectId: 'project-1', task: TARGET, embedder });

    expect((mockSearchRelatedWork.mock.calls[0][0] as { queryVectors: Float32Array[] }).queryVectors).toEqual([]);
  });
});

describe("the task window's prior work rows", () => {
  const nodes = NODES.slice(1);

  it('lists the strongest tasks that have a conversation, in rank order, each opening its best one', () => {
    const work = {
      nodes,
      related: relatedWork([
        rankedTask({ taskId: 'task-b', title: 'Relay reaper', sessionId: 'session-b', bestChunkId: 7, matches: 4, score: 0.9 }),
        rankedTask({ taskId: 'task-quiet', title: 'A task with no conversation', sessionId: null }),
        rankedTask({ key: 'conversation:conversation::loose', taskId: null, title: 'Untitled', sessionId: 'session-loose' }),
        rankedTask({ taskId: 'task-a', title: 'Relay pairing', sessionId: 'session-a', score: 0.4 }),
      ], [[7, 'the reaper passage']]),
    };

    const hits = priorWorkHits(work, 5);

    expect(hits.map((hit) => hit.taskTitle)).toEqual(['Relay reaper', 'Untitled', 'Relay pairing']);
    expect(hits[0]).toEqual({
      docKey: 'conversation::b',
      sessionId: 'session-b',
      taskId: 'task-b',
      taskTitle: 'Relay reaper',
      agentName: null,
      snippet: 'the reaper passage',
      score: 0.9,
      matchKind: 'hybrid',
      matchCount: 4,
      turnTs: null,
    });
    expect(hits[1].taskId).toBeNull();
  });

  it('stops at the limit and says keyword when no vector ran', () => {
    const handed = ['a', 'b', 'loose'].map((name) => rankedTask({ taskId: `task-${name}`, sessionId: `session-${name}` }));
    const work = { nodes, related: { ...relatedWork(handed), semantic: false } };

    const hits = priorWorkHits(work, 2);

    expect(hits.map((hit) => hit.sessionId)).toEqual(['session-a', 'session-b']);
    expect(hits.every((hit) => hit.matchKind === 'lexical')).toBe(true);
  });

  it('drops a row whose conversation is not among the ranked nodes', () => {
    const work = { nodes, related: relatedWork([rankedTask({ taskId: 'task-gone', sessionId: 'session-gone' })]) };
    expect(priorWorkHits(work, 5)).toEqual([]);
  });
});
