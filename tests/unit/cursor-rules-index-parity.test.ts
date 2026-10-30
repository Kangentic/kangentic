import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Keeps the AGENTS.md "Conventions" index in sync with the actual Cursor rule files. AGENTS.md
// is the always-loaded index of .cursor/rules/; a rule that is not listed there is easy to miss.
// This test fails if a rule file exists without a pointer in AGENTS.md, forcing the index to stay
// complete as rules are added. Rules are discovered recursively so future subdirectories under
// .cursor/rules/ are covered.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.cursor', 'rules');
const AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');

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
    } else if (entry.name.endsWith('.mdc')) {
      ruleFiles.push({ basename: entry.name, fullPath: entryPath });
    }
  }
  return ruleFiles;
}

function collectRuleBasenames(directory: string): string[] {
  return collectRuleFiles(directory).map((ruleFile) => ruleFile.basename);
}

describe('cursor rules index parity', () => {
  it('every .cursor/rules/*.mdc is referenced in the AGENTS.md index', () => {
    const agentsMd = fs.readFileSync(AGENTS_MD, 'utf-8');
    const ruleFiles = collectRuleBasenames(RULES_DIR);
    expect(ruleFiles.length).toBeGreaterThan(0);
    const missing = ruleFiles.filter((name) => !agentsMd.includes(name));
    expect(
      missing,
      `Rule files missing a pointer in the AGENTS.md Conventions index:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

const AGENTS_MD_CHARACTER_BUDGET = 40_000;

describe('AGENTS.md size budget', () => {
  it(`stays under ${AGENTS_MD_CHARACTER_BUDGET} characters`, () => {
    const characterCount = fs.readFileSync(AGENTS_MD, 'utf-8').length;
    expect(
      characterCount,
      `AGENTS.md is ${characterCount} characters, over the ${AGENTS_MD_CHARACTER_BUDGET} limit. `
      + 'It loads into every session, so move the newest weight out rather than raising this '
      + 'number: prescriptive content belongs in a glob-scoped `.cursor/rules/*.mdc` (which loads '
      + 'only with its subsystem), and background, measurements, and rejected alternatives belong '
      + 'in `docs/`. Leave a pointer line behind.',
    ).toBeLessThan(AGENTS_MD_CHARACTER_BUDGET);
  });
});

const ALWAYS_ON_HEADING = '**Always-on rules:**';
const PATH_SCOPED_HEADING = '**Path-scoped rules (load with their subsystem):**';

function extractSection(agentsMdText: string, headingText: string): string {
  const headingIndex = agentsMdText.indexOf(headingText);
  if (headingIndex === -1) {
    throw new Error(`AGENTS.md: could not find the heading "${headingText}"`);
  }
  const textAfterHeading = agentsMdText.slice(headingIndex + headingText.length);
  const nextHeadingMatch = textAfterHeading.match(/\n\*\*[^\n*]+\*\*/);
  return nextHeadingMatch === null || nextHeadingMatch.index === undefined
    ? textAfterHeading
    : textAfterHeading.slice(0, nextHeadingMatch.index);
}

function extractListedRuleBasenames(sectionText: string): string[] {
  const basenames: string[] = [];
  for (const line of sectionText.split('\n')) {
    const bulletMatch = line.match(/^- `([\w.-]+\.mdc)`/);
    if (bulletMatch !== null) {
      basenames.push(bulletMatch[1]);
    }
  }
  return basenames;
}

function readFrontmatter(fullPath: string): string | null {
  const source = fs.readFileSync(fullPath, 'utf-8');
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return frontmatterMatch === null ? null : frontmatterMatch[1];
}

function hasGlobsFrontmatter(fullPath: string): boolean {
  const frontmatter = readFrontmatter(fullPath);
  if (frontmatter === null) return false;
  const globsMatch = frontmatter.match(/^globs:\s*\S/m);
  return globsMatch !== null;
}

function hasAlwaysApplyTrue(fullPath: string): boolean {
  const frontmatter = readFrontmatter(fullPath);
  if (frontmatter === null) return false;
  return /^alwaysApply:\s*true\s*$/m.test(frontmatter);
}

describe('cursor rules index parity: always-on rules and path-scoped rules agree with AGENTS.md', () => {
  const agentsMd = fs.readFileSync(AGENTS_MD, 'utf-8');
  const alwaysOnBasenames = extractListedRuleBasenames(extractSection(agentsMd, ALWAYS_ON_HEADING));
  const pathScopedBasenames = extractListedRuleBasenames(extractSection(agentsMd, PATH_SCOPED_HEADING));

  const ruleFilePathByBasename = new Map<string, string>();
  for (const ruleFile of collectRuleFiles(RULES_DIR)) {
    const existingPath = ruleFilePathByBasename.get(ruleFile.basename);
    if (existingPath !== undefined) {
      throw new Error(
        `Two rule files share the basename "${ruleFile.basename}" (${existingPath} and `
        + `${ruleFile.fullPath}). This test looks up a rule file by basename, so basenames under `
        + '.cursor/rules/ must stay unique.',
      );
    }
    ruleFilePathByBasename.set(ruleFile.basename, ruleFile.fullPath);
  }

  it('reads a non-empty Always-on rules list and a non-empty Path-scoped rules list', () => {
    expect(alwaysOnBasenames.length).toBeGreaterThan(0);
    expect(alwaysOnBasenames).toContain('writing-style.mdc');
    expect(pathScopedBasenames.length).toBeGreaterThan(0);
    expect(pathScopedBasenames).toContain('dependency-block-parity.mdc');
  });

  it('detects alwaysApply and globs frontmatter the way this test needs to, on known files', () => {
    expect(hasAlwaysApplyTrue(path.join(RULES_DIR, 'writing-style.mdc'))).toBe(true);
    expect(hasGlobsFrontmatter(path.join(RULES_DIR, 'writing-style.mdc'))).toBe(false);
    expect(hasGlobsFrontmatter(path.join(RULES_DIR, 'hmr-patterns.mdc'))).toBe(true);
    expect(hasAlwaysApplyTrue(path.join(RULES_DIR, 'hmr-patterns.mdc'))).toBe(false);
  });

  it('every rule listed under Always-on rules carries alwaysApply: true', () => {
    const offenders = alwaysOnBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && !hasAlwaysApplyTrue(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} sit under AGENTS.md's "Always-on rules" heading but do not carry `
      + 'alwaysApply: true. A Cursor always-on rule must set alwaysApply: true.',
    ).toEqual([]);
  });

  it('every rule listed under Path-scoped rules carries globs: with at least one entry', () => {
    const offenders = pathScopedBasenames.filter((basename) => {
      const fullPath = ruleFilePathByBasename.get(basename);
      return fullPath !== undefined && !hasGlobsFrontmatter(fullPath);
    });
    expect(
      offenders,
      `${offenders.join(', ')} sit under AGENTS.md's "Path-scoped rules" heading but carry no `
      + 'globs: frontmatter, or an empty one. Add `globs:` naming the files this rule should load '
      + 'with, or move its AGENTS.md entry to "Always-on rules" if it is genuinely meant to load '
      + 'every session.',
    ).toEqual([]);
  });

  it('every basename listed under either heading names a rule file that exists on disk', () => {
    const staleAlwaysOnEntries = alwaysOnBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    const stalePathScopedEntries = pathScopedBasenames.filter(
      (basename) => !ruleFilePathByBasename.has(basename),
    );
    expect(
      staleAlwaysOnEntries,
      `${staleAlwaysOnEntries.join(', ')} are listed under AGENTS.md's "Always-on rules" heading `
      + 'but name no file under .cursor/rules/. Remove the stale entry or fix the filename.',
    ).toEqual([]);
    expect(
      stalePathScopedEntries,
      `${stalePathScopedEntries.join(', ')} are listed under AGENTS.md's "Path-scoped rules" `
      + 'heading but name no file under .cursor/rules/. Remove the stale entry or fix the filename.',
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
      + 'the "Path-scoped rules" heading in AGENTS.md. Every rule under .cursor/rules/ sorts into '
      + 'one of the two today; file the entry under whichever regime the rule\'s frontmatter '
      + 'matches, or extend this test with a documented exception if a rule genuinely belongs to '
      + 'neither.',
    ).toEqual([]);
    expect(
      listedUnderBoth,
      `${listedUnderBoth.join(', ')} are listed under both the "Always-on rules" heading and the `
      + '"Path-scoped rules" heading in AGENTS.md. A rule belongs under exactly one.',
    ).toEqual([]);
  });

  it('does not copy bash-single-command, which is a Claude Code Bash-tool constraint', () => {
    expect(ruleFilePathByBasename.has('bash-single-command.mdc')).toBe(false);
    expect(alwaysOnBasenames).not.toContain('bash-single-command.mdc');
  });
});
