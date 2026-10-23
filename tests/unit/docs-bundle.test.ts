/**
 * Unit tests for scripts/docs-bundle.mjs, the helpers behind the docs concept folder: frontmatter,
 * GitHub heading slugs, heading and link extraction, the concept list, the parts a titled source
 * entry covers, and the `sources` CLI.
 *
 * tests/unit/okf-docs-conformance.test.ts already covers repeated-heading numbering, three slugs,
 * one frontmatter shape and three conceptsForSource cases through these helpers. This file pins the
 * edges that file does not reach, each one chosen so that putting back the behavior it replaced
 * turns an assertion red. Every filesystem write goes under os.tmpdir().
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  conceptsForSource,
  coveredPartsOf,
  githubSlug,
  headingText,
  headingsOf,
  linksOf,
  listConcepts,
  listDocsMarkdown,
  parseFrontmatter,
  stripFrontmatter,
} from '../../scripts/docs-bundle.mjs';

const ROOT = path.resolve(__dirname, '../..');
const CLAUDE_ADAPTER_PATH = 'src/main/agent/adapters/claude/claude-adapter.ts';
const USAGE_LINE = 'usage: node scripts/docs-bundle.mjs sources <repo path>...';

interface SourceEntry {
  resource?: string;
  title?: string;
}

interface ConceptRecord {
  path: string;
  frontmatter: { sources?: Array<string | SourceEntry> } | null;
}

interface HeadingRecord {
  level: number;
  text: string;
  line: number;
  slug: string;
}

interface LinkRecord {
  url: string;
  path: string;
  fragment: string | null;
  line: number;
  column: number;
  length: number;
}

/** A text from its lines, joined with the given line ending and with no ending after the last line. */
function joinLines(lines: string[], lineEnding = '\n'): string {
  return lines.join(lineEnding);
}

/** The headings of a text reduced to what a heading is: its level, its text and its anchor. */
function headingSummaries(text: string): Array<{ level: number; text: string; slug: string }> {
  return (headingsOf(text) as HeadingRecord[]).map((heading) => ({ level: heading.level, text: heading.text, slug: heading.slug }));
}

/** The links of a text reduced to the four fields the docs checks read. */
function linkSummaries(text: string): Array<{ url: string; path: string; fragment: string | null; line: number }> {
  return (linksOf(text) as LinkRecord[]).map((link) => ({ url: link.url, path: link.path, fragment: link.fragment, line: link.line }));
}

function conceptPaths(repoPath: string, concepts: ConceptRecord[]): string[] {
  return (conceptsForSource(repoPath, concepts) as ConceptRecord[]).map((concept) => concept.path);
}

