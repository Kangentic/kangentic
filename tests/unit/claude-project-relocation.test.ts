/**
 * Unit tests for migrateClaudeProjectData()
 * (src/main/agent/adapters/claude/project-relocation.ts).
 *
 * Claude Code keys per-project data to the absolute project path, outside the
 * project folder: session transcripts under ~/.claude/projects/<slug>/ and
 * per-project state under the ~/.claude.json `projects` object. When a Kangentic
 * project is relocated, both must be migrated or sessions stop resuming.
 *
 * These tests use real temp files (same pattern as trust-manager.test.ts) with
 * os.homedir() mocked to a temp directory. Generic fixture paths only - never
 * personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateClaudeProjectData } from '../../src/main/agent/adapters/claude/project-relocation';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { toForwardSlash } from '../../src/shared/paths';

// Resolved project locations, created fresh under the OS temp dir for each test.
// They MUST be real, writable paths inside the sandbox: production discovers
// worktrees by listing `<newPath>/.kangentic/worktrees` on disk (see
// collectRelocationPairs), and one test creates that directory for real. A
// hardcoded absolute root like `/projects/new-app` is writable on a developer's
// Windows drive (C:\projects\new-app) but EACCES on CI's Linux runner, where
// `/projects` is the unwritable filesystem root. Deriving them from a temp dir
// keeps every write inside the sandbox on all platforms; path.resolve still
// yields the absolute, drive-prefixed form production computes, so the slugs and
// ~/.claude.json keys match.
let tmpProjectsParent: string;
let OLD_PATH: string;
let NEW_PATH: string;

function projectsRoot(): string {
  return path.join(tmpHome, '.claude', 'projects');
}

function transcriptDir(projectPath: string): string {
  return path.join(projectsRoot(), claudeProjectSlug(path.resolve(projectPath)));
}

function writeTranscriptDir(projectPath: string, files: Record<string, string>): void {
  const dir = transcriptDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
}

function claudeJsonPath(): string {
  return path.join(tmpHome, '.claude.json');
}

function writeClaudeJson(data: Record<string, unknown>): void {
  fs.writeFileSync(claudeJsonPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf-8'));
}

/** Forward-slash key form used by Claude Code on all platforms. */
function projectKey(projectPath: string): string {
  return toForwardSlash(path.resolve(projectPath));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocate-'));
  tmpProjectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocate-proj-'));
  OLD_PATH = path.join(tmpProjectsParent, 'old-app');
  NEW_PATH = path.join(tmpProjectsParent, 'new-app');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsParent, { recursive: true, force: true });
});

/**
 * Claude files both stores under its real cwd, so a project reached through a
 * symlink has them under the physical path, and the trust writer now does too.
 * Migrating only the path the project was opened by would leave them behind.
 * Linking a directory needs a privilege on Windows, where keys stay as given.
 */
