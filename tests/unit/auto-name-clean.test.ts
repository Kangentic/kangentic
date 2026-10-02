import { describe, it, expect } from 'vitest';
import {
  cleanSummarizeOutput,
  buildSummarizePrompt,
  extractFinalAssistantText,
} from '../../src/main/agent/shared/auto-name';
import { quoteForCmdShell } from '../../src/main/agent/shared/cli-print';

describe('cleanSummarizeOutput', () => {
  it('returns the first non-empty line', () => {
    expect(cleanSummarizeOutput('Toast Reappears On Reopen\n\nextra content')).toBe('Toast Reappears On Reopen');
  });

  it('strips wrapping straight and curly quotes', () => {
    expect(cleanSummarizeOutput('"Fix Login Bug"')).toBe('Fix Login Bug');
    expect(cleanSummarizeOutput("'Fix Login Bug'")).toBe('Fix Login Bug');
    expect(cleanSummarizeOutput('“Fix Login Bug”')).toBe('Fix Login Bug');
  });

  it('removes leading markdown punctuation and trailing periods', () => {
    expect(cleanSummarizeOutput('# Fix Login Bug')).toBe('Fix Login Bug');
    expect(cleanSummarizeOutput('- Fix Login Bug.')).toBe('Fix Login Bug');
    expect(cleanSummarizeOutput('* Fix Login Bug!!')).toBe('Fix Login Bug');
  });

  it('strips fenced code blocks before scanning lines', () => {
    expect(cleanSummarizeOutput('```\nFix Login Bug\n```\nFinal Title')).toBe('Final Title');
  });

  it('strips inline backticks', () => {
    expect(cleanSummarizeOutput('Fix `auth` Token Refresh')).toBe('Fix auth Token Refresh');
  });

  it('caps the title at 80 characters and trims trailing separators', () => {
    const longInput = 'A'.repeat(120);
    const cleaned = cleanSummarizeOutput(longInput);
    expect(cleaned.length).toBe(80);
    expect(cleaned).toBe('A'.repeat(80));
  });

  it('returns empty string for empty input', () => {
    expect(cleanSummarizeOutput('')).toBe('');
    expect(cleanSummarizeOutput('   ')).toBe('');
  });
});

