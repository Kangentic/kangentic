/**
 * A turn end's reply is read from where the turn began in its transcript
 * (`readFinalReply` with a `TranscriptAnchor`, src/main/agent/message-trail-read.ts).
 *
 * The walk back to the newest text stops only at a real prompt. A Claude turn
 * opened by a background job's `<task-notification>`, or by an `isMeta` peer
 * hand-back or `/loop` wakeup (which the parser drops), has no prompt to stop
 * at. When such a turn wrote no text, the tail read hands on the message the
 * previous turn ended on, and a Text match on `Findings: applied` moves the
 * task again. The anchor is the message trail's cursor as it stood before the
 * turn began, so the read covers the turn and nothing earlier.
 *
 * Driven over a temp JSONL with the REAL Claude window parser. The anchor is
 * taken with `readTrail`, the read the trail tracker makes, so its offset form
 * is the one production hands over. The lines are synthetic, shaped like the
 * CLI's own; tests/unit/helpers/claude-transcript-fixture.ts says which of
 * their fields the parser and the reply walk actually read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { readFinalReply, type MessageTrailAdapter } from '../../src/main/agent/message-trail-read';
import { MESSAGE_TRAIL_WINDOW_BYTES } from '../../src/main/agent/message-trail-tracker';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import { claudeTranscriptLines, claudeWindowAdapter, trailAnchorAfterRead } from './helpers/claude-transcript-fixture';

const AGENT_SESSION_ID = 'agent-session-1';
const FACTS = { sessionType: 'claude_agent', agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' };

/** How many windows one final-reply read parses at most (`FINAL_REPLY_MAX_WINDOWS`, which message-trail-read.ts does not export). */
const FINAL_REPLY_MAX_WINDOWS = 8;

const { humanPrompt, notification, peerHandBack, assistantText, assistantTool, toolResult, turnEnd } = claudeTranscriptLines({
  agentSessionId: AGENT_SESSION_ID,
  cwd: FACTS.cwd,
});

