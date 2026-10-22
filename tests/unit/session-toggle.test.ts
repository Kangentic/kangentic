/**
 * The card menu's Pause session / Resume session row: which row a task gets
 * (`sessionToggleRowFor`), the copy a failed toggle toasts
 * (`sessionToggleFailureToast`, over `sessionFailureBody`), the "Reconnected" toast
 * (`toastIfReconnectedResume`), and the click handler that ties them to the
 * session store (`runSessionToggle`).
 *
 * The row table is the renderer's reading of the one shared Pause / Resume rule
 * (`sessionToggleOffer`): To Do offers nothing, Done and archived keep Pause but
 * refuse Resume with main's own copy, and a task with no session lifecycle gets
 * no row. The expectations here come from that rule, not from the helper.
 *
 * `runSessionToggle` is driven against the real session and toast stores with
 * `window.electronAPI` stubbed, the way session-store-remove-session.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session, SessionDisplayState } from '../../src/shared/types';
import { resumeBlockMessage } from '../../src/shared/session-resume-eligibility';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the stores.
// ---------------------------------------------------------------------------

const suspendIpc: Mock = vi.fn();
const resumeIpc: Mock = vi.fn();
const reconcileIpc: Mock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: suspendIpc,
      resume: resumeIpc,
      reconcile: reconcileIpc,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
      getMessageTrails: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

// Import after the global stub so the store modules see the mocked window.
import {
  runSessionToggle,
  sessionFailureBody,
  sessionToggleFailureToast,
  sessionToggleRowFor,
  toastIfReconnectedResume,
  type SessionToggleRow,
} from '../../src/renderer/utils/session-toggle';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';
import { useToastStore } from '../../src/renderer/stores/toast-store';

// ---------------------------------------------------------------------------
// sessionToggleRowFor
// ---------------------------------------------------------------------------

type Kind = SessionDisplayState['kind'];

const NOT_ARCHIVED = { archived_at: null };
const ARCHIVED = { archived_at: '2026-01-01T00:00:00.000Z' };

/** The row each display kind gets in a custom column (role null) for a live task. */
const ROW_IN_A_CUSTOM_COLUMN: Record<Kind, SessionToggleRow | null> = {
  running: { direction: 'pause', sessionState: 'active', refusal: null },
  initializing: { direction: 'pause', sessionState: 'active', refusal: null },
  preparing: { direction: 'pause', sessionState: 'active', refusal: null },
  queued: { direction: 'pause', sessionState: 'queued', refusal: null },
  suspended: { direction: 'resume', sessionState: 'suspended', refusal: null },
  exited: null,
  none: null,
};

const ALL_KINDS = Object.keys(ROW_IN_A_CUSTOM_COLUMN) as Kind[];
const ACTIVE_KINDS: Kind[] = ['running', 'initializing', 'preparing', 'queued'];
const ENDED_KINDS: Kind[] = ['exited', 'none'];

