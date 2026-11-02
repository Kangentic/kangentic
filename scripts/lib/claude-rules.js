/**
 * Reads the team rules in `.claude/rules/`. Shared by scripts/measure-rule-load.js, which sizes
 * what an edit loads, and scripts/cursor-rules.js, which writes Cursor's copy of each rule.
 *
 * Line endings: .gitattributes checks every file out with LF, but an editor can still save a rule
 * with CRLF before it is committed, so every pattern here accepts both.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Every `.md` file under `rulesDir`, recursively, sorted by path so the output order is stable.
 * `relativePath` uses forward slashes on every platform (`frontend/foo.md`).
 *
 * @param {string} rulesDir
 * @returns {{ relativePath: string, name: string, source: string }[]}
 */
function collectRuleFiles(rulesDir) {
  const ruleFiles = [];
  const walk = (directory, relativeDirectory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
      } else if (entry.name.endsWith('.md')) {
        ruleFiles.push({ relativePath, name: entry.name, source: fs.readFileSync(entryPath, 'utf-8') });
      }
    }
  };
  walk(rulesDir, '');
  return ruleFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Splits a rule into its frontmatter text (null when it has none) and the body after the closing
 * `---` line. The body is returned byte for byte.
 *
 * @param {string} source
 * @returns {{ frontmatter: string | null, body: string }}
 */
function splitFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) {
    return { frontmatter: null, body: source };
  }
  return { frontmatter: match[1], body: source.slice(match[0].length) };
}

/**
 * Reads the `paths:` list out of a rule's frontmatter. Entries are written quoted and unquoted
 * across the corpus, so both forms are accepted, and single quotes too.
 *
 * @param {string} source
 * @returns {string[]}
 */
function parsePathGlobs(source) {
  const { frontmatter } = splitFrontmatter(source);
  if (frontmatter === null) {
    return [];
  }
  const pathsBlock = frontmatter.match(/^paths:[ \t]*\r?\n((?:[ \t]*-[ \t].*(?:\r?\n|$))*)/m);
  if (pathsBlock === null) {
    return [];
  }
  return pathsBlock[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
}

module.exports = { collectRuleFiles, splitFrontmatter, parsePathGlobs };
