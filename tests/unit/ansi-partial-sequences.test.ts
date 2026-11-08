import { describe, expect, it } from 'vitest';
import { carryForPartialEscape, createHyperlinkStripper, exposeHyperlinkTargets, skipTruncatedStringSequence, stripAnsiControlCodes } from '../../src/shared/ansi-strip';

describe('carryForPartialEscape', () => {
  it('keeps a short partial whole', () => {
    const partial = '\x1b]8;id=1;https://example.com/a';
    expect(carryForPartialEscape(partial)).toBe(partial);
  });

  it('keeps a partial of exactly the cap whole', () => {
    const partial = `\x1b]${'a'.repeat(4094)}`;
    expect(partial).toHaveLength(4096);
    expect(carryForPartialEscape(partial)).toBe(partial);
  });

  it('keeps only the introducer of an oversize partial, so its tail still reads as a sequence', () => {
    expect(carryForPartialEscape(`\x1b]8;id=1;${'a'.repeat(5000)}`)).toBe('\x1b]');
    expect(carryForPartialEscape(`\x1b[${'1;'.repeat(3000)}`)).toBe('\x1b[');
  });

  it('keeps the trailing ESC of an oversize partial, which may start its terminator', () => {
    expect(carryForPartialEscape(`\x1b]8;id=1;${'a'.repeat(5000)}\x1b`)).toBe('\x1b]\x1b');
  });
});

describe('skipTruncatedStringSequence', () => {
  it.each([
    ['the rest of a URL before ST', 'example.com/a\x1b\\label', 'example.com/a\x1b\\'.length],
    ['the rest of a title before BEL', 'a title\x07text', 'a title\x07'.length],
    ['a lone ST', '\x1b\\text', 2],
  ])('skips %s', (_label, data, expected) => {
    expect(skipTruncatedStringSequence(data)).toBe(expected);
  });

  it.each([
    ['plain text', 'hello world'],
    ['text before a new sequence', 'hello\x1b[31mred'],
    ['text before a hyperlink of its own', 'hello \x1b]8;;https://example.com\x1b\\'],
    ['a line ending before any terminator', 'hello\r\nworld\x07'],
    ['an empty string', ''],
  ])('keeps %s whole, since skipping would eat real output', (_label, data) => {
    expect(skipTruncatedStringSequence(data)).toBe(0);
  });

  it('gives up past the longest payload it carries', () => {
    expect(skipTruncatedStringSequence(`${'a'.repeat(5000)}\x1b\\`)).toBe(0);
  });
});

describe('createHyperlinkStripper', () => {
  // The bytes Claude wrote for a link in tests/captures/fixtures/demo/contoso-web-claude-validate-mcp.json:
  // an `id=` parameter, and ST closing both sequences.
  const CAPTURED_LABEL = 'http://localhost:${(server.address()';
  const CAPTURED_LINK = `\x1b]8;id=u-1hh8tfm%2275790205556602265;${CAPTURED_LABEL}\x1b\\${CAPTURED_LABEL}\x1b[m\x1b]8;;\x1b\\`;
  const LINKS: Array<[string, string, string]> = [
    ['captured from Claude', CAPTURED_LINK, `${CAPTURED_LABEL}\x1b[m`],
    ['closed by ST', '\x1b]8;id=1;https://example.com/a\x1b\\label\x1b]8;;\x1b\\', 'label'],
    ['closed by BEL', '\x1b]8;;https://example.com/a\x07label\x1b]8;;\x07', 'label'],
  ];
  const CUTS = LINKS.flatMap(([name, link, label]) => Array.from(
    { length: link.length - 1 },
    (_unused, index) => [name, index + 1, link, label] as const,
  ));

  it.each(CUTS)('keeps the label of a link %s when a chunk ends at character %i', (_name, cut, link, label) => {
    const strip = createHyperlinkStripper();
    expect(strip(`a ${link.slice(0, cut)}`) + strip(`${link.slice(cut)} b`)).toBe(`a ${label} b`);
  });

  it.each([
    ['a chunk with no link', 'plain \x1b[31mred\x1b[0m', 'plain \x1b[31mred\x1b[0m'],
    ['a link whole in one chunk', 'a \x1b]8;;https://example.com\x07b\x1b]8;;\x07 c', 'a b c'],
  ])('passes %s through in one call', (_label, chunk, expected) => {
    expect(createHyperlinkStripper()(chunk)).toBe(expected);
  });

  it('leaves every other sequence alone', () => {
    const colored = '\x1b[31mred\x1b[0m\x1b]0;title\x07';
    expect(createHyperlinkStripper()(colored)).toBe(colored);
  });

  it('releases an ESC that turns out to start something else', () => {
    const strip = createHyperlinkStripper();
    expect(strip('text\x1b') + strip('[31mred')).toBe('text\x1b[31mred');
  });

  it('holds no more than a URL could be', () => {
    const strip = createHyperlinkStripper();
    expect(strip(`\x1b]8;;${'a'.repeat(5000)}`).length).toBeGreaterThan(5000);
  });
});

describe('exposeHyperlinkTargets', () => {
  const PR_URL = 'https://github.com/owner/repo/pull/12';

  it('keeps the only copy of a URL behind a short label through a strip', () => {
    const linked = `\x1b]8;id=1;${PR_URL}\x1b\\PR #12\x1b]8;;\x1b\\`;
    expect(stripAnsiControlCodes(linked)).toBe('PR #12');
    expect(stripAnsiControlCodes(exposeHyperlinkTargets(linked))).toBe(`${PR_URL} PR #12`);
  });

  it('reads a BEL-terminated link and leaves other sequences alone', () => {
    expect(exposeHyperlinkTargets(`\x1b]8;;${PR_URL}\x07x\x1b]0;title\x07`)).toBe(`${PR_URL} x\x1b]0;title\x07`);
  });
});