describe('sessionToggleRowFor', () => {
  describe('in a custom column (no lane role)', () => {
    for (const kind of ALL_KINDS) {
      it(`${kind} gets ${ROW_IN_A_CUSTOM_COLUMN[kind] ? ROW_IN_A_CUSTOM_COLUMN[kind]!.direction : 'no row'}`, () => {
        expect(sessionToggleRowFor(kind, null, NOT_ARCHIVED)).toEqual(ROW_IN_A_CUSTOM_COLUMN[kind]);
      });
    }

    it('reads an undefined lane role as a custom column', () => {
      expect(sessionToggleRowFor('running', undefined, NOT_ARCHIVED)).toEqual(ROW_IN_A_CUSTOM_COLUMN.running);
    });
  });

  describe('in To Do', () => {
    // A move into To Do tears the session down, so there is nothing to pause or resume.
    for (const kind of ALL_KINDS) {
      it(`${kind} gets no row`, () => {
        expect(sessionToggleRowFor(kind, 'todo', NOT_ARCHIVED)).toBeNull();
      });
    }
  });

  describe('in Done', () => {
    // Pause stays: it is the only stop for a live agent a failed Done move left running.
    for (const kind of ACTIVE_KINDS) {
      it(`${kind} keeps Pause, unrefused`, () => {
        expect(sessionToggleRowFor(kind, 'done', NOT_ARCHIVED)).toEqual(ROW_IN_A_CUSTOM_COLUMN[kind]);
      });
    }

    it('suspended shows Resume refused with the Done message', () => {
      expect(sessionToggleRowFor('suspended', 'done', NOT_ARCHIVED)).toEqual({
        direction: 'resume',
        sessionState: 'suspended',
        refusal: resumeBlockMessage('done'),
      });
    });

    for (const kind of ENDED_KINDS) {
      it(`${kind} gets no row`, () => {
        expect(sessionToggleRowFor(kind, 'done', NOT_ARCHIVED)).toBeNull();
      });
    }

    it('names Done, not archived, for a completed task that is both', () => {
      // A completed task is archived and in Done; the message names the move out of Done.
      const row = sessionToggleRowFor('suspended', 'done', ARCHIVED);
      expect(row?.refusal).toBe(resumeBlockMessage('done'));
      expect(row?.refusal).not.toBe(resumeBlockMessage('archived'));
    });
  });

  describe('for an archived task outside Done', () => {
    it('suspended shows Resume refused with the archived message', () => {
      expect(sessionToggleRowFor('suspended', null, ARCHIVED)).toEqual({
        direction: 'resume',
        sessionState: 'suspended',
        refusal: resumeBlockMessage('archived'),
      });
    });

    for (const kind of ACTIVE_KINDS) {
      it(`${kind} keeps Pause, unrefused`, () => {
        expect(sessionToggleRowFor(kind, null, ARCHIVED)).toEqual(ROW_IN_A_CUSTOM_COLUMN[kind]);
      });
    }

    for (const kind of ENDED_KINDS) {
      it(`${kind} gets no row`, () => {
        expect(sessionToggleRowFor(kind, null, ARCHIVED)).toBeNull();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// sessionToggleFailureToast
// ---------------------------------------------------------------------------

describe('sessionToggleFailureToast', () => {
  it('titles a failed pause and makes the reason its one-sentence body', () => {
    expect(sessionToggleFailureToast('pause', new Error('reason'))).toEqual({
      title: "Couldn't pause session",
      message: 'Reason.',
    });
  });

  it('titles a failed resume and keeps a reason that is already a sentence', () => {
    expect(sessionToggleFailureToast('resume', new Error('The worktree is missing.'))).toEqual({
      title: "Couldn't resume session",
      message: 'The worktree is missing.',
    });
  });

  it('toasts main\'s two-sentence Resume refusal as its one-sentence form', () => {
    // Main throws the guidance the phone and the tooltip read; the toast sits by the card.
    const refused = new Error(`Error invoking remote method 'session:resume': Error: ${resumeBlockMessage('done')}`);
    expect(sessionToggleFailureToast('resume', refused)).toEqual({ title: "Couldn't resume session", message: 'The task is in Done.' });
    expect(sessionFailureBody(new Error(resumeBlockMessage('archived')))).toBe('The task is archived.');
  });

  it('drops the channel and class main decorates a rejection with', () => {
    const decorated = new Error("Error invoking remote method 'session:suspend': Error: PTY refused to stop");
    expect(sessionToggleFailureToast('pause', decorated).message).toBe('PTY refused to stop.');
  });

  it('says no reason was given when the error carries no message', () => {
    expect(sessionToggleFailureToast('pause', new Error(''))).toEqual({ title: "Couldn't pause session", message: 'No reason was given.' });
    expect(sessionToggleFailureToast('resume', new Error(''))).toEqual({ title: "Couldn't resume session", message: 'No reason was given.' });
  });

  it('says no reason was given for a rejection that is not an Error', () => {
    expect(sessionToggleFailureToast('pause', 'refused').message).toBe('No reason was given.');
    expect(sessionToggleFailureToast('resume', undefined).message).toBe('No reason was given.');
  });
});

// ---------------------------------------------------------------------------
// Store-backed behavior
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-toggle';
const TASK_ID = 'task-toggle';
const SESSION_ID = 'sess-toggle';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    pid: 4242,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-16T15:20:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    ...overrides,
  };
}

function seedSessions(sessions: Session[]): void {
  useSessionStore.setState({ sessions, _sessionByTaskId: buildSessionByTaskId(sessions) });
}

function heldSession(): Session | undefined {
  return useSessionStore.getState()._sessionByTaskId.get(TASK_ID);
}

const RECONNECTED_TOAST = { title: 'Reconnected', message: 'The session was already running.', variant: 'info' };
const PAUSE_REFUSED_TOAST = { title: "Couldn't pause session", message: 'PTY refused to stop.', variant: 'warning' };

function toastMessages(): Array<{ title: string | null; message: string; variant: string }> {
  return useToastStore.getState().toasts.map((toast) => ({ title: toast.title, message: toast.message, variant: toast.variant }));
}

beforeEach(() => {
  suspendIpc.mockReset();
  resumeIpc.mockReset();
  reconcileIpc.mockReset();
  suspendIpc.mockResolvedValue(undefined);
  reconcileIpc.mockResolvedValue(null);
  seedSessions([]);
  useToastStore.setState({ toasts: [] });
  // runSessionToggle logs the failures it toasts; keep them out of the report.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toastIfReconnectedResume', () => {
  it('raises an info toast when main hands back the session already shown, running', () => {
    toastIfReconnectedResume(SESSION_ID, makeSession({ status: 'running' }));
    expect(toastMessages()).toEqual([RECONNECTED_TOAST]);
  });

  it('stays silent when the resume started a different session', () => {
    toastIfReconnectedResume('sess-before', makeSession({ id: 'sess-after', status: 'running' }));
    expect(toastMessages()).toEqual([]);
  });

  it('stays silent when the card showed no session before the resume', () => {
    toastIfReconnectedResume(null, makeSession({ status: 'running' }));
    expect(toastMessages()).toEqual([]);
  });

  it('stays silent when the resume was cancelled and returned nothing', () => {
    toastIfReconnectedResume(SESSION_ID, null);
    expect(toastMessages()).toEqual([]);
  });

  it('stays silent when the returned session is not running', () => {
    toastIfReconnectedResume(SESSION_ID, makeSession({ status: 'queued' }));
    toastIfReconnectedResume(SESSION_ID, makeSession({ status: 'suspended' }));
    expect(toastMessages()).toEqual([]);
  });
});

describe('runSessionToggle: pause', () => {
  it('suspends the task for the project it was given, then tells the host', async () => {
    seedSessions([makeSession()]);
    const onSucceeded = vi.fn();

    await runSessionToggle({ taskId: TASK_ID, direction: 'pause', projectId: 'proj-other', onSucceeded });

    expect(suspendIpc).toHaveBeenCalledTimes(1);
    expect(suspendIpc).toHaveBeenCalledWith(TASK_ID, 'proj-other');
    expect(heldSession()?.status).toBe('suspended');
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(toastMessages()).toEqual([]);
  });

  describe('when main refuses the suspend', () => {
    beforeEach(() => {
      seedSessions([makeSession()]);
      suspendIpc.mockRejectedValue(new Error('PTY refused to stop'));
    });

    it('toasts the reason as a warning and does not tell the host it worked', async () => {
      reconcileIpc.mockResolvedValue(makeSession({ status: 'running' }));
      const onSucceeded = vi.fn();

      await runSessionToggle({ taskId: TASK_ID, direction: 'pause', projectId: PROJECT_ID, onSucceeded });

      expect(toastMessages()).toEqual([PAUSE_REFUSED_TOAST]);
      expect(onSucceeded).not.toHaveBeenCalled();
    });

    it('puts the optimistic pause back by asking main for the live session', async () => {
      reconcileIpc.mockResolvedValue(makeSession({ status: 'running' }));

      await runSessionToggle({ taskId: TASK_ID, direction: 'pause', projectId: 'proj-other' });

      expect(reconcileIpc).toHaveBeenCalledTimes(1);
      expect(reconcileIpc).toHaveBeenCalledWith(TASK_ID, 'proj-other');
      expect(heldSession()?.status).toBe('running');
    });

    it('still surfaces the refusal when the reconcile itself fails', async () => {
      reconcileIpc.mockRejectedValue(new Error('reconcile unavailable'));

      await runSessionToggle({ taskId: TASK_ID, direction: 'pause', projectId: PROJECT_ID });

      expect(toastMessages()).toEqual([PAUSE_REFUSED_TOAST]);
    });

    it('leaves the row paused when main has no live session to report', async () => {
      // Main confirmed nothing is live, so there is nothing to heal toward.
      reconcileIpc.mockResolvedValue(null);

      await runSessionToggle({ taskId: TASK_ID, direction: 'pause', projectId: PROJECT_ID });

      expect(heldSession()?.status).toBe('suspended');
    });
  });
});

describe('runSessionToggle: resume', () => {
  it('resumes the task for the project it was given with no prompt, then tells the host', async () => {
    seedSessions([makeSession({ status: 'suspended' })]);
    resumeIpc.mockResolvedValue(makeSession({ id: 'sess-new', status: 'running' }));
    const onSucceeded = vi.fn();

    await runSessionToggle({ taskId: TASK_ID, direction: 'resume', projectId: 'proj-other', onSucceeded });

    expect(resumeIpc).toHaveBeenCalledTimes(1);
    expect(resumeIpc).toHaveBeenCalledWith(TASK_ID, undefined, 'proj-other');
    expect(heldSession()?.id).toBe('sess-new');
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(toastMessages()).toEqual([]);
  });

  it('says it reconnected when main hands back the session the card already showed', async () => {
    seedSessions([makeSession({ status: 'suspended' })]);
    resumeIpc.mockResolvedValue(makeSession({ status: 'running' }));

    await runSessionToggle({ taskId: TASK_ID, direction: 'resume', projectId: PROJECT_ID });

    expect(toastMessages()).toEqual([RECONNECTED_TOAST]);
  });

  it('toasts the reason as a warning and does not tell the host when the resume fails', async () => {
    seedSessions([makeSession({ status: 'suspended' })]);
    resumeIpc.mockRejectedValue(new Error('Session could not be revived'));
    const onSucceeded = vi.fn();

    await runSessionToggle({ taskId: TASK_ID, direction: 'resume', projectId: PROJECT_ID, onSucceeded });

    expect(toastMessages()).toEqual([{ title: "Couldn't resume session", message: 'Session could not be revived.', variant: 'warning' }]);
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(heldSession()?.status).toBe('suspended');
  });

  it('writes nothing and stays silent when main cancelled the resume', async () => {
    // Whatever cancelled it pushes the task's real state, so the card is left as it is.
    seedSessions([makeSession({ status: 'suspended' })]);
    resumeIpc.mockResolvedValue(null);

    await runSessionToggle({ taskId: TASK_ID, direction: 'resume', projectId: PROJECT_ID });

    expect(heldSession()?.status).toBe('suspended');
    expect(toastMessages()).toEqual([]);
  });
});
