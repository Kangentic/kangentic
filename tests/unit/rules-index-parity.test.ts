import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Keeps the CLAUDE.md "Conventions" index in sync with the actual rule files. CLAUDE.md is the
// always-loaded index of .claude/rules/; a rule that is not listed there is easy to miss. This
// test fails if a rule file exists without a pointer in CLAUDE.md, forcing the index to stay
// complete as rules are added. Rules are discovered recursively so future subdirectories under
// .claude/rules/ are covered.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

interface RuleFile {
  basename: string;
  fullPath: string;
}

function collectRuleFiles(directory: string): RuleFile[] {
  const ruleFiles: RuleFile[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      ruleFiles.push(...collectRuleFiles(entryPath));
    } else if (entry.name.endsWith('.md')) {
      ruleFiles.push({ basename: entry.name, fullPath: entryPath });
    }
  }
  return ruleFiles;
}

function collectRuleBasenames(directory: string): string[] {
  return collectRuleFiles(directory).map((ruleFile) => ruleFile.basename);
}

describe('rules index parity', () => {
  it('every .claude/rules/*.md is referenced in the CLAUDE.md index', () => {
    const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf-8');
    const ruleFiles = collectRuleBasenames(RULES_DIR);
    expect(ruleFiles.length).toBeGreaterThan(0);
    const missing = ruleFiles.filter((name) => !claudeMd.includes(name));
    expect(
      missing,
      `Rule files missing a pointer in the CLAUDE.md Conventions index:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

// A rule file with no `paths:` frontmatter loads into every session; a rule file with `paths:`
// frontmatter loads only when a matching file enters context. CLAUDE.md's "Authoring a rule"
// section says always-on rules are reserved for a small, deliberate set (currently four) and
// sorts every rule into either the "Always-on rules" list or the "Path-scoped rules" list, so a
// reader can tell which regime a rule lives under without opening the file. Nothing checked that
// a rule's frontmatter agreed with the list it sat under: `dependency-block-parity.md` shipped
// with no `paths:` frontmatter (so it loaded every session) while CLAUDE.md filed it under
// "Path-scoped rules" (so the index said it did not). This closes that gap: it fails when a
// rule's frontmatter and its CLAUDE.md section disagree, in either direction.

const ALWAYS_ON_HEADING = '**Always-on rules:**';
const PATH_SCOPED_HEADING = '**Path-scoped rules (load with their subsystem):**';

/**
 * Slices the text between `headingText` and the next standalone bold heading line
 * (`\n**...**`), or to the end of the document if there is none.
 */
function extractSection(claudeMdText: string, headingText: string): string {
  const headingIndex = claudeMdText.indexOf(headingText);
  if (headingIndex === -1) {
    throw new Error(`CLAUDE.md: could not find the heading "${headingText}"`);
  }
  const textAfterHeading = claudeMdText.slice(headingIndex + headingText.length);
  const nextHeadingMatch = textAfterHeading.match(/\n\*\*[^\n*]+\*\*/);
  return nextHeadingMatch === null || nextHeadingMatch.index === undefined
    ? textAfterHeading
    : textAfterHeading.slice(0, nextHeadingMatch.index);
}

/** Reads the rule basenames named by `- \`some-rule.md\` - ...` bullet lines in a section. */
function extractListedRuleBasenames(sectionText: string): string[] {
  const basenames: string[] = [];
  for (const line of sectionText.split('\n')) {
    const bulletMatch = line.match(/^- `([\w.-]+\.md)`/);
    if (bulletMatch !== null) {
      basenames.push(bulletMatch[1]);
    }
  }
  return basenames;
}

/** True when a rule file opens with a `---` frontmatter block naming at least one `paths:` entry. */
function hasNonEmptyPathsFrontmatter(fullPath: string): boolean {
  const source = fs.readFileSync(fullPath, 'utf-8');
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch === null) {
    return false;
  }
  const pathsMatch = frontmatterMatch[1].match(/paths:\s*\n((?:\s*-\s.+\n?)*)/);
  if (pathsMatch === null) {
    return false;
  }
  const pathEntries = pathsMatch[1].split('\n').filter((line) => line.trim().startsWith('-'));
  return pathEntries.length > 0;
}

describe('rules index parity: always-on rules and path-scoped rules agree with CLAUDE.md', () => {
  const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf-8');
  const alwaysOnBasenames = extractListedRuleBasenames(extractSection(claudeMd, ALWAYS_ON_HEADING));
  const pathScopedBasenames = extractListedRuleBasenames(extractSection(claudeMd, PATH_SCOPED_HEADING));

  const ruleFilePathByBasename = new Map<string, string>();
  for (const ruleFile of collectRuleFiles(RULES_DIR)) {
    const existingPath = ruleFilePathByBasename.get(ruleFile.basename);
    if (existingPath !== undefined) {
      throw new Error(
        `Two rule files share the basename "${ruleFile.basename}" (${existingPath} and `
        + `${ruleFile.fullPath}). This test looks up a rule file by basename, so basenames under `
        + '.claude/rules/ must stay unique.',
      );
    }
    ruleFilePathByBasename.set(ruleFile.basename, ruleFile.fullPath);
  }

  it('reads a non-empty Always-on rules list and a non-empty Path-scoped rules list', () => {
    // Both lists come from a regex parse of a CLAUDE.md heading, which a reformat of that
    // section could move or reword. Checking length alone only catches a parse that returns
    // nothing; it would not catch one that latches onto the wrong section and returns some
    // other non-empty list. Pinning a known member of each list catches that case too, and ties
    // the guard to the defect that motivated this file: dependency-block-parity.md is the rule
    // whose misfiled entry went uncaught.
    expect(alwaysOnBasenames.length).toBeGreaterThan(0);
    expect(alwaysOnBasenames).toContain('bash-single-command.md');
    expect(pathScopedBasenames.length).toBeGreaterThan(0);
    expect(pathScopedBasenames).toContain('dependency-block-parity.md');
  });

  it('detects paths: frontmatter the way this test needs to, on known files', () => {
    // Drives hasNonEmptyPathsFrontmatter over a committed rule with frontmatter and a
    // committed rule without one, so a regex that stops matching (and starts returning false
    // for everything) is caught here rather than making the "Always-on" check above pass
    // vacuously.
    expect(hasNonEmptyPathsFrontmatter(path.join(RULES_DIR, 'hmr-patterns.md'))).toBe(true);
    expect(hasNonEmptyPathsFrontmatter(path.join(RULES_DIR, 'bash-single-command.md'))).toBe(false);
  });

  it('every rule listed under Always-on rules carries no paths: frontmatter', () => {
    const offenders = alwaysOnBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && hasNonEmptyPathsFrontmatter(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} carry a paths: frontmatter block but sit under CLAUDE.md's `
      + '"Always-on rules" heading. A rule with paths: frontmatter is path-scoped, not always-on: '
      + 'move its CLAUDE.md entry to the "Path-scoped rules" list, or drop its frontmatter if it '
      + 'genuinely needs to load every session.',
    ).toEqual([]);
  });

  it('every rule listed under Path-scoped rules carries paths: frontmatter with at least one entry', () => {
    const offenders = pathScopedBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && !hasNonEmptyPathsFrontmatter(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} sit under CLAUDE.md's "Path-scoped rules" heading but carry no `
      + 'paths: frontmatter, or an empty one. A rule with no paths: frontmatter loads every '
      + 'session, which the "Authoring a rule" section reserves for a small, deliberate '
      + 'always-on set. Add a `---\\npaths:\\n  - "some/glob/**"\\n---` block naming the files '
      + 'this rule should load with, or move its CLAUDE.md entry to "Always-on rules" if it is '
      + 'genuinely meant to load every session.',
    ).toEqual([]);
  });

  it('every basename listed under either heading names a rule file that exists on disk', () => {
    // The offender filters above skip a basename with no matching file
    // (fullPath !== undefined), so a stale CLAUDE.md pointer to a deleted or renamed rule file
    // would silently pass both of them instead of being reported. Catch that direction here.
    const staleAlwaysOnEntries = alwaysOnBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    const stalePathScopedEntries = pathScopedBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    expect(
      staleAlwaysOnEntries,
      `${staleAlwaysOnEntries.join(', ')} are listed under CLAUDE.md's "Always-on rules" heading `
      + 'but name no file under .claude/rules/. Remove the stale entry or fix the filename.',
    ).toEqual([]);
    expect(
      stalePathScopedEntries,
      `${stalePathScopedEntries.join(', ')} are listed under CLAUDE.md's "Path-scoped rules" `
      + 'heading but name no file under .claude/rules/. Remove the stale entry or fix the filename.',
    ).toEqual([]);
  });

  it('every rule file sits under exactly one of Always-on rules or Path-scoped rules', () => {
    const allBasenames = [...ruleFilePathByBasename.keys()];
    const listedUnderNeither = allBasenames.filter(
      (basename) => !alwaysOnBasenames.includes(basename) && !pathScopedBasenames.includes(basename),
    );
    const listedUnderBoth = allBasenames.filter(
      (basename) => alwaysOnBasenames.includes(basename) && pathScopedBasenames.includes(basename),
    );
    expect(
      listedUnderNeither,
      `${listedUnderNeither.join(', ')} are missing from both the "Always-on rules" heading and `
      + 'the "Path-scoped rules" heading in CLAUDE.md. Every rule under .claude/rules/ sorts into '
      + 'one of the two today; file the entry under whichever regime the rule\'s frontmatter '
      + 'matches, or extend this test with a documented exception if a rule genuinely belongs to '
      + 'neither.',
    ).toEqual([]);
    expect(
      listedUnderBoth,
      `${listedUnderBoth.join(', ')} are listed under both the "Always-on rules" heading and the `
      + '"Path-scoped rules" heading in CLAUDE.md. A rule belongs under exactly one.',
    ).toEqual([]);
  });
});