describe('parseFrontmatter', () => {
  it('reads CRLF frontmatter with no carriage return left in any value', () => {
    const text = joinLines([
      '---',
      'type: Guide',
      'title: Windows file',
      'tags: [a, b]',
      'sources:',
      '  - resource: src/a.ts',
      '    title: A file',
      '---',
      '# Body',
      '',
    ], '\r\n');
    expect(parseFrontmatter(text)).toEqual({
      type: 'Guide',
      title: 'Windows file',
      tags: ['a', 'b'],
      sources: [{ resource: 'src/a.ts', title: 'A file' }],
    });
  });

  it('unescapes a doubled quote in a single-quoted scalar and keeps a backslash literal', () => {
    const text = joinLines([
      '---',
      'title: \'it\'\'s here\'',
      'directory: \'back\\slash\'',
      '---',
      '',
    ]);
    expect(parseFrontmatter(text)).toEqual({ title: 'it\'s here', directory: 'back\\slash' });
  });

  it('unescapes a quote and a backslash in a double-quoted scalar', () => {
    const text = joinLines([
      '---',
      'title: "say \\"hi\\" and a\\\\b"',
      '---',
      '',
    ]);
    expect(parseFrontmatter(text)).toEqual({ title: 'say "hi" and a\\b' });
  });

  it('keeps a comma inside a quoted inline-list item in that item', () => {
    const text = joinLines([
      '---',
      'tags: [a, "b, c"]',
      'aliases: [x, \'it\'\'s, ok\', y]',
      'escaped: ["a \\", b", c]',
      '---',
      '',
    ]);
    expect(parseFrontmatter(text)).toEqual({
      tags: ['a', 'b, c'],
      aliases: ['x', 'it\'s, ok', 'y'],
      escaped: ['a ", b', 'c'],
    });
  });

  it('trims the items of an inline list', () => {
    expect(parseFrontmatter('---\ntags: [ a ,  b  ]\n---\n')).toEqual({ tags: ['a', 'b'] });
  });

  it('reads an empty inline list as an empty array', () => {
    expect(parseFrontmatter('---\ntags: []\nother: [ ]\n---\n')).toEqual({ tags: [], other: [] });
  });

  it('skips comment lines and blank lines inside the block', () => {
    const text = joinLines([
      '---',
      '# a comment',
      'type: Guide',
      '',
      '   # an indented comment',
      'title: T',
      '---',
      '',
    ]);
    expect(parseFrontmatter(text)).toEqual({ type: 'Guide', title: 'T' });
  });

  it('reads a bare string item in a block list, next to a mapping item', () => {
    const text = joinLines([
      '---',
      'tags:',
      '  - alpha',
      '  - "beta gamma"',
      '  - \'delta\'',
      'sources:',
      '  - src/a.ts',
      '  - resource: src/b.ts',
      '---',
      '',
    ]);
    expect(parseFrontmatter(text)).toEqual({
      tags: ['alpha', 'beta gamma', 'delta'],
      sources: ['src/a.ts', { resource: 'src/b.ts' }],
    });
  });

  it('accepts a byte order mark before the opening fence', () => {
    const text = '\uFEFF---\ntype: Guide\n---\n# Body\n';
    expect(parseFrontmatter(text)).toEqual({ type: 'Guide' });
    expect(stripFrontmatter(text)).toBe('# Body\n');
  });

  it('reads an empty block as {} without swallowing text up to a later fence-like line', () => {
    const text = joinLines(['---', '---', '# Body', '', 'some text', '---', 'tail', '']);
    expect(parseFrontmatter(text)).toEqual({});
    expect(stripFrontmatter(text)).toBe('# Body\n\nsome text\n---\ntail\n');
  });

  it('throws on a line that is not a top-level key, and names the line', () => {
    expect(() => parseFrontmatter('---\ntype: Guide\n- orphan\n---\n')).toThrow(/line 2 is not a top-level key: - orphan/);
    expect(() => parseFrontmatter('---\nbad key: x\n---\n')).toThrow(/line 1 is not a top-level key: bad key: x/);
  });
});

describe('stripFrontmatter', () => {
  it('returns the body after the block', () => {
    expect(stripFrontmatter('---\ntype: Guide\n---\n# Body\n')).toBe('# Body\n');
    expect(stripFrontmatter('---\r\na: b\r\n---\r\nBody\r\n')).toBe('Body\r\n');
  });

  it('returns the whole text when there is no frontmatter', () => {
    const text = '# Title\n\nSome text\n---\nmore\n';
    expect(stripFrontmatter(text)).toBe(text);
  });

  it('keeps the text after an empty block', () => {
    expect(stripFrontmatter('---\n---\nafter\n')).toBe('after\n');
  });
});

describe('headingText and githubSlug', () => {
  it('keeps the text of a link in a heading', () => {
    expect(headingText('See [the guide](docs/guide.md#top) now')).toBe('See the guide now');
    expect(githubSlug('See [the guide](docs/guide.md#top) now')).toBe('see-the-guide-now');
  });

  it('keeps the alt text of an image and drops the image syntax', () => {
    expect(headingText('![logo](img/logo.png) Title')).toBe('logo Title');
  });

  it('drops an HTML tag', () => {
    expect(headingText('Press <kbd>Enter</kbd> twice')).toBe('Press Enter twice');
    expect(githubSlug('Press <kbd>Enter</kbd> twice')).toBe('press-enter-twice');
  });

  it('drops * emphasis', () => {
    expect(headingText('**Bold** and *italic* text')).toBe('Bold and italic text');
  });

  it('drops _ emphasis at a word edge but keeps the underscores of a snake_case word', () => {
    expect(headingText('_italic_ and __bold__ words')).toBe('italic and bold words');
    expect(headingText('Use snake_case_name here')).toBe('Use snake_case_name here');
    expect(headingText('_emph_ with snake_case')).toBe('emph with snake_case');
    expect(githubSlug('snake_case_name')).toBe('snake_case_name');
    expect(githubSlug('_emphasis_ word')).toBe('emphasis-word');
  });

  it('keeps inline code as written, including characters that would be markup elsewhere', () => {
    expect(headingText('The `<id>` and `*.ts` fields')).toBe('The <id> and *.ts fields');
    expect(githubSlug('Glob `*.ts` files')).toBe('glob-ts-files');
  });

  it('keeps unicode letters, digits and combining marks', () => {
    expect(githubSlug('\u00DCber Caf\u00E9 \u65E5\u672C\u8A9E \u03A9mega 2')).toBe('\u00FCber-caf\u00E9-\u65E5\u672C\u8A9E-\u03C9mega-2');
    expect(githubSlug('Cafe\u0301')).toBe('cafe\u0301');
  });

  it('turns each space into its own hyphen, so removed punctuation leaves consecutive hyphens', () => {
    expect(githubSlug('a  b')).toBe('a--b');
    expect(githubSlug('Q & A')).toBe('q--a');
  });

  it('keeps hyphens and gives a punctuation-only heading an empty slug', () => {
    expect(githubSlug('Well-known')).toBe('well-known');
    expect(githubSlug('?!')).toBe('');
    expect(githubSlug('(...)')).toBe('');
  });
});

