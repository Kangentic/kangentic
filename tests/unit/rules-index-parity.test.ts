import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_CODE_ONLY_RULES } from '../../scripts/cursor-rules.js';

// Keeps the rules index in sync with the actual rule files. AGENTS.md is the always-loaded index
// of .claude/rules/ for every agent, and CLAUDE.md (which imports it) indexes the rules that bind
// only Claude Code. A rule that is listed in neither is easy to miss. This test fails if a rule
// file exists without a pointer in one of the two, forcing the index to stay complete as rules are
// added. Rules are discovered recursively so future subdirectories under .claude/rules/ are covered.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');
const AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');
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
  it('every .claude/rules/*.md is referenced in the AGENTS.md or CLAUDE.md index', () => {
    const indexText = `${fs.readFileSync(AGENTS_MD, 'utf-8')}\n${fs.readFileSync(CLAUDE_MD, 'utf-8')}`;
    const ruleFiles = collectRuleBasenames(RULES_DIR);
    expect(ruleFiles.length).toBeGreaterThan(0);
    const missing = ruleFiles.filter((name) => !indexText.includes(name));
    expect(
      missing,
      `Rule files missing a pointer in the AGENTS.md Conventions index:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

// AGENTS.md and CLAUDE.md load into every Claude Code session, and into every subagent's fixed
// floor, so their size is a recurring tax rather than a one-time cost. Claude Code warns above
// 40,000 characters for one file, and CLAUDE.md crossed it at 45,805: two Key Patterns bullets
// (Command Terminal and activity marks) had grown into 17,276 characters of subsystem prose between
// them, which is what `.claude/rules/` and `docs/` are for. Nothing stopped that growth, and nothing
// would stop it recurring, so this pins the budget at the harness's own limit. The content now
// lives in AGENTS.md, which CLAUDE.md imports. An import loads with the file that imports it, so
// the two are budgeted together rather than one at a time.

const INSTRUCTIONS_CHARACTER_BUDGET = 40_000;

describe('AGENTS.md and CLAUDE.md size budget', () => {
  it(`stay under ${INSTRUCTIONS_CHARACTER_BUDGET} characters together`, () => {
    const agentsMdCount = fs.readFileSync(AGENTS_MD, 'utf-8').length;
    const claudeMdCount = fs.readFileSync(CLAUDE_MD, 'utf-8').length;
    const characterCount = agentsMdCount + claudeMdCount;
    expect(
      characterCount,
      `AGENTS.md (${agentsMdCount}) and CLAUDE.md (${claudeMdCount}) are ${characterCount} characters `
      + `together, over the ${INSTRUCTIONS_CHARACTER_BUDGET} limit Claude Code warns at. Both load into `
      + 'every session and every subagent floor, so move the newest weight out rather than raising '
      + 'this number: prescriptive content belongs in a path-scoped `.claude/rules/*.md` (which loads '
      + 'only with its subsystem), and background, measurements, and rejected alternatives belong in '
      + '`docs/`. Leave a pointer line behind.',
    ).toBeLessThan(INSTRUCTIONS_CHARACTER_BUDGET);
  });
});

// A rule file with no `paths:` frontmatter loads into every session; a rule file with `paths:`
// frontmatter loads only when a matching file enters context. AGENTS.md's "Authoring a rule"
// section says always-on rules are reserved for a small, deliberate set (currently four) and
// sorts every rule into either the "Always-on rules" list or the "Path-scoped rules" list, so a
// reader can tell which regime a rule lives under without opening the file. CLAUDE.md holds a third
// list, "Always-on rules (Claude Code only)", for an always-on rule that binds only Claude Code.
// Nothing checked that a rule's frontmatter agreed with the list it sat under:
// `dependency-block-parity.md` shipped with no `paths:` frontmatter (so it loaded every session)
// while the index filed it under "Path-scoped rules" (so the index said it did not). This closes
// that gap: it fails when a rule's frontmatter and its index section disagree, in either direction.

const ALWAYS_ON_HEADING = '**Always-on rules:**';
const PATH_SCOPED_HEADING = '**Path-scoped rules (load with their subsystem):**';
const CLAUDE_ONLY_ALWAYS_ON_HEADING = '**Always-on rules (Claude Code only):**';

/**
 * Slices the text between `headingText` and the next standalone bold heading line
 * (`\n**...**`), or to the end of the document if there is none.
 */
function extractSection(documentText: string, headingText: string, documentName: string): string {
  const headingIndex = documentText.indexOf(headingText);
  if (headingIndex === -1) {
    throw new Error(`${documentName}: could not find the heading "${headingText}"`);
  }
  const textAfterHeading = documentText.slice(headingIndex + headingText.length);
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

describe('rules index parity: always-on rules and path-scoped rules agree with the index', () => {
  const agentsMd = fs.readFileSync(AGENTS_MD, 'utf-8');
  const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf-8');
  const sharedAlwaysOnBasenames = extractListedRuleBasenames(
    extractSection(agentsMd, ALWAYS_ON_HEADING, 'AGENTS.md'),
  );
  const claudeOnlyAlwaysOnBasenames = extractListedRuleBasenames(
    extractSection(claudeMd, CLAUDE_ONLY_ALWAYS_ON_HEADING, 'CLAUDE.md'),
  );
  const alwaysOnBasenames = [...sharedAlwaysOnBasenames, ...claudeOnlyAlwaysOnBasenames];
  const pathScopedBasenames = extractListedRuleBasenames(
    extractSection(agentsMd, PATH_SCOPED_HEADING, 'AGENTS.md'),
  );

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

  it('reads a non-empty list under each of the three headings', () => {
    // Each list comes from a regex parse of a heading, which a reformat of that section could
    // move or reword. Checking length alone only catches a parse that returns nothing; it would
    // not catch one that latches onto the wrong section and returns some other non-empty list.
    // Pinning a known member of each list catches that case too, and ties the guard to the defect
    // that motivated this file: dependency-block-parity.md is the rule whose misfiled entry went
    // uncaught.
    expect(sharedAlwaysOnBasenames.length).toBeGreaterThan(0);
    expect(sharedAlwaysOnBasenames).toContain('writing-style.md');
    expect(claudeOnlyAlwaysOnBasenames).toContain('bash-single-command.md');
    expect(pathScopedBasenames.length).toBeGreaterThan(0);
    expect(pathScopedBasenames).toContain('dependency-block-parity.md');
  });

  it('lists exactly the rules scripts/cursor-rules.js leaves out of Cursor as Claude Code only', () => {
    // A rule under CLAUDE.md's Claude Code only heading gets no Cursor copy, and a rule the
    // generator skips is invisible to Cursor. If the two lists drift, Cursor either loses a rule
    // that binds it or gets one about Claude Code's own tools.
    expect([...claudeOnlyAlwaysOnBasenames].sort()).toEqual([...CLAUDE_CODE_ONLY_RULES].sort());
  });

  it('detects paths: frontmatter the way this test needs to, on known files', () => {
    // Drives hasNonEmptyPathsFrontmatter over a committed rule with frontmatter and a
    // committed rule without one, so a regex that stops matching (and starts returning false
    // for everything) is caught here rather than making the "Always-on" check above pass
    // vacuously.
    expect(hasNonEmptyPathsFrontmatter(path.join(RULES_DIR, 'hmr-patterns.md'))).toBe(true);
    expect(hasNonEmptyPathsFrontmatter(path.join(RULES_DIR, 'bash-single-command.md'))).toBe(false);
  });

  it('every rule listed under an Always-on heading carries no paths: frontmatter', () => {
    const offenders = alwaysOnBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && hasNonEmptyPathsFrontmatter(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} carry a paths: frontmatter block but sit under an "Always-on rules" `
      + 'heading. A rule with paths: frontmatter is path-scoped, not always-on: move its entry to '
      + 'AGENTS.md\'s "Path-scoped rules" list, or drop its frontmatter if it genuinely needs to load '
      + 'every session.',
    ).toEqual([]);
  });

  it('every rule listed under Path-scoped rules carries paths: frontmatter with at least one entry', () => {
    const offenders = pathScopedBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && !hasNonEmptyPathsFrontmatter(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} sit under AGENTS.md's "Path-scoped rules" heading but carry no `
      + 'paths: frontmatter, or an empty one. A rule with no paths: frontmatter loads every '
      + 'session, which the "Authoring a rule" section reserves for a small, deliberate '
      + 'always-on set. Add a `---\\npaths:\\n  - "some/glob/**"\\n---` block naming the files '
      + 'this rule should load with, or move its entry to "Always-on rules" if it is '
      + 'genuinely meant to load every session.',
    ).toEqual([]);
  });

  it('every basename listed under any heading names a rule file that exists on disk', () => {
    // The offender filters above skip a basename with no matching file
    // (fullPath !== undefined), so a stale index pointer to a deleted or renamed rule file
    // would silently pass both of them instead of being reported. Catch that direction here.
    const staleAlwaysOnEntries = alwaysOnBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    const stalePathScopedEntries = pathScopedBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    expect(
      staleAlwaysOnEntries,
      `${staleAlwaysOnEntries.join(', ')} are listed under an "Always-on rules" heading `
      + 'but name no file under .claude/rules/. Remove the stale entry or fix the filename.',
    ).toEqual([]);
    expect(
      stalePathScopedEntries,
      `${stalePathScopedEntries.join(', ')} are listed under AGENTS.md's "Path-scoped rules" `
      + 'heading but name no file under .claude/rules/. Remove the stale entry or fix the filename.',
    ).toEqual([]);
  });

  it('every rule file sits under exactly one of the three headings', () => {
    const allBasenames = [...ruleFilePathByBasename.keys()];
    const listings = [sharedAlwaysOnBasenames, claudeOnlyAlwaysOnBasenames, pathScopedBasenames];
    const listingCount = (basename: string): number =>
      listings.filter((listing) => listing.includes(basename)).length;
    const listedUnderNone = allBasenames.filter((basename) => listingCount(basename) === 0);
    const listedMoreThanOnce = allBasenames.filter((basename) => listingCount(basename) > 1);
    expect(
      listedUnderNone,
      `${listedUnderNone.join(', ')} are missing from AGENTS.md's "Always-on rules" and `
      + '"Path-scoped rules" headings and from CLAUDE.md\'s "Always-on rules (Claude Code only)" '
      + 'heading. Every rule under .claude/rules/ sorts into one of the three today; file the entry '
      + 'under whichever regime the rule\'s frontmatter matches, or extend this test with a '
      + 'documented exception if a rule genuinely belongs to none.',
    ).toEqual([]);
    expect(
      listedMoreThanOnce,
      `${listedMoreThanOnce.join(', ')} are listed under more than one rules heading in AGENTS.md `
      + 'and CLAUDE.md. A rule belongs under exactly one.',
    ).toEqual([]);
  });
});
