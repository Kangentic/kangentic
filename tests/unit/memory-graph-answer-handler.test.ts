/**
 * The MEMORY_GRAPH_ANSWER handler: what Ask does around the agent call.
 *
 * The interesting behaviour is all in the ORDER and the short circuits, because
 * every one of them decides whether a real CLI call happens. The related-work
 * search is tested where it lives (`related-work.test.ts`) and mocked here; the
 * adapter is tested where it lives. What is only true here is the wiring: the
 * set is pushed before the agent starts, a follow-up carries the chat, the map's
 * filters scope everything, and nothing runs when it should not.
 *
 * Mock strategy mirrors `agent-summarize-handler.test.ts`: capture the handlers
 * off a mocked `ipcMain.handle`, then drive one channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryAnswerContext, MemoryGraphAnswerResult } from '../../src/shared/types';
import type { AnswerFromContextOptions, AnswerSession, AnswerSessionInput } from '../../src/main/agent/agent-adapter';
import type { AnswerStreamEvent } from '../../src/main/agent/shared/auto-name';
import type {
  ProjectRelatedWork,
  RelatedWork,
  RelatedWorkTask,
  SearchRelatedWorkAcrossInput,
  SearchRelatedWorkInput,
} from '../../src/main/retrieval/related-work';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    // The fire-and-forget channels (prewarm, end chat) register through `on`.
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// The first session opened sweeps stale run directories out of the real temp
// folder; a unit run must not touch the developer's.
vi.mock('../../src/main/agent/shared/answer-run-directory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/agent/shared/answer-run-directory')>();
  return { ...actual, sweepStaleAnswerRunDirectories: vi.fn(async () => 0) };
});

type MockAdapter = {
  name: string;
  displayName: string;
  detect: (override?: string | null) => Promise<{ found: boolean; path: string | null; version: string | null }>;
  answerCapabilities?: { streaming: boolean; search: boolean; model: boolean; effort?: boolean; defaultEffort?: string };
  discoverCapabilities?: (cliPath: string) => Promise<{ effortLevels?: string[] }>;
  answerFromContext?: (
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
    options?: AnswerFromContextOptions,
  ) => Promise<string>;
  openAnswerSession?: (input: AnswerSessionInput) => AnswerSession;
};

/** Claude as the handler sees it: every extension, and a model required. */
function claudeAdapter(answerFromContext: MockAdapter['answerFromContext']): MockAdapter {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
    answerCapabilities: { streaming: true, search: true, model: true },
    answerFromContext,
  };
}

/** An agent with only the base: no streaming, no search. */
function baseAdapter(answerFromContext: MockAdapter['answerFromContext']): MockAdapter {
  return {
    ...claudeAdapter(answerFromContext),
    answerCapabilities: { streaming: false, search: false, model: true },
  };
}

/** One agent call's arguments, as the handler made them. */
type AnswerCall = [string, string, string, string | null, AnswerFromContextOptions | undefined];

let mockAdapters: MockAdapter[] = [];

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => mockAdapters.map((adapter) => adapter.name),
    get: (name: string) => mockAdapters.find((adapter) => adapter.name === name) ?? null,
  },
}));

let mockRelated: RelatedWork;
const relatedSpy = vi.fn(async (_input: SearchRelatedWorkInput): Promise<RelatedWork> => mockRelated);
let mockRelatedAcross: ProjectRelatedWork;
const relatedAcrossSpy = vi.fn(async (_input: SearchRelatedWorkAcrossInput): Promise<ProjectRelatedWork> => mockRelatedAcross);
vi.mock('../../src/main/retrieval/related-work', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/retrieval/related-work')>();
  return {
    ...actual,
    searchRelatedWork: (input: SearchRelatedWorkInput) => relatedSpy(input),
    searchRelatedWorkAcross: (input: SearchRelatedWorkAcrossInput) => relatedAcrossSpy(input),
  };
});

/** Board tasks as `RetrievalStore.boardTaskFacts` reads them, per test. */
let mockBoardTasks: unknown[] = [];
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class { boardTaskFacts() { return mockBoardTasks; } },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { getEmbedder: vi.fn(() => null), prewarmEmbedWorker: vi.fn() },
}));
vi.mock('../../src/main/retrieval/graph/graph-service', () => {
  const getSnapshot = vi.fn();
  return {
    graphService: {
      getSnapshot,
      // Ask reads the map alone; each test sets it through the snapshot.
      getProjection: (projectId: string) => getSnapshot(projectId, '')?.projection ?? null,
      requestRefresh: vi.fn(),
      setOnChanged: vi.fn(),
    },
  };
});
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { getById = vi.fn(() => null); },
}));

