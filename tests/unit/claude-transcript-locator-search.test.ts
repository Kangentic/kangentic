/**
 * The search half of the Claude transcript locator
 * (`src/main/agent/adapters/claude/transcript-locator.ts`): which copy of a
 * conversation wins, what one listing of the projects folder costs and answers,
 * what a reported path must look like, and what the synchronous and resume forms
 * will and will not do.
 *
 * `claude-transcript-locator.test.ts` pins the order of the steps and the
 * adapter reads built on them. This file pins the edges that file leaves open:
 * the newest copy across folders, the 32-folder batch, one listing shared by
 * many lookups, the cache after a deleted find, the reported path's shape and
 * its WSL mapping, `listClaudeProjectFolders`, and `peek` and `resume`.
 *
 * Every case runs against a temp home (`os.homedir` spied) and writes only under
 * `os.tmpdir()`, so the real `~/.claude` never decides one. Time is the spied
 * `Date.now`, never a sleep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_SCAN_BATCH,
  clearClaudeTranscriptLocatorCacheForTests,
  findClaudeResumeTranscriptFile,
  findClaudeTranscriptFile,
  listClaudeProjectFolders,
  peekClaudeTranscriptFile,
} from '../../src/main/agent/adapters/claude/transcript-locator';
import { claudeProjectSlug, locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const AGENT_SESSION_ID = 'eeb45f96-13b4-4780-a79d-6cd3a3094dcb';
const OTHER_SESSION_ID = '23985a96-1fe5-4964-bf04-65eaf7a76b20';
const LATE_SESSION_ID = '5f0a9c1e-7d3b-4e62-9a18-0b6c2d4e8f71';
const MISSING_SESSION_IDS = [
  '0a1b2c3d-1111-4a5b-8c6d-000000000001',
  '0a1b2c3d-2222-4a5b-8c6d-000000000002',
  '0a1b2c3d-3333-4a5b-8c6d-000000000003',
  '0a1b2c3d-4444-4a5b-8c6d-000000000004',
  '0a1b2c3d-5555-4a5b-8c6d-000000000005',
];
const FILE_NAME = `${AGENT_SESSION_ID}.jsonl`;

const OLDER = '2026-01-01T00:00:00Z';
const NEWER = '2026-01-02T00:00:00Z';

let workDir: string;
let tempHome: string;
let projectRoot: string;
let worktree: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-transcript-search-'));
  tempHome = path.join(workDir, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  projectRoot = path.join(workDir, 'project');
  worktree = path.join(projectRoot, '.kangentic', 'worktrees', '918');
});

afterEach(() => {
  vi.restoreAllMocks();
  clearClaudeTranscriptLocatorCacheForTests();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function projectsRoot(): string {
  return path.join(tempHome, '.claude', 'projects');
}

/** The transcript a session started in `folder` writes. */
function transcriptUnder(folder: string, agentSessionId = AGENT_SESSION_ID): string {
  return path.join(projectsRoot(), claudeProjectSlug(folder), `${agentSessionId}.jsonl`);
}

/** A transcript in a project folder named directly, whatever Claude would have called it. */
function transcriptInFolderNamed(folderName: string, agentSessionId = AGENT_SESSION_ID): string {
  return path.join(projectsRoot(), folderName, `${agentSessionId}.jsonl`);
}

function writeFile(filePath: string, body = '{"type":"user"}\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function setModified(filePath: string, isoTime: string): void {
  const time = new Date(isoTime);
  fs.utimesSync(filePath, time, time);
}

/** Counts the readdirs of the projects folder, which only the full scan makes. */
function countProjectScans(): () => number {
  const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  let scans = 0;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === path.resolve(projectsRoot())) scans += 1;
    return realReaddir(...args);
  }) as unknown as typeof fs.promises.readdir);
  return () => scans;
}

/**
 * `countProjectScans` that also hands the projects folder back sorted by name,
 * so which folder falls in which batch of 32 is the same on every filesystem.
 */
function countSortedProjectScans(): () => number {
  const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  let scans = 0;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
    const entries = await realReaddir(...args);
    if (path.resolve(String(args[0])) !== path.resolve(projectsRoot())) return entries;
    scans += 1;
    return (entries as fs.Dirent[]).slice().sort((left, right) => {
      if (left.name === right.name) return 0;
      return left.name < right.name ? -1 : 1;
    });
  }) as unknown as typeof fs.promises.readdir);
  return () => scans;
}

