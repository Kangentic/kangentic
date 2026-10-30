import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Stubbed so the tool's resolution and attribution logic can be exercised
 * without standing up a per-project SQLite file and its migrations. Keyed by
 * the fake project DB handle, so a lookup against the WRONG project's database
 * returns nothing - which is exactly the cross-project attribution bug this
 * file exists to pin.
 */
const tasksByProjectDb = new Map<string, Map<string, { id: string; display_id: number; title: string; session_id: string | null }>>();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    private readonly rows: Map<string, { id: string; display_id: number; title: string; session_id: string | null }>;
    constructor(database: unknown) {
      this.rows = tasksByProjectDb.get(String(database)) ?? new Map();
    }
    getById(taskId: string) {
      return this.rows.get(taskId);
    }
    getByDisplayId(displayId: number) {
      return [...this.rows.values()].find((row) => row.display_id === displayId);
    }
  },
}));

/** Rows the tool wrote, tagged with which project DB handle received them. */
const insertedSentMessages: Array<{ db: string; row: Record<string, unknown> }> = [];

/** Rows the mocked repository returns from its list methods. */
let storedSentMessages: Array<Record<string, unknown>> = [];

vi.mock('../../src/main/db/repositories/sent-session-message-repository', () => ({
  SentSessionMessageRepository: class {
    constructor(private readonly database: unknown) {}
    insert(row: Record<string, unknown>) {
      insertedSentMessages.push({ db: String(this.database), row });
      return { id: 'sent-1', created_at: '2026-07-25T00:00:00.000Z', ...row };
    }
    listForSession(sessionId: string) {
      return storedSentMessages.filter((row) => row.session_id === sessionId);
    }
    listForTask() {
      return storedSentMessages;
    }
  },
}));

/** Session records by id, as `SessionRepository.findByAnyId` reads them: a paused or exited session's task. */
const sessionRecordsById = new Map<string, { id: string; task_id: string }>();

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId(sessionId: string) {
      return sessionRecordsById.get(sessionId);
    }
  },
}));

const { registerSteeringTools, heldMessageReply } = await import('../../src/main/agent/mcp-http/steering-tools');
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function makeProject(dbHandle: string, rows: Array<{ id: string; display_id: number; title: string; session_id?: string | null }>) {
  tasksByProjectDb.set(
    dbHandle,
    new Map(rows.map((row) => [row.id, { session_id: null, ...row }])),
  );
  return { getProjectDb: () => dbHandle, getProjectPath: () => '/mock/project' };
}

/**
 * Captures every handler `registerTool` is called with, keyed by tool name,
 * plus each one's declared annotations. `handler` / `annotations` refer to the
 * send tool so existing callers read unchanged.
 */
function captureTool(dependencies: Parameters<typeof registerSteeringTools>[2], resolver: Parameters<typeof registerSteeringTools>[1]) {
  const handlers = new Map<string, ToolHandler>();
  const annotationsByName = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, config: { annotations?: unknown }, toolHandler: ToolHandler) => {
      handlers.set(name, toolHandler);
      annotationsByName.set(name, config.annotations);
    },
  };
  registerSteeringTools(server as unknown as Parameters<typeof registerSteeringTools>[0], resolver, dependencies);
  const sendHandler = handlers.get('kangentic_send_session_message');
  if (!sendHandler) throw new Error('registerSteeringTools did not register the send tool');
  return {
    handler: sendHandler,
    annotations: annotationsByName.get('kangentic_send_session_message'),
    handlers,
    annotationsByName,
  };
}

beforeEach(() => {
  tasksByProjectDb.clear();
  sessionRecordsById.clear();
  insertedSentMessages.length = 0;
  storedSentMessages = [];
});

