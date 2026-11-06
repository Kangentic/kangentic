/**
 * The turn end's reply read (`tryReadSessionFinalReply`,
 * src/main/automations/turn-end/final-reply-reader.ts) sends the session row's
 * `transcript_path` to the retrieval worker with the rest of its facts.
 *
 * The reply is read in the worker, and the worker's adapter reads that path
 * before any it derives from the cwd: Claude keeps appending a resumed
 * conversation to the file under the folder it started in. Dropped on this hop,
 * every row-held report would stop at main while the worker read only the cwd,
 * and the tests that call `readFinalReply` directly would still pass.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  call: vi.fn(),
  RetrievalUnavailableError: class extends Error {},
}));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: hoisted.call },
  RetrievalUnavailableError: hoisted.RetrievalUnavailableError,
}));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: {} }));

import { AGENT_REPLY_RETRY_DELAY_MS, tryReadSessionFinalReply } from '../../src/main/automations/turn-end/final-reply-reader';
import { DEFAULT_BACKOFF_MS } from '../../src/main/utility-process/restart-policy';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';

const REPORTED_PATH = '/home/dev/.claude/projects/-mock-project/agent-1.jsonl';
const WORKTREE = '/mock/project/.kangentic/worktrees/918';

function repositoryWith(transcriptPath: string | null): SessionRepository {
  return {
    findByAnyId: () => ({
      session_type: 'claude_agent',
      agent_session_id: 'agent-1',
      cwd: WORKTREE,
      cli_target: null,
      transcript_path: transcriptPath,
    }),
  } as unknown as SessionRepository;
}

describe('tryReadSessionFinalReply', () => {
  beforeEach(() => {
    hoisted.call.mockReset();
    hoisted.call.mockResolvedValue({ text: 'On to Merge', uuid: 'a-2', ts: 0 });
  });

  it('sends the row\'s reported transcript path with the cwd it derives from', async () => {
    const read = await tryReadSessionFinalReply({ sessionId: 'session-1' }, repositoryWith(REPORTED_PATH));

    expect(read).toEqual({ ok: true, reply: { text: 'On to Merge', uuid: 'a-2', ts: 0 } });
    expect(hoisted.call).toHaveBeenCalledWith(
      'transcript.finalReply',
      expect.objectContaining({
        facts: expect.objectContaining({ agentSessionId: 'agent-1', cwd: WORKTREE, transcriptPath: REPORTED_PATH }),
      }),
      expect.anything(),
    );
  });

  it('sends null for a row whose status line never reported a path', async () => {
    await tryReadSessionFinalReply({ sessionId: 'session-1' }, repositoryWith(null));

    expect(hoisted.call).toHaveBeenCalledWith(
      'transcript.finalReply',
      expect.objectContaining({ facts: expect.objectContaining({ transcriptPath: null }) }),
      expect.anything(),
    );
  });
});

describe('a reply read that meets a retrieval worker restart', () => {
  const REPLY = { text: 'On to Merge', uuid: 'a-2', ts: 0 };

  beforeEach(() => {
    hoisted.call.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the reply from the next worker, once the restart policy lets one start', async () => {
    hoisted.call
      .mockRejectedValueOnce(new hoisted.RetrievalUnavailableError('did not answer in time'))
      .mockResolvedValueOnce(REPLY);

    const pending = tryReadSessionFinalReply({ sessionId: 'session-1' }, repositoryWith(REPORTED_PATH));
    await vi.advanceTimersByTimeAsync(AGENT_REPLY_RETRY_DELAY_MS - 1);
    expect(hoisted.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ ok: true, reply: REPLY });
    expect(hoisted.call).toHaveBeenCalledTimes(2);
  });

  it('waits past the restart policy\'s first backoff', () => {
    expect(AGENT_REPLY_RETRY_DELAY_MS).toBeGreaterThan(DEFAULT_BACKOFF_MS[0]);
  });

  it('reports a failure, not an empty reply, when the retry finds no worker either', async () => {
    hoisted.call.mockRejectedValue(new hoisted.RetrievalUnavailableError('restarting'));

    const pending = tryReadSessionFinalReply({ sessionId: 'session-1' }, repositoryWith(REPORTED_PATH));
    await vi.advanceTimersByTimeAsync(AGENT_REPLY_RETRY_DELAY_MS);

    expect(await pending).toEqual({ ok: false });
    expect(hoisted.call).toHaveBeenCalledTimes(2);
  });

  it('does not retry a read the worker answered with its own error', async () => {
    hoisted.call.mockRejectedValue(new Error('the transcript could not be parsed'));

    expect(await tryReadSessionFinalReply({ sessionId: 'session-1' }, repositoryWith(REPORTED_PATH))).toEqual({ ok: false });
    expect(hoisted.call).toHaveBeenCalledTimes(1);
  });
});
