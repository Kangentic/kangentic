/**
 * The user's messages in one turn, read back from the agent's transcript for a Text match on the
 * user's message (#1078): `turnUserMessages`, Claude's queued-input parse, and the read's
 * fail-closed rules in `readTurnUserMessages`.
 *
 * What a user loses if these go: a card that moves on an earlier turn's "signed off", or on a
 * sign-off a later "not signed off" typed mid-turn should have overruled. Every case where the turn
 * cannot be read exactly must answer null (unreadable), never a guess.
 */
import { describe, expect, it } from 'vitest';
import { turnUserMessages } from '../../src/main/agent/shared/agent-reply';
import { queuedHumanMessageOf } from '../../src/main/agent/adapters/claude/queued-user-messages';
import { readTurnUserMessages, TURN_USER_MESSAGES_MAX_WINDOWS } from '../../src/main/agent/message-trail-read';
import { canReadTurnUserMessages } from '../../src/main/agent/shared/transcript-reader-capability';
import type { ParsedTranscriptWindow } from '../../src/main/agent/agent-adapter';
import type { TranscriptEntry } from '../../src/shared/types';

function user(text: string, ts: number): TranscriptEntry {
  return { kind: 'user', uuid: `user-${ts}`, ts, text } as TranscriptEntry;
}

function assistant(text: string, ts: number): TranscriptEntry {
  return { kind: 'assistant', uuid: `assistant-${ts}`, ts, blocks: [{ type: 'text', text }] } as unknown as TranscriptEntry;
}

describe('turnUserMessages', () => {
  it('lists the turn\'s user messages oldest first, merging queued ones by time', () => {
    const entries = [user('Make the header bold', 100), assistant('Done.', 200)];
    const queued = [{ text: 'signed off', ts: 150 }];
    expect(turnUserMessages(entries, queued)).toEqual(['Make the header bold', 'signed off']);
  });

  it('leaves out a background job\'s notification and the agent\'s own text', () => {
    const entries = [user('<task-notification>build done</task-notification>', 100), assistant('signed off', 200)];
    expect(turnUserMessages(entries, [{ text: '<task-notification>x</task-notification>', ts: 300 }])).toEqual([]);
  });
});

describe('Claude\'s queued input (queuedHumanMessageOf)', () => {
  // The shape a real transcript carries (sanitized), measured on Claude Code 2.1.30x.
  const queuedLine = {
    type: 'attachment',
    timestamp: '2026-11-12T20:00:00.000Z',
    attachment: {
      type: 'queued_command',
      prompt: 'signed off',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp: '2026-11-12T20:00:00.000Z',
      humanTurn: true,
    },
  };

  it('reads a person\'s message typed mid-turn', () => {
    expect(queuedHumanMessageOf(queuedLine)).toEqual({ text: 'signed off', ts: Date.parse('2026-11-12T20:00:00.000Z') });
  });

  it('never reads a background job\'s notice, another origin, or another shape', () => {
    expect(queuedHumanMessageOf({ ...queuedLine, attachment: { ...queuedLine.attachment, commandMode: 'task-notification' } })).toBeNull();
    expect(queuedHumanMessageOf({ ...queuedLine, attachment: { ...queuedLine.attachment, origin: { kind: 'agent' } } })).toBeNull();
    expect(queuedHumanMessageOf({ ...queuedLine, attachment: { ...queuedLine.attachment, prompt: '<task-notification>x' } })).toBeNull();
    expect(queuedHumanMessageOf({ type: 'user', message: { content: 'signed off' } })).toBeNull();
  });
});

