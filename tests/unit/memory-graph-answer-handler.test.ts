/**
 * The MEMORY_GRAPH_ANSWER handler: what Ask does around the agent call.
 *
 * The interesting behaviour is all in the ORDER and the short circuits, because
 * every one of them decides whether a real CLI call happens. Retrieval is the
 * map's own search and is tested where it lives; the adapter is tested where it
 * lives. What is only true here is that neither runs when it should not.
 *
 * Mock strategy mirrors `agent-summarize-handler.test.ts`: capture the handlers
 * off a mocked `ipcMain.handle`, then drive one channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryGraphAnswerResult } from '../../src/shared/types';
import type { StoredChunk } from '../../src/main/retrieval/types';
import type { TranscriptSearchHit } from '../../src/main/retrieval/memory-search';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

type MockAdapter = {
  name: string;
  displayName: string;
  detect: (override?: string | null) => Promise<{ found: boolean; path: string | null; version: string | null }>;
  answerFromContext?: (prompt: string, cliPath: string, cwd: string) => Promise<string>;
};

let mockAdapters: MockAdapter[] = [];

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => mockAdapters.map((adapter) => adapter.name),
    get: (name: string) => mockAdapters.find((adapter) => adapter.name === name) ?? null,
  },
}));

let mockHits: TranscriptSearchHit[] = [];
const searchSpy = vi.fn(async () => mockHits);
vi.mock('../../src/main/retrieval/memory-search', () => ({
  searchConversationMemory: (...args: unknown[]) => searchSpy(...(args as [])),
}));

let mockChunks: StoredChunk[] = [];
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    getChunks(ids: number[]): StoredChunk[] {
      return mockChunks.filter((chunk) => ids.includes(chunk.id));
    }
    docKeysForChunks(): Map<number, string> { return new Map(); }
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { getEmbedder: vi.fn(() => null) },
}));
vi.mock('../../src/main/retrieval/graph/graph-service', () => ({
  graphService: { getSnapshot: vi.fn(), requestRefresh: vi.fn(), setOnChanged: vi.fn() },
}));
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { getById = vi.fn(() => null); },
}));

import { registerSearchHandlers } from '../../src/main/ipc/handlers/search';
import { graphService } from '../../src/main/retrieval/graph/graph-service';

function chunk(id: number, text = `Passage ${id}`): StoredChunk {
  return {
    id, corpus: 'conversation', docId: `doc-${id}`, sessionId: `session-${id}`,
    taskId: `task-${id}`, agentSessionId: `agent-${id}`, embeddedModel: 'bge-large@q8-cls',
    seq: 0, text, contentHash: '', tokenEstimate: 100, role: 'user',
    tsStart: 1_760_000_000_000, tsEnd: 1_760_000_000_000,
    turnUuidStart: null, turnUuidEnd: null,
  };
}

function hit(chunkId: number): TranscriptSearchHit {
  return {
    chunkId, projectId: 'project-1', projectName: 'P', sessionId: `session-${chunkId}`,
    taskId: `task-${chunkId}`, taskTitle: `Conversation ${chunkId}`, agentName: 'Claude Code',
    role: 'user', turnUuid: null, turnTs: null, snippet: '', matchStart: 0, matchEnd: 0,
    score: 0.02, matchKind: 'hybrid', matchCount: 1,
  };
}

/**
 * A cached projection for the handler to read the task table out of.
 *
 * Ask now reads the WHOLE board, not just retrieved passages, so the snapshot is
 * no longer incidental to these tests: without it the handler has no table and
 * correctly refuses. Two tasks, one of them spanning two conversations, so the
 * per-task rollup is exercised on the real path rather than only in the pure
 * unit test.
 */
function graphNode(docKey: string, taskId: string, title: string, costUsd: number) {
  return {
    docKey, x: 0, y: 0, z: 0, chunkCount: 5, title,
    sessionId: `session-${docKey}`, taskId, agent: 'Claude Code', model: 'claude-opus-5',
    effort: null, durationMs: 60_000, costUsd, tokens: 1_000,
    lastActivityMs: 1_760_000_000_000, outcome: 'done' as const,
    clusters: { coarse: 0, balanced: 0, fine: 0 },
  };
}

