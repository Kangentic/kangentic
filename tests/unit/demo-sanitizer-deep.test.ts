/**
 * sanitizeDeep (scripts/lib/demo-sanitizer.js) is the walk both transcript writers run before
 * the leak check: capture-agent-scrollback.js --transcript-out at record time, and
 * scripts/backfill-demo-transcripts.mjs for a recording already on disk. A transcript carries the
 * identity in tool inputs, tool results, and file paths the agent quotes, at any depth, so the
 * walk has to reach every string. The rewrite itself is buildSanitizer's and is driven by the
 * recording machine's own home and user name, so it is stood in for here by a fake that rewrites
 * one marker; what this pins is the walk.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeDeep, stripAccountLinks, buildSanitizer } = require('../../scripts/lib/demo-sanitizer.js') as {
  sanitizeDeep: (value: unknown, sanitizer: { apply: (text: string) => string }) => unknown;
  stripAccountLinks: (text: string) => string;
  buildSanitizer: (options: { project: string; cwd: string }) => { apply: (text: string) => string; assertClean: (text: string, label: string) => void };
};

describe('stripAccountLinks', () => {
  // Claude's footer as a recording carries it: "/rc" linked to the account's own session.
  const linked = (terminator: string): string => `\x1b]8;id=u-abc%123;https://claude.ai/code/session_01AbCdEf?from=cli${terminator}/rc\x1b]8;;${terminator}`;

  it('drops the session link\'s target and keeps the text in the same cells', () => {
    expect(stripAccountLinks(linked('\x1b\\'))).toBe('\x1b]8;;\x1b\\/rc\x1b]8;;\x1b\\');
    expect(stripAccountLinks(linked('\x07'))).toBe('\x1b]8;;\x07/rc\x1b]8;;\x07');
  });

  it('leaves every other link alone', () => {
    const docs = '\x1b]8;;https://docs.example.com/page\x1b\\docs\x1b]8;;\x1b\\';
    expect(stripAccountLinks(docs)).toBe(docs);
  });

  it('runs inside the capture\'s rewrite, and the leak check refuses a link that survived it', () => {
    const sanitizer = buildSanitizer({ project: 'contoso-web', cwd: process.cwd() });
    expect(sanitizer.apply(linked('\x1b\\'))).not.toContain('claude.ai/code/session_');
    expect(() => sanitizer.assertClean(linked('\x1b\\'), 'footer')).toThrow(/claude\.ai session/);
  });
});

const rewriter = { apply: (text: string) => text.replaceAll('MARKER', 'dev') };

describe('sanitizeDeep', () => {
  it('rewrites every string at any depth, keys included, and leaves other values alone', () => {
    const input = {
      kind: 'assistant',
      ts: 1234,
      done: true,
      nothing: null,
      blocks: [
        { type: 'text', text: 'read C:\\Users\\MARKER\\work\\contoso-web' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/Users/MARKER/work/x.ts', 'MARKER-key': ['MARKER', 7] } },
      ],
    };

    const output = sanitizeDeep(input, rewriter) as typeof input & { blocks: Array<{ input?: Record<string, unknown> }> };

    expect(output).toEqual({
      kind: 'assistant',
      ts: 1234,
      done: true,
      nothing: null,
      blocks: [
        { type: 'text', text: 'read C:\\Users\\dev\\work\\contoso-web' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/Users/dev/work/x.ts', 'dev-key': ['dev', 7] } },
      ],
    });
  });

  it('returns a copy rather than rewriting the input in place', () => {
    const input = { text: 'MARKER', nested: { text: 'MARKER' } };

    const output = sanitizeDeep(input, rewriter) as typeof input;

    expect(input.text).toBe('MARKER');
    expect(input.nested.text).toBe('MARKER');
    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(input.nested);
  });

  it('passes a bare string, array, or primitive through the same rewrite', () => {
    expect(sanitizeDeep('MARKER', rewriter)).toBe('dev');
    expect(sanitizeDeep(['MARKER', 1], rewriter)).toEqual(['dev', 1]);
    expect(sanitizeDeep(42, rewriter)).toBe(42);
    expect(sanitizeDeep(undefined, rewriter)).toBeUndefined();
  });
});