/** Holds the projects folder's listing until `release()`, so a search can be caught mid-flight. */
function holdProjectsListing(): { reached: Promise<void>; release: () => void; scans: () => number } {
  const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reportReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { reportReached = resolve; });
  let scans = 0;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === path.resolve(projectsRoot())) {
      scans += 1;
      reportReached();
      await gate;
    }
    return realReaddir(...args);
  }) as unknown as typeof fs.promises.readdir);
  return { reached, release: () => release(), scans: () => scans };
}

/** A clock the test moves by hand; `Date.now` is the only time the locator reads. */
function freezeClock(): { advance: (milliseconds: number) => void } {
  let now = Date.UTC(2026, 9, 27, 20, 0, 0);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { advance: (milliseconds) => { now += milliseconds; } };
}

describe('findClaudeTranscriptFile - the newest copy wins', () => {
  it('returns the newer of two copies in different project folders, whichever folder sorts first', async () => {
    // Two conversations from one listing, so no single "first listed" or "last
    // listed" rule can answer both: A's newer copy is in the folder that sorts
    // last, B's in the folder that sorts first.
    const firstFolderA = transcriptInFolderNamed('aaa-first', AGENT_SESSION_ID);
    const lastFolderA = transcriptInFolderNamed('zzz-last', AGENT_SESSION_ID);
    const firstFolderB = transcriptInFolderNamed('aaa-first', OTHER_SESSION_ID);
    const lastFolderB = transcriptInFolderNamed('zzz-last', OTHER_SESSION_ID);
    for (const filePath of [firstFolderA, lastFolderA, firstFolderB, lastFolderB]) writeFile(filePath);
    setModified(firstFolderA, OLDER);
    setModified(lastFolderA, NEWER);
    setModified(firstFolderB, NEWER);
    setModified(lastFolderB, OLDER);

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(lastFolderA);
    await expect(findClaudeTranscriptFile({ agentSessionId: OTHER_SESSION_ID, cwd: worktree })).resolves.toBe(firstFolderB);
  });

  it('finds the only copy when it sits past the 32nd project folder', async () => {
    const folderCount = PROJECT_SCAN_BATCH + 8;
    const lastFolderName = `-batch-${String(folderCount - 1).padStart(3, '0')}`;
    for (let index = 0; index < folderCount - 1; index++) {
      writeFile(transcriptInFolderNamed(`-batch-${String(index).padStart(3, '0')}`, OTHER_SESSION_ID));
    }
    const hit = transcriptInFolderNamed(lastFolderName);
    writeFile(hit);
    const scans = countSortedProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(hit);
    expect(scans()).toBe(1);
  });

  it('lets a newer copy in a later batch of folders beat an older one in the first batch', async () => {
    const folderCount = PROJECT_SCAN_BATCH + 8;
    for (let index = 1; index < folderCount - 1; index++) {
      writeFile(transcriptInFolderNamed(`-batch-${String(index).padStart(3, '0')}`, OTHER_SESSION_ID));
    }
    const inFirstBatch = transcriptInFolderNamed('-batch-000');
    const inLastBatch = transcriptInFolderNamed(`-batch-${String(folderCount - 1).padStart(3, '0')}`);
    writeFile(inFirstBatch);
    writeFile(inLastBatch);
    setModified(inFirstBatch, OLDER);
    setModified(inLastBatch, NEWER);
    countSortedProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(inLastBatch);
  });

  it('prefers the nearest parent folder when several parents hold the conversation', async () => {
    const nearest = transcriptUnder(path.join(projectRoot, '.kangentic'));
    const farther = transcriptUnder(projectRoot);
    writeFile(nearest);
    writeFile(farther);
    setModified(nearest, OLDER);
    setModified(farther, NEWER);
    const scans = countProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(nearest);
    expect(scans()).toBe(0);
  });
});