describe('readTurnUserMessages fails closed', () => {
  const FILE_SIZE = 1000;
  const ANCHOR = { agentSessionId: 'agent-1', byteOffset: 400 };
  const FACTS = { sessionType: 'claude_agent', agentSessionId: 'agent-1', cwd: '/mock/worktree', cliTarget: null, transcriptPath: null };

  function windowOf(entries: TranscriptEntry[], startByte: number, reachesEnd: boolean): ParsedTranscriptWindow {
    return {
      entries,
      sourcePath: '/mock/transcript.jsonl',
      firstByteOffset: startByte,
      endByte: reachesEnd ? FILE_SIZE : startByte + 1,
      nextByteOffset: reachesEnd ? FILE_SIZE : startByte + 1,
      totalBytes: FILE_SIZE,
    };
  }

  function adapterOf(options: {
    reachesEnd?: boolean;
    queued?: Array<{ text: string; ts: number }> | null;
    windowed?: boolean;
    startBytes?: number[];
  } = {}) {
    const startBytes = options.startBytes ?? [];
    return {
      locateSessionHistoryFile: async () => '/mock/transcript.jsonl',
      parseTranscriptWindow: options.windowed === false ? undefined : async (_id: string, _cwd: string, startByte: number) => {
        startBytes.push(startByte);
        return windowOf([user('signed off', 100)], startByte, options.reachesEnd ?? true);
      },
      readQueuedUserMessages: async () => (options.queued === undefined ? [] : options.queued),
      parseTranscript: undefined,
    };
  }
  const fileSize = async () => FILE_SIZE;

  it('reads the turn from its own anchor when every condition holds (the control)', async () => {
    const startBytes: number[] = [];
    expect(await readTurnUserMessages(adapterOf({ startBytes }), FACTS, ANCHOR, fileSize)).toEqual(['signed off']);
    expect(startBytes[0]).toBe(ANCHOR.byteOffset);
  });

  it('is unreadable with no anchor (a fresh spawn\'s first turn, Run again)', async () => {
    expect(await readTurnUserMessages(adapterOf(), FACTS, null, fileSize)).toBeNull();
  });

  it('is unreadable when the anchor is another agent session\'s', async () => {
    expect(await readTurnUserMessages(adapterOf(), FACTS, { ...ANCHOR, agentSessionId: 'agent-2' }, fileSize)).toBeNull();
  });

  it('is unreadable when the anchor lies past the file\'s end (the file was replaced)', async () => {
    expect(await readTurnUserMessages(adapterOf(), FACTS, { ...ANCHOR, byteOffset: FILE_SIZE + 1 }, fileSize)).toBeNull();
  });

  it('is unreadable when the windows never reach the end of the turn within the window bound', async () => {
    // Each window advances one byte and ends short of the file's end, so the loop
    // spends every window it is allowed and still has not seen the end.
    const startBytes: number[] = [];
    expect(await readTurnUserMessages(adapterOf({ reachesEnd: false, startBytes }), FACTS, ANCHOR, fileSize)).toBeNull();
    expect(startBytes).toHaveLength(TURN_USER_MESSAGES_MAX_WINDOWS);
    expect(startBytes[1]).toBe(ANCHOR.byteOffset + 1);
  });

  it('is unreadable when the file shrank under the anchor (the read was re-anchored)', async () => {
    const shrunkWindow = (startByte: number): ParsedTranscriptWindow => ({
      entries: [user('signed off', 100)],
      sourcePath: '/mock/transcript.jsonl',
      firstByteOffset: startByte,
      endByte: 100,
      nextByteOffset: 100,
      totalBytes: 100,
    });
    const shrunkAdapter = { ...adapterOf(), parseTranscriptWindow: async (_id: string, _cwd: string, startByte: number) => shrunkWindow(startByte) };
    expect(await readTurnUserMessages(shrunkAdapter, FACTS, ANCHOR, fileSize)).toBeNull();
  });

  it('is unreadable when the history file cannot be located', async () => {
    const noFileAdapter = { ...adapterOf(), locateSessionHistoryFile: async () => null };
    expect(await readTurnUserMessages(noFileAdapter, FACTS, ANCHOR, fileSize)).toBeNull();
  });

  it('is unreadable when the queued-input read failed', async () => {
    expect(await readTurnUserMessages(adapterOf({ queued: null }), FACTS, ANCHOR, fileSize)).toBeNull();
  });

  it('is unreadable for an agent with no windowed reader or no queued-input reader', async () => {
    expect(await readTurnUserMessages(adapterOf({ windowed: false }), FACTS, ANCHOR, fileSize)).toBeNull();
    const noQueuedReader = { ...adapterOf(), readQueuedUserMessages: undefined };
    expect(canReadTurnUserMessages(noQueuedReader)).toBe(false);
    expect(await readTurnUserMessages(noQueuedReader, FACTS, ANCHOR, fileSize)).toBeNull();
  });
});
