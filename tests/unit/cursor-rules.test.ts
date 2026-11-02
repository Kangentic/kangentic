import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_CODE_ONLY_RULES,
  READ_ONLY_TOOLS,
  toYamlScalar,
  translateAgentToCursor,
  translateRuleToCursor,
  writeCursorRules,
} from '../../scripts/cursor-rules.js';
import { collectRuleFiles, parsePathGlobs } from '../../scripts/lib/claude-rules.js';

// scripts/cursor-rules.js writes Cursor's copy of .claude/rules/ and .claude/agents/ into a
// gitignored .cursor/. Nothing commits that copy, so nothing can drift out of a parity check against
// it. What this file pins instead is the translation itself, and that every live rule and agent
// translates: one the translator cannot carry would otherwise fail only on a developer's next
// npm install.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');

/** A subagent the way .claude/agents/ writes one: a block scalar description, haiku, read tools. */
const READ_ONLY_AGENT = [
  '---',
  'name: example-auditor',
  'description: |',
  '  Audits an example.',
  '',
  '  Use after a change to the example.',
  '  <example>',
  '  User: "check it" -> spawn it.',
  '  </example>',
  'model: haiku',
  'effort: medium',
  'tools: Read, Glob, Grep',
  '---',
  '',
  '# Example Auditor',
  '',
  'Body line.',
  '',
].join('\n');