describe('findClaudeTranscriptFile - one search and one listing for many lookups', () => {
  it('shares one search between two concurrent finds of the same conversation', async () => {
    const elsewhere = transcriptUnder(path.join(workDir, 'somewhere'));
    writeFile(elsewhere);
    const scans = countProjectScans();
    const stat = vi.spyOn(fs.promises, 'stat');
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    const [first, second] = await Promise.all([findClaudeTranscriptFile(query), findClaudeTranscriptFile(query)]);

    expect(first).toBe(elsewhere);
    expect(second).toBe(elsewhere);
    expect(scans()).toBe(1);
    // The parent-folder step stats the project root's slug once per search that
    // runs it. The listing itself is shared either way, so this count is what
    // tells one search from two.
    const rootSlugStats = stat.mock.calls.filter((call) => String(call[0]) === transcriptUnder(projectRoot));
    expect(rootSlugStats).toHaveLength(1);
  });

  it('answers many distinct conversations from one listing of the projects folder', async () => {
    const present = transcriptUnder(path.join(workDir, 'somewhere'), LATE_SESSION_ID);
    writeFile(present);
    freezeClock();
    const scans = countProjectScans();

    for (const agentSessionId of MISSING_SESSION_IDS) {
      await expect(findClaudeTranscriptFile({ agentSessionId, cwd: worktree })).resolves.toBeNull();
    }
    await expect(findClaudeTranscriptFile({ agentSessionId: LATE_SESSION_ID, cwd: worktree })).resolves.toBe(present);

    expect(scans()).toBe(1);
  });

  it('lists the projects folder again for a new conversation once the 30 s listing has expired', async () => {
    writeFile(transcriptUnder(path.join(workDir, 'unrelated'), OTHER_SESSION_ID));
    const clock = freezeClock();
    const scans = countProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBeNull();
    expect(scans()).toBe(1);

    // Written after the listing, so only a fresh listing can show it.
    const late = transcriptUnder(path.join(workDir, 'late'), LATE_SESSION_ID);
    writeFile(late);

    clock.advance(29_000);
    await expect(findClaudeTranscriptFile({ agentSessionId: MISSING_SESSION_IDS[0], cwd: worktree })).resolves.toBeNull();
    expect(scans()).toBe(1);

    clock.advance(2_000);
    await expect(findClaudeTranscriptFile({ agentSessionId: LATE_SESSION_ID, cwd: worktree })).resolves.toBe(late);
    expect(scans()).toBe(2);
  });
});

describe('findClaudeTranscriptFile - the cache of an earlier find', () => {
  it('returns an earlier find without listing again, even after the listing expired', async () => {
    const elsewhere = transcriptUnder(path.join(workDir, 'somewhere'));
    writeFile(elsewhere);
    const clock = freezeClock();
    const scans = countProjectScans();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(findClaudeTranscriptFile(query)).resolves.toBe(elsewhere);
    expect(scans()).toBe(1);

    clock.advance(60_000);
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(elsewhere);
    expect(scans()).toBe(1);
  });

  it('lists the folders again, inside the 30 s window, when a found file was deleted and moved', async () => {
    const first = transcriptUnder(path.join(workDir, 'first'));
    writeFile(first);
    freezeClock();
    const scans = countProjectScans();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(first);
    expect(scans()).toBe(1);

    fs.rmSync(first);
    const second = transcriptUnder(path.join(workDir, 'second'));
    writeFile(second);

    // No time has passed, so only dropping the old listing can show the new file.
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(second);
    expect(scans()).toBe(2);
  });

  it('drops the listing too when a peek finds the cached file gone', async () => {
    const first = transcriptUnder(path.join(workDir, 'first'));
    writeFile(first);
    freezeClock();
    const scans = countProjectScans();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(first);

    fs.rmSync(first);
    const second = transcriptUnder(path.join(workDir, 'second'));
    writeFile(second);

    // The peek notices the vanished file, forgets it, and starts the find that
    // the next call joins.
    expect(peekClaudeTranscriptFile(query)).toBe(locateClaudeTranscriptFile(AGENT_SESSION_ID, worktree));
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(second);
    expect(scans()).toBe(2);
  });
});

describe('findClaudeTranscriptFile - the path Claude reported must be a transcript in a projects folder', () => {
  const ignoredShapes: Array<{ name: string; reportedPathFor: (folder: string) => string }> = [
    { name: 'outside any projects folder', reportedPathFor: (folder) => path.join(folder, 'elsewhere', FILE_NAME) },
    { name: 'directly in a projects folder, with no project folder between', reportedPathFor: (folder) => path.join(folder, 'projects', FILE_NAME) },
    { name: 'nested below a project folder', reportedPathFor: (folder) => path.join(folder, 'projects', '-slug', 'nested', FILE_NAME) },
    { name: 'named .json instead of .jsonl', reportedPathFor: (folder) => path.join(folder, 'projects', '-slug', `${AGENT_SESSION_ID}.json`) },
  ];

  for (const shape of ignoredShapes) {
    it(`ignores a reported file that is present but ${shape.name}, and returns the real one`, async () => {
      const real = transcriptUnder(worktree);
      writeFile(real);
      const reportedPath = shape.reportedPathFor(workDir);
      writeFile(reportedPath);

      await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath })).resolves.toBe(real);
    });
  }

  it('is used from any config folder\'s projects folder, not only the home one', async () => {
    const stale = transcriptUnder(worktree);
    writeFile(stale, '{"stale":true}\n');
    const reportedPath = path.join(workDir, 'custom-config', 'projects', '-some-slug', FILE_NAME);
    writeFile(reportedPath);

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath })).resolves.toBe(reportedPath);
  });

  it('ignores a Linux path reported with no place when it does not exist here', async () => {
    const real = transcriptUnder(worktree);
    writeFile(real);
    const reportedPath = `/kangentic-test-absent/projects/-slug/${FILE_NAME}`;

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath })).resolves.toBe(real);
  });
});