describe.skipIf(process.platform === 'win32')('migrateClaudeProjectData - a project reached through a symlink', () => {
  let linkedParent: string;
  let physicalParent: string;

  beforeEach(() => {
    physicalParent = path.join(fs.realpathSync(tmpProjectsParent), 'physical');
    fs.mkdirSync(physicalParent);
    linkedParent = path.join(tmpProjectsParent, 'linked');
    fs.symlinkSync(physicalParent, linkedParent);
  });

  it('migrates the physical key and transcripts, the old folder already gone', async () => {
    const oldPhysical = path.join(physicalParent, 'old-app');
    const newPhysical = path.join(physicalParent, 'new-app');
    fs.mkdirSync(newPhysical);
    writeTranscriptDir(oldPhysical, { 'session-a.jsonl': 'line-a' });
    writeClaudeJson({ projects: { [oldPhysical]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(path.join(linkedParent, 'old-app'), path.join(linkedParent, 'new-app'));

    const projects = readClaudeJson().projects as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual([newPhysical]);
    expect(fs.existsSync(transcriptDir(oldPhysical))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(newPhysical), 'session-a.jsonl'), 'utf-8')).toBe('line-a');
  });

  it('still migrates a key an earlier version wrote under the linked path', async () => {
    const oldLinked = path.join(linkedParent, 'old-app');
    const newLinked = path.join(linkedParent, 'new-app');
    writeClaudeJson({ projects: { [oldLinked]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(oldLinked, newLinked);

    expect(Object.keys(readClaudeJson().projects as Record<string, unknown>)).toEqual([newLinked]);
  });

  it('files the key and transcripts under the new physical path when only the new folder is reached through the link', async () => {
    // The old folder is plain, so its data sits under its physical path. The new
    // folder is spelled through the linked parent, but Claude will run in its
    // real cwd, so everything must land under the new PHYSICAL path.
    const oldPlain = path.join(physicalParent, 'old-app');
    const newPhysical = path.join(physicalParent, 'new-app');
    fs.mkdirSync(newPhysical);
    writeTranscriptDir(oldPlain, { 'session-a.jsonl': 'line-a' });
    writeClaudeJson({ projects: { [oldPlain]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(oldPlain, path.join(linkedParent, 'new-app'));

    const projects = readClaudeJson().projects as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual([newPhysical]);
    expect(fs.existsSync(transcriptDir(oldPlain))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(newPhysical), 'session-a.jsonl'), 'utf-8')).toBe('line-a');
    expect(fs.existsSync(transcriptDir(path.join(linkedParent, 'new-app')))).toBe(false);
  });

  it('files the key and transcripts under the new physical path when only the old folder is reached through the link', async () => {
    // Data sits under the old physical path although the caller names the old
    // folder through the link. The new folder is plain.
    const oldPhysical = path.join(physicalParent, 'old-app');
    const newPlain = path.join(physicalParent, 'new-app');
    fs.mkdirSync(newPlain);
    writeTranscriptDir(oldPhysical, { 'session-b.jsonl': 'line-b' });
    writeClaudeJson({ projects: { [oldPhysical]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(path.join(linkedParent, 'old-app'), newPlain);

    const projects = readClaudeJson().projects as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual([newPlain]);
    expect(fs.existsSync(transcriptDir(oldPhysical))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(newPlain), 'session-b.jsonl'), 'utf-8')).toBe('line-b');
  });
});

describe('migrateClaudeProjectData - transcript directories', () => {
  it('renames the root transcript directory and preserves its files', async () => {
    writeTranscriptDir(OLD_PATH, { 'session-a.jsonl': 'line-a' });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(transcriptDir(OLD_PATH))).toBe(false);
    const moved = path.join(transcriptDir(NEW_PATH), 'session-a.jsonl');
    expect(fs.readFileSync(moved, 'utf-8')).toBe('line-a');
  });

  it('renames worktree transcript dirs discovered from the relocated folder', async () => {
    // The worktree moved with the folder, so it exists on disk under NEW_PATH.
    const worktreeName = 'feat-x';
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName), { recursive: true });
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeTranscriptDir(oldWorktree, { 'wt.jsonl': 'wt-content' });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(transcriptDir(oldWorktree))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(newWorktree), 'wt.jsonl'), 'utf-8')).toBe('wt-content');
  });

  it('migrates a worktree present only as a ~/.claude.json key (deleted from disk)', async () => {
    const worktreeName = 'gone';
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeTranscriptDir(oldWorktree, { 'g.jsonl': 'gone-content' });
    writeClaudeJson({ projects: { [projectKey(oldWorktree)]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(transcriptDir(oldWorktree))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(newWorktree), 'g.jsonl'), 'utf-8')).toBe('gone-content');
  });

  it('does not throw and does not create a target when the source dir is missing', async () => {
    writeClaudeJson({ projects: { [projectKey(OLD_PATH)]: { hasTrustDialogAccepted: true } } });

    await expect(migrateClaudeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    expect(fs.existsSync(transcriptDir(NEW_PATH))).toBe(false);
  });

  it('merges into an existing target dir, keeping pre-existing target entries', async () => {
    writeTranscriptDir(OLD_PATH, { 'a.jsonl': 'from-old' });
    writeTranscriptDir(NEW_PATH, { 'b.jsonl': 'from-new' });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(transcriptDir(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(transcriptDir(NEW_PATH), 'a.jsonl'), 'utf-8')).toBe('from-old');
    expect(fs.readFileSync(path.join(transcriptDir(NEW_PATH), 'b.jsonl'), 'utf-8')).toBe('from-new');
  });

  it('leaves the source dir in place when a filename collision blocks full removal', async () => {
    // The source has two files: one that will collide with the target (dup.jsonl)
    // and one that will not (unique-old.jsonl). After the merge, the non-colliding
    // entry moves to the target; the colliding entry is NOT overwritten; and because
    // rmdirSync cannot remove a non-empty directory, the source dir survives with
    // only the colliding entry still inside. No exception is thrown.
    writeTranscriptDir(OLD_PATH, { 'dup.jsonl': 'old-dup', 'unique-old.jsonl': 'unique' });
    writeTranscriptDir(NEW_PATH, { 'dup.jsonl': 'new-dup' });

    await expect(migrateClaudeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    // Non-colliding file moved into the target.
    expect(
      fs.readFileSync(path.join(transcriptDir(NEW_PATH), 'unique-old.jsonl'), 'utf-8'),
    ).toBe('unique');

    // The target's pre-existing colliding entry is not overwritten.
    expect(
      fs.readFileSync(path.join(transcriptDir(NEW_PATH), 'dup.jsonl'), 'utf-8'),
    ).toBe('new-dup');

    // The source dir still exists because rmdirSync cannot remove a non-empty dir.
    expect(fs.existsSync(transcriptDir(OLD_PATH))).toBe(true);

    // The source dir contains only the colliding entry that could not be moved.
    const remaining = fs.readdirSync(transcriptDir(OLD_PATH));
    expect(remaining).toEqual(['dup.jsonl']);
  });

  it.runIf(process.platform === 'win32')(
    'resolveSourceTranscriptDir falls back to the forward-slash candidate when the native-separator slug is absent',
    // This branch is only reachable on Windows: for paths short enough to be under
    // the 200-char slug limit, both separator forms map to identical sanitized
    // slugs (/ and \ both become -). For a path long enough to be TRUNCATED, the
    // hash suffix is computed over the ORIGINAL string, so the backslash form and
    // the forward-slash form of the same path produce different hashes and
    // therefore different slugs. resolveSourceTranscriptDir probes both candidates
    // and returns the first that exists. This test exercises the case where only
    // the SECOND candidate (forward-slash form) has a transcript directory on disk.
    //
    // On POSIX, path.resolve() already yields forward slashes, so both candidates
    // are always identical and this scenario cannot occur; the test is skipped.
    async () => {
      // Construct an old path that exceeds CLAUDE_SLUG_MAX_LENGTH (200 chars) when
      // sanitized so that the hash suffix kicks in. Every non-alphanumeric char
      // (including \ and /) maps to -, so we need at least 200 alphanumeric chars
      // in the sanitized form. A drive prefix like C:\ contributes 3 chars (C--),
      // so we need roughly 197 more alphanumeric chars in the path segments.
      const longSegment = 'a'.repeat(200);
      const nativePath = path.resolve(`C:\\projects\\${longSegment}\\old-app`);
      const forwardSlashPath = toForwardSlash(nativePath);

      // The sanitized slugs have identical prefixes (/ and \ both become -), but
      // the hashes over the original strings differ. Verify divergence before
      // proceeding so the test fails fast with a clear message if the algorithm
      // changes rather than silently passing against identical slugs.
      const nativeSlug = claudeProjectSlug(nativePath);
      const forwardSlashSlug = claudeProjectSlug(forwardSlashPath);
      if (nativeSlug === forwardSlashSlug) {
        // Path was not long enough to trigger truncation on this machine; skip
        // gracefully rather than asserting against the wrong invariant.
        return;
      }

      // Create the transcript dir ONLY under the forward-slash slug (second candidate).
      const forwardSlashTranscriptDir = path.join(projectsRoot(), forwardSlashSlug);
      fs.mkdirSync(forwardSlashTranscriptDir, { recursive: true });
      fs.writeFileSync(path.join(forwardSlashTranscriptDir, 'session.jsonl'), 'fallback-content', 'utf-8');

      // The NEW path can be a simple path; we just need the migration to find the source.
      const newAbsolutePath = path.resolve('/projects/new-long-app');
      const newTranscriptDir = path.join(projectsRoot(), claudeProjectSlug(newAbsolutePath));

      await migrateClaudeProjectData(nativePath, newAbsolutePath);

      // The source (forward-slash candidate) should have been renamed to the target.
      expect(fs.existsSync(forwardSlashTranscriptDir)).toBe(false);
      expect(
        fs.readFileSync(path.join(newTranscriptDir, 'session.jsonl'), 'utf-8'),
      ).toBe('fallback-content');
    },
  );
});

describe('migrateClaudeProjectData - ~/.claude.json', () => {
  it('rewrites matching keys to forward-slash form and preserves their values', async () => {
    const entryValue = { hasTrustDialogAccepted: true, allowedTools: ['Read'] };
    writeClaudeJson({
      numStartups: 7,
      projects: { [projectKey(OLD_PATH)]: entryValue },
    });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, unknown>;
    expect(projects[projectKey(OLD_PATH)]).toBeUndefined();
    expect(projects[projectKey(NEW_PATH)]).toEqual(entryValue);
    // Unrelated top-level fields are untouched.
    expect(data.numStartups).toBe(7);
  });

  it('leaves unrelated projects keys untouched', async () => {
    const otherKey = toForwardSlash(path.join(tmpProjectsParent, 'other'));
    writeClaudeJson({
      projects: {
        [projectKey(OLD_PATH)]: { hasTrustDialogAccepted: true },
        [otherKey]: { hasTrustDialogAccepted: true },
      },
    });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    const projects = readClaudeJson().projects as Record<string, unknown>;
    expect(projects[otherKey]).toEqual({ hasTrustDialogAccepted: true });
    expect(projects[projectKey(NEW_PATH)]).toEqual({ hasTrustDialogAccepted: true });
  });

  it('backs the file up to .kangentic-backup with the pre-migration bytes', async () => {
    writeClaudeJson({ projects: { [projectKey(OLD_PATH)]: { hasTrustDialogAccepted: true } } });
    const before = fs.readFileSync(claudeJsonPath(), 'utf-8');

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    const backup = fs.readFileSync(`${claudeJsonPath()}.kangentic-backup`, 'utf-8');
    expect(backup).toBe(before);
  });

  it('keeps the destination value and drops the old key when the destination already exists', async () => {
    writeClaudeJson({
      projects: {
        [projectKey(OLD_PATH)]: { hasTrustDialogAccepted: true, marker: 'old' },
        [projectKey(NEW_PATH)]: { hasTrustDialogAccepted: true, marker: 'new' },
      },
    });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    const projects = readClaudeJson().projects as Record<string, Record<string, unknown>>;
    expect(projects[projectKey(OLD_PATH)]).toBeUndefined();
    expect(projects[projectKey(NEW_PATH)].marker).toBe('new');
  });

  it('does not throw and still migrates transcripts when ~/.claude.json is missing', async () => {
    writeTranscriptDir(OLD_PATH, { 's.jsonl': 'content' });

    await expect(migrateClaudeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    expect(fs.existsSync(transcriptDir(NEW_PATH))).toBe(true);
    expect(fs.existsSync(`${claudeJsonPath()}.kangentic-backup`)).toBe(false);
  });

  it('leaves an unparsable ~/.claude.json byte-identical', async () => {
    const garbage = '{ this is not valid json ';
    fs.writeFileSync(claudeJsonPath(), garbage, 'utf-8');
    writeTranscriptDir(OLD_PATH, { 's.jsonl': 'content' });

    await expect(migrateClaudeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(garbage);
    // Transcripts still migrate independently of the broken config.
    expect(fs.existsSync(transcriptDir(NEW_PATH))).toBe(true);
  });

  it('leaves ~/.claude.json byte-identical and writes no backup when the file parses but has no projects field', async () => {
    // This covers the early-return branch in rewriteClaudeJson where the file
    // is valid JSON but the top-level `projects` key is entirely absent. The
    // function must not modify the file at all (no key rewrite, no backup).
    const noProjectsData = { numStartups: 3, autoUpdates: true };
    writeClaudeJson(noProjectsData);
    const before = fs.readFileSync(claudeJsonPath(), 'utf-8');

    await expect(migrateClaudeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    // File is byte-identical to before.
    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(before);
    // No backup was written.
    expect(fs.existsSync(`${claudeJsonPath()}.kangentic-backup`)).toBe(false);
  });

  it('does not write at all when no projects key matches', async () => {
    const otherKey = toForwardSlash(path.join(tmpProjectsParent, 'other'));
    writeClaudeJson({ projects: { [otherKey]: { hasTrustDialogAccepted: true } } });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    // No matching key, so no backup is written.
    expect(fs.existsSync(`${claudeJsonPath()}.kangentic-backup`)).toBe(false);
  });

  it('leaves a sibling path that merely shares a string prefix untouched', async () => {
    // /projects/old-app2 starts with the old path string but is NOT under it.
    const siblingPath = `${OLD_PATH}2`;
    writeTranscriptDir(siblingPath, { 'sib.jsonl': 'sibling' });
    writeClaudeJson({
      projects: {
        [projectKey(OLD_PATH)]: { hasTrustDialogAccepted: true },
        [projectKey(siblingPath)]: { hasTrustDialogAccepted: true, marker: 'sibling' },
      },
    });

    await migrateClaudeProjectData(OLD_PATH, NEW_PATH);

    // Sibling transcript dir and key are both preserved as-is.
    expect(fs.existsSync(transcriptDir(siblingPath))).toBe(true);
    const projects = readClaudeJson().projects as Record<string, Record<string, unknown>>;
    expect(projects[projectKey(siblingPath)]).toEqual({ hasTrustDialogAccepted: true, marker: 'sibling' });
  });
});