const WRITING_AGENT = [
  '---',
  'name: example-builder',
  'description: Builds an example, editing files and running commands.',
  'model: sonnet',
  'tools: Read, Write, Edit, Glob, Grep, Bash',
  '---',
  '# Example Builder',
  '',
].join('\n');

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

  it('quotes a globs value that a strict YAML parser would reject, and only then', () => {
    const leadingStar = PATH_SCOPED_RULE.replace('src/renderer/**', '**/*.test.ts');
    expect(translateRuleToCursor(leadingStar, 'star.md')).toContain('\nglobs: "**/*.test.ts, tests/ui/**, scripts/dev.js"\n');
    expect(translateRuleToCursor(PATH_SCOPED_RULE, 'plain.md')).toContain('\nglobs: src/renderer/**, tests/ui/**, scripts/dev.js\n');
  });

  it('leaves a plain scalar alone and quotes each indicator, a colon-space and a comment marker', () => {
    for (const plain of ['src/**', '.claude/**', 'package.json', 'a/b/**, c.ts', '/abs/path/**']) {
      expect(toYamlScalar(plain), plain).toBe(plain);
    }
    for (const risky of ['**/*.ts', '*.ts', '!src/**', '{a}/**', '[a]/**', '#x', '&x', 'a: b', 'a #b', '- x', 'trailing:']) {
      const quoted = toYamlScalar(risky);
      expect(quoted, risky).toBe(JSON.stringify(risky));
      expect(JSON.parse(quoted), risky).toBe(risky);
    }
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

describe('translateAgentToCursor', () => {
  it('flattens a block scalar description to one quoted line', () => {
    const translated = translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md');
    expect(translated).toContain(
      'description: "Audits an example. Use after a change to the example. <example> User: \\"check it\\" -> spawn it. </example>"\n',
    );
  });

  it('writes model: inherit and drops the original model, effort and tools', () => {
    const frontmatter = translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md').split('\n---\n')[0];
    expect(frontmatter).toContain('\nmodel: inherit');
    expect(frontmatter).not.toMatch(/haiku|sonnet|effort|tools:/);
    expect(frontmatter.split('\n').filter((line) => line.startsWith('model:'))).toHaveLength(1);
  });

  it('keeps the name and puts the generated marker before the body', () => {
    const translated = translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md');
    expect(translated.startsWith('---\nname: example-auditor\n')).toBe(true);
    expect(translated).toContain(
      '---\n<!-- Generated from .claude/agents/example-auditor.md by scripts/cursor-rules.js.',
    );
  });

  it('copies the prompt body after the frontmatter byte for byte', () => {
    const body = READ_ONLY_AGENT.slice(READ_ONLY_AGENT.indexOf('\n# Example Auditor'));
    expect(translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md').endsWith(`-->\n${body}`)).toBe(true);
  });

  it('marks an agent whose tools are only read tools as readonly', () => {
    expect(translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md')).toContain('\nreadonly: true\n---\n');
  });

  it('does not mark an agent that can write, edit or run commands, or one with no tools line', () => {
    expect(translateAgentToCursor(WRITING_AGENT, 'example-builder.md')).not.toContain('readonly');
    const noTools = WRITING_AGENT.replace(/^tools:.*\n/m, '');
    expect(translateAgentToCursor(noTools, 'example-builder.md')).not.toContain('readonly');
    for (const tool of ['Write', 'Edit', 'Bash', 'SomeNewTool']) {
      const withTool = READ_ONLY_AGENT.replace('tools: Read, Glob, Grep', `tools: Read, Glob, Grep, ${tool}`);
      expect(translateAgentToCursor(withTool, 'example-auditor.md'), tool).not.toContain('readonly');
    }
  });

  it('reads tools written as a YAML list or a flow list', () => {
    const asList = READ_ONLY_AGENT.replace('tools: Read, Glob, Grep', 'tools:\n  - Read\n  - Glob\n  - Grep');
    const asFlow = READ_ONLY_AGENT.replace('tools: Read, Glob, Grep', 'tools: [Read, Glob, Grep]');
    expect(translateAgentToCursor(asList, 'example-auditor.md')).toContain('\nreadonly: true\n');
    expect(translateAgentToCursor(asFlow, 'example-auditor.md')).toContain('\nreadonly: true\n');
  });

  it('reads a plain, a double-quoted and a single-quoted description the same way', () => {
    const plain = WRITING_AGENT;
    const doubleQuoted = WRITING_AGENT.replace(/^description:.*$/m, 'description: "Builds an example, editing files and running commands."');
    const singleQuoted = WRITING_AGENT.replace(/^description:.*$/m, "description: 'Builds an example, editing files and running commands.'");
    const expected = translateAgentToCursor(plain, 'example-builder.md');
    expect(translateAgentToCursor(doubleQuoted, 'example-builder.md')).toBe(expected);
    expect(translateAgentToCursor(singleQuoted, 'example-builder.md')).toBe(expected);
  });

  it('reads a CRLF agent the same way and keeps its line endings', () => {
    const translated = translateAgentToCursor(READ_ONLY_AGENT.replace(/\n/g, '\r\n'), 'example-auditor.md');
    expect(translated).toContain('\r\nmodel: inherit\r\nreadonly: true\r\n---\r\n');
    expect(translated).not.toMatch(/[^\r]\n/);
  });

  it('refuses an agent with no frontmatter, no description, or a name Cursor rejects, naming the file', () => {
    expect(() => translateAgentToCursor('# Just a body\n', 'bare.md')).toThrow(/agents\/bare\.md has no frontmatter/);
    const noDescription = WRITING_AGENT.replace(/^description:.*\n/m, '');
    expect(() => translateAgentToCursor(noDescription, 'quiet.md')).toThrow(/agents\/quiet\.md has no description/);
    const badName = WRITING_AGENT.replace('name: example-builder', 'name: Example_Builder');
    expect(() => translateAgentToCursor(badName, 'loud.md')).toThrow(/agents\/loud\.md.*"Example_Builder".*lowercase/);
  });
});

describe('the live .claude/agents/ corpus', () => {
  const agentFiles = fs.readdirSync(AGENTS_DIR).filter((fileName) => fileName.endsWith('.md'));

  it('finds agents to check, so the checks below cannot pass on an empty list', () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('translates every agent to one named, described, inheriting subagent', () => {
    for (const fileName of agentFiles) {
      const translated = translateAgentToCursor(fs.readFileSync(path.join(AGENTS_DIR, fileName), 'utf-8'), fileName);
      const frontmatter = translated.split('\n---\n')[0].split('\n');
      expect(frontmatter[1], fileName).toBe(`name: ${fileName.replace(/\.md$/, '')}`);
      expect(frontmatter[2], fileName).toMatch(/^description: ".{20,}"$/);
      expect(frontmatter[3], fileName).toBe('model: inherit');
      // Only the keys Cursor documents, so nothing Claude Code specific leaks into its copy.
      const keys = frontmatter.slice(1).map((line) => line.split(':')[0]);
      expect(keys.every((key) => ['name', 'description', 'model', 'readonly'].includes(key)), fileName).toBe(true);
    }
  });

  it('marks exactly the agents whose tools line names only read tools as readonly', () => {
    let readOnlyCount = 0;
    for (const fileName of agentFiles) {
      const source = fs.readFileSync(path.join(AGENTS_DIR, fileName), 'utf-8');
      const toolsLine = source.match(/^tools: (.+)$/m);
      const tools = toolsLine === null ? [] : toolsLine[1].split(',').map((tool) => tool.trim());
      const expectedReadOnly = tools.length > 0 && tools.every((tool) => READ_ONLY_TOOLS.includes(tool));
      const translated = translateAgentToCursor(source, fileName);
      expect(translated.split('\n---\n')[0].includes('\nreadonly: true'), fileName).toBe(expectedReadOnly);
      if (expectedReadOnly) readOnlyCount++;
    }
    expect(readOnlyCount, 'at least the review and audit agents are read-only').toBeGreaterThanOrEqual(5);
  });

  it('carries no Cursor-only key in .claude/agents/, which Claude Code reads as written', () => {
    for (const fileName of agentFiles) {
      const frontmatter = fs.readFileSync(path.join(AGENTS_DIR, fileName), 'utf-8').split('\n---')[0];
      expect(/^readonly:/m.test(frontmatter), `${fileName} sets readonly: it is derived from tools: instead`).toBe(false);
    }
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
        expect(translated, rule.relativePath).toContain(`\nglobs: ${toYamlScalar(globs.join(', '))}\nalwaysApply: false\n`);
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

  it('never overwrites or removes a hand-written rule that has the name of a generated one', () => {
    const projectDir = makeProject();
    const outputDir = path.join(projectDir, '.cursor', 'rules');
    fs.mkdirSync(outputDir, { recursive: true });
    const sameName = path.join(outputDir, 'always.mdc');
    const ownText = '---\nalwaysApply: true\n---\nMy own always rule.\n';
    fs.writeFileSync(sameName, ownText);

    expect(writeCursorRules(projectDir)).toEqual({ total: 1, written: 1, removed: 0 });
    expect(fs.readFileSync(sameName, 'utf-8')).toBe(ownText);

    fs.rmSync(path.join(projectDir, '.claude', 'rules', 'always.md'), { force: true });
    expect(writeCursorRules(projectDir)).toEqual({ total: 1, written: 0, removed: 0 });
    expect(fs.readFileSync(sameName, 'utf-8')).toBe(ownText);
  });

  function makeProjectWithAgents(): string {
    const projectDir = makeProject();
    const agentsDir = path.join(projectDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'example-auditor.md'), READ_ONLY_AGENT);
    fs.writeFileSync(path.join(agentsDir, 'example-builder.md'), WRITING_AGENT);
    return projectDir;
  }

  it('writes one .cursor/agents file per agent beside the rules, and counts both', () => {
    const projectDir = makeProjectWithAgents();
    const agentsOutput = path.join(projectDir, '.cursor', 'agents');
    expect(writeCursorRules(projectDir)).toEqual({ total: 4, written: 4, removed: 0 });
    expect(fs.readFileSync(path.join(agentsOutput, 'example-auditor.md'), 'utf-8'))
      .toBe(translateAgentToCursor(READ_ONLY_AGENT, 'example-auditor.md'));
    expect(fs.existsSync(path.join(agentsOutput, 'example-builder.md'))).toBe(true);
    expect(writeCursorRules(projectDir)).toEqual({ total: 4, written: 0, removed: 0 });
  });

  it('writes no agents and does not fail when the project has no .claude/agents/', () => {
    const projectDir = makeProject();
    expect(writeCursorRules(projectDir)).toEqual({ total: 2, written: 2, removed: 0 });
    expect(fs.existsSync(path.join(projectDir, '.cursor', 'agents'))).toBe(false);
  });

  it('never overwrites or removes a hand-written subagent, even one named like a generated one', () => {
    const projectDir = makeProjectWithAgents();
    const agentsOutput = path.join(projectDir, '.cursor', 'agents');
    fs.mkdirSync(agentsOutput, { recursive: true });
    const sameName = path.join(agentsOutput, 'example-auditor.md');
    const unrelated = path.join(agentsOutput, 'mine.md');
    const ownText = '---\nname: example-auditor\ndescription: my own\nmodel: inherit\n---\nMy own prompt.\n';
    fs.writeFileSync(sameName, ownText);
    fs.writeFileSync(unrelated, '---\nname: mine\ndescription: another of mine\n---\nPrompt.\n');

    expect(writeCursorRules(projectDir)).toEqual({ total: 3, written: 3, removed: 0 });
    expect(fs.readFileSync(sameName, 'utf-8')).toBe(ownText);

    fs.rmSync(path.join(projectDir, '.claude', 'agents', 'example-auditor.md'), { force: true });
    expect(writeCursorRules(projectDir)).toEqual({ total: 3, written: 0, removed: 0 });
    expect(fs.readFileSync(sameName, 'utf-8')).toBe(ownText);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('removes a generated subagent whose agent is gone', () => {
    const projectDir = makeProjectWithAgents();
    const agentsOutput = path.join(projectDir, '.cursor', 'agents');
    writeCursorRules(projectDir);
    fs.rmSync(path.join(projectDir, '.claude', 'agents', 'example-builder.md'), { force: true });
    expect(writeCursorRules(projectDir)).toEqual({ total: 3, written: 0, removed: 1 });
    expect(fs.existsSync(path.join(agentsOutput, 'example-builder.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentsOutput, 'example-auditor.md'))).toBe(true);
  });
});

// The generator only reaches Cursor if something runs it: `npm install` (the `prepare` script) and
// every `npm start` (scripts/dev.js). The behavior tests above call writeCursorRules directly, so
// deleting either call site would leave them all green while Cursor's copy of the rules silently
// went stale. These are source scans, in the style of invariant (b) of external-scripts-parity.test.ts.
describe('the generator is wired into install and dev start', () => {
  /**
   * Source with its comments removed, so a commented-out call does not count as a call. Block
   * comments are matched only where one opens a line (a JSDoc block), which keeps a glob string
   * holding a slash-star from swallowing the code up to the next close.
   */
  function readSourceWithoutComments(relativePath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/[ \t]\/\/.*$/gm, '');
  }

  it('scripts/dev.js requires the generator and calls writeCursorRules(projectDir) inside a try', () => {
    const source = readSourceWithoutComments('scripts/dev.js');
    expect(
      /require\(\s*['"]\.\/cursor-rules['"]\s*\)/.test(source),
      "scripts/dev.js must require('./cursor-rules'). Without it `npm start` never refreshes .cursor/rules/.",
    ).toBe(true);
    // The try is what lets a rule the translator cannot carry warn instead of stopping the dev server.
    expect(
      /try\s*\{[^}]*\bwriteCursorRules\s*\(\s*projectDir\s*\)/.test(source),
      'scripts/dev.js must call writeCursorRules(projectDir) inside a try block, so a failure only warns.',
    ).toBe(true);
  });

  it('package.json prepare runs scripts/cursor-rules.js, so npm install refreshes the rules', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const prepareSteps = (manifest.scripts?.prepare ?? '').split('&&').map((step) => step.trim());
    expect(
      prepareSteps,
      `the prepare script must include "node scripts/cursor-rules.js" as a step (found "${manifest.scripts?.prepare}")`,
    ).toContain('node scripts/cursor-rules.js');
  });

  it('scripts/cursor-rules.js runs the generator when executed directly, which is what prepare does', () => {
    // The script exports writeCursorRules and, run as `node scripts/cursor-rules.js`, must also call
    // it. Without the main-module block, `prepare` would load the file, write nothing and exit 0.
    const source = readSourceWithoutComments('scripts/cursor-rules.js');
    expect(
      /if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{[\s\S]*?\bwriteCursorRules\s*\(/.test(source),
      'scripts/cursor-rules.js must call writeCursorRules inside `if (require.main === module)`.',
    ).toBe(true);
  });
});