describe('headingsOf', () => {
  it('strips a closing run of # that follows a space', () => {
    expect(headingSummaries('## A ##\n')).toEqual([{ level: 2, text: 'A', slug: 'a' }]);
    expect(headingSummaries('### Using C# ###\n')).toEqual([{ level: 3, text: 'Using C#', slug: 'using-c' }]);
  });

  it('keeps a # that is part of the heading text (CommonMark needs a space before a closing run)', () => {
    expect(headingSummaries('## Using C#\n')).toEqual([{ level: 2, text: 'Using C#', slug: 'using-c' }]);
    expect(headingSummaries('## C#\n')).toEqual([{ level: 2, text: 'C#', slug: 'c' }]);
  });

  it('reads CRLF input, skips the frontmatter block and a fence, and leaves no carriage return in a text', () => {
    const text = joinLines([
      '---',
      '# yaml comment, not a heading',
      'title: Doc',
      '---',
      '# One',
      '```',
      '## hidden',
      '```',
      '## Two ##',
      '',
    ], '\r\n');
    expect(headingSummaries(text)).toEqual([
      { level: 1, text: 'One', slug: 'one' },
      { level: 2, text: 'Two', slug: 'two' },
    ]);
  });

  it('does not read headings inside the frontmatter block', () => {
    const text = '---\n# comment line\ntitle: Doc\n---\n# Real\n';
    expect(headingSummaries(text).map((heading) => heading.text)).toEqual(['Real']);
  });

  it('numbers a heading by its 1-based line in the whole file, frontmatter included, as linksOf does', () => {
    expect(headingsOf('---\ntitle: Doc\n---\n# Real\n\n## Second\n').map((heading: { line: number }) => heading.line)).toEqual([4, 6]);
    expect(headingsOf('---\r\ntitle: Doc\r\n---\r\n# Real\r\n').map((heading: { line: number }) => heading.line)).toEqual([4]);
    expect(headingsOf('# First\n').map((heading: { line: number }) => heading.line)).toEqual([1]);
  });

  it('hides headings inside a ~~~ fence', () => {
    const text = '# A\n~~~\n## Hidden\n~~~\n## B\n';
    expect(headingSummaries(text).map((heading) => heading.text)).toEqual(['A', 'B']);
  });

  it('does not read #NoSpace or a seven-hash line as a heading', () => {
    const text = '#NoSpace\n####### Seven\n# Real\n';
    expect(headingSummaries(text).map((heading) => heading.text)).toEqual(['Real']);
  });
});