import { registerSearchHandlers } from '../../src/main/ipc/handlers/search';
import { answerSessionPool } from '../../src/main/retrieval/answer-session-pool';
import { AnswerSessionError } from '../../src/main/agent/shared/answer-session/stdin-json-session';
import { graphService } from '../../src/main/retrieval/graph/graph-service';
import { broadcast } from '../../src/main/pop-out/window-broadcast';
import { IPC } from '../../src/shared/ipc-channels';

/** Every stream push the handler broadcast, in order, payload only. */
function streamPushes(): Array<Record<string, unknown>> {
  return vi.mocked(broadcast).mock.calls
    .filter(([, channel]) => channel === IPC.MEMORY_GRAPH_ANSWER_STREAM)
    .map(([, , payload]) => payload as Record<string, unknown>);
}

/**
 * A cached projection for the handler to read the task table out of: two
 * tasks, one of them spanning two conversations, so the per-task rollup is
 * exercised on the real path.
 */
function graphNode(docKey: string, taskId: string, displayId: number, title: string, costUsd: number) {
  return {
    docKey, x: 0, y: 0, z: 0, chunkCount: 5, title,
    sessionId: `session-${docKey}`, taskId, displayId, agent: 'Claude Code', model: 'claude-opus-5',
    effort: null, durationMs: 60_000, costUsd, tokens: 1_000,
    lastActivityMs: 1_760_000_000_000, outcome: 'done' as const,
    clusters: { coarse: 0, balanced: 0, fine: 0 },
  };
}

const MOCK_PROJECTION = {
  nodes: [
    graphNode('conversation::doc-1', 'task-1', 561, 'Sphere fit framing', 10),
    graphNode('conversation::doc-2', 'task-1', 561, 'Sphere fit framing', 15),
    graphNode('conversation::doc-3', 'task-2', 564, 'Terminal scrollback repaint', 4),
  ],
  edges: [],
  clusterings: [{ granularity: 'balanced', regions: [{ label: 'framing', size: 3, x: 0, y: 0, z: 0 }] }],
};

/** The related work the search "found": task-1, strongest, with a passage. */
function relatedTask(overrides: Partial<RelatedWorkTask> = {}): RelatedWorkTask {
  return {
    key: 'task-1',
    taskId: 'task-1',
    displayId: 561,
    title: 'Sphere fit framing',
    score: 0.8,
    strength: 1,
    matches: 6,
    firstMs: 1_750_000_000_000,
    lastMs: 1_760_000_000_000,
    docKeys: ['conversation::doc-1', 'conversation::doc-2'],
    bestChunkId: 42,
    sessionId: 'session-conversation::doc-2',
    turnUuid: 'turn-7',
    ...overrides,
  };
}

function relatedWork(handed: RelatedWorkTask[]): RelatedWork {
  return {
    ranked: handed,
    handed,
    passages: new Map([[42, 'we dropped the sphere fit because it circumscribes']]),
    semantic: true,
    elapsedMs: 5,
  };
}

/** Global memory settings for the context double, per test. */
let memoryConfig: Record<string, unknown> = {};

/**
 * The IPC context double. `mcpServerUp` models whether Kangentic's own MCP
 * server is listening, which is what decides whether the agent is handed the
 * search tool or answers from what it was given.
 */
function makeContext(defaultAgent: string | null = 'claude', mcpServerUp = true) {
  return {
    configManager: { load: vi.fn(() => ({ agent: { cliPaths: {} }, memory: memoryConfig })) },
    projectRepo: { list: vi.fn(() => [{ id: 'project-1', default_agent: defaultAgent, path: '/repo' }]) },
    currentProjectId: 'project-1',
    currentProjectPath: '/repo',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    ...(mcpServerUp
      ? {
        mcpServerHandle: {
          urlForProject: vi.fn((projectId: string) => `http://127.0.0.1:4321/mcp/${projectId}`),
          token: 'secret-token',
        },
      }
      : {}),
  };
}

async function ask(
  question: string,
  requestId = '',
  answerContext?: MemoryAnswerContext,
): Promise<MemoryGraphAnswerResult> {
  const handler = capturedHandlers.get('memory:graphAnswer');
  if (!handler) throw new Error('memory:graphAnswer handler not registered');
  return handler(undefined, question, 'project-1', 'balanced', requestId, answerContext) as Promise<MemoryGraphAnswerResult>;
}