describe('readFinalReply from where the turn began', () => {
  let tmpDir: string;
  let file: string;
  let adapter: MessageTrailAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-reply-anchor-test-'));
    file = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
    adapter = claudeWindowAdapter(file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write what came before the turn, and read the anchor the trail would hold when the turn began. */
  async function beginTurnAfter(before: string): Promise<TranscriptAnchor> {
    fs.writeFileSync(file, before);
    return trailAnchorAfterRead(file, FACTS);
  }

  const PREVIOUS_TURN = humanPrompt('p1', 'Apply the findings and end on the line.')
    + assistantText('a1', 'Applied all three.\n\nFindings: applied')
    + turnEnd('t1');

  it('gives no reply for a notification-opened turn that wrote no text, where the tail read hands on the last turn\'s', async () => {
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    fs.appendFileSync(file, notification('n1') + assistantTool('a2', 'toolu_1', 'TaskOutput') + toolResult('r1', 'toolu_1') + turnEnd('t2'));

    // The bug: nothing stops the walk, so the previous turn's line comes back.
    expect((await readFinalReply(adapter, FACTS))?.text).toBe('Applied all three.\n\nFindings: applied');
    expect(await readFinalReply(adapter, FACTS, anchor)).toBeNull();
  });

  it('gives no reply for a turn a peer hand-back opened that wrote no text', async () => {
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    fs.appendFileSync(file, peerHandBack('m1') + assistantTool('a2', 'toolu_1', 'Bash') + toolResult('r1', 'toolu_1') + turnEnd('t2'));

    expect((await readFinalReply(adapter, FACTS))?.text).toBe('Applied all three.\n\nFindings: applied');
    expect(await readFinalReply(adapter, FACTS, anchor)).toBeNull();
  });

  it('still reads past a notification inside the turn to the reply the user is waiting on', async () => {
    // One engine turn holds two CLI turns: background work kept the session
    // thinking past the first Stop, and the job's notification opened the second.
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    fs.appendFileSync(
      file,
      humanPrompt('p2', '/code-review')
        + assistantText('a2', 'Verdict: Ready')
        + turnEnd('t2')
        + notification('n1')
        + assistantTool('a3', 'toolu_1', 'TaskOutput')
        + toolResult('r1', 'toolu_1')
        + turnEnd('t3'),
    );

    expect((await readFinalReply(adapter, FACTS, anchor))?.text).toBe('Verdict: Ready');
  });

  it('reads the turn\'s own reply when it wrote one', async () => {
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    fs.appendFileSync(file, notification('n1') + assistantText('a2', 'The job finished.\n\nFindings: applied') + turnEnd('t2'));

    const reply = await readFinalReply(adapter, FACTS, anchor);
    expect(reply?.text).toBe('The job finished.\n\nFindings: applied');
    expect(reply?.uuid).toBe('a2');
  });

  it('after a plan approval, keeps the implementation\'s reply and leaves out the plan', async () => {
    const planning = humanPrompt('p1', 'Plan the change.')
      + assistantText('a1', 'Here is the plan.')
      + assistantTool('a2', 'toolu_plan', 'ExitPlanMode');
    const anchor = await beginTurnAfter(planning);

    fs.appendFileSync(
      file,
      toolResult('r1', 'toolu_plan', 'User approved the plan.') + assistantTool('a3', 'toolu_2', 'Edit') + toolResult('r2', 'toolu_2'),
    );
    expect((await readFinalReply(adapter, FACTS))?.text).toBe('Here is the plan.');
    expect(await readFinalReply(adapter, FACTS, anchor)).toBeNull();

    fs.appendFileSync(file, assistantText('a4', 'Implemented.') + turnEnd('t1'));
    expect((await readFinalReply(adapter, FACTS, anchor))?.text).toBe('Implemented.');
  });

  it('reads the tail when the turn began further back than the window cap reaches', async () => {
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    // Eleven 200 KB tool results put the turn's start more than eight windows
    // before the end of the file. A window holds one such line and part of the
    // next, so a read from the raw anchor gets through one result per window
    // and stops at the cap before the reply. Each line stays under the 256 KB
    // window, which skips a longer one.
    let turn = humanPrompt('p2', 'Run the whole suite.');
    for (let index = 0; index < 11; index += 1) {
      turn += assistantTool(`t${index}`, `toolu_${index}`, 'Bash') + toolResult(`r${index}`, `toolu_${index}`, 'x'.repeat(200 * 1024));
    }
    fs.appendFileSync(file, turn + assistantText('a9', 'All green.') + turnEnd('t2'));
    expect(fs.statSync(file).size - anchor.byteOffset).toBeGreaterThan(FINAL_REPLY_MAX_WINDOWS * MESSAGE_TRAIL_WINDOW_BYTES);

    // The control: report the file no larger than the anchor, so the tail clamp
    // has nothing to cut and the read starts at the raw anchor. It runs out of
    // windows in the tool results and finds no reply. If this stops being null,
    // the turn above no longer outruns the cap and the read below proves nothing.
    const fileSizeAtAnchor = async (): Promise<number> => anchor.byteOffset + 1;
    expect(await readFinalReply(adapter, FACTS, anchor, fileSizeAtAnchor)).toBeNull();

    expect((await readFinalReply(adapter, FACTS, anchor))?.text).toBe('All green.');
  });

  it('falls back to the tail read, and says so, when the anchor lies past the end of the file', async () => {
    fs.writeFileSync(file, PREVIOUS_TURN + notification('n1') + assistantTool('a2', 'toolu_1', 'TaskOutput') + toolResult('r1', 'toolu_1'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pastEnd = { agentSessionId: AGENT_SESSION_ID, byteOffset: fs.statSync(file).size + 100 };

    expect((await readFinalReply(adapter, FACTS, pastEnd))?.text).toBe('Applied all three.\n\nFindings: applied');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('past the end');
  });

  it('reads from an anchor exactly at the end of the file as anchored, giving no reply and no warning', async () => {
    // The turn began at the end of the file and nothing was written since. That
    // is not a replaced file (the past-end case above): it is the anchor doing
    // its job, so the read covers nothing and the tail's earlier turn stays out.
    // The offset is the file's real size, not the trail cursor, which rests on
    // the last record's closing newline (size - 1).
    fs.writeFileSync(file, PREVIOUS_TURN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const atEnd = { agentSessionId: AGENT_SESSION_ID, byteOffset: fs.statSync(file).size };

    // The control: the tail does hold an earlier turn's reply, so the null
    // below is the anchor at work and not an empty file.
    expect((await readFinalReply(adapter, FACTS))?.text).toBe('Applied all three.\n\nFindings: applied');
    expect(await readFinalReply(adapter, FACTS, atEnd)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and reads the tail for an anchor one byte past the end of the file, the other side of the at-end boundary', async () => {
    fs.writeFileSync(file, PREVIOUS_TURN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onePastEnd = { agentSessionId: AGENT_SESSION_ID, byteOffset: fs.statSync(file).size + 1 };

    expect((await readFinalReply(adapter, FACTS, onePastEnd))?.text).toBe('Applied all three.\n\nFindings: applied');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('past the end');
  });

  it('reads nothing, and does not throw, when the history file cannot be located for an anchored read', async () => {
    const parseTranscriptWindow = vi.fn();
    const fileSize = vi.fn(async () => 0);
    const missingFile: MessageTrailAdapter = { locateSessionHistoryFile: async () => null, parseTranscriptWindow };
    // The anchor names this session, so the anchored path is the one taken.
    const anchor = { agentSessionId: AGENT_SESSION_ID, byteOffset: 100 };

    await expect(readFinalReply(missingFile, FACTS, anchor, fileSize)).resolves.toBeNull();
    // No file, so there is nothing to size and nothing to parse.
    expect(fileSize).not.toHaveBeenCalled();
    expect(parseTranscriptWindow).not.toHaveBeenCalled();
  });

  it('ignores an anchor into another session\'s file', async () => {
    const anchor = await beginTurnAfter(PREVIOUS_TURN);
    fs.appendFileSync(file, notification('n1') + assistantTool('a2', 'toolu_1', 'TaskOutput') + toolResult('r1', 'toolu_1'));

    const otherFile = { ...anchor, agentSessionId: 'agent-session-before-clear' };
    expect((await readFinalReply(adapter, FACTS, otherFile))?.text).toBe('Applied all three.\n\nFindings: applied');
  });

  it('ignores the anchor for an adapter with no window read', async () => {
    fs.writeFileSync(file, PREVIOUS_TURN);
    const parsed = await parseClaudeTranscriptWindow(file, 0, 1024 * 1024);
    // Like Aider: no history file to locate, no window read, only the whole-transcript parse.
    const cachedOnly: MessageTrailAdapter = {
      locateSessionHistoryFile: async () => null,
      parseTranscript: async () => ({ entries: parsed.entries, sourcePath: file }),
    };

    const anchor = { agentSessionId: AGENT_SESSION_ID, byteOffset: 0 };
    const reply = await readFinalReply(cachedOnly, { ...FACTS, sessionType: 'cached-only-agent' }, anchor);
    expect(reply?.text).toBe('Applied all three.\n\nFindings: applied');
  });
});
