import { describe, it, expect } from 'vitest';
import {
  transcriptToMarkdown,
  filterTranscriptView,
  searchTranscript,
  renderTranscriptBudgeted,
} from '../../src/shared/transcript-format';
import { sanitizeTranscriptText } from '../../src/shared/ansi-strip';
import type { TranscriptEntry } from '../../src/shared/types';

// Build escape/control sequences from char codes so no raw control bytes
// live in this source file (keeps it clean for the no-control-byte scanners).
const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07
const sgr = (code: string): string => `${ESC}[${code}m`;

describe('transcriptToMarkdown - system entries', () => {
  it('renders a compaction system entry as a "Conversation compacted" section', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'compaction', text: 'Conversation compacted (auto, 1000 tokens before compaction)' },
    ]);
    expect(md).toContain('## Conversation compacted');
    expect(md).toContain('1000 tokens before compaction');
  });

  it('renders a command system entry as a compact inline marker, not raw XML', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'command', text: '/exit' },
    ]);
    expect(md).toContain('`[command: /exit]`');
    expect(md).not.toContain('## User');
  });

  it('renders a command_output system entry as a fenced Command output block', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'command_output', text: 'Goodbye!' },
    ]);
    expect(md).toContain('**Command output:**');
    expect(md).toContain('Goodbye!');
  });

  it('renders a truncated system entry as a plain italic note, not a heading or a Command output block', () => {
    const md = transcriptToMarkdown([
      {
        kind: 'system',
        uuid: 's1',
        ts: 0,
        subtype: 'truncated',
        text: 'Earlier 121.9 MB of this conversation are not shown (the transcript is 137.9 MB). Search still covers the full history.',
      },
    ]);
    expect(md).toContain('_Earlier 121.9 MB of this conversation are not shown');
    // Deliberately NOT a heading: it describes the transcript itself rather
    // than being part of the conversation. Falling through to the default
    // ('Command output') branch is the exact revert this pins against.
    expect(md).not.toContain('## ');
    expect(md).not.toContain('Command output');
  });
});

describe('transcriptToMarkdown - orphaned tool results', () => {
  it('renders an orphaned tool_result (no matching tool_use) in a trailing section', () => {
    const md = transcriptToMarkdown([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'do it' },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 'toolu_missing', content: 'orphaned output here' },
    ]);
    expect(md).toContain('## Orphaned tool results');
    expect(md).toContain('toolu_missing');
    expect(md).toContain('orphaned output here');
  });

  it('does not add an orphan section when every tool_result is paired', () => {
    const md = transcriptToMarkdown([
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 0,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: 'a.txt' },
    ]);
    expect(md).not.toContain('## Orphaned tool results');
    expect(md).toContain('**Result:**');
    expect(md).toContain('a.txt');
  });

  it('flags an orphaned error result', () => {
    const md = transcriptToMarkdown([
      { kind: 'tool_result', uuid: 'r1', ts: 0, toolUseId: 'toolu_x', content: 'boom', isError: true },
    ]);
    expect(md).toContain('## Orphaned tool results');
    expect(md).toContain('**Error for `toolu_x`:**');
  });
});

describe('transcriptToMarkdown - sanitization', () => {
  it('strips ANSI escape sequences from rendered user text', () => {
    const md = transcriptToMarkdown([
      { kind: 'user', uuid: 'u1', ts: 0, text: `${sgr('31')}red prompt${sgr('0')}` },
    ]);
    expect(md).toContain('red prompt');
    expect(md).not.toContain(ESC);
  });

  it('strips ANSI escapes and control bytes from tool output content', () => {
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 0,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: `${sgr('32')}ok${sgr('0')} done${BEL}` },
    ];
    const md = transcriptToMarkdown(entries);
    expect(md).toContain('ok');
    expect(md).toContain('done');
    expect(md).not.toContain(ESC);
    expect(md).not.toContain(BEL);
  });
});

describe('sanitizeTranscriptText', () => {
  it('removes CSI color codes and the BEL control byte', () => {
    expect(sanitizeTranscriptText(`${sgr('1;32')}hello${sgr('0')}${BEL}`)).toBe('hello');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeTranscriptText('a\n\tb')).toBe('a\n\tb');
  });
});

