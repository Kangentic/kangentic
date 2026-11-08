import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';
import { cellRangeOf, readLogicalLine } from '../../src/renderer/utils/terminal-links/buffer-line-text';
import { parsePaths, parseUrls } from '../../src/renderer/utils/terminal-links/parse-links';
import { MAX_LINK_PATHS_PER_ROW } from '../../src/shared/terminal-link-limits';

function pathsIn(text: string): string[] {
  return parsePaths(text).map((parsed) => parsed.path);
}

describe('parseUrls', () => {
  it.each([
    ['a sentence end', 'see https://example.com/docs.', 'https://example.com/docs'],
    ['a comma', 'https://example.com/a, then more', 'https://example.com/a'],
    ['prose parens', '(see https://example.com/a)', 'https://example.com/a'],
    ['a balanced paren in the URL', 'https://example.com/wiki/Foo_(bar) ok', 'https://example.com/wiki/Foo_(bar)'],
    ['a TUI border', 'https://example.com/a\u2502', 'https://example.com/a'],
    ['a query string', 'http://localhost:3000/x?a=1&b=2', 'http://localhost:3000/x?a=1&b=2'],
  ])('stops at %s', (_label, text, expected) => {
    expect(parseUrls(text).map((parsed) => parsed.url)).toEqual([expected]);
  });

  it('skips other schemes and a bare scheme', () => {
    expect(parseUrls('ftp://example.com javascript:alert(1) https:// mailto:a@example.com')).toEqual([]);
  });
});

describe('parsePaths', () => {
  it.each([
    ['a Windows path', 'error in C:\\Users\\dev\\app.ts', 'C:\\Users\\dev\\app.ts'],
    ['a Windows path with forward slashes', 'C:/Users/dev/app.ts', 'C:/Users/dev/app.ts'],
    ['a POSIX path', 'wrote /home/dev/app.ts', '/home/dev/app.ts'],
    ['a relative path', 'src/renderer/app.ts', 'src/renderer/app.ts'],
    ['a dotted relative path', './src/app.ts', './src/app.ts'],
    ['a parent relative path', '..\\src\\app.ts', '..\\src\\app.ts'],
    ['a home path', '~/.config/app.json', '~/.config/app.json'],
    ['a bare file name', 'updated package.json', 'package.json'],
    ['a distro share', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts'],
    ['a tool call', 'Update(src/app.ts)', 'src/app.ts'],
    ['a flag value', '--config=config/app.json', 'config/app.json'],
    ['a value with an equals sign before it', '--define=mode=src/app.ts', 'src/app.ts'],
    ['a folder with an equals sign', 'src/a=b/file.ts', 'src/a=b/file.ts'],
    ['a path with a parenthesised folder', 'app/(group)/page.tsx', 'app/(group)/page.tsx'],
    ['a sentence end', 'look at src/app.ts.', 'src/app.ts'],
  ])('finds %s', (_label, text, expected) => {
    expect(pathsIn(text)).toEqual([expected]);
  });

  it.each([
    [':line', 'src/app.ts:42', 42, null],
    [':line:column', 'src/app.ts:42:7', 42, 7],
    ['a Windows path', 'C:\\src\\app.ts:42:7', 42, 7],
  ])('splits %s off the path', (_label, text, line, column) => {
    const [parsed] = parsePaths(text);
    expect(parsed).toMatchObject({ line, column });
    expect(parsed.path.endsWith('app.ts')).toBe(true);
    expect(parsed.end - parsed.start).toBe(text.length);
  });

  it('keeps spaces inside quotes and not outside them', () => {
    expect(pathsIn('"C:\\Program Files\\app.exe"')).toEqual(['C:\\Program Files\\app.exe']);
    expect(pathsIn('C:\\Program Files\\app.exe')).toEqual(['C:\\Program', 'Files\\app.exe']);
  });

  it('leaves a UNC path to a network host out entirely', () => {
    expect(pathsIn('\\\\fileserver\\share\\secrets.txt')).toEqual([]);
    expect(pathsIn('//fileserver/share/secrets.txt')).toEqual([]);
  });

  it('takes nothing out of a URL', () => {
    expect(pathsIn('https://example.com/src/app.ts')).toEqual([]);
  });

  it('skips plain prose', () => {
    expect(pathsIn('The build finished, done / ok')).toEqual([]);
  });

  it('caps a row of candidates', () => {
    const text = Array.from({ length: 40 }, (_unused, index) => `src/file${index}.ts`).join(' ');
    expect(parsePaths(text)).toHaveLength(MAX_LINK_PATHS_PER_ROW);
  });
});

async function terminalWith(text: string, cols = 40): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows: 6, allowProposedApi: true });
  activateUnicode11(terminal);
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  return terminal;
}