describe('linksOf', () => {
  it('reads each link with its exact url, path, fragment and 1-based line', () => {
    const text = joinLines([
      '[intro](intro.md#top) and [self](#local)',
      '```',
      '[fenced](fenced.md)',
      '```',
      'Use `[code](code.md)` here, see ![diagram](img/d.png "A diagram")',
      '[ext](https://example.com/x) [mail](mailto:a@example.com) [web](http://example.com) [titled](a.md "title")',
    ]);
    expect(linkSummaries(text)).toEqual([
      { url: 'intro.md#top', path: 'intro.md', fragment: 'top', line: 1 },
      { url: '#local', path: '', fragment: 'local', line: 1 },
      { url: 'img/d.png', path: 'img/d.png', fragment: null, line: 5 },
      { url: 'a.md', path: 'a.md', fragment: null, line: 6 },
    ]);
  });

  it('skips a link inside a fence, in either fence style', () => {
    expect(linkSummaries('```\n[x](a.md)\n```\n~~~\n[y](b.md)\n~~~\n[z](c.md)\n')).toEqual([
      { url: 'c.md', path: 'c.md', fragment: null, line: 7 },
    ]);
  });

  it('skips a link inside inline code and reads one after the code span on the same line', () => {
    expect(linkSummaries('a `[x](a.md)` b ``[y](b.md)`` c [z](c.md)\n')).toEqual([
      { url: 'c.md', path: 'c.md', fragment: null, line: 1 },
    ]);
  });

  it('skips http, https and mailto links', () => {
    expect(linkSummaries('[a](http://example.com) [b](https://example.com/p#frag) [c](mailto:a@example.com)\n')).toEqual([]);
  });

  it('gives a fragment-only link an empty path', () => {
    expect(linkSummaries('[x](#some-heading)\n')).toEqual([{ url: '#some-heading', path: '', fragment: 'some-heading', line: 1 }]);
  });

  it('reads a link that carries a title after its url', () => {
    expect(linkSummaries('[x](a.md "t")\n')).toEqual([{ url: 'a.md', path: 'a.md', fragment: null, line: 1 }]);
    expect(linkSummaries('[x](a.md#sec "t")\n')).toEqual([{ url: 'a.md#sec', path: 'a.md', fragment: 'sec', line: 1 }]);
  });

  it('reads an image link', () => {
    expect(linkSummaries('![alt](img/pic.png)\n')).toEqual([{ url: 'img/pic.png', path: 'img/pic.png', fragment: null, line: 1 }]);
  });

  it('percent-decodes a fragment', () => {
    expect(linkSummaries('[x](a.md#Using%20C%23)\n')).toEqual([{ url: 'a.md#Using%20C%23', path: 'a.md', fragment: 'Using C#', line: 1 }]);
  });

  it('keeps the raw fragment when its percent escape is malformed, instead of throwing', () => {
    expect(() => linksOf('[x](a.md#100%)\n')).not.toThrow();
    expect(linkSummaries('[x](a.md#100%)\n')).toEqual([{ url: 'a.md#100%', path: 'a.md', fragment: '100%', line: 1 }]);
  });

  it('counts lines on CRLF input', () => {
    expect(linkSummaries('one\r\n\r\n[x](a.md)\r\n')).toEqual([{ url: 'a.md', path: 'a.md', fragment: null, line: 3 }]);
  });
});

