/**
 * Build a scaffold sample repo (scripts/demo-repos/<name>) as a REAL git repository with a real
 * history, from the commit plan beside it (`commits.json`: an author, and an ordered list of
 * commits naming the paths each one adds). Every path the plan leaves out lands in the last
 * commit, so the tree at HEAD is always the whole scaffold and a new file cannot be forgotten.
 *
 * Shared by the capture matrix (scripts/capture-demo-sessions.mjs), which records agent sessions
 * against this repo, and the history capture (scripts/capture-demo-history.mjs), which reads its
 * log, blame, and per-commit diffs into a fixture for the web build. Dates come from the plan
 * and the author is fixed, so the hashes are the same on every machine given the same files;
 * autocrlf is pinned off so a Windows checkout produces the same blobs as a Linux one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLAN_FILE = 'commits.json';

/** The plan, or null for a scaffold that ships none (it is then one "Initial import" commit). */
export function readCommitPlan(scaffoldDir) {
  const planPath = path.join(scaffoldDir, PLAN_FILE);
  if (!fs.existsSync(planPath)) return null;
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (!plan.author || !Array.isArray(plan.commits) || plan.commits.length === 0) {
    throw new Error(`${planPath} needs an author and a non-empty commits list`);
  }
  return plan;
}

// Every setting a machine's own gitconfig could fold into a commit object is pinned on the
// command line, which outranks the global and system config: a signature (commit.gpgsign) and
// an executable bit (core.filemode, off on Windows and on elsewhere) would each change the hash
// the history fixture bakes. autocrlf is pinned so the blobs match across checkouts.
function git(cwd, args, env) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.filemode=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function listFiles(dir, prefix = '') {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === PLAN_FILE) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...listFiles(path.join(dir, entry.name), relative));
    else entries.push(relative);
  }
  return entries.sort();
}

/**
 * Copy the scaffold to `target` and commit it following its plan. Returns the plan's author
 * identity so callers that commit later (the matrix's scaffold refresh) use the same one.
 */
export function buildScaffoldRepo(scaffoldDir, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(scaffoldDir, target, { recursive: true });
  const planCopy = path.join(target, PLAN_FILE);
  if (fs.existsSync(planCopy)) fs.rmSync(planCopy, { force: true });

  const plan = readCommitPlan(scaffoldDir) ?? {
    author: { name: 'Dev', email: 'dev@example.com' },
    commits: [{ subject: 'Initial import', date: new Date().toISOString(), paths: [] }],
  };
  git(target, ['init', '-q', '-b', 'main']);
  git(target, ['config', 'user.name', plan.author.name]);
  git(target, ['config', 'user.email', plan.author.email]);

  const remaining = new Set(listFiles(target));
  plan.commits.forEach((commit, index) => {
    const isLast = index === plan.commits.length - 1;
    const paths = commit.paths.filter((relative) => {
      if (!remaining.has(relative)) throw new Error(`${PLAN_FILE}: "${commit.subject}" names ${relative}, which the scaffold does not have or an earlier commit already took`);
      return true;
    });
    const staged = isLast ? [...paths, ...[...remaining].filter((relative) => !paths.includes(relative))] : paths;
    if (staged.length === 0) throw new Error(`${PLAN_FILE}: "${commit.subject}" adds nothing`);
    git(target, ['add', '--', ...staged]);
    const dateEnv = { GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date };
    git(target, ['commit', '-q', '-m', commit.subject], dateEnv);
    for (const relative of staged) remaining.delete(relative);
  });
  return plan.author;
}
