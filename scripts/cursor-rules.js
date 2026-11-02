#!/usr/bin/env node
/**
 * Writes Cursor's copy of what Cursor cannot read in place from `.claude/`: one
 * `.cursor/rules/<name>.mdc` for each `.claude/rules/<name>.md`, and one
 * `.cursor/agents/<name>.md` for each `.claude/agents/<name>.md`.
 *
 * Claude Code reads `.claude/` itself. Cursor reads rules only as `.mdc` files in `.cursor/rules/`,
 * with its own frontmatter (`description`, `globs`, `alwaysApply`), and an `@file` mention in a
 * rule is read on demand, never inlined, so a stub pointing at the real rule would load nothing.
 * Cursor does load `.claude/agents/`, but its docs name only `inherit` or a specific model ID for
 * `model`, so `sonnet` and `haiku` are not values it documents. One contributor's run on Cursor
 * started Claude Haiku 4.5 for `haiku` and stopped when the account could not use it, and listed a
 * multi-line `description: |` as the character `|`. Cursor prefers `.cursor/agents/` over
 * `.claude/agents/` for the same name (its subagents doc says so), so a generated copy with
 * `model: inherit` and a one-line description wins where it matters, and `.claude/agents/` stays
 * exactly as Claude Code wants it.
 *
 * The copies are generated and gitignored rather than committed: a committed copy would need a
 * parity test, and every edit to a rule or agent would then have to rerun this script or fail CI.
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
 * An agent whose `tools:` names only these gets `readonly: true` in its Cursor copy. Cursor
 * documents no `tools:` field, so `readonly` is how a read-only agent stays read-only there. An
 * allowlist, so a tool this script has not heard of never makes an agent look read-only.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * Opens the first line after a generated file's frontmatter. It tells an agent in Cursor where to
 * make an edit, and it is how a later run tells its own stale output from a file a developer put
 * in `.cursor/` by hand.
 */
const RULE_MARKER_PREFIX = '<!-- Generated from .claude/rules/';
const AGENT_MARKER_PREFIX = '<!-- Generated from .claude/agents/';

function generatedMarker(prefix, relativePath) {
  return `${prefix}${relativePath} by scripts/cursor-rules.js. Edit that file; `
    + 'this copy is rewritten on npm install and npm start. -->';
}

/**
 * `text` as a YAML scalar: left as written when a plain scalar would read back the same, quoted
 * (as JSON, which is valid YAML) when it would not. Cursor's docs write globs unquoted, so the
 * ordinary case stays that way, but a value starting with `*` (`**` + `/*.test.ts`) is a YAML alias
 * and a strict parser rejects it, and the same goes for a leading `!`, `{`, `[`, `#` or `&`, a
 * `: ` inside, or a ` #` comment marker.
 *
 * @param {string} text
 * @returns {string}
 */