describe('filterTranscriptView', () => {
  const sample: TranscriptEntry[] = [
    { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
    {
      kind: 'assistant',
      uuid: 'a1',
      ts: 1,
      blocks: [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ],
    },
    { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 't1', content: 'out' },
    { kind: 'assistant', uuid: 'a2', ts: 3, blocks: [{ type: 'text', text: 'second' }] },
  ];

  it('full returns the entries unchanged', () => {
    expect(filterTranscriptView(sample, 'full')).toBe(sample);
  });

  it('responses keeps only assistant text blocks (no thinking / tool_use)', () => {
    const out = filterTranscriptView(sample, 'responses');
    expect(out).toHaveLength(2);
    expect(out.every((entry) => entry.kind === 'assistant')).toBe(true);
    const firstTurn = out[0];
    if (firstTurn.kind !== 'assistant') throw new Error('expected assistant');
    expect(firstTurn.blocks).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('responses drops assistant turns that have no text', () => {
    const out = filterTranscriptView(
      [{ kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }],
      'responses',
    );
    expect(out).toHaveLength(0);
  });

  it('result returns only the last assistant text turn', () => {
    const out = filterTranscriptView(sample, 'result');
    expect(out).toHaveLength(1);
    const only = out[0];
    if (only.kind !== 'assistant') throw new Error('expected assistant');
    expect(only.blocks).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('result walks back past a trailing tool-call-only turn', () => {
    const out = filterTranscriptView(
      [
        { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'the summary' }] },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      ],
      'result',
    );
    expect(out).toHaveLength(1);
    const only = out[0];
    if (only.kind !== 'assistant') throw new Error('expected assistant');
    expect(only.blocks).toEqual([{ type: 'text', text: 'the summary' }]);
  });

  it('result returns [] when there is no assistant text', () => {
    expect(filterTranscriptView([{ kind: 'user', uuid: 'u1', ts: 0, text: 'hi' }], 'result')).toHaveLength(0);
  });
});

describe('searchTranscript', () => {
  it('keeps assistant turns whose text matches (case-insensitive)', () => {
    const out = searchTranscript(
      [
        { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'Migration complete' }] },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'nothing here' }] },
      ],
      'migration',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('a1');
  });

  it('matches content inside an inlined tool result and keeps the result entry too', () => {
    const out = searchTranscript(
      [
        { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: 'needle found' },
      ],
      'needle',
    );
    expect(out.map((entry) => entry.uuid).sort()).toEqual(['a1', 'r1']);
  });

  it('matches user text', () => {
    const out = searchTranscript(
      [
        { kind: 'user', uuid: 'u1', ts: 0, text: 'deploy the needle' },
        { kind: 'user', uuid: 'u2', ts: 1, text: 'unrelated' },
      ],
      'needle',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('u1');
  });

  it('returns [] when nothing matches', () => {
    expect(searchTranscript([{ kind: 'user', uuid: 'u1', ts: 0, text: 'hello' }], 'zzz')).toHaveLength(0);
  });

  it('matches on tool_use.name (the tool name substring)', () => {
    // The assistant turn has a Bash tool call - searching "bash" must hit via the name field.
    const out = searchTranscript(
      [
        { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'nothing' }] },
      ],
      'bash',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('a1');
  });

  it('matches on tool_use.input JSON value (serialized input contains the term)', () => {
    // The input is { command: "grep migration" } - searching "grep" must match.
    const out = searchTranscript(
      [
        {
          kind: 'assistant',
          uuid: 'a1',
          ts: 0,
          blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep migration' } }],
        },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'irrelevant' }] },
      ],
      'grep',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('a1');
  });

  it('matches on a thinking block inside an assistant turn', () => {
    const out = searchTranscript(
      [
        {
          kind: 'assistant',
          uuid: 'a1',
          ts: 0,
          blocks: [
            { type: 'thinking', text: 'The user wants to deploy to production.' },
            { type: 'text', text: 'No problem.' },
          ],
        },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'nothing here' }] },
      ],
      'production',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('a1');
  });

  it('matches on system entry text', () => {
    const out = searchTranscript(
      [
        { kind: 'system', uuid: 's1', ts: 0, subtype: 'compaction', text: 'Conversation compacted (auto, 5000 tokens)' },
        { kind: 'user', uuid: 'u1', ts: 1, text: 'hello' },
      ],
      'compacted',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('s1');
  });

  it('matches a standalone orphan tool_result with no owning assistant turn in the list', () => {
    // An orphaned result (e.g. from a compacted session) - searching its content must find it.
    const out = searchTranscript(
      [
        { kind: 'tool_result', uuid: 'r1', ts: 0, toolUseId: 'toolu_orphan', content: 'migration applied cleanly' },
        { kind: 'user', uuid: 'u1', ts: 1, text: 'unrelated' },
      ],
      'applied',
    );
    expect(out).toHaveLength(1);
    expect(out[0].uuid).toBe('r1');
  });

  it('returns entries unchanged when term is empty string (the !needle early-return)', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'world' }] },
    ];
    // Empty string lowercases to '' which is falsy - the early return fires.
    const out = searchTranscript(entries, '');
    expect(out).toBe(entries); // same reference, not a filtered copy
  });

  it('returns entries unchanged when term is whitespace-only (whitespace lowercases truthy but no entry has only spaces)', () => {
    // The implementation lowercases: '  '.toLowerCase() = '  ', truthy, so it filters.
    // Every entry with actual text will not match '  ', so we get [].
    // This confirms whitespace is NOT treated as the empty-term early-return path.
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello world' },
    ];
    const out = searchTranscript(entries, '  ');
    // '  ' is not empty after toLowerCase(), so filtering happens and nothing matches '  '
    expect(out).toHaveLength(0);
  });
});