/** A place whose share root is a plain temp folder, so a mapped Linux path lands in it. */
function wslPlaceSharing(shareRoot: string): CliPlace {
  return {
    kind: 'wsl',
    distro: 'Ubuntu',
    facts: {
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc: path.join(shareRoot, 'home', 'dev'),
      uncRoot: shareRoot,
      interactivePath: '',
      env: {},
      networkingMode: 'unknown',
    },
  };
}

// hostPathForTarget joins the share root to the Linux path with backslashes,
// which only reads back as a path on Windows, the one host WSL runs on.
describe.runIf(process.platform === 'win32')('findClaudeTranscriptFile - a path reported from a WSL place', () => {
  it('maps a Linux path through the distro share to the host file', async () => {
    const shareRoot = path.join(workDir, 'distro-share');
    const place = wslPlaceSharing(shareRoot);
    // Another config folder than the place's own home, so the scan of the home's
    // projects folder cannot turn the file up: only the mapped report can.
    const mapped = path.join(shareRoot, 'srv', 'claude-config', 'projects', '-home-dev-proj', FILE_NAME);
    writeFile(mapped);
    const reportedPath = `/srv/claude-config/projects/-home-dev-proj/${FILE_NAME}`;

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, place, reportedPath })).resolves.toBe(mapped);
    // The same report for this machine names a path that is not here.
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath })).resolves.toBeNull();
  });

  it.skipIf(!/^[a-zA-Z]:\\/.test(os.tmpdir()))('maps a drive mount path back to its drive', async () => {
    const shareRoot = path.join(workDir, 'distro-share');
    const place = wslPlaceSharing(shareRoot);
    const real = path.join(workDir, 'other-config', 'projects', '-slug', FILE_NAME);
    writeFile(real);
    const driveLetter = workDir.slice(0, 1);
    const afterDrive = workDir.slice(3).split(path.sep).join('/');
    const reportedPath = `/mnt/${driveLetter.toLowerCase()}/${afterDrive}/other-config/projects/-slug/${FILE_NAME}`;

    // The mapping writes the drive letter in capitals.
    const expected = `${driveLetter.toUpperCase()}${real.slice(1)}`;
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, place, reportedPath })).resolves.toBe(expected);
  });
});

describe('peekClaudeTranscriptFile - when it starts a find', () => {
  it('starts a find for a conversation it cannot place (the control for the cases below)', async () => {
    const stat = vi.spyOn(fs.promises, 'stat');
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    peekClaudeTranscriptFile(query);
    // The find reaches its first async stat before it yields, so this needs no wait.
    expect(stat).toHaveBeenCalled();

    // Let the find it started finish before the test ends.
    await findClaudeTranscriptFile(query);
  });

  it('starts no find while a miss is remembered, and starts one again when the miss expires', async () => {
    writeFile(transcriptUnder(path.join(workDir, 'unrelated'), OTHER_SESSION_ID));
    const clock = freezeClock();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBeNull();

    // Spies from here on see only what the peek starts: the peek's own stats
    // are synchronous (`fs.statSync`), and a find's are `fs.promises.stat`.
    const stat = vi.spyOn(fs.promises, 'stat');
    const scans = countProjectScans();
    expect(peekClaudeTranscriptFile(query)).toBe(locateClaudeTranscriptFile(AGENT_SESSION_ID, worktree));
    expect(stat).not.toHaveBeenCalled();

    clock.advance(31_000);
    peekClaudeTranscriptFile(query);
    expect(stat).toHaveBeenCalled();

    // Let the find it started finish before the test ends.
    await findClaudeTranscriptFile(query);
    expect(scans()).toBe(1);
  });

  it('starts no second find while a search is in flight', async () => {
    writeFile(transcriptUnder(path.join(workDir, 'unrelated'), OTHER_SESSION_ID));
    const listing = holdProjectsListing();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    const search = findClaudeTranscriptFile(query);
    await listing.reached;

    const stat = vi.spyOn(fs.promises, 'stat');
    peekClaudeTranscriptFile(query);
    expect(stat).not.toHaveBeenCalled();

    listing.release();
    await expect(search).resolves.toBeNull();
    expect(listing.scans()).toBe(1);
  });
});