function toYamlScalar(text) {
  const needsQuotes = /^[\s*&!|>%@`'"#{}[\],?:-]/.test(text) || /:\s|\s#|[:\s]$/.test(text);
  return needsQuotes ? JSON.stringify(text) : text;
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
    header.push(`globs: ${toYamlScalar(globs.join(', '))}`, 'alwaysApply: false');
  } else {
    header.push('alwaysApply: true');
  }
  header.push('---', generatedMarker(RULE_MARKER_PREFIX, relativePath), '');
  return header.join(lineEnding) + body;
}

/**
 * The top-level keys of a frontmatter block, each with the text after its colon and the indented
 * or blank lines that follow it (a block scalar's lines, a list's items). A line at column 0 that
 * is not `key:` ends the previous key's lines.
 *
 * @param {string} frontmatter
 * @returns {Map<string, { inline: string, continuation: string[] }>}
 */
function readTopLevelEntries(frontmatter) {
  const entries = new Map();
  let current = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (keyMatch !== null) {
      current = { inline: keyMatch[2].trim(), continuation: [] };
      entries.set(keyMatch[1], current);
    } else if (current !== null && (line.trim() === '' || /^[ \t]/.test(line))) {
      current.continuation.push(line.trim());
    } else {
      current = null;
    }
  }
  return entries;
}

/**
 * A key's value as one line of text. A block scalar (`|`, `>`, with or without a chomping mark), a
 * plain scalar that wraps onto indented lines, and a quoted scalar all read the same: the pieces
 * joined by single spaces. Line breaks inside a description carry no meaning for Cursor.
 *
 * @param {{ inline: string, continuation: string[] }} entry
 * @returns {string}
 */
function scalarText(entry) {
  const startsBlock = /^[|>][+-]?\d*$/.test(entry.inline);
  const pieces = startsBlock || entry.inline === '' ? [] : [entry.inline];
  pieces.push(...entry.continuation.filter((line) => line !== ''));
  let text = pieces.join(' ').replace(/\s+/g, ' ').trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      text = JSON.parse(text);
    } catch {
      text = text.slice(1, -1);
    }
  } else if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    text = text.slice(1, -1).replace(/''/g, "'");
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The `tools:` list as names, or null when the agent names none (it then inherits every tool).
 * Both spellings Claude Code accepts: a comma-separated string and a YAML list.
 *
 * @param {{ inline: string, continuation: string[] } | undefined} entry
 * @returns {string[] | null}
 */
function readAgentTools(entry) {
  if (entry === undefined) {
    return null;
  }
  const names = entry.inline === ''
    ? entry.continuation.filter((line) => line.startsWith('- ')).map((line) => line.slice(2))
    : entry.inline.replace(/^\[(.*)\]$/, '$1').split(',');
  const tools = names.map((name) => name.trim().replace(/^["']|["']$/g, '')).filter((name) => name !== '');
  return tools.length > 0 ? tools : null;
}

/**
 * Translates one subagent into Cursor's form. Keeps `name`, flattens `description` to one quoted
 * line, sets `model: inherit` so it runs on the session's model, and adds `readonly: true` when its
 * `tools:` name only read tools. `tools:`, `effort:` and the original `model:` are left out: Cursor
 * documents none of them, and `model: haiku` made it start a Claude model the account may not have.
 * The body, the agent's prompt, is copied byte for byte.
 *
 * Throws, naming the agent, when there is no frontmatter, no `description`, or a `name` that is not
 * lowercase letters and hyphens, which Cursor requires.
 *
 * @param {string} source the agent file's text
 * @param {string} relativePath the agent's path under `.claude/agents/`, forward slashes
 * @returns {string} the Cursor agent file's text
 */
function translateAgentToCursor(source, relativePath) {
  const { frontmatter, body } = splitFrontmatter(source);
  if (frontmatter === null) {
    throw new Error(`.claude/agents/${relativePath} has no frontmatter to read a name and description from.`);
  }
  const entries = readTopLevelEntries(frontmatter);
  const name = entries.has('name') ? scalarText(entries.get('name')) : '';
  const description = entries.has('description') ? scalarText(entries.get('description')) : '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `.claude/agents/${relativePath}: the name "${name}" is not lowercase letters, digits and hyphens, `
      + 'which Cursor requires of a subagent name.',
    );
  }
  if (description === '') {
    throw new Error(`.claude/agents/${relativePath} has no description, which Cursor needs to decide when to delegate.`);
  }
  const tools = readAgentTools(entries.get('tools'));
  const isReadOnly = tools !== null && tools.every((tool) => READ_ONLY_TOOLS.includes(tool));
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const header = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, 'model: inherit'];
  if (isReadOnly) {
    header.push('readonly: true');
  }
  header.push('---', generatedMarker(AGENT_MARKER_PREFIX, relativePath), '');
  return header.join(lineEnding) + body;
}

/** True when `text` is a file this script wrote. */
function isGeneratedFile(text) {
  const { body } = splitFrontmatter(text);
  return body.startsWith(RULE_MARKER_PREFIX) || body.startsWith(AGENT_MARKER_PREFIX);
}

/** Every file with `extension` under `directory`, recursively, or none when it does not exist. */
function listFilesWithExtension(directory, extension) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesWithExtension(entryPath, extension));
    } else if (entry.name.endsWith(extension)) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Writes one translated file per `.md` under `sourceDir`, then sweeps `outputDir`. A file is
 * rewritten only when its text changed. A file at an output path that was not generated is a
 * developer's own and is left alone, and so is every unmarked file in the sweep. A generated file
 * whose source is gone is removed.
 *
 * @returns {{ total: number, written: number, removed: number }}
 */
function syncGenerated({ sourceDir, outputDir, outputExtension, translate, skipNames }) {
  const expectedPaths = new Set();
  let written = 0;
  const sources = fs.existsSync(sourceDir) ? collectRuleFiles(sourceDir) : [];
  for (const source of sources) {
    if (skipNames.includes(source.name)) {
      continue;
    }
    const outputPath = path.join(outputDir, ...source.relativePath.replace(/\.md$/, outputExtension).split('/'));
    const text = translate(source.source, source.relativePath);
    const currentText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : null;
    // A file at this path that we did not write is the developer's own. Leave it, and leave it out
    // of the sweep below, so a same-named file of theirs is never replaced or removed.
    if (currentText !== null && !isGeneratedFile(currentText)) {
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
  for (const filePath of listFilesWithExtension(outputDir, outputExtension)) {
    if (expectedPaths.has(filePath) || !isGeneratedFile(fs.readFileSync(filePath, 'utf-8'))) {
      continue;
    }
    fs.rmSync(filePath, { force: true });
    removed++;
  }
  return { total: expectedPaths.size, written, removed };
}

/**
 * Writes `<projectDir>/.cursor/rules/<name>.mdc` for every rule in `<projectDir>/.claude/rules/`
 * except the Claude Code only ones, and `<projectDir>/.cursor/agents/<name>.md` for every agent in
 * `<projectDir>/.claude/agents/`. A file is rewritten only when its text changed. A generated file
 * whose source is gone is removed; a file without the generated marker is left alone, even when it
 * has the name a generated file would take.
 *
 * @param {string} projectDir
 * @returns {{ total: number, written: number, removed: number }} counts across rules and agents
 */
function writeCursorRules(projectDir) {
  const results = [
    syncGenerated({
      sourceDir: path.join(projectDir, '.claude', 'rules'),
      outputDir: path.join(projectDir, '.cursor', 'rules'),
      outputExtension: '.mdc',
      translate: translateRuleToCursor,
      skipNames: CLAUDE_CODE_ONLY_RULES,
    }),
    syncGenerated({
      sourceDir: path.join(projectDir, '.claude', 'agents'),
      outputDir: path.join(projectDir, '.cursor', 'agents'),
      outputExtension: '.md',
      translate: translateAgentToCursor,
      skipNames: [],
    }),
  ];
  return {
    total: results.reduce((sum, result) => sum + result.total, 0),
    written: results.reduce((sum, result) => sum + result.written, 0),
    removed: results.reduce((sum, result) => sum + result.removed, 0),
  };
}

if (require.main === module) {
  const projectDir = path.resolve(__dirname, '..');
  // This runs from `prepare`, so a throw would fail every `npm install` and
  // `npm ci`, CI's included, before a test runs. The copies are a Cursor
  // convenience, so a failure only warns, as it does in scripts/dev.js, and
  // tests/unit/cursor-rules.test.ts is the gate that fails on a rule or agent
  // the translator cannot carry.
  try {
    const { total, written, removed } = writeCursorRules(projectDir);
    console.log(`[cursor-rules] ${total} rules and agents in .cursor/ (${written} written, ${removed} stale removed)`);
  } catch (error) {
    console.warn('[cursor-rules] could not refresh .cursor/:', error instanceof Error ? error.message : error);
  }
}

module.exports = {
  CLAUDE_CODE_ONLY_RULES,
  READ_ONLY_TOOLS,
  toYamlScalar,
  translateRuleToCursor,
  translateAgentToCursor,
  writeCursorRules,
};