describe('conceptsForSource', () => {
  const codexConcept: ConceptRecord = { path: 'docs/codex.md', frontmatter: { sources: [{ resource: 'src/main/agent/adapters/codex/' }] } };

  it('accepts a backslash path and a leading ./', () => {
    const concepts: ConceptRecord[] = [
      codexConcept,
      { path: 'docs/foo.md', frontmatter: { sources: [{ resource: 'src/main/foo.ts' }] } },
    ];
    expect(conceptPaths('src\\main\\agent\\adapters\\codex\\command-builder.ts', concepts)).toEqual(['docs/codex.md']);
    expect(conceptPaths('./src/main/foo.ts', concepts)).toEqual(['docs/foo.md']);
    expect(conceptPaths('.\\src\\main\\foo.ts', concepts)).toEqual(['docs/foo.md']);
  });

  it('reads a sources entry that is a bare string', () => {
    const concepts: ConceptRecord[] = [{ path: 'docs/bare.md', frontmatter: { sources: ['src/main/foo.ts', 'src/shared/'] } }];
    expect(conceptPaths('src/main/foo.ts', concepts)).toEqual(['docs/bare.md']);
    expect(conceptPaths('src/shared/types.ts', concepts)).toEqual(['docs/bare.md']);
  });

  it('does not let a file source match a sibling that shares its prefix', () => {
    const concepts: ConceptRecord[] = [{ path: 'docs/foo.md', frontmatter: { sources: [{ resource: 'src/main/foo.ts' }] } }];
    expect(conceptPaths('src/main/foo.tsx', concepts)).toEqual([]);
    expect(conceptPaths('src/main/foo.ts', concepts)).toEqual(['docs/foo.md']);
  });

  it('matches files under a directory source written without a trailing slash, but not a sibling directory', () => {
    const concepts: ConceptRecord[] = [{ path: 'docs/agent.md', frontmatter: { sources: [{ resource: 'src/main/agent' }] } }];
    expect(conceptPaths('src/main/agent/x.ts', concepts)).toEqual(['docs/agent.md']);
    expect(conceptPaths('src/main/agent/adapters/claude/y.ts', concepts)).toEqual(['docs/agent.md']);
    expect(conceptPaths('src/main/agent-extra/x.ts', concepts)).toEqual([]);
  });

  it('matches nothing for an empty resource, a missing resource or an empty string', () => {
    const concepts: ConceptRecord[] = [
      { path: 'docs/empty.md', frontmatter: { sources: [{ resource: '' }, { title: 'No resource' }, ''] } },
    ];
    // A leading-slash target and an empty target would match an empty source if it were not skipped.
    expect(conceptPaths('/outside/file.ts', concepts)).toEqual([]);
    expect(conceptPaths('', concepts)).toEqual([]);
    expect(conceptPaths('src/main/foo.ts', concepts)).toEqual([]);
  });

  it('lists a concept once when two of its sources match', () => {
    const concepts: ConceptRecord[] = [
      { path: 'docs/twice.md', frontmatter: { sources: ['src/main/', { resource: 'src/main/foo.ts' }] } },
    ];
    expect(conceptPaths('src/main/foo.ts', concepts)).toEqual(['docs/twice.md']);
  });
});

describe('coveredPartsOf', () => {
  it('names the symbols a titled entry covers in a shared file', () => {
    const concept: ConceptRecord = { path: 'docs/config.md', frontmatter: { sources: [{ resource: 'src/shared/types.ts', title: 'AppConfig, DEFAULT_CONFIG' }] } };
    expect(coveredPartsOf('src/shared/types.ts', concept)).toBe('AppConfig, DEFAULT_CONFIG');
    expect(coveredPartsOf('.\\src\\shared\\types.ts', concept)).toBe('AppConfig, DEFAULT_CONFIG');
  });

  it('joins the titles when two titled entries cover the path', () => {
    const concept: ConceptRecord = {
      path: 'docs/two.md',
      frontmatter: { sources: [{ resource: 'src/shared/types.ts', title: 'Swimlane' }, { resource: 'src/shared/', title: 'shared helpers' }] },
    };
    expect(coveredPartsOf('src/shared/types.ts', concept)).toBe('Swimlane; shared helpers');
  });

  it('is null when an untitled entry, a bare string or a blank title covers the path whole', () => {
    const titledAndWhole: ConceptRecord = {
      path: 'docs/whole.md',
      frontmatter: { sources: [{ resource: 'src/shared/types.ts', title: 'Swimlane' }, { resource: 'src/shared/' }] },
    };
    expect(coveredPartsOf('src/shared/types.ts', titledAndWhole)).toBeNull();
    expect(coveredPartsOf('src/shared/types.ts', { path: 'docs/bare.md', frontmatter: { sources: ['src/shared/types.ts'] } })).toBeNull();
    expect(coveredPartsOf('src/shared/types.ts', { path: 'docs/blank.md', frontmatter: { sources: [{ resource: 'src/shared/types.ts', title: '  ' }] } })).toBeNull();
  });

  it('is null when no entry covers the path, so a title on another file never leaks in', () => {
    const concept: ConceptRecord = { path: 'docs/other.md', frontmatter: { sources: [{ resource: 'src/shared/types.ts', title: 'Swimlane' }] } };
    expect(coveredPartsOf('src/shared/ipc-channels.ts', concept)).toBeNull();
    expect(coveredPartsOf('src/shared/types.ts', { path: 'docs/none.md', frontmatter: null })).toBeNull();
  });
});

