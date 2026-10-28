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
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.call } }));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: {} }));

import { tryReadSessionFinalReply } from '../../src/main/automations/turn-end/final-reply-reader';
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
