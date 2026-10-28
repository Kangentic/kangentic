/**
 * The translated READMEs (README.<locale>.md at the root, docs/contributing/translations.md).
 *
 * The first block holds the live files to SHIPPED_LOCALES: one translation per shipped language and
 * no other, every README's language switcher listing exactly the shipped languages in order with
 * the current one unlinked, a stamp on every translation, and links that resolve. Adding a language
 * to SHIPPED_LOCALES fails here until `npm run i18n:translate-readme -- --locales <code>` has written
 * its README. Freshness is deliberately not checked. A feature commit that edits README.md in passing
 * should not need 14 translations, and a stale translation still helps its reader.
 *
 * The switcher is parsed here on its own terms rather than compared to renderSwitcher's output, so a
 * bug in the renderer cannot pass both sides.
 *
 * The second block drives the checks translate-readme.mjs runs before it writes a translation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LOCALE_NATIVE_NAMES, SHIPPED_LOCALES, SOURCE_LOCALE } from '../../src/shared/i18n/locales';
import { loadGlossary } from '../../scripts/i18n/glossary.mjs';
import {
  composeTranslation,
  documentTerms,
  ENGLISH_NOTICE,
  gitBlobHash,
  README_KEEP,
  readmeProblems,
  readStamp,
  renderSwitcher,
  replaceSwitcher,
  restamp,
  translatableSource,
} from '../../scripts/i18n/readme.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SWITCHER_START = '<!-- language-switcher -->';
const SWITCHER_END = '<!-- /language-switcher -->';
const TRANSLATION_FILE = /^README\.(.+)\.md$/;
const STAMP_LINE = /^<!-- readme-translation source-blob=([0-9a-f]{40}) -->$/;

interface SwitcherEntry {
  label: string;
  href: string | null;
}

function readRepoFile(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, name), 'utf-8').replace(/\r\n/g, '\n');
}

function expectedHref(locale: string): string {
  return locale === SOURCE_LOCALE ? 'README.md' : `README.${locale}.md`;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The entries of a file's one switcher block, or a reason it has none. */
function parseSwitcher(markdown: string): SwitcherEntry[] | string {
  if (countOccurrences(markdown, SWITCHER_START) !== 1 || countOccurrences(markdown, SWITCHER_END) !== 1) {
    return `needs exactly one ${SWITCHER_START} ... ${SWITCHER_END} block`;
  }
  const inner = markdown.slice(markdown.indexOf(SWITCHER_START) + SWITCHER_START.length, markdown.indexOf(SWITCHER_END)).trim();
  const paragraph = /^<p align="center">\n([\s\S]*)\n<\/p>$/.exec(inner);
  if (!paragraph) return 'the switcher must be one <p align="center"> paragraph';
  return paragraph[1].split('|').map((part) => {
    const entry = part.trim();
    const link = /^<a href="([^"]+)">([^<]+)<\/a>$/.exec(entry);
    return link ? { label: link[2], href: link[1] } : { label: entry, href: null };
  });
}

function expectedSwitcher(currentLocale: string): SwitcherEntry[] {
  return SHIPPED_LOCALES.map((locale) => ({
    label: LOCALE_NATIVE_NAMES[locale],
    href: locale === currentLocale ? null : expectedHref(locale),
  }));
}