/** The text the cells of a range hold, read back through the terminal rather than the string. */
function textInCells(terminal: Terminal, range: { start: { x: number; y: number }; end: { x: number; y: number } }): string {
  const parts: string[] = [];
  for (let row = range.start.y; row <= range.end.y; row += 1) {
    const line = terminal.buffer.active.getLine(row - 1);
    const firstColumn = row === range.start.y ? range.start.x - 1 : 0;
    const lastColumn = row === range.end.y ? range.end.x - 1 : terminal.cols - 1;
    for (let column = firstColumn; column <= lastColumn; column += 1) parts.push(line?.getCell(column)?.getChars() ?? '');
  }
  return parts.join('');
}

describe('readLogicalLine against real Unicode 11 widths', () => {
  it.each([
    ['an emoji', '\u2705 https://example.com/a'],
    ['a wide CJK run', '\u65e5\u672c\u8a9e https://example.com/a'],
    ['an astral emoji', '\u{1f680}\u{1f680} https://example.com/a'],
    ['a combining mark', 'e\u0301e\u0301 https://example.com/a'],
  ])('keeps the link range on its cells after %s', async (_label, text) => {
    const terminal = await terminalWith(text);
    const line = readLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const [parsed] = parseUrls(line.text);
    const range = cellRangeOf(line, parsed.start, parsed.end);
    expect(range).not.toBeNull();
    expect(textInCells(terminal, range!)).toBe('https://example.com/a');
  });

  it('ends a range on the second cell of a wide last glyph', async () => {
    const terminal = await terminalWith('\u2705 src/\u65e5\u672c.ts\u65e5');
    const line = readLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const lastGlyph = line.text.lastIndexOf('日');
    const range = cellRangeOf(line, lastGlyph, lastGlyph + 1);
    expect(range!.end.x - range!.start.x).toBe(1);
  });

  it('joins a soft wrap, and the link covers both rows', async () => {
    const url = `https://example.com/${'a'.repeat(50)}`;
    const terminal = await terminalWith(`\u2705 ${url}`);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    for (const hoveredRow of [0, 1]) {
      const line = readLogicalLine(terminal.buffer.active, hoveredRow, terminal.cols);
      const [parsed] = parseUrls(line.text);
      expect(parsed.url).toBe(url);
      expect(cellRangeOf(line, parsed.start, parsed.end)).toMatchObject({ start: { y: 1 }, end: { y: 2 } });
    }
  });

  it('stops at a run of wrapped rows rather than reading a whole padded screen', async () => {
    const terminal = await terminalWith('x'.repeat(40 * 5));
    const fromTop = readLogicalLine(terminal.buffer.active, 0, terminal.cols);
    expect(fromTop.text.length).toBe(40 * 5);
    const tall = new Terminal({ cols: 10, rows: 30, allowProposedApi: true });
    await new Promise<void>((resolve) => tall.write('y'.repeat(10 * 20), resolve));
    expect(readLogicalLine(tall.buffer.active, 10, tall.cols).text.length).toBeLessThanOrEqual(10 * 9);
  });
});