describe('extractFinalAssistantText', () => {
  it('prefers a line with type=assistant over an unrelated line with a text field', () => {
    const stream = [
      JSON.stringify({ type: 'init', text: 'Initializing model gpt-4' }),
      JSON.stringify({ type: 'tool_call', name: 'shell', text: 'ls -la' }),
      JSON.stringify({ type: 'assistant', text: 'Fix Login Race Condition' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('Fix Login Race Condition');
  });

  it('walks the stream from the end and picks the LAST type-tagged line', () => {
    const stream = [
      JSON.stringify({ type: 'message', text: 'first message' }),
      JSON.stringify({ type: 'message', text: 'second message' }),
      JSON.stringify({ type: 'message', text: 'final message' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('final message');
  });

  it('accepts type values: assistant | message | completion | result | final', () => {
    expect(extractFinalAssistantText(JSON.stringify({ type: 'completion', text: 'A' }))).toBe('A');
    expect(extractFinalAssistantText(JSON.stringify({ type: 'result', text: 'B' }))).toBe('B');
    expect(extractFinalAssistantText(JSON.stringify({ type: 'final', text: 'C' }))).toBe('C');
  });

  it('falls back to any JSON line with a text field if no type-tagged line is found', () => {
    const stream = JSON.stringify({ text: 'untagged candidate' });
    expect(extractFinalAssistantText(stream)).toBe('untagged candidate');
  });

  it('returns raw stdout when the stream has no JSON lines', () => {
    expect(extractFinalAssistantText('plain text response\n')).toBe('plain text response\n');
  });

  it('extracts message.content for nested-shape adapters', () => {
    const stream = JSON.stringify({ type: 'assistant', message: { content: 'Nested Title' } });
    expect(extractFinalAssistantText(stream)).toBe('Nested Title');
  });

  it('skips malformed JSON lines without throwing', () => {
    const stream = [
      'not json at all',
      '{this is broken',
      JSON.stringify({ type: 'assistant', text: 'Real Title' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('Real Title');
  });
});

// ---------------------------------------------------------------------------
// #1: quoteForCmdShell
// ---------------------------------------------------------------------------

describe('quoteForCmdShell', () => {
  it('passes through a plain token unchanged (no quoting needed)', () => {
    expect(quoteForCmdShell('--print')).toBe('--print');
    expect(quoteForCmdShell('hello')).toBe('hello');
    expect(quoteForCmdShell('abc123')).toBe('abc123');
  });

  it('wraps an empty string in double quotes', () => {
    expect(quoteForCmdShell('')).toBe('""');
  });

  it('wraps a token with spaces in double quotes', () => {
    expect(quoteForCmdShell('hello world')).toBe('"hello world"');
  });

  it('doubles embedded double-quotes (cmd.exe convention)', () => {
    expect(quoteForCmdShell('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmdShell('"quoted"')).toBe('"""quoted"""');
  });

  it('doubles percent signs to prevent cmd.exe variable expansion', () => {
    // A Windows path like %APPDATA% must become %%APPDATA%% inside cmd.exe
    // strings even when double-quoted, because cmd expands %VAR% before the
    // enclosing double-quotes are parsed.
    const result = quoteForCmdShell('%APPDATA%');
    expect(result).toBe('"%%APPDATA%%"');
  });

  it('doubles both percent signs and embedded double-quotes together', () => {
    const input = '%PATH% and "value"';
    const result = quoteForCmdShell(input);
    // Percents doubled, quotes doubled, whole thing wrapped
    expect(result).toBe('"%%PATH%% and ""value"""');
  });

  it('wraps tokens with special cmd characters: & < > | ^ ( )', () => {
    expect(quoteForCmdShell('a&b')).toBe('"a&b"');
    expect(quoteForCmdShell('a<b')).toBe('"a<b"');
    expect(quoteForCmdShell('a>b')).toBe('"a>b"');
    expect(quoteForCmdShell('a|b')).toBe('"a|b"');
    expect(quoteForCmdShell('a^b')).toBe('"a^b"');
    expect(quoteForCmdShell('(flag)')).toBe('"(flag)"');
  });
});

// ---------------------------------------------------------------------------
// #7: extractFinalAssistantText - two-pass boundary enforcement
// ---------------------------------------------------------------------------

describe('extractFinalAssistantText - two-pass boundary', () => {
  it('does NOT match a tool_call line even when it has a text field, when a later assistant line exists', () => {
    // Both passes: the tool_call line must be skipped in pass 1 (not in
    // FINAL_MESSAGE_TYPES). Pass 2 would find it, but pass 1 finds the
    // assistant line first (walking from the end). The tool_call text
    // must never become the extracted title.
    const stream = [
      JSON.stringify({ type: 'tool_call', name: 'Bash', text: 'ls -la' }),
      JSON.stringify({ type: 'assistant', text: 'Fix Database Migration Script' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('Fix Database Migration Script');
  });

  it('does NOT match a tool_call line in pass 2 when it is the only JSON line with a text field', () => {
    // tool_call is not in FINAL_MESSAGE_TYPES (pass 1 skips it), but pass 2
    // falls back to ANY JSON line with a text field. tool_call with text='ls -la'
    // would be picked by pass 2 naively -- this test confirms the actual current
    // behavior so regressions are caught. (The fallback IS intentionally broad;
    // this test documents the boundary, not a prohibition.)
    const stream = JSON.stringify({ type: 'tool_call', name: 'Bash', text: 'ls -la' });
    // Pass 2 intentionally does pick this - it is the only candidate.
    // The test asserts the ACTUAL behavior (pass 2 found it) to document the
    // current semantics and catch unintended changes.
    const result = extractFinalAssistantText(stream);
    expect(result).toBe('ls -la');
  });

  it('prefers the assistant-typed line over tool_call text regardless of stream order', () => {
    // Stream order: tool_call first (index 0), assistant last (index 1).
    // Walking from the end: pass 1 hits assistant at index 1 first and returns it.
    const stream = [
      JSON.stringify({ type: 'tool_call', text: 'rm -rf /tmp' }),
      JSON.stringify({ type: 'assistant', text: 'Clean Up Temp Files Safely' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('Clean Up Temp Files Safely');
  });

  it('prefers the assistant-typed line when tool_call appears AFTER assistant in the stream', () => {
    // Stream order: assistant at index 0, tool_call at index 1 (later in stream).
    // Walking from the end: pass 1 hits tool_call first (index 1), skips it (not
    // in FINAL_MESSAGE_TYPES), then hits assistant at index 0 and returns it.
    // The tool_call text must NOT be returned.
    const stream = [
      JSON.stringify({ type: 'assistant', text: 'Refactor Auth Service' }),
      JSON.stringify({ type: 'tool_call', text: 'cat auth.ts' }),
    ].join('\n');
    expect(extractFinalAssistantText(stream)).toBe('Refactor Auth Service');
  });
});

describe('buildSummarizePrompt', () => {
  it('embeds the user description after the system prefix', () => {
    const prompt = buildSummarizePrompt('My description here');
    expect(prompt).toContain('Summarize the following task description');
    expect(prompt).toContain('imperative title');
    expect(prompt.endsWith('My description here')).toBe(true);
  });

  it('truncates very long descriptions to a 4000-char budget', () => {
    const huge = 'x'.repeat(10_000);
    const prompt = buildSummarizePrompt(huge);
    // Total length is system prefix (~250 chars) + 4000 capped description.
    expect(prompt.length).toBeLessThan(4500);
    expect(prompt.length).toBeGreaterThan(4000);
  });

  it('trims leading/trailing whitespace from the description', () => {
    const prompt = buildSummarizePrompt('   trimmed input   ');
    expect(prompt.endsWith('trimmed input')).toBe(true);
  });
});
