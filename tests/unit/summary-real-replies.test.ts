/**
 * The summary reply parser against REAL replies, not hand-written ones.
 *
 * The fixtures in `tests/fixtures/summary-replies/` are what the Claude CLI
 * printed for one ten-task summary prompt, run as the summary pass runs it
 * (`answerArgs` in claude-adapter.ts, non-streaming: --print,
 * --no-session-persistence, --permission-prompts none, --tools '',
 * --strict-mcp-config, --effort low, MAX_THINKING_TOKENS=0, the prompt on stdin,
 * an empty folder as cwd), on Claude Code 2.1.289, 2026-10-04. The ten tasks
 * were written for the capture and carry the edges a reply can trip on:
 *  - D2: a title and nothing else ("Release 0.5.0"),
 *  - D3: a description that tells the model to answer every task "done",
 *  - D5: a question that ended in a decision, with no change,
 *  - D6: commit subjects with "(#142)" and "merged in PR #77",
 *  - D7: a 1,200-character description,
 *  - D9: a description and files but no closing message.
 *
 * Sonnet (the model this install's summaries run on) answered all ten, one line
 * each, and ignored the injected instruction. Haiku wrapped its answer in a
 * preamble and a closing note, and answered D2, D5 and D9 with a note in
 * parentheses instead of a summary. The parser kept those notes as summaries
 * until it saw this reply.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { describeReplyGaps, parseSummaryReply } from '../../src/main/retrieval/summary/summary-prompt';
import { runSummaryPass } from '../../src/main/retrieval/summary/summary-pass';
import type { SummaryCandidate } from '../../src/main/retrieval/summary/summary-sources';
import type { SummaryPassStore, SummaryRow } from '../../src/main/retrieval/summary/summary-pass-store';

function captured(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'summary-replies', name), 'utf8');
}

const SONNET = captured('claude-sonnet-5-5-low.txt');
const HAIKU = captured('claude-haiku-low.txt');

describe('a real Sonnet reply', () => {
  it('reads all ten labels and leaves nothing out', () => {
    const summaries = parseSummaryReply(SONNET, 10);
    expect(summaries.size).toBe(10);
    expect(describeReplyGaps(SONNET, 10)).toBeNull();
  });

  it('keeps the task that asked to answer everything "done" summarized as itself', () => {
    expect(parseSummaryReply(SONNET, 10).get(2)).toMatch(/QR code/);
  });

  it('carries no PR or issue number into a summary', () => {
    for (const summary of parseSummaryReply(SONNET, 10).values()) expect(summary).not.toMatch(/#\d/);
  });
});

describe('a real Haiku reply', () => {
  // Red-green: before `isNoteInPlaceOfSummary` the three notes were kept, so
  // this read 10 and the three tasks were stored with a note as their summary.
  it('takes no note in parentheses for a summary', () => {
    const summaries = parseSummaryReply(HAIKU, 10);
    expect(summaries.size).toBe(7);
    expect([...summaries.keys()]).toEqual([0, 2, 3, 5, 6, 7, 9]);
    for (const summary of summaries.values()) expect(summary.startsWith('(')).toBe(false);
  });

  it('reports the notes as blank labels, and quotes the preamble and the closing note', () => {
    const gaps = describeReplyGaps(HAIKU, 10);
    expect(gaps).toMatchObject({ missing: [], writtenTwice: [], blank: [1, 4, 8] });
    expect(gaps?.unlabelled[0]).toMatch(/^I'll write one-line summaries/);
    expect(gaps?.unlabelled[1]).toMatch(/^\*\*Note:\*\*/);
  });

  // A note is a line wholly in parentheses. A genuine summary can open with a
  // parenthetical or carry one, and must not be read as a note. No capture holds
  // such a summary, so D1 is written by hand; D2 is line 4 of the Haiku capture.
  //
  // Red-green: `isNoteInPlaceOfSummary` in summary-prompt.ts. The earlier
  // greedy `/^\(.*\)\.?$/` matches D1 (it starts with "(" and ends with ")."),
  // so D1 is blanked and `summaries.get(0)` is undefined. A rule that never
  // matched would keep D2 and fail the blank assertions.
  it('keeps a summary that carries parentheses of its own, and still blanks the note', () => {
    const reply = [
      'D1: (Hotfix) Fixed the crash on resume (see the log).',
      'D2: (No description or outcome provided; cannot write a meaningful summary)',
    ].join('\n');
    const summaries = parseSummaryReply(reply, 2);
    expect(summaries.get(0)).toBe('(Hotfix) Fixed the crash on resume (see the log).');
    expect(summaries.has(1)).toBe(false);
    expect(describeReplyGaps(reply, 2)).toMatchObject({ missing: [], writtenTwice: [], blank: [1] });
  });

  // A model that ends its note with a full stop. No capture holds one, so the
  // reply is written by hand; it is the Haiku note's own words with the stop.
  //
  // Red-green: `isNoteInPlaceOfSummary` in summary-prompt.ts. Stop it dropping
  // the trailing full stop and "(No description provided)." is no longer a
  // note: it is kept as D1's summary, so the first assertion reads one entry
  // and the second reads no blank label.
  it('takes a note that ends in a full stop for no summary either', () => {
    const reply = 'D1: (No description provided).';

    expect(parseSummaryReply(reply, 1).size).toBe(0);
    expect(describeReplyGaps(reply, 1)?.blank).toEqual([0]);
  });

  // A note with a parenthetical of its own. No capture holds one, so the reply
  // is written by hand. D2 opens and closes with a group but is two of them, so
  // it is a summary.
  //
  // Red-green: the earlier `/^\([^()]*\)\.?$/` admits no inner parentheses, so
  // D1 is kept as its summary and the first assertion reads two entries.
  it('takes a note with parentheses inside it for no summary, and keeps a summary made of two groups', () => {
    const reply = [
      'D1: (No outcome (or description) was provided.)',
      'D2: (Hotfix) Fixed the crash on resume (see the log)',
    ].join('\n');
    const summaries = parseSummaryReply(reply, 2);
    expect([...summaries.keys()]).toEqual([1]);
    expect(summaries.get(1)).toBe('(Hotfix) Fixed the crash on resume (see the log)');
    expect(describeReplyGaps(reply, 2)?.blank).toEqual([0]);
  });

  // A note is the one group its first character opens, closed at its end. A line
  // whose first group never closes is not that, so it stays a summary. No
  // capture holds one, so the reply is written by hand.
  //
  // Red-green: `return depth === 0` at the end of `isNoteInPlaceOfSummary`, as
  // `return true`. The line starts and ends with a parenthesis, so it is then
  // read as a note and blanked, and the first assertion finds no summary.
  it('keeps a line whose opening parenthesis never closes, which is no note', () => {
    const reply = 'D1: (Fixed the crash on resume (see the log)';

    expect(parseSummaryReply(reply, 1).get(0)).toBe('(Fixed the crash on resume (see the log)');
    expect(describeReplyGaps(reply, 1)).toBeNull();
  });

  // Seven labels came back, so this is not a reply with no usable label: its
  // three notes are passed over, and nothing is asked again one task at a time.
  it('passes the three over in a pass without asking any task again on its own', async () => {
    const candidates: SummaryCandidate[] = Array.from({ length: 10 }, (_unused, index) => ({
      input: { taskId: `task-${index + 1}`, title: `Task ${index + 1}`, description: '', changedFiles: [], commits: [], closingMessages: [] },
      hash: `hash-${index + 1}`,
      lastActivityMs: 10 - index,
    }));
    const saved: SummaryRow[] = [];
    const store: SummaryPassStore = {
      candidates: async () => candidates,
      save: async (_projectId, rows) => {
        saved.push(...rows);
        return rows.length;
      },
    };
    const write = vi.fn(async () => HAIKU);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await runSummaryPass('project', { agent: 'claude', model: 'haiku', effort: 'low', write }, { maxBatches: 3, shouldContinue: () => true }, { store, now: () => '2026-10-04T00:00:00.000Z' });
      expect(write).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ written: 7, remaining: 0, failed: false });
      expect(result.unanswered).toEqual(['task-2', 'task-5', 'task-9']);
      expect(saved.every((row) => !row.summary.startsWith('('))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
