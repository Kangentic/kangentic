import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_CODE_ONLY_RULES, translateRuleToCursor, writeCursorRules } from '../../scripts/cursor-rules.js';
import { collectRuleFiles, parsePathGlobs } from '../../scripts/lib/claude-rules.js';

// scripts/cursor-rules.js writes Cursor's copy of .claude/rules/ into a gitignored .cursor/rules/.
// Nothing commits that copy, so nothing can drift out of a parity check against it. What this file
// pins instead is the translation itself, and that every live rule translates: a rule the
// translator cannot carry would otherwise fail only on a developer's next npm install.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');

const PATH_SCOPED_RULE = [
  '---',
  'paths:',
  '  - "src/renderer/**"',
  '  - tests/ui/**',
  "  - 'scripts/dev.js'",
  '---',
  '# Rule: example path-scoped rule',
  '',
  'Body line one.',
  '',
  '## The rule',
  '',
  '- A bullet.',
  '',
].join('\n');

const ALWAYS_ON_RULE = ['# Rule: example always-on rule', '', 'Body.', ''].join('\n');

describe('translateRuleToCursor', () => {
  it('turns paths: into one comma-separated globs line with alwaysApply false', () => {
    const translated = translateRuleToCursor(PATH_SCOPED_RULE, 'example.md');
    expect(translated.startsWith([
      '---',
      'description: "example path-scoped rule"',
      'globs: src/renderer/**, tests/ui/**, scripts/dev.js',
      'alwaysApply: false',
      '---',
      '<!-- Generated from .claude/rules/example.md by scripts/cursor-rules.js.',
    ].join('\n'))).toBe(true);
  });

  it('turns a rule with no paths: into alwaysApply true and writes no globs line', () => {
    const translated = translateRuleToCursor(ALWAYS_ON_RULE, 'always.md');
    const frontmatter = translated.split('\n---\n')[0];
    expect(frontmatter).toContain('alwaysApply: true');
    expect(frontmatter).not.toContain('globs:');
    expect(frontmatter).toContain('description: "example always-on rule"');
  });

  it('copies the body after the frontmatter byte for byte', () => {
    const body = PATH_SCOPED_RULE.slice(PATH_SCOPED_RULE.indexOf('# Rule:'));
    expect(translateRuleToCursor(PATH_SCOPED_RULE, 'example.md').endsWith(`-->\n${body}`)).toBe(true);
    expect(translateRuleToCursor(ALWAYS_ON_RULE, 'always.md').endsWith(`-->\n${ALWAYS_ON_RULE}`)).toBe(true);
  });

  it('reads a CRLF rule the same way and keeps its line endings', () => {
    const crlfRule = PATH_SCOPED_RULE.replace(/\n/g, '\r\n');
    const translated = translateRuleToCursor(crlfRule, 'example.md');
    expect(translated).toContain('globs: src/renderer/**, tests/ui/**, scripts/dev.js\r\n');
    expect(translated).toContain('description: "example path-scoped rule"\r\n');
    expect(translated).not.toMatch(/[^\r]\n/);
    expect(translated.endsWith(crlfRule.slice(crlfRule.indexOf('# Rule:')))).toBe(true);
  });

  it('quotes a description that YAML would otherwise misread', () => {
    const translated = translateRuleToCursor('# Rule: a "quoted": title\n\nBody.\n', 'quoted.md');
    expect(translated).toContain('description: "a \\"quoted\\": title"');
  });

  it('refuses a rule with no "# Rule:" heading, naming the file', () => {
    expect(() => translateRuleToCursor('# Something else\n\nBody.\n', 'untitled.md'))
      .toThrow(/\.claude\/rules\/untitled\.md has no "# Rule: <title>" heading/);
  });

  it('refuses a glob holding a comma or a brace, which a comma-separated list cannot carry', () => {
    const withComma = PATH_SCOPED_RULE.replace('tests/ui/**', '"tests/ui/a.ts,b.ts"');
    const withBrace = PATH_SCOPED_RULE.replace('tests/ui/**', '"tests/{ui,e2e}/**"');
    expect(() => translateRuleToCursor(withComma, 'comma.md')).toThrow(/comma\.md.*comma or a brace/);
    expect(() => translateRuleToCursor(withBrace, 'brace.md')).toThrow(/brace\.md.*comma or a brace/);
  });
});

