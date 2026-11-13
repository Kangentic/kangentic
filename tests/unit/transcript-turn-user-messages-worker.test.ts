/**
 * The retrieval worker's `transcript.turnUserMessages`: the method main calls at a turn end to
 * read the user's messages for a Text match on the user's message (#1078). It fails closed: an
 * unknown session type and a read that throws both answer null (unreadable), never a rejection
 * the caller could mistake for "no messages". Driven directly through the real
 * `readTurnUserMessages`; the adapter is a stub the registry resolves for a test session type.
 *
 * Tier: Unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';

const STUB_SESSION_TYPE = 'stub_turn_user_messages_agent';
const AGENT_SESSION_ID = 'agent-session-1';
const FACTS = { sessionType: STUB_SESSION_TYPE, agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' };
const FILE_BYTES = 4096;
const ANCHOR = { agentSessionId: AGENT_SESSION_ID, byteOffset: 1500 };

const context: WorkerContext = {
  getDb: () => ({}) as unknown as Database.Database,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};

function turnUserMessages(sessionType: string) {
  return transcriptHandlers['transcript.turnUserMessages'](
    { facts: { ...FACTS, sessionType }, since: ANCHOR, remoteTargets: [] },
    context,
  );
}

describe('transcript.turnUserMessages', () => {
  let tmpDir: string;
  let parseTranscriptWindow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-user-messages-worker-test-'));
    const file = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
    fs.writeFileSync(file, 'x'.repeat(FILE_BYTES));
    parseTranscriptWindow = vi.fn(async () => ({
      entries: [{ kind: 'user' as const, uuid: 'u1', ts: 100, text: 'signed off' }],
      sourcePath: file,
      nextByteOffset: FILE_BYTES,
      totalBytes: FILE_BYTES,
    }));
    const stub = {
      name: 'stub-turn-user-messages',
      sessionType: STUB_SESSION_TYPE,
      locateSessionHistoryFile: async () => file,
      parseTranscriptWindow,
      readQueuedUserMessages: async () => [],
    } as unknown as AgentAdapter;
    vi.spyOn(agentRegistry, 'getBySessionType').mockImplementation(
      (sessionType) => (sessionType === STUB_SESSION_TYPE ? stub : undefined),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers the turn\'s user messages for an agent that can report them (the control)', async () => {
    expect(await turnUserMessages(STUB_SESSION_TYPE)).toEqual(['signed off']);
  });

  it('answers null, reading nothing, for a session type no adapter handles', async () => {
    expect(await turnUserMessages('unknown_agent')).toBeNull();
    expect(parseTranscriptWindow).not.toHaveBeenCalled();
  });

  it('answers null, not a rejection, when the read throws', async () => {
    parseTranscriptWindow.mockRejectedValue(new Error('the transcript could not be read'));
    expect(await turnUserMessages(STUB_SESSION_TYPE)).toBeNull();
    expect(parseTranscriptWindow).toHaveBeenCalled();
  });
});