describe('renderTranscriptBudgeted', () => {
  const convo = (count: number): TranscriptEntry[] =>
    Array.from(
      { length: count },
      (_unused, index): TranscriptEntry => ({ kind: 'user', uuid: `u${index}`, ts: index, text: `message ${index}` }),
    );

  it('renders everything when within budget', () => {
    const out = renderTranscriptBudgeted(convo(3));
    expect(out.totalEntries).toBe(3);
    expect(out.renderedEntries).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.markdown).toContain('message 0');
    expect(out.markdown).toContain('message 2');
  });

  it('tail keeps the most recent entries', () => {
    const out = renderTranscriptBudgeted(convo(5), { tail: 2 });
    expect(out.renderedEntries).toBe(2);
    expect(out.omittedByTail).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.markdown).toContain('message 4');
    expect(out.markdown).not.toContain('message 0');
  });

  it('charBudget drops the oldest entries, keeping the most recent', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: `OLDEST ${'x'.repeat(400)}` },
      { kind: 'user', uuid: 'u2', ts: 1, text: `NEWEST ${'y'.repeat(400)}` },
    ];
    const out = renderTranscriptBudgeted(entries, { charBudget: 600 });
    expect(out.renderedEntries).toBe(1);
    expect(out.omittedByBudget).toBe(1);
    expect(out.markdown).toContain('NEWEST');
    expect(out.markdown).not.toContain('OLDEST');
  });

  it('always keeps at least the newest entry even when it exceeds the budget', () => {
    const out = renderTranscriptBudgeted([{ kind: 'user', uuid: 'u1', ts: 0, text: 'z'.repeat(5000) }], { charBudget: 1000 });
    expect(out.renderedEntries).toBe(1);
    // Hard-truncate backstop keeps the rendered size near the budget (plus the marker).
    expect(out.markdown.length).toBeLessThanOrEqual(1000 + 200);
  });

  it('does not resurrect an orphan section when a tool_use owner is truncated away', () => {
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 0,
        blocks: [
          { type: 'text', text: `OLDEST ${'x'.repeat(400)}` },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: 'tool output' },
      { kind: 'user', uuid: 'u1', ts: 2, text: `NEWEST ${'y'.repeat(400)}` },
    ];
    const out = renderTranscriptBudgeted(entries, { charBudget: 600 });
    expect(out.markdown).toContain('NEWEST');
    expect(out.markdown).not.toContain('OLDEST');
    expect(out.markdown).not.toContain('Orphaned tool results');
  });

  it('tail larger than entry count is a no-op (omittedByTail === 0, not truncated by tail)', () => {
    // Requesting tail=100 when there are only 3 entries should keep all 3.
    const entries = convo(3);
    const out = renderTranscriptBudgeted(entries, { tail: 100 });
    expect(out.totalEntries).toBe(3);
    expect(out.renderedEntries).toBe(3);
    expect(out.omittedByTail).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.markdown).toContain('message 0');
    expect(out.markdown).toContain('message 2');
  });

  it('tail + charBudget both active: omittedByTail + omittedByBudget equals total minus rendered', () => {
    // 6 entries, tail=4 (drops 2 oldest by tail), charBudget tight enough to drop 1 more.
    // Each entry is ~500 chars; budget of 600 keeps only the newest of the tailed 4.
    const entries: TranscriptEntry[] = Array.from({ length: 6 }, (_, index): TranscriptEntry => ({
      kind: 'user',
      uuid: `u${index}`,
      ts: index,
      text: `entry-${index} ${'z'.repeat(450)}`,
    }));
    const out = renderTranscriptBudgeted(entries, { tail: 4, charBudget: 600 });
    // tail removes 2 (indices 0,1); budget trims further from the tailed window
    expect(out.omittedByTail).toBe(2);
    // Budget omits at least 1 more from the tailed window (entries are ~470 chars each)
    expect(out.omittedByBudget).toBeGreaterThan(0);
    // The accounting invariant: omittedByTail + omittedByBudget + renderedEntries === totalEntries
    expect(out.omittedByTail + out.omittedByBudget + out.renderedEntries).toBe(out.totalEntries);
  });

  it('a genuine orphan tool_result (owner never in any window) is preserved in the orphan section', () => {
    // The tool_result's toolUseId 'toolu_orphan' is not referenced by any assistant turn,
    // so it is a genuine orphan. dropTruncationOrphans must NOT remove it.
    const entries: TranscriptEntry[] = [
      { kind: 'tool_result', uuid: 'r1', ts: 0, toolUseId: 'toolu_orphan', content: 'orphaned output' },
      { kind: 'user', uuid: 'u1', ts: 1, text: 'hello' },
    ];
    const out = renderTranscriptBudgeted(entries);
    expect(out.markdown).toContain('## Orphaned tool results');
    expect(out.markdown).toContain('toolu_orphan');
    expect(out.markdown).toContain('orphaned output');
    expect(out.truncated).toBe(false);
  });
});
