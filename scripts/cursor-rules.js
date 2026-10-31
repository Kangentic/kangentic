#!/usr/bin/env node
/**
 * Writes Cursor's copy of the team rules: one `.cursor/rules/<name>.mdc` for each
 * `.claude/rules/<name>.md`.
 *
 * Claude Code reads `.claude/rules/` itself. Cursor reads only `.mdc` files in `.cursor/rules/`,
 * with its own frontmatter (`description`, `globs`, `alwaysApply`), and an `@file` mention in a
 * rule is read on demand, never inlined, so a stub pointing at the real rule would load nothing.
 * Each rule therefore needs a translated copy. The copy is generated and gitignored rather than
 * committed: a committed copy would need a parity test, and every rule edit would then have to
 * rerun this script or fail CI.
 *
 * It runs from `npm run cursor:rules`, from `prepare` (every `npm install`, which a fresh task
 * worktree needs before anything else) and from scripts/dev.js (every `npm start`, which catches
 * a pull that changed a rule without a reinstall). How the two tools share instructions:
 * docs/contributing/agent-instructions.md.
 *
 * Usage: node scripts/cursor-rules.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { collectRuleFiles, splitFrontmatter, parsePathGlobs } = require('./lib/claude-rules');

/**
 * Rules that constrain a Claude Code tool and mean nothing in Cursor. They get no Cursor copy, and
 * CLAUDE.md indexes them instead of AGENTS.md (tests/unit/rules-index-parity.test.ts holds the two
 * lists equal).
 */
const CLAUDE_CODE_ONLY_RULES = ['bash-single-command.md'];

/**
 * Opens the first line after a generated file's frontmatter. It tells an agent in Cursor where to
 * make an edit, and it is how a later run tells its own stale output from a rule a developer put
 * in `.cursor/rules/` by hand.
 */
const GENERATED_MARKER_PREFIX = '<!-- Generated from .claude/rules/';

function generatedMarker(relativePath) {
  return `${GENERATED_MARKER_PREFIX}${relativePath} by scripts/cursor-rules.js. Edit that file; `
    + 'this copy is rewritten on npm install and npm start. -->';
}

/**
 * Translates one rule into Cursor's `.mdc` form. `paths:` becomes `globs:` (one comma-separated
 * string, the form Cursor documents) with `alwaysApply: false`; a rule with no `paths:` loads every
 * session in Claude Code, so it becomes `alwaysApply: true`. The description is the rule's
 * `# Rule:` title. The body is copied byte for byte.
 *
 * Throws, naming the rule, when there is no `# Rule:` title or a glob holds a comma or a brace,
 * which a comma-separated list cannot carry.
 *
 * @param {string} source the rule file's text
 * @param {string} relativePath the rule's path under `.claude/rules/`, forward slashes
 * @returns {string} the `.mdc` text
 */
function translateRuleToCursor(source, relativePath) {
  const { body } = splitFrontmatter(source);
  const titleMatch = body.match(/^# Rule: (.+?)\r?$/m);
  if (titleMatch === null) {
    throw new Error(`.claude/rules/${relativePath} has no "# Rule: <title>" heading to describe it with.`);
  }
  const globs = parsePathGlobs(source);
  for (const glob of globs) {
    if (/[,{}]/.test(glob)) {
      throw new Error(
        `.claude/rules/${relativePath}: the paths: entry "${glob}" holds a comma or a brace, which `
        + "Cursor's comma-separated globs cannot carry. Split it into one entry per pattern.",
      );
    }
  }
  const lineEnding = body.includes('\r\n') ? '\r\n' : '\n';
  const header = ['---', `description: ${JSON.stringify(titleMatch[1].trim())}`];
  if (globs.length > 0) {
    header.push(`globs: ${globs.join(', ')}`, 'alwaysApply: false');
  } else {
    header.push('alwaysApply: true');
  }
  header.push('---', generatedMarker(relativePath), '');
  return header.join(lineEnding) + body;
}

/** True when `text` is a file this script wrote. */
function isGeneratedRule(text) {
  return splitFrontmatter(text).body.startsWith(GENERATED_MARKER_PREFIX);
}

/** Every `.mdc` file under `directory`, recursively, or none when it does not exist. */
function listMdcFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMdcFiles(entryPath));
    } else if (entry.name.endsWith('.mdc')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Writes `<projectDir>/.cursor/rules/<name>.mdc` for every rule in `<projectDir>/.claude/rules/`
 * except the Claude Code only ones. A file is rewritten only when its text changed. A generated
 * file whose rule is gone is removed; a `.mdc` without the generated marker is left alone, even
 * when it has the name a generated rule would take.
 *
 * @param {string} projectDir
 * @returns {{ total: number, written: number, removed: number }}
 */
function writeCursorRules(projectDir) {
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  const outputDir = path.join(projectDir, '.cursor', 'rules');
  const expectedPaths = new Set();
  let written = 0;
  for (const rule of collectRuleFiles(rulesDir)) {
    if (CLAUDE_CODE_ONLY_RULES.includes(rule.name)) {
      continue;
    }
    const outputPath = path.join(outputDir, ...rule.relativePath.replace(/\.md$/, '.mdc').split('/'));
    const text = translateRuleToCursor(rule.source, rule.relativePath);
    const currentText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : null;
    // A file at this path that we did not write is the developer's own rule. Leave it, and leave
    // it out of the stale sweep below, so a same-named rule of theirs is never replaced or removed.
    if (currentText !== null && !isGeneratedRule(currentText)) {
      continue;
    }
    expectedPaths.add(outputPath);
    if (currentText !== text) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, text);
      written++;
    }
  }
  let removed = 0;
  for (const filePath of listMdcFiles(outputDir)) {
    if (expectedPaths.has(filePath) || !isGeneratedRule(fs.readFileSync(filePath, 'utf-8'))) {
      continue;
    }
    fs.rmSync(filePath, { force: true });
    removed++;
  }
  return { total: expectedPaths.size, written, removed };
}

if (require.main === module) {
  const projectDir = path.resolve(__dirname, '..');
  // This runs from `prepare`, so a throw would fail every `npm install` and
  // `npm ci`, CI's included, before a test runs. The copies are a Cursor
  // convenience, so a failure only warns, as it does in scripts/dev.js, and
  // tests/unit/cursor-rules.test.ts is the gate that fails on a rule the
  // translator cannot carry.
  try {
    const { total, written, removed } = writeCursorRules(projectDir);
    console.log(`[cursor-rules] ${total} rules in .cursor/rules/ (${written} written, ${removed} stale removed)`);
  } catch (error) {
    console.warn('[cursor-rules] could not refresh .cursor/rules/:', error instanceof Error ? error.message : error);
  }
}

module.exports = { CLAUDE_CODE_ONLY_RULES, translateRuleToCursor, writeCursorRules };
