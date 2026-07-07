import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeTranscript, claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { transcriptToMarkdown } from '../../src/shared/transcript-format';

describe('claudeProjectSlug', () => {
  it('replaces backslashes and colons on Windows-style paths', () => {
    expect(claudeProjectSlug('C:\\Users\\dev\\project')).toBe('C--Users-dev-project');
  });

  it('replaces forward slashes on POSIX paths', () => {
    expect(claudeProjectSlug('/home/dev/project')).toBe('-home-dev-project');
  });

  it('replaces dots (project names with extensions)', () => {
    expect(claudeProjectSlug('C:\\Users\\dev\\my.app')).toBe('C--Users-dev-my-app');
  });

  it('handles worktree subpaths the same way', () => {
    expect(
      claudeProjectSlug('C:\\Users\\dev\\proj\\.kangentic\\worktrees\\feature-x'),
    ).toBe('C--Users-dev-proj--kangentic-worktrees-feature-x');
  });

  it('does not collapse adjacent separators', () => {
    expect(claudeProjectSlug('C:\\x')).toBe('C--x');
  });

  it('replaces underscores and spaces (every non-alphanumeric char)', () => {
    expect(claudeProjectSlug('/home/dev/my_project')).toBe('-home-dev-my-project');
    expect(claudeProjectSlug('/home/dev/my project')).toBe('-home-dev-my-project');
  });

  it('truncates to 200 chars and appends a base36 hash suffix when too long', () => {
    const longPath = `/home/dev/${'a'.repeat(300)}`;
    const slug = claudeProjectSlug(longPath);
    const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, '-');
    // h = (h << 5) - h + charCode | 0 over the original string.
    let hash = 0;
    for (let index = 0; index < longPath.length; index++) {
      hash = (hash << 5) - hash + longPath.charCodeAt(index);
      hash = hash | 0;
    }
    const expected = `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
    expect(slug).toBe(expected);
    expect(slug.startsWith(sanitized.slice(0, 200))).toBe(true);
  });
});

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

describe('parseClaudeTranscript', () => {
  let tmpFile: string | null = null;

  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for missing files', async () => {
    const entries = await parseClaudeTranscript(path.join(os.tmpdir(), 'does-not-exist.jsonl'));
    expect(entries).toEqual([]);
  });

  it('parses user, assistant, and tool_result entries', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'u1', timestamp: '2026-04-09T00:00:00Z', message: { content: 'hello there' } },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tool-123', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        timestamp: '2026-04-09T00:00:02Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-123', content: 'file1.txt\nfile2.txt' },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-04-09T00:00:03Z',
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Two files found.' }] },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello there' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'claude-opus-4-6',
      blocks: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tool-123', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    expect(entries[2]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tool-123',
      content: 'file1.txt\nfile2.txt',
    });
    expect(entries[3]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Two files found.' }] });
  });

  it('captures per-turn token usage (raw component counts) on the assistant entry', async () => {
    tmpFile = writeFixture([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 18000,
          },
          content: [{ type: 'text', text: 'Answer.' }],
        },
      },
      {
        // No usage object at all: the entry must simply omit `usage`.
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-04-09T00:00:02Z',
        message: { id: 'msg_2', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'No usage here.' }] },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      usage: { inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 2000, cacheReadInputTokens: 18000 },
    });
    expect(entries[1].kind).toBe('assistant');
    if (entries[1].kind === 'assistant') expect(entries[1].usage).toBeUndefined();
  });

  it('attributes a message id\'s usage to a single turn, so a message split across lines is not double-counted', async () => {
    tmpFile = writeFixture([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          id: 'msg_shared',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: 'text', text: 'First part.' }],
        },
      },
      {
        // Same message id (a streamed continuation): its usage must NOT be
        // attached again, or a burn-rate sum would count this turn twice.
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-04-09T00:00:02Z',
        message: {
          id: 'msg_shared',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries[0]).toMatchObject({ kind: 'assistant', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(entries[1].kind).toBe('assistant');
    if (entries[1].kind === 'assistant') expect(entries[1].usage).toBeUndefined();
  });

  it('keeps usage on the text turn when an extended-thinking turn leads with a dropped empty-thinking line (same message id)', async () => {
    // Real high-effort shape (captured from a live Claude session): one turn is
    // written as two JSONL lines under ONE message id - a thinking-only line
    // (persisted thinking is empty/signature-only, so the parser drops it) then
    // the text line. Both lines carry identical usage. The usage must land on the
    // emitted text entry; if it were claimed by the dropped thinking line, the
    // text entry would be deduped out of its own usage and the whole turn's
    // per-turn tokens would vanish from the ledger.
    tmpFile = writeFixture([
      {
        type: 'assistant',
        uuid: 'think-line',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          id: 'msg_thinking_turn',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2, output_tokens: 49, cache_creation_input_tokens: 4138, cache_read_input_tokens: 81395 },
          // Empty (signature-only) thinking block: dropped, so this line emits nothing.
          content: [{ type: 'thinking', thinking: '', signature: 'enc' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'text-line',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          id: 'msg_thinking_turn',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2, output_tokens: 49, cache_creation_input_tokens: 4138, cache_read_input_tokens: 81395 },
          content: [{ type: 'text', text: 'Hello! What can I help you with?' }],
        },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    // Only the text line produced an entry (the empty-thinking line was dropped).
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      uuid: 'text-line',
      usage: { inputTokens: 2, outputTokens: 49, cacheCreationInputTokens: 4138, cacheReadInputTokens: 81395 },
    });
  });

  it('preserves non-empty thinking blocks but drops the empty signature-only blocks Claude actually persists', async () => {
    tmpFile = writeFixture([
      // Realistic shape: real Claude Code session JSONL only stores
      // signature-encrypted thinking, never plaintext. The empty-thinking
      // assistant entry must NOT produce a stray empty assistant turn.
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-09T00:00:01Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'thinking', thinking: '', signature: 'ErcCCmIIDB...' }],
        },
      },
      // Forward-compat coverage: real Claude Code 2.1.x never produces
      // this shape (it always emits empty `thinking` with a signature),
      // but the parser branch exists so that if a future version starts
      // persisting plaintext thinking we will capture it. DO NOT delete
      // this case as "unrealistic" - it locks in the contract.
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-04-09T00:00:02Z',
        message: {
          model: 'claude-opus-4-6',
          content: [
            { type: 'thinking', thinking: 'reasoning...' },
            { type: 'text', text: 'done' },
          ],
        },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    // a1 should be filtered entirely (no blocks after dropping empty thinking)
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      uuid: 'a2',
      blocks: [
        { type: 'thinking', text: 'reasoning...' },
        { type: 'text', text: 'done' },
      ],
    });
  });

  it('flattens tool_result content with text, image, and tool_reference blocks', async () => {
    tmpFile = writeFixture([
      {
        type: 'user',
        uuid: 'r1',
        timestamp: '2026-04-09T00:00:02Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              is_error: true,
              content: [
                { type: 'text', text: 'boom' },
                { type: 'image' },
                { type: 'tool_reference', tool_name: 'ExitPlanMode' },
              ],
            },
          ],
        },
      },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_result',
      isError: true,
      content: 'boom\n[image]\n[tool_reference: ExitPlanMode]',
    });
  });

  it('ignores entries Claude Code adds for its own bookkeeping', async () => {
    // Real-world top-level types observed in Claude Code 2.1.x sessions
    // that the parser must skip without complaint. Verified empirically
    // against ~/.claude/projects/<slug>/<sessionId>.jsonl files.
    tmpFile = writeFixture([
      { type: 'permission-mode', permissionMode: 'plan', sessionId: 's1' },
      { type: 'file-history-snapshot', messageId: 'm1', snapshot: {} },
      { type: 'attachment', uuid: 'att1', attachment: { type: 'skill_listing', content: '...' } },
      { type: 'system', subtype: 'stop_hook_summary', hookCount: 1 },
      { type: 'custom-title', customTitle: 'my-session' },
      { type: 'agent-name', agentName: 'my-agent' },
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'progress', progress: 42 },
      // Sandwich a real entry between them to make sure surrounding noise
      // doesn't shift the order or count.
      { type: 'user', uuid: 'u1', timestamp: '2026-04-09T00:00:00Z', message: { content: 'hello' } },
      { type: 'file-history-snapshot', messageId: 'm2', snapshot: {} },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });

  it('parses a realistic Claude Code 2.1.x streaming session end-to-end', async () => {
    // Mirrors the actual on-disk shape verified against real ~/.claude/projects
    // session files: each streaming chunk (thinking, text, tool_use) is its
    // own assistant entry; tool results come back as synthetic user entries
    // with array-typed message.content. Bookkeeping entries are interspersed.
    tmpFile = writeFixture([
      { type: 'permission-mode', permissionMode: 'default', sessionId: 's1' },
      { type: 'file-history-snapshot', messageId: 'm1', snapshot: {} },
      {
        type: 'user',
        uuid: 'u-prompt',
        timestamp: '2026-04-09T10:00:00Z',
        message: { role: 'user', content: 'Find files matching foo' },
      },
      { type: 'attachment', uuid: 'att-1', attachment: { type: 'deferred_tools_delta' } },
      // Streaming chunk 1: signature-only thinking (filtered)
      {
        type: 'assistant',
        uuid: 'a-think',
        timestamp: '2026-04-09T10:00:01Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'thinking', thinking: '', signature: 'sig...' }],
        },
      },
      // Streaming chunk 2: text response
      {
        type: 'assistant',
        uuid: 'a-text',
        timestamp: '2026-04-09T10:00:02Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Let me search.' }],
        },
      },
      // Streaming chunk 3: tool_use
      {
        type: 'assistant',
        uuid: 'a-tool',
        timestamp: '2026-04-09T10:00:03Z',
        message: {
          model: 'claude-opus-4-6',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      // Synthetic user entry carrying the tool_result
      {
        type: 'user',
        uuid: 'u-result',
        timestamp: '2026-04-09T10:00:04Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: 'src/foo.ts\nsrc/foo-utils.ts',
            },
          ],
        },
      },
      // Final assistant text turn
      {
        type: 'assistant',
        uuid: 'a-final',
        timestamp: '2026-04-09T10:00:05Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Found 2 matches.' }],
        },
      },
      { type: 'system', subtype: 'stop_hook_summary' },
    ]);

    const entries = await parseClaudeTranscript(tmpFile);

    // Expected order: user prompt, assistant text, assistant tool_use, tool_result, assistant text
    // The signature-only thinking and all bookkeeping entries are filtered.
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'Find files matching foo' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'Let me search.' }],
    });
    expect(entries[2]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'tool_use', id: 'toolu_01', name: 'Grep' }],
    });
    expect(entries[3]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_01',
      content: 'src/foo.ts\nsrc/foo-utils.ts',
    });
    expect(entries[4]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'Found 2 matches.' }],
    });

    // The markdown formatter should pair the tool_result back under its
    // owning tool_use even though they're separate entries on disk.
    const md = transcriptToMarkdown(entries);
    expect(md).toContain('## User');
    expect(md).toContain('Find files matching foo');
    expect(md).toContain('**Tool:** `Grep`');
    expect(md).toContain('"pattern": "foo"');
    expect(md).toContain('**Result:**');
    expect(md).toContain('src/foo.ts');
    expect(md).toContain('Found 2 matches.');
  });

  it('skips malformed lines without throwing', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'u1', timestamp: '2026-04-09T00:00:00Z', message: { content: 'one' } },
    ]);
    fs.appendFileSync(tmpFile, '\n{not valid json\n');
    fs.appendFileSync(tmpFile, JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-04-09T00:00:01Z', message: { content: 'two' } }) + '\n');

    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: 'one' });
    expect(entries[1]).toMatchObject({ text: 'two' });
  });

  // --- Fidelity fixes (each isolated so reverting its guard turns it red) ---

  it('skips isMeta user entries (skill preambles, queued-message bookkeeping)', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'm', isMeta: true, timestamp: '2026-06-12T00:00:00Z', message: { content: 'Base directory for this skill: C:\\Users\\dev\\skills\\demo' } },
      { type: 'user', uuid: 'u', timestamp: '2026-06-12T00:00:01Z', message: { content: 'real prompt' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'real prompt' });
  });

  it('renders a whole-message slash-command as a plain user message showing just the command', async () => {
    // A slash-command invocation is a user-role turn: show it as a message from
    // You carrying "/exit", not a system divider and not the raw XML wrapper.
    tmpFile = writeFixture([
      { type: 'user', uuid: 'c', timestamp: '2026-06-12T00:00:00Z', message: { content: '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: 'c', ts: expect.any(Number), text: '/exit' },
    ]);
  });

  it('includes command args in the user-message command text when present', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'c', timestamp: '2026-06-12T00:00:00Z', message: { content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries[0]).toMatchObject({ kind: 'user', text: '/model opus' });
  });

  it('cleans a slash-command when <command-message> leads (current Claude order), not just <command-name>-first', async () => {
    // Real transcripts now emit the message block BEFORE the name block; the
    // parser must not leave the raw XML wrapper as visible user text.
    tmpFile = writeFixture([
      { type: 'user', uuid: 'c', timestamp: '2026-06-12T00:00:00Z', message: { content: '<command-message>code-review</command-message> <command-name>/code-review</command-name>' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: 'c', ts: expect.any(Number), text: '/code-review' },
    ]);
  });

  it('surfaces non-empty local-command-stdout and drops empty stdout', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'o', timestamp: '2026-06-12T00:00:00Z', message: { content: '<local-command-stdout>Goodbye!</local-command-stdout>' } },
      { type: 'user', uuid: 'e', timestamp: '2026-06-12T00:00:01Z', message: { content: '<local-command-stdout></local-command-stdout>' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'command_output', text: 'Goodbye!' });
  });

  it('strips <system-reminder> spans from user text and drops reminder-only entries', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'mix', timestamp: '2026-06-12T00:00:00Z', message: { content: 'Add a test.\n<system-reminder>follow the style guide</system-reminder>' } },
      { type: 'user', uuid: 'only', timestamp: '2026-06-12T00:00:01Z', message: { content: '<system-reminder>background context</system-reminder>' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'Add a test.' });
    expect((entries[0] as { text: string }).text).not.toContain('system-reminder');
  });

  it('surfaces an isCompactSummary entry as a compaction system entry', async () => {
    tmpFile = writeFixture([
      { type: 'user', uuid: 'sum', isCompactSummary: true, timestamp: '2026-06-12T00:00:00Z', message: { content: 'Summary: prior work recap.' } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'system', uuid: 'sum', ts: expect.any(Number), subtype: 'compaction', text: 'Summary: prior work recap.' },
    ]);
  });

  it('surfaces a compact_boundary system entry with trigger and pre-compaction tokens', async () => {
    tmpFile = writeFixture([
      { type: 'system', subtype: 'compact_boundary', uuid: 'b', timestamp: '2026-06-12T00:00:00Z', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 165432 } },
    ]);
    const entries = await parseClaudeTranscript(tmpFile);
    expect(entries[0]).toMatchObject({
      kind: 'system',
      subtype: 'compaction',
      text: 'Conversation compacted (auto, 165432 tokens before compaction)',
    });
  });

  it('parses the pinned real-capture fixture into a clean entry sequence', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'claude-real-session.jsonl');
    const entries = await parseClaudeTranscript(fixturePath);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'user',       // real prompt
      'user',       // mixed system-reminder, stripped
      'assistant',  // text
      'assistant',  // tool_use
      'tool_result',
      'user',       // /exit command - a user-role turn, shown as a plain "/exit" message
      'system',     // local-command-stdout
      'system',     // compact_boundary
      'system',     // isCompactSummary
      'assistant',  // final text
    ]);

    const markdown = transcriptToMarkdown(entries);
    expect(markdown).not.toContain('<command-name>');
    expect(markdown).not.toContain('<system-reminder>');
    expect(markdown).not.toContain('Base directory for this skill'); // isMeta dropped
    expect(markdown.match(/## Conversation compacted/g) ?? []).toHaveLength(2);
    expect(markdown).toContain('/exit'); // the command, rendered as a user message
    expect(markdown).toContain('**Command output:**');
    expect(markdown).toContain('Goodbye!');
  });
});

describe('transcriptToMarkdown', () => {
  it('formats a transcript with paired tool result', () => {
    const md = transcriptToMarkdown([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'list files' },
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 1,
        model: 'claude-opus-4-6',
        blocks: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 't1', content: 'a.txt\nb.txt' },
    ]);
    expect(md).toContain('## User');
    expect(md).toContain('list files');
    expect(md).toContain('## Assistant (claude-opus-4-6)');
    expect(md).toContain('**Tool:** `Bash`');
    expect(md).toContain('"command": "ls"');
    expect(md).toContain('**Result:**');
    expect(md).toContain('a.txt');
  });
});