describe('the live .claude/rules/ corpus', () => {
  const liveRules = collectRuleFiles(RULES_DIR);

  it('finds rules to check, so the checks below cannot pass on an empty list', () => {
    expect(liveRules.length).toBeGreaterThan(10);
  });

  it('names only rule files that exist as Claude Code only', () => {
    const liveNames = liveRules.map((rule) => rule.name);
    for (const ruleName of CLAUDE_CODE_ONLY_RULES) {
      expect(liveNames, `${ruleName} is in CLAUDE_CODE_ONLY_RULES but not in .claude/rules/`).toContain(ruleName);
    }
  });

  it('translates every rule, with globs matching its paths: entries', () => {
    for (const rule of liveRules) {
      const translated = translateRuleToCursor(rule.source, rule.relativePath);
      const globs = parsePathGlobs(rule.source);
      if (globs.length > 0) {
        expect(translated, rule.relativePath).toContain(`\nglobs: ${globs.join(', ')}\nalwaysApply: false\n`);
      } else {
        expect(translated, rule.relativePath).toContain('\nalwaysApply: true\n');
      }
    }
  });
});

describe('writeCursorRules', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeProject(): string {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-rules-'));
    temporaryDirectories.push(projectDir);
    const rulesDir = path.join(projectDir, '.claude', 'rules');
    fs.mkdirSync(path.join(rulesDir, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'always.md'), ALWAYS_ON_RULE);
    fs.writeFileSync(path.join(rulesDir, 'frontend', 'scoped.md'), PATH_SCOPED_RULE);
    fs.writeFileSync(path.join(rulesDir, 'bash-single-command.md'), '# Rule: one command per Bash tool call\n');
    return projectDir;
  }

  it('writes one .mdc per rule, nested folders included, and skips the Claude Code only rules', () => {
    const projectDir = makeProject();
    const outputDir = path.join(projectDir, '.cursor', 'rules');
    const result = writeCursorRules(projectDir);
    expect(result).toEqual({ total: 2, written: 2, removed: 0 });
    expect(fs.existsSync(path.join(outputDir, 'always.mdc'))).toBe(true);
    expect(fs.readFileSync(path.join(outputDir, 'frontend', 'scoped.mdc'), 'utf-8'))
      .toBe(translateRuleToCursor(PATH_SCOPED_RULE, 'frontend/scoped.md'));
    expect(fs.existsSync(path.join(outputDir, 'bash-single-command.mdc'))).toBe(false);
  });

  it('rewrites nothing on a second run with no rule changes', () => {
    const projectDir = makeProject();
    writeCursorRules(projectDir);
    expect(writeCursorRules(projectDir)).toEqual({ total: 2, written: 0, removed: 0 });
  });

  it('removes a generated file whose rule is gone and keeps a rule a developer wrote by hand', () => {
    const projectDir = makeProject();
    const outputDir = path.join(projectDir, '.cursor', 'rules');
    writeCursorRules(projectDir);
    const handWritten = path.join(outputDir, 'mine.mdc');
    fs.writeFileSync(handWritten, '---\nalwaysApply: true\n---\nMy own rule.\n');
    fs.rmSync(path.join(projectDir, '.claude', 'rules', 'always.md'), { force: true });

    expect(writeCursorRules(projectDir)).toEqual({ total: 1, written: 0, removed: 1 });
    expect(fs.existsSync(path.join(outputDir, 'always.mdc'))).toBe(false);
    expect(fs.existsSync(handWritten)).toBe(true);
  });
});