describe('readLogicalLine across a wrap a TUI drew itself', () => {
  /** Rows that are not `isWrapped`, as every agent's own renderer draws them. */
  function hardRows(rows: readonly string[]): string {
    return rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join('');
  }

  function firstUrl(terminal: Terminal, row = 0): string | undefined {
    return parseUrls(readLogicalLine(terminal.buffer.active, row, terminal.cols).text)[0]?.url;
  }

  it('joins an indented continuation, from either row, without its indent', async () => {
    const head = `https://example.com/${'b'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  rest-of-it and then prose']));
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false);
    expect(firstUrl(terminal, 0)).toBe(`${head}rest-of-it`);
    expect(firstUrl(terminal, 1)).toBe(`${head}rest-of-it`);
  });

  it('follows a URL across three rows', async () => {
    const head = `https://example.com/${'c'.repeat(20)}`;
    const middle = `  ${'d'.repeat(38)}`;
    const terminal = await terminalWith(hardRows([head, middle, '  end']));
    expect(firstUrl(terminal, 2)).toBe(`${head}${'d'.repeat(38)}end`);
  });

  it('joins a row that stops one cell short, as Claude Code wraps its prompt echo', async () => {
    const head = `https://example.com/${'e'.repeat(19)}`;
    const terminal = await terminalWith(hardRows([head, '-continued']));
    expect(firstUrl(terminal)).toBe(`${head}-continued`);
  });

  describe('Copilot CLI 1.0.105, rows captured from a real session at 120 columns', () => {
    const FULL_URL = 'https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past-the-right-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-full-terminal-row-on-any-reasonable-window-width-0123456789-abcdefghij';

    async function wideTerminalWith(rows: readonly string[]): Promise<Terminal> {
      const terminal = new Terminal({ cols: 120, rows: 6, allowProposedApi: true });
      activateUnicode11(terminal);
      await new Promise<void>((resolve) => terminal.write(hardRows(rows), resolve));
      return terminal;
    }

    it('reads the prompt echo, which wraps seven cells short of its panel border', async () => {
      const terminal = await wideTerminalWith([
        '   https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past       ┃',
        '   -the-right-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-ful       ┃',
        '   l-terminal-row-on-any-reasonable-window-width-0123456789-abcdefghij                                                 ┃',
        '   src/app.ts:12                                                                                                       ┃',
      ]);
      for (const row of [0, 1, 2]) expect(firstUrl(terminal, row)).toBe(FULL_URL);
    });

    it('reads a response row that runs to the border', async () => {
      const terminal = await wideTerminalWith([
        ' ● https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past-the-r ┃',
        '   ight-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-full-terminal-r ┃',
        '   ow-on-any-reasonable-window-width-0123456789-abcdefghij                                                             ┃',
      ]);
      expect(firstUrl(terminal, 1)).toBe(FULL_URL);
    });
  });

  it('leaves a line that ends in a URL alone when the next word would have fit beside it', async () => {
    const head = `see https://example.com/${'i'.repeat(8)}`;
    const terminal = await terminalWith(hardRows([head, 'Then run it']));
    expect(firstUrl(terminal)).toBe(`https://example.com/${'i'.repeat(8)}`);
  });

  it('keeps the cells right, so the range ends on the continuation', async () => {
    const head = `https://example.com/${'f'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  tail']));
    const line = readLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const [parsed] = parseUrls(line.text);
    expect(cellRangeOf(line, parsed.start, parsed.end)).toEqual({ start: { x: 1, y: 1 }, end: { x: 6, y: 2 } });
  });

  it('leaves a link short of the edge alone', async () => {
    const terminal = await terminalWith(hardRows(['https://example.com/a', 'next']));
    expect(firstUrl(terminal)).toBe('https://example.com/a');
  });

  it('does not run two wrapped words of prose together', async () => {
    const terminal = await terminalWith(hardRows(['x'.repeat(40), 'yyy']));
    expect(readLogicalLine(terminal.buffer.active, 0, terminal.cols).text).not.toContain('yyy');
  });

  it('stops at a bullet or a border, which cannot be part of a link', async () => {
    const head = `https://example.com/${'g'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  ● next item']));
    expect(firstUrl(terminal)).toBe(head);
  });

  it('stops at text indented like a different block', async () => {
    const head = `https://example.com/${'h'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, `${' '.repeat(12)}aside`]));
    expect(firstUrl(terminal)).toBe(head);
  });
});