/** Every link target in a README: Markdown targets and href/src attributes. */
function linkTargets(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  const markdownTargets = [...withoutCode.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  const attributeTargets = [...withoutCode.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  return [...markdownTargets, ...attributeTargets];
}

const translationFiles = fs.readdirSync(REPO_ROOT).filter((name) => TRANSLATION_FILE.test(name)).sort();
const translatedLocales = SHIPPED_LOCALES.filter((locale) => locale !== SOURCE_LOCALE);
const readmeFiles: Array<{ file: string; locale: string }> = [
  { file: 'README.md', locale: SOURCE_LOCALE },
  ...translatedLocales.map((locale) => ({ file: expectedHref(locale), locale })),
].filter(({ file }) => fs.existsSync(path.join(REPO_ROOT, file)));

describe('translated READMEs', () => {
  it('has one README.<locale>.md for every shipped language but English, and no other', () => {
    const fileLocales = translationFiles.map((name) => TRANSLATION_FILE.exec(name)![1]).sort();
    expect(
      fileLocales,
      'Each shipped language needs README.<locale>.md (npm run i18n:translate-readme -- --locales <code>), and a language that is not shipped has none.',
    ).toEqual([...translatedLocales].sort());
  });

  it('gives every README a switcher listing the shipped languages in order, the current one unlinked', () => {
    expect(readmeFiles.length).toBeGreaterThan(1);
    for (const { file, locale } of readmeFiles) {
      expect(parseSwitcher(readRepoFile(file)), `${file} switcher`).toEqual(expectedSwitcher(locale));
    }
  });

  it('opens every translation with a stamp naming the README.md blob and linking README.md', () => {
    expect(readStamp(readRepoFile('README.md')), 'README.md is the source and carries no stamp').toBeNull();
    for (const file of translationFiles) {
      const lines = readRepoFile(file).split('\n');
      const stamp = STAMP_LINE.exec(lines[0]);
      expect(stamp, `${file} line 1 must be the stamp marker`).not.toBeNull();
      expect(lines[1].startsWith('> '), `${file} line 2 must be the notice, as a quote`).toBe(true);
      expect(lines[1], `${file} notice links README.md`).toContain('[README.md](README.md)');
      expect(lines[1], `${file} notice shows the short hash`).toContain(`\`${stamp![1].slice(0, 7)}\``);
      expect(lines[2], `${file} line 3 is blank`).toBe('');
    }
  });

  it('links only files that exist, and every #fragment to an anchor in the same file', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const { file } of readmeFiles) {
      const markdown = readRepoFile(file);
      for (const target of linkTargets(markdown)) {
        if (/^(https?:|mailto:)/.test(target)) continue;
        checked += 1;
        if (target.startsWith('#')) {
          const anchor = target.slice(1);
          if (!markdown.includes(`<a name="${anchor}"></a>`)) problems.push(`${file}: ${target} has no <a name="${anchor}"></a>`);
          continue;
        }
        const relativePath = target.split('#')[0];
        if (!fs.existsSync(path.join(REPO_ROOT, relativePath))) problems.push(`${file}: ${target} does not exist`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked, 'the scan found no relative links, so it proves nothing').toBeGreaterThan(readmeFiles.length * 5);
  });

  it('is refreshed by /release', () => {
    const releaseSkill = readRepoFile('.claude/skills/release/SKILL.md');
    expect(
      releaseSkill.includes('scripts/i18n/translate-readme.mjs --stale'),
      '.claude/skills/release/SKILL.md must run the stale refresh (docs/contributing/translations.md)',
    ).toBe(true);
  });
});

const SOURCE_FIXTURE = [
  '<p align="center">',
  '  <picture>',
  '    <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png" />',
  '    <img src="https://example.com/logo.png" alt="Example logo" width="96" />',
  '  </picture>',
  '</p>',
  '',
  SWITCHER_START,
  SWITCHER_END,
  '',
  '## Install',
  '',
  '```bash',
  'npx kangentic',
  '```',
  '',
  'Run `npx kangentic`, then set `KANGENTIC_TELEMETRY=0`. See [the guide](https://example.com/guide/) and the [supported agents](#supported-agents).',
  '',
  '<a name="supported-agents"></a>',
  '## Supported agents',
  '',
  '- [Claude Code](https://docs.anthropic.com/claude-code) and [Cursor CLI](https://cursor.com/cli) work in a worktree.',
  '- Email support@example.com.',
].join('\n');

const GERMAN_FIXTURE = [
  '<p align="center">',
  '  <picture>',
  '    <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png" />',
  '    <img src="https://example.com/logo.png" alt="Beispiel-Logo" width="96" />',
  '  </picture>',
  '</p>',
  '',
  SWITCHER_START,
  SWITCHER_END,
  '',
  '## Installation',
  '',
  '```bash',
  'npx kangentic',
  '```',
  '',
  'Setzen Sie `KANGENTIC_TELEMETRY=0`, nachdem Sie `npx kangentic` ausgeführt haben. Siehe [die Anleitung](https://example.com/guide/) und die [unterstützten Agents](#supported-agents).',
  '',
  '<a name="supported-agents"></a>',
  '## Unterstützte Agents',
  '',
  '- [Claude Code](https://docs.anthropic.com/claude-code) und [Cursor CLI](https://cursor.com/cli) arbeiten in einem Worktree.',
  '- E-Mail an support@example.com.',
].join('\n');

const GERMAN_NOTICE = 'Dies ist eine maschinelle Übersetzung von {readme} beim Stand {revision}. Die englische Fassung ist maßgeblich.';

describe('translated README checks', () => {
  const glossary = loadGlossary();
  const problemsFor = (translated: string, notice = GERMAN_NOTICE, source = SOURCE_FIXTURE): string[] => (
    readmeProblems({ source, translated, notice, locale: 'de', glossary })
  );

  it('passes a faithful translation, with its alt text translated and its code spans reordered', () => {
    expect(problemsFor(GERMAN_FIXTURE)).toEqual([]);
  });

  it('flags a changed inline code span', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('`KANGENTIC_TELEMETRY=0`', '`KANGENTIC_TELEMETRIE=0`'));
    expect(problems.some((problem) => problem.includes('inline code span') && problem.includes('KANGENTIC_TELEMETRY=0'))).toBe(true);
  });

  it('flags a dropped fenced block', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('```bash\nnpx kangentic\n```\n', ''));
    expect(problems).toContain('copy every fenced code block exactly as in the English, in the same order');
    expect(problems.some((problem) => problem.startsWith('keep the document line for line'))).toBe(true);
  });

  it('flags an edited URL and an edited srcset', () => {
    expect(problemsFor(GERMAN_FIXTURE.replace('https://example.com/guide/', 'https://example.com/anleitung/'))
      .some((problem) => problem.includes('https://example.com/guide/'))).toBe(true);
    expect(problemsFor(GERMAN_FIXTURE.replace('srcset="https://example.com/dark.png"', 'srcset="https://example.com/dunkel.png"'))
      .some((problem) => problem.includes('HTML tag') && problem.includes('dark.png'))).toBe(true);
  });

  it('flags a dropped heading', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('## Installation', 'Installation'));
    expect(problems).toContain('the English has 2 headings and the translation has 1');
  });

  it('flags a missing kept name', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('[Cursor CLI]', '[Cursor-Befehlszeile]'));
    expect(problems).toContain('keep the name "Cursor CLI" exactly as written');
  });

  it('flags a glossary term translated another way', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('einem Worktree', 'einem Arbeitsbaum'));
    expect(problems).toContain('translate "worktree" as "Worktree"');
  });

  it('flags a lost anchor', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('<a name="supported-agents"></a>', ''));
    expect(problems.some((problem) => problem.includes('"<a name="supported-agents">"'))).toBe(true);
  });

  it('flags an emptied alt text', () => {
    const problems = problemsFor(GERMAN_FIXTURE.replace('alt="Beispiel-Logo"', 'alt=""'));
    expect(problems).toContain('translate every alt text; none may be empty');
  });

  it('flags a notice that drops or repeats a token', () => {
    expect(problemsFor(GERMAN_FIXTURE, 'Maschinelle Übersetzung von {readme}.')).toContain('the notice must hold {revision} exactly once, as written');
    expect(problemsFor(GERMAN_FIXTURE, '{readme} {readme} {revision}')).toContain('the notice must hold {readme} exactly once, as written');
  });

  it('flags a list item rewritten as plain text, naming its line', () => {
    const listLine = GERMAN_FIXTURE.split('\n').findIndex((line) => line.startsWith('- E-Mail')) + 1;
    expect(listLine, 'the fixture still has its Email list item').toBeGreaterThan(0);
    const problems = problemsFor(GERMAN_FIXTURE.replace('- E-Mail an', 'E-Mail an'));
    expect(problems).toContain(`keep each line's Markdown: line ${listLine} should start as a list item, not text`);
  });

  it('flags a code span, an email address and a comment the English does not have', () => {
    const extraCodeSpan = problemsFor(GERMAN_FIXTURE.replace('Siehe [die Anleitung]', 'Siehe `extra` [die Anleitung]'));
    expect(extraCodeSpan).toContain('the English has no inline code span "`extra`"');
    const changedEmail = problemsFor(GERMAN_FIXTURE.replace('support@example.com', 'hilfe@example.com'));
    expect(changedEmail).toContain('copy every URL, link target or email address exactly as in the English; missing "support@example.com"');
    expect(changedEmail).toContain('the English has no URL, link target or email address "hilfe@example.com"');
  });

  describe('with a comment and a version in the document', () => {
    // Local pairs, parallel line for line, so the module-level fixtures stay as the tests above know them.
    const insertBeforeHeading = (fixture: string, heading: string, lines: string[]): string => fixture.replace(heading, `${lines.join('\n')}\n${heading}`);
    const EXTENDED_SOURCE = insertBeforeHeading(SOURCE_FIXTURE, '## Install', [
      'Requires Git 2.26 and Node.js 20. There are two ways to start.',
      '',
      '<!-- install steps -->',
      '',
    ]);
    const EXTENDED_GERMAN = insertBeforeHeading(GERMAN_FIXTURE, '## Installation', [
      'Erfordert Git 2.26 und Node.js 20. Es gibt zwei Möglichkeiten zum Start.',
      '',
      '<!-- install steps -->',
      '',
    ]);
    const extendedProblemsFor = (translated: string, notice = GERMAN_NOTICE): string[] => problemsFor(translated, notice, EXTENDED_SOURCE);

    it('passes the faithful extended translation, so the cases below fail only for the edit they make', () => {
      expect(extendedProblemsFor(EXTENDED_GERMAN)).toEqual([]);
    });

    it('flags a changed HTML comment in both directions', () => {
      const problems = extendedProblemsFor(EXTENDED_GERMAN.replace('<!-- install steps -->', '<!-- Installationsschritte -->'));
      expect(problems).toContain('copy every HTML comment exactly as in the English; missing "<!-- install steps -->"');
      expect(problems).toContain('the English has no HTML comment "<!-- Installationsschritte -->"');
    });

    it('flags a version written differently, naming the English one', () => {
      const problems = extendedProblemsFor(EXTENDED_GERMAN.replace('Git 2.26', 'Git 2.62'));
      expect(problems).toEqual(['keep every number and version as in the English; missing "2.26"']);
    });

    it('lets a translation write a digit where the English spells the number out', () => {
      expect(extendedProblemsFor(EXTENDED_GERMAN.replace('zwei', '2'))).toEqual([]);
    });
  });

  it('flags a notice with a line break or no words', () => {
    const noticeProblem = 'the notice must be one non-empty line';
    expect(problemsFor(GERMAN_FIXTURE, 'Maschinelle Übersetzung von {readme}\nbeim Stand {revision}.')).toEqual([noticeProblem]);
    expect(problemsFor(GERMAN_FIXTURE, '   ')).toContain(noticeProblem);
  });

  it.each([
    { name: 'a Markdown link', notice: 'Siehe [die Anleitung](guide.md): {readme} beim Stand {revision}.' },
    { name: 'a URL', notice: 'Siehe https://example.com/guide: {readme} beim Stand {revision}.' },
    { name: 'an HTML tag', notice: 'Maschinelle <b>Übersetzung</b> von {readme} beim Stand {revision}.' },
    { name: 'an HTML comment', notice: 'Maschinelle Übersetzung <!-- x --> von {readme} beim Stand {revision}.' },
    { name: 'a code span', notice: 'Maschinelle Übersetzung `x` von {readme} beim Stand {revision}.' },
  ])('flags a notice holding $name', ({ notice }) => {
    expect(problemsFor(GERMAN_FIXTURE, notice)).toEqual(['the notice holds only words and the two tokens: no link, URL, HTML or code']);
  });

  it('flags the two switcher markers swapped, which the comment and line checks both pass', () => {
    const swapped = GERMAN_FIXTURE.replace(`${SWITCHER_START}\n${SWITCHER_END}`, `${SWITCHER_END}\n${SWITCHER_START}`);
    expect(swapped).not.toBe(GERMAN_FIXTURE);
    expect(problemsFor(swapped)).toEqual([
      `keep the language switcher block as in the English: the ${SWITCHER_START} line, then the ${SWITCHER_END} line`,
    ]);
  });

  it('passes an alt text that holds a ">"', () => {
    const translated = GERMAN_FIXTURE.replace('alt="Beispiel-Logo"', 'alt="Beispiel > Logo"');
    expect(translated).not.toBe(GERMAN_FIXTURE);
    expect(problemsFor(translated)).toEqual([]);
  });
});

