/**
 * Prepares one Phase 0 replay state: a detached worktree at the state's commit and a review pack
 * built by THIS checkout's scripts/build-review-pack.mjs, so every arm reviews the exact pack the
 * shipped skill would build.
 *
 * Usage: node scripts/review-eval/prepare.mjs <state or delta id> --scratch <dir>
 *   S1..S4 build a pack of the state against its recorded merge base.
 *   D1..D5 build a pack of that one commit (base: its parent, or the recorded base).
 * Writes the worktree to <dir>/replay/<id> and the pack to <dir>/packs/<id>, both outside the repo.
 * Run it from the main checkout or any worktree of it: the tags and commits are shared.
 *
 * Remove a worktree afterwards with `git worktree remove --force <dir>/replay/<id>`, by its exact
 * path. Never clean up by glob.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');
const corpus = JSON.parse(fs.readFileSync(path.join(scriptDirectory, 'corpus.json'), 'utf8'));

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const cliArguments = process.argv.slice(2);
const scratchIndex = cliArguments.indexOf('--scratch');
const caseId = cliArguments.find((argument, argumentIndex) => argumentIndex !== scratchIndex && argumentIndex !== scratchIndex + 1);
if (!caseId || scratchIndex === -1 || !cliArguments[scratchIndex + 1]) {
  console.error('usage: node scripts/review-eval/prepare.mjs <S1..S4 | D1..D5> --scratch <dir>');
  process.exit(2);
}
const scratchDirectory = path.resolve(cliArguments[scratchIndex + 1]);
const entry = corpus.states.find((state) => state.id === caseId) || corpus.deltas.find((delta) => delta.id === caseId);
if (!entry) {
  console.error(`no state or delta named ${caseId} in corpus.json`);
  process.exit(2);
}

const commit = git(['rev-parse', '--verify', `${entry.tag}^{commit}`]);
if (!commit.startsWith(entry.sha)) {
  console.error(`tag ${entry.tag} points at ${commit}, but corpus.json records ${entry.sha}`);
  process.exit(1);
}
const base = entry.base || git(['rev-parse', `${commit}^`]);

const worktreePath = path.join(scratchDirectory, 'replay', caseId);
if (fs.existsSync(worktreePath)) {
  const existingHead = git(['rev-parse', 'HEAD'], worktreePath);
  if (existingHead !== commit) {
    console.error(`${worktreePath} exists at ${existingHead}, not ${commit}; remove it by its exact path first`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '--detach', worktreePath, commit]);
}

const packDirectory = path.join(scratchDirectory, 'packs', caseId);
const summary = execFileSync(
  'node',
  [path.join(repoRoot, 'scripts', 'build-review-pack.mjs'), base, '--out-dir', packDirectory, '--shard-lines', '1500'],
  { cwd: worktreePath, encoding: 'utf8' },
);
const packPath = path.join(packDirectory, 'REVIEW_PACK.tmp.md');
const packBytes = fs.statSync(packPath).size;
console.log(`${caseId}: ${commit} against ${base}`);
console.log(`  worktree: ${worktreePath}`);
console.log(summary.trimEnd());
// A rough guide only: code averages about 3.5 bytes per token. The runner compares it with the
// finder model's context window before choosing a single-finder arm.
console.log(`  estimated pack tokens: ${Math.round(packBytes / 3.5)}`);