describe('findClaudeResumeTranscriptFile - only the cwd and its parent folders', () => {
  it('returns the cwd file, and prefers it to a parent folder\'s', async () => {
    const atCwd = transcriptUnder(worktree);
    writeFile(atCwd);
    writeFile(transcriptUnder(projectRoot));

    await expect(findClaudeResumeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(atCwd);
  });

  it('returns a parent folder\'s file without listing the projects folder', async () => {
    const atRoot = transcriptUnder(projectRoot);
    writeFile(atRoot);
    const scans = countProjectScans();

    await expect(findClaudeResumeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(atRoot);
    expect(scans()).toBe(0);
  });

  it('returns the nearest parent folder\'s file when several parents hold the conversation', async () => {
    const nearest = transcriptUnder(path.join(projectRoot, '.kangentic'));
    writeFile(nearest);
    writeFile(transcriptUnder(projectRoot));

    await expect(findClaudeResumeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(nearest);
  });

  it('returns null for a file under a sibling folder\'s slug, which the general find does find', async () => {
    const sibling = path.join(projectRoot, '.kangentic', 'worktrees', '917');
    const underSibling = transcriptUnder(sibling);
    writeFile(underSibling);
    const scans = countProjectScans();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(findClaudeResumeTranscriptFile(query)).resolves.toBeNull();
    expect(scans()).toBe(0);
    // The control: the same file is the conversation's, and the full search reaches it.
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(underSibling);
  });

  it('ignores a reported path', async () => {
    const reportedPath = transcriptUnder(path.join(workDir, 'somewhere'));
    writeFile(reportedPath);
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(findClaudeResumeTranscriptFile({ ...query, reportedPath })).resolves.toBeNull();
    await expect(findClaudeTranscriptFile({ ...query, reportedPath })).resolves.toBe(reportedPath);
  });
});

type LinkKind = 'directory' | 'file';

/** True when the link was made; false when this machine may not make that kind of link (Windows without developer mode). */
function tryCreateLink(target: string, linkPath: string, kind: LinkKind): boolean {
  const linkType = kind === 'file' ? 'file' : (process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.symlinkSync(target, linkPath, linkType);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

/** Whether links of `kind` can be made here, found out once at load because `it.skipIf` reads it then. */
function canCreateLinks(kind: LinkKind): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-link-probe-'));
  try {
    const target = path.join(probeDir, 'target');
    if (kind === 'file') fs.writeFileSync(target, '');
    else fs.mkdirSync(target);
    return tryCreateLink(target, path.join(probeDir, 'link'), kind);
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const canLinkDirectories = canCreateLinks('directory');
const canLinkFiles = canCreateLinks('file');

describe('listClaudeProjectFolders', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(workDir, 'projects-root');
  });

  it('returns null for a projects folder that does not exist', async () => {
    await expect(listClaudeProjectFolders(root)).resolves.toBeNull();
  });

  it('returns null when the projects folder is a file', async () => {
    writeFile(root);
    await expect(listClaudeProjectFolders(root)).resolves.toBeNull();
  });

  it('includes a directory and leaves out a loose file', async () => {
    fs.mkdirSync(path.join(root, 'a-folder'), { recursive: true });
    writeFile(path.join(root, 'notes.txt'));

    await expect(listClaudeProjectFolders(root)).resolves.toEqual([path.join(root, 'a-folder')]);
  });

  it.skipIf(!canLinkDirectories)('includes a link to a directory', async () => {
    const target = path.join(workDir, 'link-target');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const link = path.join(root, 'linked-folder');
    expect(tryCreateLink(target, link, 'directory')).toBe(true);

    await expect(listClaudeProjectFolders(root)).resolves.toEqual([link]);
  });

  it.skipIf(!canLinkFiles)('leaves out a link to a file, which can hold no transcript', async () => {
    const target = path.join(workDir, 'link-target.txt');
    writeFile(target);
    fs.mkdirSync(path.join(root, 'a-folder'), { recursive: true });
    expect(tryCreateLink(target, path.join(root, 'linked-file'), 'file')).toBe(true);

    await expect(listClaudeProjectFolders(root)).resolves.toEqual([path.join(root, 'a-folder')]);
  });
});
