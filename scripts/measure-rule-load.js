#!/usr/bin/env node
/**
 * Measure how much rule text an ordinary edit pulls into context.
 *
 * CLAUDE.md's "Authoring a rule" section carries a soft ceiling: "we run ~4
 * always-on; treat that as a soft ceiling." That count is honest but it bounds
 * the wrong quantity. It counts rule files with no `paths:` frontmatter, which
 * today total under 12k characters. What actually lands in a session is those
 * four PLUS every path-scoped rule whose glob matches a file in context, and a
 * rule scoped to `src/renderer/**` matches essentially any renderer edit. On a
 * board-card edit that union measured 103,940 characters against the 11,820 the
 * ceiling was counting, so the ceiling could stay green while the real cost
 * grew without limit.
 *
 * This prints the real number, per representative edit, so the ceiling can be
 * stated in terms of it. Run it when adding a rule or widening a glob, and
 * compare against the baseline recorded in CLAUDE.md.
 *
 * Deliberately NOT a pass/fail gate. A threshold on rule load would have to be
 * invented rather than derived: there is no measured point at which the union
 * starts hurting, and a made-up number would either never fire or block real
 * work. The gate that does exist is on CLAUDE.md alone, where the harness
 * supplies the limit (tests/unit/rules-index-parity.test.ts).
 *
 * Usage: node scripts/measure-rule-load.js [--verbose]
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

/**
 * One file per subsystem an agent routinely edits. These are real paths; the
 * script reports any that stop existing, so a rename shows up as a stale probe
 * rather than a silently wrong measurement.
 */
const PROBE_PATHS = [
  'src/renderer/components/board/TaskCard.tsx',
  'src/renderer/components/command-bar/CommandTerminalWindow.tsx',
  'src/renderer/stores/session-store/transient-session-slice.ts',
  'src/main/pty/session-manager.ts',
  'src/main/ipc/handlers/task-move.ts',
  'src/main/agent/adapters/claude/command-builder.ts',
  'src/main/db/migrations.ts',
  'package.json',
];

function collectRuleFiles(directory) {
  const ruleFiles = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      ruleFiles.push(...collectRuleFiles(entryPath));
    } else if (entry.name.endsWith('.md')) {
      const source = fs.readFileSync(entryPath, 'utf-8');
      ruleFiles.push({ name: entry.name, size: source.length, globs: parsePathGlobs(source) });
    }
  }
  return ruleFiles;
}

/**
 * Reads the `paths:` list out of a rule's frontmatter. Entries are written both
 * quoted and unquoted across the corpus, so both forms are accepted.
 */
function parsePathGlobs(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter === null) {
    return [];
  }
  const pathsBlock = frontmatter[1].match(/paths:\s*\n((?:\s*-\s.+\n?)*)/);
  if (pathsBlock === null) {
    return [];
  }
  return pathsBlock[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, '$1'));
}

/**
 * Glob match for the subset of syntax the rules use: `**` spans directory
 * separators, `*` does not. A trailing `**` has to reach the rest of the path,
 * which is the case that decides almost every renderer rule.
 */
function globMatches(glob, filePath) {
  const pattern = glob
    .replace(/[.+^${}()[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${pattern}$`).test(filePath);
}

function totalSize(ruleFiles) {
  return ruleFiles.reduce((sum, rule) => sum + rule.size, 0);
}

function main() {
  const verbose = process.argv.includes('--verbose');
  const allRules = collectRuleFiles(RULES_DIR);
  const alwaysOnRules = allRules.filter((rule) => rule.globs.length === 0);
  const claudeMdSize = fs.readFileSync(CLAUDE_MD, 'utf-8').length;

  console.log(`CLAUDE.md                 ${String(claudeMdSize).padStart(7)} chars`);
  console.log(`rule corpus               ${String(totalSize(allRules)).padStart(7)} chars in ${allRules.length} files`);
  console.log(`always-on rules           ${String(totalSize(alwaysOnRules)).padStart(7)} chars in ${alwaysOnRules.length} files`);
  console.log('');
  console.log('Loaded per single-file edit (CLAUDE.md + always-on + matching path-scoped):');

  const missingProbes = [];
  for (const probePath of PROBE_PATHS) {
    if (!fs.existsSync(path.join(REPO_ROOT, probePath))) {
      missingProbes.push(probePath);
    }
    const matchedRules = allRules.filter(
      (rule) => rule.globs.some((glob) => globMatches(glob, probePath)),
    );
    const loaded = claudeMdSize + totalSize(alwaysOnRules) + totalSize(matchedRules);
    console.log(`  ${String(loaded).padStart(7)} chars  ${String(matchedRules.length).padStart(2)} scoped  ${probePath}`);
    if (verbose) {
      for (const rule of [...matchedRules].sort((a, b) => b.size - a.size)) {
        console.log(`            ${String(rule.size).padStart(6)}  ${rule.name}`);
      }
    }
  }

  if (missingProbes.length > 0) {
    console.log('');
    console.log('Stale probe paths (renamed or deleted; update PROBE_PATHS):');
    for (const probePath of missingProbes) {
      console.log(`  ${probePath}`);
    }
  }
}

main();
