/**
 * The retrieval worker's `transcript.finalReply`: the method main calls at a
 * turn end to read the reply for `{{agentReply}}` and for a Text match row. The
 * turn's `TranscriptAnchor` rides in `since`, and the handler must hand it to
 * `readFinalReply`, or every turn's reply is read from the tail again and a
 * turn that wrote no text hands on the line an earlier turn ended on.
 *
 * The handler is driven directly, through the real `readFinalReply` and the
 * real window loop. The adapter is a stub the agent registry resolves for a
 * test session type. It records the byte each window is asked to start at, which
 * is what tells an anchored read from a tail read. The reply read from those
 * windows (the anchor's meaning on a real transcript) is pinned against the
 * real Claude parser in message-trail-read-final-reply.test.ts.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';

const STUB_SESSION_TYPE = 'stub_final_reply_agent';
const AGENT_SESSION_ID = 'agent-session-1';
const FACTS = { sessionType: STUB_SESSION_TYPE, agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' };
/** Well under the one-megabyte tail, so a tail read of the file starts at byte 0. */
const TRANSCRIPT_BYTES = 4096;
const ANCHOR_OFFSET = 1500;

/** The handler reads nothing from its context. */
const context: WorkerContext = {
  getDb: () => ({}) as unknown as Database.Database,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};

function finalReply(since?: TranscriptAnchor | null) {
  return transcriptHandlers['transcript.finalReply']({ facts: FACTS, since, remoteTargets: [] }, context);
}

describe('transcript.finalReply', () => {
  let tmpDir: string;
  /** The byte each window read was asked to start at, in order. */
  let requestedStarts: number[];
  let parseTranscriptWindow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-reply-worker-test-'));
    const file = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
    fs.writeFileSync(file, 'x'.repeat(TRANSCRIPT_BYTES));

    requestedStarts = [];
    // One window that reaches the end of the file, holding the turn's reply.
    parseTranscriptWindow = vi.fn(async (_agentSessionId: string, _cwd: string, startByte: number) => {
      requestedStarts.push(startByte);
      return {
        entries: [{ kind: 'assistant' as const, uuid: 'a1', ts: 2000, blocks: [{ type: 'text' as const, text: 'Verdict: Ready' }] }],
        sourcePath: file,
        nextByteOffset: TRANSCRIPT_BYTES,
        totalBytes: TRANSCRIPT_BYTES,
      };
    });
    const stub = {
      name: 'stub-final-reply',
      sessionType: STUB_SESSION_TYPE,
      locateSessionHistoryFile: async () => file,
      parseTranscriptWindow,
    } as unknown as AgentAdapter;
    // The registry has no unregister, so resolve the stub through a spy that the
    // afterEach restores.
    vi.spyOn(agentRegistry, 'getBySessionType').mockImplementation(
      (sessionType) => (sessionType === STUB_SESSION_TYPE ? stub : undefined),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts the read at the anchor it is given, and answers with the reply read from there', async () => {
    const reply = await finalReply({ agentSessionId: AGENT_SESSION_ID, byteOffset: ANCHOR_OFFSET });

    expect(requestedStarts).toEqual([ANCHOR_OFFSET]);
    expect(reply?.text).toBe('Verdict: Ready');
    expect(reply?.uuid).toBe('a1');
  });

  it.each([
    ['no anchor', undefined],
    ['a null anchor', null],
  ])('reads from the tail with %s', async (_label, since) => {
    const reply = await finalReply(since);

    // The tail of a file this small starts at byte 0, which no anchor above does.
    expect(requestedStarts).toEqual([0]);
    expect(reply?.text).toBe('Verdict: Ready');
  });

  it('reads from the tail when the anchor is into another session\'s transcript', async () => {
    await finalReply({ agentSessionId: 'agent-session-before-clear', byteOffset: ANCHOR_OFFSET });

    expect(requestedStarts).toEqual([0]);
  });

  it('answers null, reading nothing, for a session type no adapter handles', async () => {
    const reply = await transcriptHandlers['transcript.finalReply'](
      { facts: { ...FACTS, sessionType: 'unknown_agent' }, since: { agentSessionId: AGENT_SESSION_ID, byteOffset: ANCHOR_OFFSET }, remoteTargets: [] },
      context,
    );

    expect(reply).toBeNull();
    expect(parseTranscriptWindow).not.toHaveBeenCalled();
  });
});