describe('the Ask handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    relatedSpy.mockClear();
    vi.mocked(broadcast).mockClear();
    // Chosen explicitly, as it must be: there is no fallback agent or model.
    memoryConfig = { answerAgent: 'claude', answerModel: 'haiku' };
    vi.mocked(graphService.getSnapshot).mockReturnValue({
      projectId: 'project-1',
      projection: MOCK_PROJECTION,
      coverage: {},
      building: false,
      stale: false,
      semanticAvailable: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test double
    } as any);
    mockRelated = relatedWork([relatedTask()]);
    mockBoardTasks = [];
  });

  it('lists a board task with no indexed conversation, so "every task" holds', async () => {
    mockBoardTasks = [{
      taskId: 'task-old', displayId: 14, title: 'Add support for OpenCode agent', outcome: 'done',
      sessions: 1, costUsd: 2.5, durationMs: null, tokens: null,
      lastActivity: '2025-02-01T00:00:00.000Z', agent: 'claude', model: null,
    }];
    const answerSpy = vi.fn(async () => 'Two tasks.');
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('how many adapters did we add?');
    const prompt = answerSpy.mock.calls[0][0] as string;
    const table = prompt.slice(prompt.indexOf('<task_table>'), prompt.indexOf('</task_table>'));
    expect(table).toMatch(/\n#14\|Add support for OpenCode agent\|/);
    // Still the conversation-backed tasks too, once each.
    expect(table.match(/\n#561\|/g)).toHaveLength(1);
  });

  it('hands the agent the board, the related work, and the one search tool', async () => {
    const answerSpy = vi.fn(async () => 'The sphere fit circumscribes.');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('why did we drop the sphere fit?', 'req-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toBe('The sphere fit circumscribes.');
    expect(result.agentName).toBe('Claude Code');

    // The prompt is built HERE and handed over whole, so the adapter cannot
    // change what the answer may draw on.
    const [prompt, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
    expect(prompt).toContain('why did we drop the sphere fit?');
    expect(prompt).toContain('Terminal scrollback repaint');
    // The related work, by the same ref the table uses, with its passage and
    // the task's rolled-up facts: 10 + 15 dollars across its two conversations.
    expect(prompt).toMatch(/<related_work>[\s\S]*#561\|Sphere fit framing\|1\.00\|6\|[\s\S]*circumscribes/);
    expect(prompt).toMatch(/\n#561\|Sphere fit framing\|1\.00\|6\|[^|\n]*\|[^|\n]*\|25\.00\|/);

    // ONE tool, scoped to THIS project by its URL, carrying the live token. The
    // URL's caller segment marks an answer run, which the server hands exactly
    // `kangentic_search` and nothing that can create, move or delete.
    expect(options?.retrieval).toEqual({
      url: 'http://127.0.0.1:4321/mcp/project-1/answer-req-1',
      token: 'secret-token',
    });
  });

  it('runs each question in a fresh scratch directory and removes it afterwards', async () => {
    // Never the project: its instruction files cost tokens the answer may not
    // use. Never a shared directory: a run writes its prompt file and MCP config
    // there, and two answers would overwrite each other's.
    let runDirectory = '';
    let existedDuringRun = false;
    const answerSpy = vi.fn(async (_prompt: string, _cliPath: string, cwd: string) => {
      runDirectory = cwd;
      existedDuringRun = fs.existsSync(cwd);
      return 'Answered.';
    });
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('anything');
    expect(path.basename(runDirectory)).toMatch(/^kangentic-answer-/);
    expect(path.dirname(runDirectory)).toBe(os.tmpdir());
    expect(existedDuringRun).toBe(true);
    expect(fs.existsSync(runDirectory)).toBe(false);
  });

  it('offers the search tool only to an agent whose answer run can use it', async () => {
    const answerSpy = vi.fn(async () => 'Answered.');
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('anything');
    const [prompt, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
    expect(options?.retrieval).toBeUndefined();
    // And the prompt does not tell it about a tool it does not have.
    expect(prompt).not.toContain('kangentic_search');
  });

  it('answers from what it was given when the MCP server is not up', async () => {
    const answerSpy = vi.fn(async () => 'Two tasks, #561 and #564.');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('claude', false) as any);

    const result = await ask('how many tasks are there?');
    expect(result.ok).toBe(true);
    const [, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
    expect(options?.retrieval).toBeUndefined();
  });

  it('pushes the related set BEFORE the agent writes anything, then the stream, then the end', async () => {
    // Set first, answer on top: the map lights while the agent is still
    // reading. Every push carries the request id, so a delta from a question
    // the user has moved past can be dropped rather than appended.
    const answerSpy = vi.fn(async (
      _prompt: string,
      _cliPath: string,
      _cwd: string,
      _model?: string | null,
      options?: AnswerFromContextOptions,
    ) => {
      options?.onEvent?.({ kind: 'tool', name: 'mcp__kangentic__kangentic_search' });
      options?.onEvent?.({ kind: 'text', text: 'The sphere ' });
      options?.onEvent?.({ kind: 'text', text: 'circumscribes.' });
      return 'The sphere circumscribes.';
    });
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('why?', 'req-7');
    const pushes = streamPushes();
    expect(pushes.map((push) => push.kind)).toEqual(['set', 'tool', 'text', 'text', 'done']);
    expect(pushes.every((push) => push.requestId === 'req-7')).toBe(true);
    expect(pushes[0]).toMatchObject({
      handedCount: 1,
      related: [{
        key: 'task-1',
        displayId: 561,
        strength: 1,
        docKeys: ['conversation::doc-1', 'conversation::doc-2'],
        // Where a row opens: the best passage's conversation, at its turn.
        passage: { sessionId: 'session-conversation::doc-2', turnUuid: 'turn-7' },
      }],
    });
  });

  it('ends the stream even when the agent throws', async () => {
    // Or the renderer is left holding a partial answer it believes is still
    // growing, with the loading line never stopping.
    mockAdapters = [baseAdapter(async () => { throw new Error('the CLI fell over'); })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('why?', 'req-8');
    expect(result.ok).toBe(false);
    expect(streamPushes().map((push) => push.kind)).toEqual(['set', 'done']);
  });

  it('still answers from the table when the related search fails', async () => {
    // A failed search costs the related work, not the answer.
    relatedSpy.mockRejectedValueOnce(new Error('no vec table'));
    const answerSpy = vi.fn(async () => '#561 cost the most.\nSELECTED: #561');
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('which task cost the most?', 'req-9');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handedCount).toBe(0);
    expect(result.rows.map((row) => row.displayId)).toEqual([561]);
    expect(streamPushes()[0]).toMatchObject({ kind: 'set', handedCount: 0, related: [] });
  });

  it('refuses without spawning when there is nothing to answer from', async () => {
    // A real call could only produce this same sentence, and a surface that
    // charges for that once is distrusted for the rest of the session.
    const answerSpy = vi.fn(async () => 'should never run');
    mockAdapters = [baseAdapter(answerSpy)];
    vi.mocked(graphService.getSnapshot).mockReturnValue({
      projectId: 'project-1',
      projection: { nodes: [], edges: [], clusterings: [] },
      coverage: {}, building: false, stale: false, semanticAvailable: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test double
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('something nothing matches');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toMatch(/nothing to answer from/i);
    expect(result.rows).toEqual([]);
    expect(answerSpy).not.toHaveBeenCalled();
    expect(relatedSpy).not.toHaveBeenCalled();
  });

  it('carries the whole board, and returns rows for the tasks the answer is about', async () => {
    // Named inline first, in the order named, then the rest of the selection.
    // task-2 was never found by the search, so its row comes from the table
    // alone: full strength, and no passage to open at.
    const answerSpy = vi.fn(async () => 'Mostly #564, and #561 for framing.\nSELECTED: #561, #564');
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('which tasks touched framing?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prompt = answerSpy.mock.calls[0][0] as string;
    // Rolled up per TASK: task-1's two conversations sum to 25, not 10 and 15.
    // Read off the generated header rather than a fixed column offset.
    const tableLines = prompt.split('\n');
    const header = tableLines.find((line) => line.startsWith('ref|task|')) ?? '';
    const columns = header.split('|');
    const firstRow = tableLines.find((line) => line.startsWith('#561|')) ?? '';
    expect(firstRow.split('|')[columns.indexOf('cost_usd')]).toBe('25.00');
    expect(firstRow.split('|')[columns.indexOf('sessions')]).toBe('2');
    expect(prompt).toContain('cost_usd - total USD the task spent');
    // A "which tasks" question is told to name all of them on the line.
    expect(prompt).toMatch(/name all of them, not a sample/);

    // What the question COST is reported, and describes the prompt actually sent.
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.promptTokens).toBeLessThanOrEqual(prompt.length);

    expect(result.rows.map((row) => row.key)).toEqual(['task-2', 'task-1']);
    expect(result.rows[0]).toMatchObject({ displayId: 564, strength: 1, passage: null, docKeys: ['conversation::doc-3'] });
    expect(result.rows[1]).toMatchObject({ displayId: 561, passage: { turnUuid: 'turn-7' } });
    expect(result.related.map((task) => task.key)).toEqual(['task-1']);
    // The protocol line never reaches the reader.
    expect(result.answer).toBe('Mostly #564, and #561 for framing.');
  });

  it('carries a follow-up\'s chat, searches the same subject, and keeps the earlier tasks', async () => {
    const answerSpy = vi.fn(async () => '#561 was the priciest.');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('which of those cost the most?', 'req-2', {
      chatId: 'chat-1',
      history: [{ question: 'what touched framing?', answer: 'Mostly #561.', taskKeys: ['task-1'] }],
      scopeDocKeys: null,
    });

    const search = relatedSpy.mock.calls[0][0];
    expect(search.anchorQuestions).toEqual(['what touched framing?']);
    expect([...(search.pinnedKeys ?? [])]).toEqual(['task-1']);

    const [prompt, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
    expect(prompt).toMatch(/<conversation_so_far>[\s\S]*Q: what touched framing\?[\s\S]*Tasks it was about: #561/);
    // Keyed by the CHAT, so every turn's searches reach the same trace.
    expect(options?.retrieval?.url).toBe('http://127.0.0.1:4321/mcp/project-1/answer-chat-1');
  });

  it('scopes the table and the search to the map\'s filters', async () => {
    // The filters are the scope of a question, so a task they hide is neither
    // counted nor searched, and the prompt says the table is filtered.
    const answerSpy = vi.fn(async () => 'One task.');
    mockAdapters = [baseAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('what is in scope?', 'req-3', { scopeDocKeys: ['conversation::doc-3'] });

    expect(relatedSpy.mock.calls[0][0].nodes.map((node) => node.docKey)).toEqual(['conversation::doc-3']);
    const prompt = answerSpy.mock.calls[0][0] as string;
    expect(prompt).toContain('Terminal scrollback repaint');
    // task-1 is outside the filter, so even the related work drops it.
    expect(prompt).not.toContain('Sphere fit framing');
    expect(prompt).toMatch(/filtered the map/);
  });

  it('runs the answer at the configured model', async () => {
    const answerSpy = vi.fn(async () => 'Answered.');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    await ask('anything');
    expect(answerSpy.mock.calls[0][3]).toBe('haiku');
  });

  it('asks for a model, without running anything, when the agent takes one and none is chosen', async () => {
    // There is no "agent default" to fall back on: a question never runs on a
    // model nobody chose.
    memoryConfig = { answerAgent: 'claude', answerModel: null };
    const answerSpy = vi.fn(async () => 'should never run');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.setup).toBe('model');
    expect(answerSpy).not.toHaveBeenCalled();
    expect(relatedSpy).not.toHaveBeenCalled();
  });

  it('asks for an agent when none is chosen, even with a capable one installed', async () => {
    // The old chain fell through to the project's agent and then to any capable
    // one, so a question could spend tokens on an agent nobody chose.
    memoryConfig = {};
    const answerSpy = vi.fn(async () => 'should never run');
    mockAdapters = [claudeAdapter(answerSpy)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('claude') as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.setup).toBe('agent');
    expect(answerSpy).not.toHaveBeenCalled();
  });

  it('asks for an agent when the chosen one cannot answer, rather than substituting another', async () => {
    memoryConfig = { answerAgent: 'aider', answerModel: 'x' };
    const answerSpy = vi.fn(async () => 'should never run');
    mockAdapters = [
      {
        name: 'aider',
        displayName: 'Aider',
        detect: async () => ({ found: true, path: '/usr/bin/aider', version: '1' }),
        // No answerFromContext: this agent cannot answer.
      },
      claudeAdapter(answerSpy),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('aider') as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.setup).toBe('agent');
    expect(answerSpy).not.toHaveBeenCalled();
    // The search never ran. Doing it first would spend real work on a question
    // that cannot be answered.
    expect(relatedSpy).not.toHaveBeenCalled();
  });

  it('honours the configured answering agent over the project default', async () => {
    const claudeSpy = vi.fn(async () => 'claude answered');
    const codexSpy = vi.fn(async () => 'codex answered');
    mockAdapters = [
      claudeAdapter(claudeSpy),
      {
        name: 'codex',
        displayName: 'Codex',
        detect: async () => ({ found: true, path: '/usr/bin/codex', version: '1' }),
        answerCapabilities: { streaming: false, search: false, model: true },
        answerFromContext: codexSpy,
      },
    ];
    memoryConfig = { answerAgent: 'codex', answerModel: 'gpt-5.5' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('claude') as any);

    const result = await ask('anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentName).toBe('Codex');
    expect(codexSpy).toHaveBeenCalled();
    expect(claudeSpy).not.toHaveBeenCalled();
  });

  it('passes the answering effort only to a run that takes it, at a level its CLI reports', async () => {
    const effortOf = (spy: ReturnType<typeof vi.fn>): string | null | undefined =>
      (spy.mock.calls[0] as unknown as AnswerCall)[4]?.effort;
    const grokLike = (spy: MockAdapter['answerFromContext'], levels: string[]): MockAdapter => ({
      name: 'grok',
      displayName: 'Grok',
      detect: async () => ({ found: true, path: '/usr/bin/grok', version: '1' }),
      answerCapabilities: { streaming: false, search: false, model: true, effort: true, defaultEffort: 'low' },
      discoverCapabilities: async () => ({ effortLevels: levels }),
      answerFromContext: spy,
    });
    const askWith = async (levels: string[], answerEffort: string | null): Promise<string | null | undefined> => {
      const spy = vi.fn(async () => 'answered');
      mockAdapters = [grokLike(spy, levels)];
      memoryConfig = { answerAgent: 'grok', answerModel: 'grok-4.7', answerEffort };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);
      expect((await ask('anything')).ok).toBe(true);
      return effortOf(spy);
    };

    // The user's level, when the CLI reports it.
    expect(await askWith(['low', 'medium', 'high'], 'high')).toBe('high');
    // Nothing chosen runs at the adapter's recommended level.
    expect(await askWith(['low', 'medium', 'high'], null)).toBe('low');
    // A stale level falls back to the recommendation rather than being sent:
    // Grok, Copilot and Antigravity all exit on an unknown one.
    expect(await askWith(['low', 'medium', 'high'], 'max')).toBe('low');
    // And when the CLI reports neither, no flag at all.
    expect(await askWith(['medium', 'high'], 'max')).toBeNull();

    // A run that does not declare effort never receives one, even when set.
    const claudeSpy = vi.fn(async () => 'answered');
    mockAdapters = [claudeAdapter(claudeSpy)];
    memoryConfig = { answerAgent: 'claude', answerModel: 'haiku', answerEffort: 'low' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);
    expect((await ask('anything')).ok).toBe(true);
    expect(effortOf(claudeSpy)).toBeNull();
  });

  it('reports a missing CLI rather than searching into a failure', async () => {
    mockAdapters = [{
      ...claudeAdapter(vi.fn()),
      detect: async () => ({ found: false, path: null, version: null }),
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Claude Code CLI not found');
    expect(relatedSpy).not.toHaveBeenCalled();
  });

  it('turns a thrown CLI failure into a reason rather than an exception', async () => {
    mockAdapters = [baseAdapter(async () => { throw new Error('the agent timed out'); })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the agent timed out');
  });

  describe('asked across projects', () => {
    // A second project whose only task carries the SAME ticket as the open
    // project's #561, which is exactly what the prefix exists for.
    const OTHER_PROJECTION = {
      nodes: [graphNode('conversation::m-1', 'task-9', 561, 'Relay pairing', 7)],
      edges: [],
      clusterings: [{ granularity: 'balanced', regions: [{ label: 'relay', size: 1, x: 0, y: 0, z: 0 }] }],
    };

    function twoProjectContext() {
      const context = makeContext();
      context.projectRepo.list = vi.fn(() => [
        { id: 'project-1', name: 'Kangentic', default_agent: 'claude', path: '/repo' },
        { id: 'project-2', name: 'Mobile App', default_agent: 'claude', path: '/mobile' },
      ]);
      return context;
    }

    beforeEach(() => {
      relatedAcrossSpy.mockClear();
      vi.mocked(graphService.getSnapshot).mockImplementation((projectId: string) => ({
        projectId,
        projection: projectId === 'project-2' ? OTHER_PROJECTION : MOCK_PROJECTION,
        coverage: {}, building: false, stale: false, semanticAvailable: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test double
      }) as any);
      mockRelatedAcross = {
        ranked: [],
        handed: [{
          ...relatedTask({
            key: 'task-9', taskId: 'task-9', displayId: 561, title: 'Relay pairing',
            docKeys: ['conversation::m-1'], sessionId: 'session-conversation::m-1',
          }),
          projectId: 'project-2',
        }],
        passages: new Map([['project-2:42', 'the relay pairs over a QR code']]),
        semantic: true,
        elapsedMs: 5,
      };
    });

    it('merges the tables with prefixed tickets and returns rows naming their project', async () => {
      const answerSpy = vi.fn(async () => 'Mostly mobile-app#561, then #564.\nSELECTED: mobile-app#561, #564');
      mockAdapters = [claudeAdapter(answerSpy)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(twoProjectContext() as any);

      const result = await ask('what touched pairing?', 'req-x', { projectIds: ['project-1', 'project-2'] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Embedded once and searched in each project, never the one-project path.
      expect(relatedSpy).not.toHaveBeenCalled();
      const across = relatedAcrossSpy.mock.calls[0][0];
      expect(across.projects.map((project) => [project.projectId, project.nodes.length])).toEqual([
        ['project-1', 3],
        ['project-2', 1],
      ]);

      const [prompt, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
      // Two tasks share ticket 561, and the table keeps them apart. Every ref
      // names its project, the open one's too: left bare, an agent read a task
      // ABOUT the mobile app as the mobile project's.
      expect(prompt).toMatch(/\nkangentic#561\|Sphere fit framing\|/);
      expect(prompt).toMatch(/\nmobile-app#561\|Relay pairing\|/);
      expect(prompt).not.toMatch(/\n#\d+\|/);
      expect(prompt).toMatch(/projects: Kangentic 2 tasks[^;\n]*written kangentic#N; Mobile App 1 tasks[^\n]*written mobile-app#N/);
      expect(prompt).toContain('written kangentic#529 or mobile-app#88');
      expect(prompt).toContain('never what the task is about');
      // The search reaches every project in scope, by name.
      expect(prompt).toContain('The question spans 2 projects: Kangentic, Mobile App');
      // The other project's passage, found by its project-qualified key.
      expect(prompt).toContain('the relay pairs over a QR code');
      // A search covers the open project unless told otherwise.
      expect(options?.retrieval?.url).toBe('http://127.0.0.1:4321/mcp/project-1/answer-req-x');

      // The answer wrote the open project's #564 bare, which still resolves.
      expect(result.rows).toEqual([
        expect.objectContaining({ key: 'task-9', ref: 'mobile-app#561', projectId: 'project-2', projectName: 'Mobile App' }),
        expect.objectContaining({ key: 'task-2', ref: 'kangentic#564', projectId: 'project-1', projectName: 'Kangentic' }),
      ]);
      expect(result.answer).toBe('Mostly mobile-app#561, then #564.');
    });

    it('never reads a bare ticket as another project\'s task', async () => {
      // The open project's #561 is task-1; mobile-app#561 is task-9. A bare
      // #561 in the answer must stay task-1.
      const answerSpy = vi.fn(async () => '#561 was first.\nSELECTED: #561');
      mockAdapters = [baseAdapter(answerSpy)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(twoProjectContext() as any);

      const result = await ask('which came first?', 'req-y', { projectIds: ['project-1', 'project-2'] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows.map((row) => row.key)).toEqual(['task-1']);
    });

    it('asks one other project on the one-project path, in that project', async () => {
      const answerSpy = vi.fn(async () => '#561.\nSELECTED: #561');
      mockAdapters = [claudeAdapter(answerSpy)];
      mockRelated = relatedWork([relatedTask({
        key: 'task-9', taskId: 'task-9', displayId: 561, title: 'Relay pairing', docKeys: ['conversation::m-1'],
      })]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(twoProjectContext() as any);

      const result = await ask('what is here?', 'req-z', { projectIds: ['project-2'] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(relatedAcrossSpy).not.toHaveBeenCalled();
      expect(relatedSpy.mock.calls[0][0].projectId).toBe('project-2');
      const [prompt, , , , options] = answerSpy.mock.calls[0] as unknown as AnswerCall;
      // One project, so its tickets stand bare and no row names a project.
      expect(prompt).toMatch(/\n#561\|Relay pairing\|/);
      expect(prompt).not.toContain('Sphere fit framing');
      expect(options?.retrieval?.url).toBe('http://127.0.0.1:4321/mcp/project-2/answer-req-z');
      expect(result.rows[0]).toMatchObject({ key: 'task-9', projectId: 'project-2', ref: '#561' });
      expect(result.rows[0].projectName).toBeUndefined();
    });
  });

  it('refuses an empty question before doing anything at all', async () => {
    mockAdapters = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ask a question/i);
    expect(relatedSpy).not.toHaveBeenCalled();
  });

  describe('with a warm session', () => {
    /** A session double: answers each turn with the next queued reply. */
    class FakeSession implements AnswerSession {
      readonly ready = Promise.resolve();
      readonly exited = Promise.resolve();
      alive = true;
      busy = false;
      disposed = false;
      readonly prompts: string[] = [];
      constructor(readonly input: AnswerSessionInput, private readonly replies: Array<string | Error>) {}
      async ask(prompt: string, onEvent?: (event: AnswerStreamEvent) => void): Promise<string> {
        this.prompts.push(prompt);
        const reply = this.replies.shift() ?? 'Answered.';
        if (reply instanceof Error) throw reply;
        onEvent?.({ kind: 'text', text: reply });
        return reply;
      }
      dispose(): void {
        this.disposed = true;
        this.alive = false;
      }
    }

    let sessions: FakeSession[] = [];
    function sessionAdapter(answerSpy: MockAdapter['answerFromContext'], replies: Array<string | Error> = []): MockAdapter {
      return {
        ...claudeAdapter(answerSpy),
        openAnswerSession: (input) => {
          const session = new FakeSession(input, replies);
          sessions.push(session);
          return session;
        },
      };
    }

    function prewarm(chatId: string): void {
      const handler = capturedHandlers.get(IPC.MEMORY_PREWARM);
      if (!handler) throw new Error('memory:prewarm handler not registered');
      handler(undefined, { chatId, projectId: 'project-1' });
    }

    beforeEach(() => {
      answerSessionPool.disposeAll();
      sessions = [];
    });

    it('asks the chat\'s session, sending the whole prompt first and only what is new after', async () => {
      const answerSpy = vi.fn(async () => 'fresh run');
      mockAdapters = [sessionAdapter(answerSpy, ['#561 is the one.\nSELECTED: #561', '#564 cost less.\nSELECTED: #564'])];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      const first = await ask('which task framed the sphere?', 'req-1', { chatId: 'chat-1' });
      expect(first.ok).toBe(true);
      const second = await ask('and the cheaper one?', 'req-2', {
        chatId: 'chat-1',
        history: [{ question: 'which task framed the sphere?', answer: '#561 is the one.', taskKeys: ['task-1'] }],
      });
      expect(answerSpy).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(1);
      const [firstPrompt, followUp] = sessions[0].prompts;
      expect(firstPrompt).toMatch(/<task_table>\n/);
      expect(firstPrompt).toContain('which task framed the sphere?');
      // The session already holds the table, the rules and the first turn. (The
      // related work's preface names the tag, so look for the block itself.)
      expect(followUp).not.toMatch(/<task_table>\n/);
      expect(followUp).not.toContain('<conversation_so_far>');
      expect(followUp).toContain('A follow-up question in the same chat');
      expect(followUp).toMatch(/<related_work>[\s\S]*#561\|Sphere fit framing/);
      expect(followUp).toContain('and the cheaper one?');
      // Refs still resolve against the table the session was primed with.
      expect(second.ok && second.rows.map((row) => row.key)).toEqual(['task-2']);
      // The session searches as the chat, so its searches reach this chat's trace.
      expect(sessions[0].input.retrieval?.url).toBe('http://127.0.0.1:4321/mcp/project-1/answer-chat-1');
      expect(sessions[0].input.model).toBe('haiku');
    });

    it('prewarms on open and answers from the prewarmed session', async () => {
      mockAdapters = [sessionAdapter(vi.fn(async () => 'fresh run'))];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      prewarm('chat-1');
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await ask('anything', 'req-1', { chatId: 'chat-1' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].prompts).toHaveLength(1);
    });

    it('starts a fresh session when the scope changes, carrying the chat so far', async () => {
      mockAdapters = [sessionAdapter(vi.fn(async () => 'fresh run'))];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      await ask('first', 'req-1', { chatId: 'chat-1' });
      await ask('second', 'req-2', {
        chatId: 'chat-1',
        scopeDocKeys: ['conversation::doc-3'],
        history: [{ question: 'first', answer: 'Answered.', taskKeys: [] }],
      });
      // Two tables in one session's context would double what every later
      // turn pays for, so the first session goes and a new one starts.
      expect(sessions).toHaveLength(2);
      expect(sessions[0].disposed).toBe(true);
      expect(sessions[1].prompts[0]).toMatch(/<task_table>\n/);
      expect(sessions[1].prompts[0]).toContain('<conversation_so_far>');
    });

    it('retries quietly as a fresh run when the session died before writing anything', async () => {
      const answerSpy = vi.fn(async () => 'From a fresh run.');
      mockAdapters = [sessionAdapter(answerSpy, [new AnswerSessionError('the agent exited 1', 'exited', true)])];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      const result = await ask('anything', 'req-1', { chatId: 'chat-1' });
      expect(result.ok && result.answer).toBe('From a fresh run.');
      expect(answerSpy).toHaveBeenCalledTimes(1);
      expect(answerSpy.mock.calls[0][0]).toMatch(/<task_table>\n/);
      expect(sessions[0].disposed).toBe(true);
    });

    it('shows an agent error as the answer\'s failure, without a retry', async () => {
      const answerSpy = vi.fn(async () => 'fresh run');
      mockAdapters = [sessionAdapter(answerSpy, [new AnswerSessionError('Model not available', 'agent', true)])];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      const result = await ask('anything', 'req-1', { chatId: 'chat-1' });
      expect(result).toMatchObject({ ok: false, reason: 'Model not available' });
      expect(answerSpy).not.toHaveBeenCalled();
      expect(sessions[0].disposed).toBe(true);
    });

    it('lets the session go when the chat ends', async () => {
      mockAdapters = [sessionAdapter(vi.fn(async () => 'fresh run'))];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);

      await ask('anything', 'req-1', { chatId: 'chat-1' });
      const endChat = capturedHandlers.get(IPC.MEMORY_GRAPH_END_CHAT);
      endChat?.(undefined, 'chat-1');
      expect(sessions[0].disposed).toBe(true);
      expect(answerSessionPool.size).toBe(0);
    });

    it('runs fresh for an agent without a session, and for a question with no chat', async () => {
      const answerSpy = vi.fn(async () => 'Answered.');
      mockAdapters = [claudeAdapter(answerSpy)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
      registerSearchHandlers(makeContext() as any);
      await ask('anything', 'req-1', { chatId: 'chat-1' });
      expect(answerSpy).toHaveBeenCalledTimes(1);

      mockAdapters = [sessionAdapter(answerSpy)];
      await ask('anything', 'req-2');
      expect(answerSpy).toHaveBeenCalledTimes(2);
      expect(sessions).toHaveLength(0);
    });
  });
});