describe('kangentic_send_session_message registration', () => {
  const targetProject = () => makeProject('target-db', [{ id: 'task-uuid-target', display_id: 42, title: 'Fix the switch' }]);

  function makeResolver(overrides: Record<string, ReturnType<typeof makeProject>> = {}) {
    const resolveProject = vi.fn((selector: string | null | undefined) => {
      if (selector && overrides[selector]) {
        return { context: overrides[selector], projectId: selector, projectName: selector, isDefault: false };
      }
      if (selector) return { error: `No project "${selector}"` };
      return { context: targetProject(), projectId: 'target-project', projectName: 'target', isDefault: true };
    });
    return { resolver: { resolveProject } as unknown as Parameters<typeof registerSteeringTools>[1], resolveProject };
  }

  /**
   * Sessions the registry places in the resolved (target) project. Needed
   * because the tool asks `getSessionProjectId` two different questions - which
   * project the CALLER belongs to, for provenance, and which project the TARGET
   * belongs to, for the cross-project guard. A single-constant stub answers the
   * second one wrongly and would refuse every send in this file.
   */
  const TARGET_PROJECT_SESSIONS = new Set(['target-session', 'explicit']);

  function makeSessions(overrides: Partial<{
    live: string | undefined;
    taskId: string | undefined;
    projectId: string | undefined;
    /** Which sessions have a PTY to deliver into. Every one, unless a test says otherwise. */
    writable: (sessionId: string) => boolean;
  }> = {}) {
    return {
      findLiveSessionByTaskId: vi.fn(() => ('live' in overrides ? (overrides.live ? { id: overrides.live } : undefined) : { id: 'target-session' })),
      getSessionTaskId: vi.fn(() => ('taskId' in overrides ? overrides.taskId : 'task-uuid-caller')),
      getSessionProjectId: vi.fn((sessionId: string) => (
        TARGET_PROJECT_SESSIONS.has(sessionId)
          ? 'target-project'
          : ('projectId' in overrides ? overrides.projectId : 'caller-project')
      )),
      isWritable: vi.fn(overrides.writable ?? (() => true)),
    };
  }

  /** A coordinator whose hold window has room unless a test says otherwise. */
  function makeCoordinator(send: ReturnType<typeof vi.fn> = vi.fn(), holdSlotFree = true) {
    return { send, reserveHoldSlot: vi.fn(() => holdSlotFree), dispose: vi.fn(), _stateSizesForTesting: vi.fn() };
  }

  /**
   * The hold function main binds: every message held, for display id 42. It
   * runs the caller's `admit` as `holdTaskMessage` does, after its own checks:
   * a refusal outcome given here returns before `admit`, as main's Done refusal does.
   */
  function makeHolder(outcome: { status: 'held'; displayId: number; rowId: string } | { status: 'refused'; error: string } = { status: 'held', displayId: 42, rowId: 'held-1' }) {
    return vi.fn((input: { admit?: () => string | null }) => {
      if (outcome.status === 'refused') return outcome;
      const admitRefusal = input.admit?.() ?? null;
      return admitRefusal === null ? outcome : { status: 'refused' as const, error: admitRefusal };
    });
  }

  it('declares mutating annotations so plan mode cannot auto-approve a live PTY write', () => {
    const { resolver } = makeResolver();
    const { annotations } = captureTool(
      { coordinator: { send: vi.fn(), dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );
    expect(annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it('resolves a taskId to the registry live session, not the drift-prone task.session_id', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'target-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'rebase onto main' });

    expect(result.isError).toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'target-session', message: 'rebase onto main', deliverWhen: 'now' }));
  });

  it('records provenance into the TARGET project database, resolving caller ids server-side', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'target-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions(), callerSessionId: 'caller-session' },
      resolver,
    );

    await handler({ taskId: '42', message: 'take this over' });

    // The recorder is handed to the coordinator rather than invoked inline, so
    // a deferred send writes its row when the text lands, not when it queued.
    const request = send.mock.calls[0][0] as { recordSentMessage: (delivery: unknown) => void };
    expect(typeof request.recordSentMessage).toBe('function');

    request.recordSentMessage({
      targetSessionId: 'target-session',
      callerSessionId: 'caller-session',
      message: 'take this over',
      status: 'delivered',
    });

    expect(insertedSentMessages).toEqual([
      {
        db: 'target-db',
        row: {
          session_id: 'target-session',
          caller_session_id: 'caller-session',
          caller_task_id: 'task-uuid-caller',
          caller_project_id: 'caller-project',
          message: 'take this over',
          status: 'delivered',
          error: null,
        },
      },
    ]);
  });

  it('records a caller-less human send with null caller ids rather than inventing them', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'target-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );

    await handler({ taskId: '42', message: 'hello' });

    const request = send.mock.calls[0][0] as { recordSentMessage: (delivery: unknown) => void };
    request.recordSentMessage({ targetSessionId: 'target-session', message: 'hello', status: 'delivered' });

    expect(insertedSentMessages[0].row).toMatchObject({
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
    });
  });

  it('records a task-less transient caller without failing the send', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'target-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      {
        coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() },
        sessions: makeSessions({ taskId: undefined }),
        callerSessionId: 'command-terminal-session',
      },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });
    expect(result.isError).toBeUndefined();

    const request = send.mock.calls[0][0] as { recordSentMessage: (delivery: unknown) => void };
    request.recordSentMessage({
      targetSessionId: 'target-session',
      callerSessionId: 'command-terminal-session',
      message: 'hello',
      status: 'delivered',
    });

    expect(insertedSentMessages[0].row).toMatchObject({
      caller_session_id: 'command-terminal-session',
      caller_task_id: null,
    });
  });

  it('holds the message for a task with no running agent, with the reply the docs quote', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      { coordinator: makeCoordinator(send), sessions: makeSessions({ live: undefined }), holdTaskMessage, callerSessionId: 'caller-session' },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'Lower the cap to 3 and rethrow the last error.' });

    // Red before held messages: refused with "has no session to send to".
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(heldMessageReply(42));
    expect(result.content[0].text).toBe(
      'Held for task #42: no agent is running on it. It goes out when an agent starts or resumes there, and is cleared if the task moves to Done, To Do or Backlog, or is archived or deleted.',
    );
    expect(holdTaskMessage).toHaveBeenCalledWith({
      projectId: 'target-project',
      taskId: 'task-uuid-target',
      message: 'Lower the cap to 3 and rethrow the last error.',
      callerSessionId: 'caller-session',
      callerTaskId: 'task-uuid-caller',
      callerProjectId: 'caller-project',
      admit: expect.any(Function),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('holds the message when the task\'s live session is still queued, with no PTY yet', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      {
        coordinator: makeCoordinator(send),
        sessions: makeSessions({ live: 'queued-session', writable: (sessionId) => sessionId !== 'queued-session' }),
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.content[0].text).toBe(heldMessageReply(42));
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a hold the task refuses (a task in Done) as an error', async () => {
    const { resolver } = makeResolver();
    const holdTaskMessage = makeHolder({ status: 'refused', error: 'Task #42 is in Done, where no agent runs, so nothing is held for it. Move it out of Done first.' });
    const { handler } = captureTool(
      { coordinator: makeCoordinator(), sessions: makeSessions({ live: undefined }), holdTaskMessage },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/is in Done/);
  });

  it('refuses to hold a message for the caller\'s own task', async () => {
    const { resolver } = makeResolver();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      {
        coordinator: makeCoordinator(),
        sessions: makeSessions({ live: undefined, taskId: 'task-uuid-target' }),
        holdTaskMessage,
        callerSessionId: 'caller-session',
      },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/its own task/);
    expect(holdTaskMessage).not.toHaveBeenCalled();
  });

  it('refuses a hold past the task\'s window, so a loop cannot fill the log', async () => {
    const { resolver } = makeResolver();
    const holdTaskMessage = makeHolder();
    const coordinator = makeCoordinator(vi.fn(), false);
    const { handler } = captureTool(
      { coordinator, sessions: makeSessions({ live: undefined }), holdTaskMessage },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Rate limit/);
    expect(coordinator.reserveHoldSlot).toHaveBeenCalledWith('task-uuid-target');
  });

  it('spends no slot of the task\'s window on a hold the task refuses', async () => {
    const { resolver } = makeResolver();
    const holdTaskMessage = makeHolder({ status: 'refused', error: 'Task #42 is in Done, where no agent runs, so nothing is held for it. Move it out of Done first.' });
    const coordinator = makeCoordinator();
    const { handler } = captureTool(
      { coordinator, sessions: makeSessions({ live: undefined }), holdTaskMessage },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.content[0].text).toMatch(/is in Done/);
    expect(coordinator.reserveHoldSlot).not.toHaveBeenCalled();
  });

  it('holds for the task a paused session belonged to, given that session id alone', async () => {
    const { resolver } = makeResolver();
    sessionRecordsById.set('paused-session', { id: 'paused-session', task_id: 'task-uuid-target' });
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      {
        coordinator: makeCoordinator(),
        // Gone from the registry, so its task comes from the record.
        sessions: makeSessions({ live: undefined, taskId: undefined, writable: () => false }),
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ sessionId: 'paused-session', message: 'hello' });

    expect(result.content[0].text).toBe(heldMessageReply(42));
    expect(holdTaskMessage).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-uuid-target' }));
  });

  it('refuses a dead session id no task here owns, with nothing to hold for', async () => {
    const { resolver } = makeResolver();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      { coordinator: makeCoordinator(), sessions: makeSessions({ taskId: undefined, writable: () => false }), holdTaskMessage },
      resolver,
    );

    const result = await handler({ sessionId: 'never-existed', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to hold the message for/);
    expect(holdTaskMessage).not.toHaveBeenCalled();
  });

  it('rejects an unknown task id', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn();
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );

    const result = await handler({ taskId: '9999', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No task found/);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires a taskId or a sessionId', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn();
    const { handler } = captureTool(
      { coordinator: makeCoordinator(send), sessions: makeSessions(), holdTaskMessage: makeHolder() },
      resolver,
    );

    const neither = await handler({ message: 'hello' });
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toMatch(/Provide taskId/);
    expect(send).not.toHaveBeenCalled();
  });

  it('takes a taskId with that task\'s own sessionId, and sends to it', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'target-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      { coordinator: makeCoordinator(send), sessions: makeSessions({ taskId: 'task-uuid-target' }), holdTaskMessage: makeHolder() },
      resolver,
    );

    const result = await handler({ taskId: '42', sessionId: 'target-session', message: 'hello' });

    expect(result.isError).toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'target-session' }));
  });

  it('holds for a task, given that task\'s own paused session id the registry still names', async () => {
    // Paused: no PTY to deliver into and the task has no live session. The id
    // is the task's own, so it is neither a stranger's nor an unknown id, and
    // the message waits for the task's next agent instead of being refused.
    const { resolver } = makeResolver();
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const coordinator = makeCoordinator(send);
    const { handler } = captureTool(
      {
        coordinator,
        sessions: makeSessions({ live: undefined, taskId: 'task-uuid-target', writable: () => false }),
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ taskId: '42', sessionId: 'paused-session', message: 'hello' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(heldMessageReply(42));
    expect(holdTaskMessage).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-uuid-target', message: 'hello' }));
    expect(coordinator.reserveHoldSlot).toHaveBeenCalledWith('task-uuid-target');
    expect(send).not.toHaveBeenCalled();
  });

  it('holds for a task, given that task\'s own paused session id only its session record names', async () => {
    // The common paused case: the session has left the live registry, so the
    // owner comes from the sessions table. Not finding it in the registry is
    // not the same as the id naming no session at all.
    const { resolver } = makeResolver();
    sessionRecordsById.set('paused-session', { id: 'paused-session', task_id: 'task-uuid-target' });
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      {
        coordinator: makeCoordinator(send),
        sessions: makeSessions({ live: undefined, taskId: undefined, writable: () => false }),
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ taskId: '42', sessionId: 'paused-session', message: 'hello' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(heldMessageReply(42));
    expect(holdTaskMessage).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-uuid-target' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a sessionId that no registry and no sessions table here knows, telling the caller to pass taskId alone', async () => {
    // Going on by taskId alone would report success ("Held for task #42") for a
    // session the caller never had, so the mistake would go uncorrected.
    const { resolver } = makeResolver();
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const coordinator = makeCoordinator(send);
    const { handler } = captureTool(
      {
        coordinator,
        sessions: makeSessions({ live: undefined, taskId: undefined, writable: () => false }),
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ taskId: '42', sessionId: 'never-existed', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Session never-existed is not a session of task #42/);
    expect(result.content[0].text).toMatch(/Pass taskId alone/);
    expect(holdTaskMessage).not.toHaveBeenCalled();
    expect(coordinator.reserveHoldSlot).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(insertedSentMessages).toEqual([]);
  });

  it('refuses a sessionId that belongs to another task than the taskId, naming its task', async () => {
    const { resolver } = makeResolver({
      both: makeProject('both-db', [
        { id: 'task-uuid-target', display_id: 42, title: 'Fix the switch' },
        { id: 'task-uuid-other', display_id: 7, title: 'Another task' },
      ]),
    });
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      { coordinator: makeCoordinator(send), sessions: makeSessions({ taskId: 'task-uuid-other' }), holdTaskMessage },
      resolver,
    );

    const result = await handler({ taskId: '42', sessionId: 'other-session', message: 'hello', project: 'both' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to task #7, not task #42/);
    expect(send).not.toHaveBeenCalled();
    expect(holdTaskMessage).not.toHaveBeenCalled();
  });

  it('passes an explicit sessionId straight through without a task lookup', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ status: 'queued', sessionId: 'explicit', targetActivity: 'thinking', hopDepth: 1 }));
    const sessions = makeSessions();
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions },
      resolver,
    );

    const result = await handler({ sessionId: 'explicit', message: 'hello', deliverWhen: 'idle' });

    expect(sessions.findLiveSessionByTaskId).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'explicit', deliverWhen: 'idle' }));
    expect(result.content[0].text).toContain('"status": "queued"');
  });

  it('refuses an explicit sessionId that lives in a different project', async () => {
    // Liveness is checked against the GLOBAL PTY registry, so without this the
    // send would land while its provenance row silently vanished: the recorder
    // writes into the resolved project's database, where no matching sessions
    // row exists, and the repository skips the insert. An unrecorded send is
    // indistinguishable from a human-typed turn.
    const { resolver } = makeResolver();
    const send = vi.fn();
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );

    const result = await handler({ sessionId: 'session-in-another-project', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to a different project/);
    expect(send).not.toHaveBeenCalled();
    expect(insertedSentMessages).toEqual([]);
  });

  it('refuses the drift-prone task.session_id fallback when it now belongs to another task, and holds instead', async () => {
    // findLiveSessionByTaskId misses, so the stale column is the only candidate
    // - and the registry says that session is another task's. Liveness is not
    // ownership; delivering would steer a stranger's agent. The task has no
    // agent of its own running, so the message waits for its next one.
    const { resolver } = makeResolver({
      drift: makeProject('drift-db', [
        { id: 'task-uuid-target', display_id: 42, title: 'Fix the switch', session_id: 'someone-elses-session' },
      ]),
    });
    const send = vi.fn();
    const holdTaskMessage = makeHolder();
    const { handler } = captureTool(
      {
        coordinator: makeCoordinator(send),
        // No live session for the task; the stale id maps to a different task.
        sessions: { ...makeSessions({ live: undefined }), getSessionTaskId: vi.fn(() => 'a-completely-different-task') },
        holdTaskMessage,
      },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello', project: 'drift' });

    expect(send).not.toHaveBeenCalled();
    expect(holdTaskMessage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'drift', taskId: 'task-uuid-target' }));
    // A named project's reply carries withProject's project line first.
    expect(result.content[0].text).toContain(heldMessageReply(42));
  });

  it('accepts the task.session_id fallback when the registry cannot contradict it', async () => {
    // The common case: the session is gone from the registry entirely, so
    // getSessionTaskId returns undefined. Absence of proof is not proof of
    // drift - fall back and let the coordinator's liveness guard decide.
    const { resolver } = makeResolver({
      stale: makeProject('stale-db', [
        { id: 'task-uuid-target', display_id: 42, title: 'Fix the switch', session_id: 'previous-session' },
      ]),
    });
    const send = vi.fn(() => Promise.resolve({ status: 'delivered', sessionId: 'previous-session', targetActivity: 'idle', hopDepth: 1 }));
    const { handler } = captureTool(
      {
        coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() },
        sessions: {
          ...makeSessions({ live: undefined }),
          getSessionTaskId: vi.fn(() => undefined),
          getSessionProjectId: vi.fn(() => undefined),
        },
      },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello', project: 'stale' });

    expect(result.isError).toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'previous-session' }));
  });

  describe('kangentic_get_session_messages_sent', () => {
    function captureReadTool() {
      const { handlers, annotationsByName } = captureTool(
        {
          coordinator: { send: vi.fn(), dispose: vi.fn(), _stateSizesForTesting: vi.fn() },
          sessions: makeSessions(),
        },
        makeResolver().resolver,
      );
      const handler = handlers.get('kangentic_get_session_messages_sent');
      if (!handler) throw new Error('the read tool was not registered');
      return { handler, annotations: annotationsByName.get('kangentic_get_session_messages_sent') };
    }

    it('is annotated read-only so it stays usable in plan mode', () => {
      expect(captureReadTool().annotations).toMatchObject({ readOnlyHint: true });
    });

    it('returns a session\'s messages with a total and a returned count', async () => {
      storedSentMessages = [
        { session_id: 'target-session', message: 'one', status: 'delivered', error: null },
        { session_id: 'target-session', message: 'two', status: 'failed', error: 'no-submission-evidence' },
      ];
      const { handler } = captureReadTool();

      const result = await handler({ sessionId: 'target-session' });
      const payload = JSON.parse(result.content[0].text) as { total: number; returned: number; messages: unknown[] };

      expect(payload).toMatchObject({ total: 2, returned: 2 });
      expect(payload.messages).toHaveLength(2);
    });

    it('resolves a taskId and reads via listForTask, not listForSession(taskId)', async () => {
      // storedSentMessages carries session_id 'target-session', which is NOT
      // task-uuid-target (the id 'task-uuid-target' resolves to for display_id
      // 42). The mocked listForSession filters by session_id === the id it is
      // given, so calling it with the task's id (a plausible copy-paste
      // regression: `repository.listForSession(task.id)` instead of
      // `repository.listForTask(task.id)`) would return 0 rows here, not 2.
      storedSentMessages = [
        { session_id: 'target-session', message: 'one', status: 'delivered', error: null },
        { session_id: 'target-session', message: 'two', status: 'failed', error: 'no-submission-evidence' },
      ];
      const { handler } = captureReadTool();

      const result = await handler({ taskId: '42' });
      const payload = JSON.parse(result.content[0].text) as { total: number; returned: number; messages: unknown[] };

      expect(payload).toMatchObject({ total: 2, returned: 2 });
    });

    it('filters to a single status so failures can be isolated', async () => {
      storedSentMessages = [
        { session_id: 'target-session', message: 'ok', status: 'delivered', error: null },
        { session_id: 'target-session', message: 'bad', status: 'failed', error: 'boom' },
        { session_id: 'target-session', message: 'blocked', status: 'refused', error: 'rate limit' },
      ];
      const { handler } = captureReadTool();

      const result = await handler({ sessionId: 'target-session', status: 'failed' });
      const payload = JSON.parse(result.content[0].text) as { total: number; messages: Array<{ message: string }> };

      expect(payload.total).toBe(1);
      expect(payload.messages[0].message).toBe('bad');
    });

    it('keeps the MOST RECENT attempts when tail truncates', async () => {
      storedSentMessages = ['a', 'b', 'c', 'd'].map((message) => ({
        session_id: 'target-session', message, status: 'delivered', error: null,
      }));
      const { handler } = captureReadTool();

      const result = await handler({ sessionId: 'target-session', tail: 2 });
      const payload = JSON.parse(result.content[0].text) as { total: number; returned: number; messages: Array<{ message: string }> };

      // Oldest-first storage, so a tail must slice from the END - returning the
      // first N would report the least useful rows when debugging.
      expect(payload).toMatchObject({ total: 4, returned: 2 });
      expect(payload.messages.map((sent) => sent.message)).toEqual(['c', 'd']);
    });

    it('rejects an unknown task id rather than reporting an empty log', async () => {
      const { handler } = captureReadTool();
      const result = await handler({ taskId: '9999' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No task found/);
    });

    it('requires exactly one of taskId or sessionId', async () => {
      const { handler } = captureReadTool();

      const neither = await handler({});
      expect(neither.isError).toBe(true);
      expect(neither.content[0].text).toMatch(/either taskId or sessionId/);

      const both = await handler({ taskId: '42', sessionId: 'target-session' });
      expect(both.isError).toBe(true);
      expect(both.content[0].text).toMatch(/not both/);
    });
  });

  it('surfaces a coordinator refusal as an isError result', async () => {
    const { resolver } = makeResolver();
    const send = vi.fn(() => Promise.resolve({ error: 'Rate limit: too many messages' }));
    const { handler } = captureTool(
      { coordinator: { send, dispose: vi.fn(), _stateSizesForTesting: vi.fn() }, sessions: makeSessions() },
      resolver,
    );

    const result = await handler({ taskId: '42', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Rate limit/);
  });
});