describe('README terms sent with the request', () => {
  const glossary = loadGlossary();

  it('keeps the README names the English uses, once each, and none it does not use', () => {
    const { keep, terms } = documentTerms(SOURCE_FIXTURE, 'de', glossary);
    expect(keep.filter((name) => name === 'Cursor CLI')).toEqual(['Cursor CLI']);
    expect(keep).toContain('Claude Code');
    expect(keep).not.toContain('Kimi Code');
    for (const name of README_KEEP) {
      if (!SOURCE_FIXTURE.includes(name)) expect(keep, `${name} is not in the README`).not.toContain(name);
    }
    expect(terms).toContainEqual({ english: 'worktree', use: 'Worktree' });
  });

  it('lists a name that both the glossary and the README keep once', () => {
    const { keep } = documentTerms(SOURCE_FIXTURE, 'de', { keep: ['Cursor CLI'], terms: [] });
    expect(keep.filter((name) => name === 'Cursor CLI')).toEqual(['Cursor CLI']);
    expect(keep, 'the README-only name beside it is still added').toContain('Cursor');
  });
});

describe('README switcher and stamp', () => {
  it('renders a switcher the parity parser reads back, for every README', () => {
    for (const locale of SHIPPED_LOCALES) {
      const block = renderSwitcher(locale, SHIPPED_LOCALES, LOCALE_NATIVE_NAMES, SOURCE_LOCALE);
      expect(parseSwitcher(block), locale).toEqual(expectedSwitcher(locale));
    }
  });

  it('replaces exactly one switcher block and refuses zero or two', () => {
    const markdown = `top\n${SWITCHER_START}\nold\n${SWITCHER_END}\nbottom`;
    expect(replaceSwitcher(markdown, 'NEW')).toBe('top\nNEW\nbottom');
    expect(() => replaceSwitcher('no switcher', 'NEW')).toThrow();
    expect(() => replaceSwitcher(`${markdown}\n${markdown}`, 'NEW')).toThrow();
    expect(translatableSource(markdown)).toBe(`top\n${SWITCHER_START}\n${SWITCHER_END}\nbottom`);
  });

  it('hashes text the way git hashes a blob', () => {
    // `git hash-object` of a file holding "hello\n".
    expect(gitBlobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('stamps a translation, reads the stamp back, and restamps only the hash', () => {
    const firstBlob = 'a'.repeat(40);
    const secondBlob = 'b'.repeat(40);
    const translation = composeTranslation({ blob: firstBlob, notice: ENGLISH_NOTICE, body: '# Body\n' });
    expect(translation).toBe(
      `<!-- readme-translation source-blob=${firstBlob} -->\n`
      + '> This is a machine translation of [README.md](README.md) at `aaaaaaa`. The English version is the canonical one.\n'
      + '\n# Body\n',
    );
    expect(readStamp(translation)).toBe(firstBlob);
    const restamped = restamp(translation, secondBlob);
    expect(readStamp(restamped)).toBe(secondBlob);
    expect(restamped).toBe(translation.replaceAll('a'.repeat(40), secondBlob).replace('`aaaaaaa`', '`bbbbbbb`'));
  });

  it('refuses a switcher whose end marker comes before its start marker', () => {
    expect(() => replaceSwitcher(`${SWITCHER_END}\nmiddle\n${SWITCHER_START}`, 'NEW')).toThrow(/Expected exactly one/);
    expect(() => translatableSource(`top\n${SWITCHER_END}\nmiddle\n${SWITCHER_START}\nbottom`)).toThrow(/Expected exactly one/);
  });

  it('gives a CRLF README the same translatable text, and so the same blob hash, as its LF form', () => {
    const lfReadme = `top\n${SWITCHER_START}\nold\n${SWITCHER_END}\nbottom\n`;
    const crlfReadme = lfReadme.replace(/\n/g, '\r\n');
    expect(crlfReadme).toContain('\r');
    const fromCrlf = translatableSource(crlfReadme);
    expect(fromCrlf).not.toContain('\r');
    expect(fromCrlf).toBe(translatableSource(lfReadme));
    expect(gitBlobHash(fromCrlf)).toBe(gitBlobHash(translatableSource(lfReadme)));
  });

  describe('restamp refusals', () => {
    const blob = 'a'.repeat(40);
    const newBlob = 'b'.repeat(40);
    const translation = composeTranslation({ blob, notice: ENGLISH_NOTICE, body: '# Body\n' });

    it('throws on a text with no stamp', () => {
      expect(() => restamp('# Body\n', newBlob)).toThrow(/no stamp/);
    });

    it('throws when line 2 no longer shows the old short hash, or is not there', () => {
      expect(() => restamp(translation.replace('`aaaaaaa`', 'a hash'), newBlob)).toThrow(/does not show `aaaaaaa`/);
      expect(() => restamp(`<!-- readme-translation source-blob=${blob} -->`, newBlob)).toThrow(/does not show `aaaaaaa`/);
    });

    it('returns a CRLF text restamped with LF line endings', () => {
      const crlfTranslation = translation.replace(/\n/g, '\r\n');
      expect(crlfTranslation).toContain('\r');
      const restamped = restamp(crlfTranslation, newBlob);
      expect(restamped).not.toContain('\r');
      expect(restamped).toBe(restamp(translation, newBlob));
      expect(readStamp(restamped)).toBe(newBlob);
    });
  });

  describe('reading a stamp', () => {
    const stampFor = (hash: string): string => `<!-- readme-translation source-blob=${hash} -->\n> notice\n`;

    it('reads a lowercase 40-character hash', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      expect(hash).toHaveLength(40);
      expect(readStamp(stampFor(hash))).toBe(hash);
    });

    it('returns null for an uppercase hash, and for a hash that is 39 or 41 characters', () => {
      expect(readStamp(stampFor('A'.repeat(40)))).toBeNull();
      expect(readStamp(stampFor('a'.repeat(39)))).toBeNull();
      expect(readStamp(stampFor('a'.repeat(41)))).toBeNull();
    });
  });
});
