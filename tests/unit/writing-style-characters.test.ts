import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces the mechanizable half of .claude/rules/writing-style.md. Em-dashes (U+2014) also
// render as garbled characters on Windows console code pages, which the team dogfoods on.
//
// Scanned trees are named one by one, never a parent walked wholesale, so no tree that exists
// only to hold untracked local files is swept in (.claude/settings.local.json sits at .claude/
// root, outside the three .claude/ subtrees named below). Two gitignored scratch paths sit inside
// the named trees anyway and are skipped explicitly, since a developer's checkout carries them
// and CI's never does: docs/superpowers/ and *-probe-report.md, both agent-written process prose
// dense in the characters banned here. Without those skips the suite fails locally over files CI
// cannot see, the exact inversion .claude/rules/cross-platform-parity.md exists to prevent. Add a
// matching skip whenever .gitignore gains a scratch path under a scanned tree.
//
// tests/ stays out: it legitimately records em-dashes inside captured terminal output and replay
// fixtures, and a static scan cannot tell authored punctuation from recorded content. Curly
// quotes are checked in markdown only, because sanitizer code under src/ lists those characters
// in regex classes as data (auto-name.ts, qwen-code/transcript-cleanup.ts). Both trees stay with
// the review half of the rule.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'scripts', 'docs', '.claude/rules', '.claude/skills', '.claude/agents'];
const SCAN_ROOT_FILES = ['README.md', 'CLAUDE.md'];
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.md', '.json', '.html',
]);
// Mirrors the .gitignore entries that drop agent scratch prose inside a scanned tree.
const SKIP_DIRECTORY_NAMES = new Set(['superpowers']);
const SKIP_FILE_SUFFIX = '-probe-report.md';
// Built from code points so this file stays free of the characters it bans.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const CURLY_QUOTES = [0x2018, 0x2019, 0x201c, 0x201d].map((code) => String.fromCharCode(code));
// Emoji blocks wide enough to catch a decorative glyph in a heading, plus the variation selector
// that renders a plain dingbat in colour.
const EMOJI_IN_HEADING = /^#{1,6} .*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

function collectTextFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...collectTextFiles(fullPath));
    } else if (
      TEXT_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(SKIP_FILE_SUFFIX)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectScannedFiles(): string[] {
  const files: string[] = [];
  // A missing tree fails loudly rather than silently scanning nothing. writing-style.md's
  // Enforcement block names this exact list as its guarantee, so dropping one has to be visible.
  for (const scanDir of SCAN_DIRS) {
    const absoluteDir = path.join(REPO_ROOT, scanDir);
    if (!fs.existsSync(absoluteDir)) {
      throw new Error(`Scanned tree '${scanDir}' is missing, so its coverage silently vanished.`);
    }
    files.push(...collectTextFiles(absoluteDir));
  }
  for (const rootFile of SCAN_ROOT_FILES) {
    const absoluteFile = path.join(REPO_ROOT, rootFile);
    if (!fs.existsSync(absoluteFile)) {
      throw new Error(`Scanned file '${rootFile}' is missing, so its coverage silently vanished.`);
    }
    files.push(absoluteFile);
  }
  return files;
}

function relativePosixPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Collects `path:line` for every line the predicate rejects, across the scanned trees. */
function findOffendingLines(
  isOffending: (line: string) => boolean,
  filter: (filePath: string) => boolean = () => true,
): string[] {
  const offenders: string[] = [];
  for (const filePath of collectScannedFiles()) {
    if (!filter(filePath)) continue;
    const contents = fs.readFileSync(filePath, 'utf-8');
    contents.split('\n').forEach((line, index) => {
      if (isOffending(line)) {
        offenders.push(`${relativePosixPath(filePath)}:${index + 1}`);
      }
    });
  }
  return offenders;
}

const isMarkdown = (filePath: string): boolean => path.extname(filePath) === '.md';

/** The em-dash/en-dash predicate, pulled out so the fixture describe block below can drive the
 *  exact same check the live-corpus scan uses, rather than a hand-copied duplicate. */
const containsBannedDash = (line: string): boolean =>
  line.includes(EM_DASH) || line.includes(EN_DASH);

describe('writing-style characters in authored text', () => {
  it('contains no em-dash (U+2014) or en-dash (U+2013)', () => {
    const offenders = findOffendingLines(containsBannedDash);
    expect(
      offenders,
      `Em-dashes (U+2014) and en-dashes (U+2013) are forbidden in authored text. Use a single dash '-', a comma, or restructure. See .claude/rules/writing-style.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('contains no curly quotes in markdown', () => {
    const offenders = findOffendingLines(
      (line) => CURLY_QUOTES.some((quote) => line.includes(quote)),
      isMarkdown,
    );
    expect(
      offenders,
      `Curly quotes are forbidden in authored markdown. Use straight quotes. See .claude/rules/writing-style.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('has no decorative emoji in a markdown heading', () => {
    const offenders = findOffendingLines((line) => EMOJI_IN_HEADING.test(line), isMarkdown);
    expect(
      offenders,
      `Decorative emoji are forbidden in headings. See .claude/rules/writing-style.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// The three it() blocks above scan the live repo, which is clean, so every offenders array is
// empty regardless of whether the detectors are even correct. This block pins the detectors
// themselves against synthetic fixtures, so a broken predicate, an emptied CURLY_QUOTES, a
// widened EMOJI_IN_HEADING, or a dropped isMarkdown filter fails here even on a clean repo.
// Every fixture is built from a code point declared locally in this block, independent of the
// EM_DASH / EN_DASH / CURLY_QUOTES constants under test, so a mutated constant leaves the
// fixture holding the real character the (now-broken) detector fails to find.
describe('writing-style character detectors (fixtures, not the live corpus)', () => {
  it('pins EM_DASH and EN_DASH to their code points, flags each in a synthetic line, and leaves a clean line unflagged', () => {
    expect(EM_DASH.codePointAt(0)).toBe(0x2014);
    expect(EN_DASH.codePointAt(0)).toBe(0x2013);

    const independentEmDashCharacter = String.fromCharCode(0x2014);
    const independentEnDashCharacter = String.fromCharCode(0x2013);
    const emDashLine = `left${independentEmDashCharacter}right`;
    const enDashLine = `left${independentEnDashCharacter}right`;
    const cleanLine = 'left-right, using a plain hyphen';

    expect(containsBannedDash(emDashLine)).toBe(true);
    expect(containsBannedDash(enDashLine)).toBe(true);
    expect(containsBannedDash(cleanLine)).toBe(false);
  });

  it('pins every CURLY_QUOTES code point, flags each in a synthetic line, and leaves straight quotes unflagged', () => {
    expect(CURLY_QUOTES.map((quote) => quote.codePointAt(0))).toEqual([0x2018, 0x2019, 0x201c, 0x201d]);

    const independentCurlyQuoteCodePoints = [0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of independentCurlyQuoteCodePoints) {
      const independentQuoteCharacter = String.fromCharCode(codePoint);
      const offendingLine = `said ${independentQuoteCharacter}hello${independentQuoteCharacter}`;
      const isOffending = CURLY_QUOTES.some((quote) => offendingLine.includes(quote));
      expect(isOffending, `curly quote U+${codePoint.toString(16)} was not detected`).toBe(true);
    }

    const straightQuoteLine = 'plain "straight" quotes only';
    expect(CURLY_QUOTES.some((quote) => straightQuoteLine.includes(quote))).toBe(false);
  });

  it('matches EMOJI_IN_HEADING on a decorative emoji, including the FE0F variation-selector branch, and rejects near misses', () => {
    const roundPushpinEmoji = String.fromCodePoint(0x1f4cd);
    const headingWithEmoji = `## Release notes ${roundPushpinEmoji}`;
    const headingWithoutEmoji = '## Release notes';
    const bodyLineWithEmoji = `See the ${roundPushpinEmoji} above.`;
    const headingWithAsciiDash = '## Release - notes, not decorative';

    // A keycap-digit sequence (digit '1' + U+FE0F + U+20E3, the shape behind the "1" keycap
    // glyph) matches ONLY through the \u{FE0F} class member: the digit and the combining
    // enclosing keycap that follow it sit outside all three numeric ranges. Dropping the
    // variation selector from the same sequence must stop the match, which is what proves this
    // pins the FE0F branch rather than one of the range branches.
    const digitOne = String.fromCodePoint(0x31);
    const variationSelector16 = String.fromCodePoint(0xfe0f);
    const combiningEnclosingKeycap = String.fromCodePoint(0x20e3);
    const headingWithVariationSelectorOnly = `## Step ${digitOne}${variationSelector16}${combiningEnclosingKeycap}`;
    const headingWithoutVariationSelector = `## Step ${digitOne}${combiningEnclosingKeycap}`;

    expect(EMOJI_IN_HEADING.test(headingWithEmoji)).toBe(true);
    expect(EMOJI_IN_HEADING.test(headingWithVariationSelectorOnly)).toBe(true);
    expect(EMOJI_IN_HEADING.test(headingWithoutEmoji)).toBe(false);
    expect(EMOJI_IN_HEADING.test(bodyLineWithEmoji)).toBe(false);
    expect(EMOJI_IN_HEADING.test(headingWithAsciiDash)).toBe(false);
    expect(EMOJI_IN_HEADING.test(headingWithoutVariationSelector)).toBe(false);
  });

  it('scopes isMarkdown to .md paths, so the src/ curly-quote exemption is intentional rather than borrowed from one file', () => {
    expect(isMarkdown('docs/example.md')).toBe(true);
    expect(isMarkdown('README.md')).toBe(true);
    expect(isMarkdown('CLAUDE.md')).toBe(true);
    expect(isMarkdown('src/main/agent/shared/auto-name.ts')).toBe(false);
  });
});
