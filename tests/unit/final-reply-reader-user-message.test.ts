/**
 * The turn end's read of the user's last message (`readTurnUserMessage`) and the capability
 * check beside it (`sessionReportsUserMessages`), in
 * src/main/automations/turn-end/final-reply-reader.ts, for a Text match on the user's message
 * (#1078).
 *
 * What a user loses if these go: a row that reads no anchor, a stale record id or a failed worker
 * call as "no message" would move a card on nothing; every doubt must answer unreadable. The
 * typed record is keyed on the session record's own id, the one Kangentic recorded under, so a
 * lookup that matched by the agent's id still finds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  call: vi.fn(),
  lastUserMessage: vi.fn(),
  getBySessionType: vi.fn(),
  RetrievalUnavailableError: class extends Error {},
}));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: hoisted.call },
  RetrievalUnavailableError: hoisted.RetrievalUnavailableError,
}));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { getBySessionType: hoisted.getBySessionType } }));
vi.mock('../../src/main/automations/turn-end/typed-message-ledger', () => ({ lastUserMessage: hoisted.lastUserMessage }));

import {
  AGENT_REPLY_RETRY_DELAY_MS,
  readTurnUserMessage,
  sessionReportsUserMessages,
} from '../../src/main/automations/turn-end/final-reply-reader';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';

const WORKTREE = '/mock/project/.kangentic/worktrees/1078';
const ANCHOR = { agentSessionId: 'agent-1', byteOffset: 400 };
const PROJECT_DB = {} as unknown as Database.Database;

function repositoryWith(record: Record<string, unknown> | undefined): SessionRepository {
  return { findByAnyId: () => record } as unknown as SessionRepository;
}

const RECORD = {
  id: 'record-id-1',
  session_type: 'claude_agent',
  agent_session_id: 'agent-1',
  cwd: WORKTREE,
  cli_target: null,
  transcript_path: null,
};

describe('readTurnUserMessage', () => {
  beforeEach(() => {
    hoisted.call.mockReset();
    hoisted.lastUserMessage.mockReset();
    hoisted.call.mockResolvedValue(['signed off']);
    hoisted.lastUserMessage.mockReturnValue({ readable: true, message: 'signed off' });
  });

  it('is unreadable with no anchor, and calls no worker', async () => {
    expect(await readTurnUserMessage({ sessionId: 'session-1', transcriptAnchor: null }, repositoryWith(RECORD), PROJECT_DB))
      .toEqual({ readable: false });
    expect(await readTurnUserMessage({ sessionId: 'session-1' }, repositoryWith(RECORD), PROJECT_DB))
      .toEqual({ readable: false });
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('is unreadable for a session with no record, or no agent session id', async () => {
    const session = { sessionId: 'session-1', transcriptAnchor: ANCHOR };
    expect(await readTurnUserMessage(session, repositoryWith(undefined), PROJECT_DB)).toEqual({ readable: false });
    expect(await readTurnUserMessage(session, repositoryWith({ ...RECORD, agent_session_id: null }), PROJECT_DB)).toEqual({ readable: false });
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('asks the worker for the turn\'s user messages from the anchor, and reads the typed record under the record id', async () => {
    const read = await readTurnUserMessage({ sessionId: 'agent-1', transcriptAnchor: ANCHOR }, repositoryWith(RECORD), PROJECT_DB);

    expect(read).toEqual({ readable: true, message: 'signed off' });
    expect(hoisted.call).toHaveBeenCalledWith(
      'transcript.turnUserMessages',
      expect.objectContaining({
        facts: expect.objectContaining({ agentSessionId: 'agent-1', cwd: WORKTREE }),
        since: ANCHOR,
      }),
      expect.anything(),
    );
    // Keyed on the record's id, not the id the caller passed (the agent's, here).
    expect(hoisted.lastUserMessage).toHaveBeenCalledWith(PROJECT_DB, 'record-id-1', ['signed off']);
  });

  it('is unreadable when the worker answers null, and hands the ledger the null', async () => {
    hoisted.call.mockResolvedValue(null);
    hoisted.lastUserMessage.mockImplementation((_db: unknown, _id: string, messages: unknown) => (
      messages === null ? { readable: false } : { readable: true, message: 'x' }
    ));
    const read = await readTurnUserMessage({ sessionId: 'session-1', transcriptAnchor: ANCHOR }, repositoryWith(RECORD), PROJECT_DB);
    expect(read).toEqual({ readable: false });
    expect(hoisted.lastUserMessage).toHaveBeenCalledWith(PROJECT_DB, 'record-id-1', null);
  });

  it('does not retry a worker error that is not an unavailable worker, and is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.call.mockRejectedValue(new Error('the transcript could not be parsed'));
    const read = await readTurnUserMessage({ sessionId: 'session-1', transcriptAnchor: ANCHOR }, repositoryWith(RECORD), PROJECT_DB);
    expect(read).toEqual({ readable: false });
    expect(hoisted.call).toHaveBeenCalledTimes(1);
    expect(hoisted.lastUserMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('when the worker is restarting', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries once, and reads from the next worker', async () => {
      hoisted.call
        .mockRejectedValueOnce(new hoisted.RetrievalUnavailableError('restarting'))
        .mockResolvedValueOnce(['signed off']);
      const pending = readTurnUserMessage({ sessionId: 'session-1', transcriptAnchor: ANCHOR }, repositoryWith(RECORD), PROJECT_DB);
      await vi.advanceTimersByTimeAsync(AGENT_REPLY_RETRY_DELAY_MS);
      expect(await pending).toEqual({ readable: true, message: 'signed off' });
      expect(hoisted.call).toHaveBeenCalledTimes(2);
    });

    it('is unreadable, after exactly one retry, when the retry finds no worker either', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.call.mockRejectedValue(new hoisted.RetrievalUnavailableError('restarting'));
      const pending = readTurnUserMessage({ sessionId: 'session-1', transcriptAnchor: ANCHOR }, repositoryWith(RECORD), PROJECT_DB);
      await vi.advanceTimersByTimeAsync(AGENT_REPLY_RETRY_DELAY_MS);
      expect(await pending).toEqual({ readable: false });
      expect(hoisted.call).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});

describe('sessionReportsUserMessages', () => {
  const fullAdapter = {
    parseTranscriptWindow: async () => ({}),
    locateSessionHistoryFile: async () => null,
    readQueuedUserMessages: async () => [],
  };

  beforeEach(() => {
    hoisted.getBySessionType.mockReset();
  });

  it('is true for an agent with the windowed reader, the locator and the queued reader', () => {
    hoisted.getBySessionType.mockReturnValue(fullAdapter);
    expect(sessionReportsUserMessages('session-1', repositoryWith(RECORD))).toBe(true);
    expect(hoisted.getBySessionType).toHaveBeenCalledWith('claude_agent');
  });

  it('is false for an agent with no queued-input reader', () => {
    hoisted.getBySessionType.mockReturnValue({ ...fullAdapter, readQueuedUserMessages: undefined });
    expect(sessionReportsUserMessages('session-1', repositoryWith(RECORD))).toBe(false);
  });

  it('is undefined with no record, or an agent the registry does not know', () => {
    hoisted.getBySessionType.mockReturnValue(fullAdapter);
    expect(sessionReportsUserMessages('session-1', repositoryWith(undefined))).toBeUndefined();
    hoisted.getBySessionType.mockReturnValue(undefined);
    expect(sessionReportsUserMessages('session-1', repositoryWith(RECORD))).toBeUndefined();
  });
});