describe('listDocsMarkdown and listConcepts', () => {
  let tempRoot: string;
  let docsRoot: string;

  function writeDoc(relativePath: string, content: string): void {
    const filePath = path.join(docsRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-bundle-test-'));
    docsRoot = path.join(tempRoot, 'docs');
    // Written out of order on purpose, and with names that tell the sort from the directory walk:
    // `sub-x.md` sorts before `sub/` because '-' is below '/', and the walk visits `zeta.md`
    // before the contents of `sub/`.
    writeDoc('zeta.md', '---\ntitle: Zeta\ntags: [a, "b, c"]\n---\n# Zeta\n');
    writeDoc('alpha.md', '# Alpha has no frontmatter\n');
    writeDoc('sub-x.md', '---\ntype: Reference\ntitle: Sub X\n---\n# Sub X\n');
    writeDoc('notes.txt', 'not markdown\n');
    writeDoc('page.mdx', '# not a .md file\n');
    writeDoc('index.md', '---\nokf_version: "0.2"\n---\n# Docs\n');
    writeDoc('log.md', '# Log\n');
    writeDoc('sub/index.md', '---\nokf_version: "0.2"\n---\n# Sub\n');
    // Reserved files are never parsed: this frontmatter would throw if listConcepts read it.
    writeDoc('sub/log.md', '---\nnot a key\n---\n# Sub log\n');
    writeDoc('sub/notes.txt', 'not markdown\n');
    writeDoc('sub/deep/concept.md', '---\ntype: Guide\ntitle: Deep\nsources:\n  - resource: src/x.ts\n    title: X\n---\n# Deep\n');
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lists only .md files, recursively, as sorted forward-slash paths relative to the repo root', () => {
    expect(listDocsMarkdown(docsRoot)).toEqual([
      'docs/alpha.md',
      'docs/index.md',
      'docs/log.md',
      'docs/sub-x.md',
      'docs/sub/deep/concept.md',
      'docs/sub/index.md',
      'docs/sub/log.md',
      'docs/zeta.md',
    ]);
  });

  it('lists every concept but index.md and log.md at any depth, with each one\'s parsed frontmatter', () => {
    expect(listConcepts(docsRoot)).toEqual([
      { path: 'docs/alpha.md', frontmatter: null },
      { path: 'docs/sub-x.md', frontmatter: { type: 'Reference', title: 'Sub X' } },
      {
        path: 'docs/sub/deep/concept.md',
        frontmatter: { type: 'Guide', title: 'Deep', sources: [{ resource: 'src/x.ts', title: 'X' }] },
      },
      { path: 'docs/zeta.md', frontmatter: { title: 'Zeta', tags: ['a', 'b, c'] } },
    ]);
  });
});

describe('the sources CLI', () => {
  function runCli(argumentsList: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['scripts/docs-bundle.mjs', ...argumentsList], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function outputLines(stdout: string): string[] {
    return stdout.split(/\r?\n/).filter((line) => line.length > 0);
  }

  it('names the concept that lists a source file', () => {
    const result = runCli(['sources', CLAUDE_ADAPTER_PATH]);
    expect(result.status).toBe(0);
    const lines = outputLines(result.stdout);
    expect(lines).toHaveLength(1);
    const prefix = `${CLAUDE_ADAPTER_PATH}: `;
    expect(lines[0].startsWith(prefix)).toBe(true);
    expect(lines[0].slice(prefix.length).split(', ')).toContain('docs/integrations/agents/claude-code.md');
  });

  it('prints one line per path, and says so when no concept lists a path', () => {
    const result = runCli(['sources', 'no/such/dir/file.ts', CLAUDE_ADAPTER_PATH]);
    expect(result.status).toBe(0);
    const lines = outputLines(result.stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('no/such/dir/file.ts: (no concept lists it)');
    expect(lines[1].startsWith(`${CLAUDE_ADAPTER_PATH}: `)).toBe(true);
  });

  it('puts the covered parts in brackets after a concept that lists a shared file for some of its symbols', () => {
    const result = runCli(['sources', 'src/shared/types.ts']);
    expect(result.status).toBe(0);
    expect(outputLines(result.stdout)[0]).toContain('docs/settings/app-config.md [AppConfig, DEFAULT_CONFIG]');
  });

  it('exits 2 and prints the usage line on stderr when given no paths, no mode or another mode', () => {
    for (const argumentsList of [['sources'], [], ['list', CLAUDE_ADAPTER_PATH]]) {
      const result = runCli(argumentsList);
      expect(result.status, `arguments: ${argumentsList.join(' ')}`).toBe(2);
      expect(result.stderr).toContain(USAGE_LINE);
      expect(result.stdout).toBe('');
    }
  });
});
