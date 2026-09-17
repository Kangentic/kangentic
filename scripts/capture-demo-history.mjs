/**
 * Capture the git history behind the scaffolded sample project, for the Changes panel's History
 * pane, commit diffs, and blame gutter in the web build.
 *
 * Builds scripts/demo-repos/contoso-web as a real repository from its commit plan (the same
 * build the capture matrix records agent sessions against), then reads out of git, never out of
 * a hand-written list:
 *
 *   commits   `git log`, newest first, in the shape git:commitGraph returns
 *   diffs     one diffFiles-shaped entry per commit (what selecting it in History shows)
 *   blame     `git blame` of every file a recorded contoso session modified, run over the
 *             working tree that session left behind (its recorded diff applied uncommitted), so
 *             the agent's own lines blame as uncommitted the way they do on the desktop
 *
 * Output: tests/captures/fixtures/demo/history/contoso-web.json. The commit hashes are real and
 * reproducible: the plan fixes the author and every date, and autocrlf is pinned off.
 *
 *   node scripts/capture-demo-history.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildScaffoldRepo } from './lib/demo-scaffold-repo.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));

const LANGUAGE_BY_EXTENSION = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.mjs': 'javascript', '.json': 'json',
  '.html': 'html', '.md': 'markdown', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml',
};

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function languageOf(filePath) {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath)] ?? null;
}

function showFile(cwd, revision, filePath) {
  try {
    return git(cwd, ['show', `${revision}:${filePath}`]);
  } catch {
    return '';
  }
}

/** `git log` in the commit-graph shape: full hash, short hash, parents, author, ISO date, subject. */
function readCommits(cwd) {
  const output = git(cwd, ['log', '--topo-order', '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s']);
  return output.split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, parents, authorName, authorTimestamp, subject] = line.split('\0');
    return { hash, shortHash, parents: parents ? parents.split(' ') : [], authorName, authorTimestamp, subject };
  });
}

/** The diff one commit introduces, in the shape git:diffFiles returns for a selected commit. */
function readCommitDiff(cwd, commit) {
  const parent = commit.parents[0] ?? null;
  const numstat = git(cwd, ['show', '--format=', '--numstat', commit.hash]).split('\n').filter(Boolean);
  const nameStatus = git(cwd, ['show', '--format=', '--name-status', commit.hash]).split('\n').filter(Boolean);
  const statusByPath = new Map(nameStatus.map((line) => { const [status, filePath] = line.split('\t'); return [filePath, status[0]]; }));
  const files = numstat.map((line) => {
    const [insertions, deletions, filePath] = line.split('\t');
    const binary = insertions === '-';
    const status = statusByPath.get(filePath) ?? 'M';
    return {
      path: filePath,
      status,
      binary: binary || undefined,
      insertions: binary ? 0 : Number(insertions),
      deletions: binary ? 0 : Number(deletions),
      // A file the commit adds has no parent side; a file it deletes has no commit side.
      original: parent && status !== 'A' ? showFile(cwd, parent, filePath) : '',
      modified: status !== 'D' ? showFile(cwd, commit.hash, filePath) : '',
      language: languageOf(filePath),
    };
  });
  return {
    files,
    totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** `git blame --line-porcelain` of a working-tree file, in the shape git:blame returns. */
function readBlame(cwd, filePath) {
  const output = git(cwd, ['blame', '--line-porcelain', '--', filePath]);
  const lines = [];
  let current = null;
  for (const raw of output.split('\n')) {
    const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (header) {
      current = { line: Number(header[2]), hash: header[1], shortHash: header[1].slice(0, 7), author: '', date: '' };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('author ')) current.author = raw.slice('author '.length);
    else if (raw.startsWith('author-time ')) current.date = new Date(Number(raw.slice('author-time '.length)) * 1000).toISOString();
    else if (raw.startsWith('\t')) {
      // An uncommitted line blames as the all-zero hash; the desktop reports it with no hash
      // and no date, and the gutter draws it as the agent's own.
      if (/^0{40}$/.test(current.hash)) lines.push({ line: current.line, hash: '', shortHash: '', author: '', date: '' });
      else lines.push(current);
      current = null;
    }
  }
  return { lines };
}

/**
 * Blame for every file a recorded session modified, with that session's recorded working tree
 * applied over the scaffold and left uncommitted. The tree is reset between sessions.
 */
function readSessionBlames(cwd, projectName) {
  const blameBySession = {};
  for (const capture of manifest.captures) {
    if (capture.project !== projectName) continue;
    const recordingPath = path.join(fixturesDir, capture.file);
    if (!fs.existsSync(recordingPath)) continue;
    const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf-8'));
    const changes = recording.changes;
    if (!changes || !Array.isArray(changes.files) || changes.files.length === 0) continue;
    const blameByFile = {};
    for (const file of changes.files) {
      if (file.binary) continue;
      const target = path.join(cwd, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.modified, 'utf8');
    }
    for (const file of changes.files) {
      // A file the session created is untracked, which git blame refuses; the desktop shows no
      // gutter for it either.
      if (file.binary || file.status === 'A') continue;
      blameByFile[file.path] = readBlame(cwd, file.path);
    }
    git(cwd, ['checkout', '--', '.']);
    git(cwd, ['clean', '-fdq']);
    blameBySession[capture.sessionId] = blameByFile;
  }
  return blameBySession;
}

function captureHistory(projectName, spec) {
  const scaffoldDir = path.join(repoRoot, spec.scaffold);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-demo-history-'));
  const cwd = path.join(tempRoot, projectName);
  try {
    buildScaffoldRepo(scaffoldDir, cwd);
    const commits = readCommits(cwd);
    const diffs = Object.fromEntries(commits.map((commit) => [commit.hash, readCommitDiff(cwd, commit)]));
    const blame = readSessionBlames(cwd, projectName);
    return {
      $comment: `Captured by scripts/capture-demo-history.mjs from ${spec.scaffold} built with its commits.json. Re-run when the scaffold or its plan changes.`,
      project: projectName,
      branch: 'main',
      tipHash: commits[0].hash,
      commits,
      diffs,
      blame,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const outDir = path.join(fixturesDir, 'history');
fs.mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [projectName, spec] of Object.entries(manifest.repos)) {
  if (!spec.scaffold) {
    // The two upstream samples are shallow clones with one commit of history; nothing to show.
    console.error(`[history] ${projectName}: not a scaffold, skipped`);
    continue;
  }
  const history = captureHistory(projectName, spec);
  const outPath = path.join(outDir, `${projectName}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(history, null, 1)}\n`);
  written += 1;
  console.error(`[history] ${projectName}: ${history.commits.length} commits, ${Object.keys(history.diffs).length} diffs, blame for ${Object.keys(history.blame).length} sessions -> ${path.relative(repoRoot, outPath)}`);
}
if (written === 0) {
  console.error('[history] no scaffold repo in the manifest; nothing written');
  process.exit(1);
}