const MOCK_PROJECTION = {
  nodes: [
    graphNode('conversation::doc-1', 'task-1', 'Sphere fit framing', 10),
    graphNode('conversation::doc-2', 'task-1', 'Sphere fit framing', 15),
    graphNode('conversation::doc-3', 'task-2', 'Terminal scrollback repaint', 4),
  ],
  edges: [],
  clusterings: [{ granularity: 'balanced', regions: [{ label: 'framing', size: 3, x: 0, y: 0, z: 0 }] }],
};

function makeContext(defaultAgent: string | null = 'claude') {
  return {
    configManager: { load: vi.fn(() => ({ agent: { cliPaths: {} }, memory: {} })) },
    projectRepo: { list: vi.fn(() => [{ id: 'project-1', default_agent: defaultAgent, path: '/repo' }]) },
    currentProjectId: 'project-1',
    currentProjectPath: '/repo',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

async function ask(question: string): Promise<MemoryGraphAnswerResult> {
  const handler = capturedHandlers.get('memory:graphAnswer');
  if (!handler) throw new Error('memory:graphAnswer handler not registered');
  return handler(undefined, question, 'project-1') as Promise<MemoryGraphAnswerResult>;
}

describe('the Ask handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    searchSpy.mockClear();
    vi.mocked(graphService.getSnapshot).mockReturnValue({
      projectId: 'project-1',
      projection: MOCK_PROJECTION,
      coverage: {},
      building: false,
      stale: false,
      semanticAvailable: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test double
    } as any);
    mockChunks = [chunk(1), chunk(2)];
    mockHits = [hit(1), hit(2)];
  });

  it('answers from the retrieved passages and cites every one it was given', async () => {
    const answerSpy = vi.fn(async () => 'The sphere fit circumscribes [1].');
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
      answerFromContext: answerSpy,
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('why did we drop the sphere fit?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toContain('[1]');
    expect(result.agentName).toBe('Claude Code');
    // BOTH sources, not only the one the answer cited. An uncited source is
    // still what the answer was allowed to see, and a reader checking whether it
    // missed something needs that list.
    expect(result.citations.map((citation) => citation.index)).toEqual([1, 2]);
    expect(result.citations[0].docKey).toBe('conversation::doc-1');

    // The prompt is built HERE and handed over whole, so the adapter cannot
    // change what the answer may draw on.
    const [prompt] = answerSpy.mock.calls[0];
    expect(prompt).toContain('why did we drop the sphere fit?');
    expect(prompt).toContain('Passage 1');
  });

  it('still answers when NO passage matched, because the board is also a source', async () => {
    // This was a refusal before the task table existed, and the refusal was the
    // bug: "how many tasks were abandoned?" matches no passage and is perfectly
    // answerable. Retrieval finding nothing is not the same as knowing nothing.
    mockHits = [];
    const answerSpy = vi.fn(async () => 'Two tasks, T1 and T2.');
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
      answerFromContext: answerSpy,
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('how many tasks are there?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(answerSpy).toHaveBeenCalled();
    // And the prompt says so plainly rather than shipping an empty section.
    expect(answerSpy.mock.calls[0][0]).toMatch(/EXCERPTS: none matched/);
  });

  it('refuses without spawning when there is nothing on EITHER side', async () => {
    // The original guard, narrowed to what it was always for: a real call could
    // only produce this same sentence, and a surface that charges for that once
    // is distrusted for the rest of the session.
    mockHits = [];
    const answerSpy = vi.fn(async () => 'should never run');
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
      answerFromContext: answerSpy,
    }];
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
    expect(result.citations).toEqual([]);
    expect(answerSpy).not.toHaveBeenCalled();
  });

  it('carries the whole board, and scopes the map to the tasks an answer selects', async () => {
    // The two properties the feature exists for. The table must hold every task
    // whether or not it was retrieved (task-2 has no hit here), and a selection
    // must come back as docKeys the map can filter on - INCLUDING the second
    // conversation of a selected task, which no retrieval returned.
    const answerSpy = vi.fn(async () => 'Framing work.\nSELECTED: T1');
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
      answerFromContext: answerSpy,
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('which tasks touched framing?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prompt = answerSpy.mock.calls[0][0] as string;
    // Rolled up per TASK: task-1's two conversations sum to 25, not 10 and 15.
    expect(prompt).toContain('T1|Sphere fit framing|2|25.00');
    // Present despite never being retrieved.
    expect(prompt).toContain('Terminal scrollback repaint');
    // A "which tasks" question gets the completeness rules.
    expect(prompt).toMatch(/return EVERY task that qualifies/);

    // Both of task-1's conversations light up, and task-2's does not.
    expect(result.selectedDocKeys).toEqual(['conversation::doc-1', 'conversation::doc-2']);
    expect(result.taskCount).toBe(2);
    // The protocol line never reaches the reader.
    expect(result.answer).toBe('Framing work.');
  });

  it('checks the agent BEFORE retrieving, so a dead end costs no work', async () => {
    mockAdapters = [{
      name: 'aider',
      displayName: 'Aider',
      detect: async () => ({ found: true, path: '/usr/bin/aider', version: '1' }),
      // No answerFromContext: this agent cannot answer.
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('aider') as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Names the SHORTAGE, not the project's agent: with nothing capable
    // registered, "Aider cannot answer" would point at the wrong problem.
    expect(result.reason).toMatch(/no installed agent can answer/i);
    // Retrieval never ran. Doing it first would spend real work on a question
    // that cannot be answered, and then report the CLI failure as a search one.
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('falls through to a capable agent when the project names one that is not', async () => {
    // The chain is configured setting, then project default, then anything
    // capable. A named fallback beats no answer, and the button prints the name
    // it resolved, so the fallback is stated rather than silent.
    const answerSpy = vi.fn(async () => 'From the other agent [1].');
    mockAdapters = [
      {
        name: 'aider',
        displayName: 'Aider',
        detect: async () => ({ found: true, path: '/usr/bin/aider', version: '1' }),
      },
      {
        name: 'claude',
        displayName: 'Claude Code',
        detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
        answerFromContext: answerSpy,
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext('aider') as any);

    const result = await ask('anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentName).toBe('Claude Code');
    expect(answerSpy).toHaveBeenCalled();
  });

  it('honours the configured answering agent over the project default', async () => {
    const claudeSpy = vi.fn(async () => 'claude answered');
    const codexSpy = vi.fn(async () => 'codex answered');
    mockAdapters = [
      {
        name: 'claude',
        displayName: 'Claude Code',
        detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
        answerFromContext: claudeSpy,
      },
      {
        name: 'codex',
        displayName: 'Codex',
        detect: async () => ({ found: true, path: '/usr/bin/codex', version: '1' }),
        answerFromContext: codexSpy,
      },
    ];
    const context = makeContext('claude');
    context.configManager.load = vi.fn(() => ({
      agent: { cliPaths: {} },
      memory: { answerAgent: 'codex' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test double
    })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(context as any);

    const result = await ask('anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Which agent runs your tasks and which reads your history are different
    // choices, so the explicit setting wins over the project's default.
    expect(result.agentName).toBe('Codex');
    expect(codexSpy).toHaveBeenCalled();
    expect(claudeSpy).not.toHaveBeenCalled();
  });

  it('reports a missing CLI rather than retrieving into a failure', async () => {
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: false, path: null, version: null }),
      answerFromContext: vi.fn(),
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Claude Code CLI not found');
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('turns a thrown CLI failure into a reason rather than an exception', async () => {
    mockAdapters = [{
      name: 'claude',
      displayName: 'Claude Code',
      detect: async () => ({ found: true, path: '/usr/bin/claude', version: '1' }),
      answerFromContext: async () => { throw new Error('summarize timed out'); },
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('summarize timed out');
  });

  it('refuses an empty question before doing anything at all', async () => {
    mockAdapters = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the context is a narrow test double
    registerSearchHandlers(makeContext() as any);

    const result = await ask('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ask a question/i);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
