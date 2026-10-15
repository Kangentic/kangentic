/**
 * `proveClaudeConversationGone` directly: the proof that Claude can no longer
 * resume a conversation. It answers true only when the transcript is gone from
 * every place Claude could look, and false on anything short of proof, which
 * resumes exactly as before.
 *
 * Layout used below (all under one mkdtemp folder):
 *
 *  - `claude-projects/` stands in for `~/.claude/projects`, the root derived
 *    from the reported path. It holds one folder per project.
 *  - `home/` is what `os.homedir()` returns, so the cwd locator
 *    (`locateClaudeTranscriptFile`) looks under `home/.claude/projects/`, a
 *    root that is deliberately NOT the one the folder scan reads. That keeps
 *    each negative case honest: only the step under test can return false.
 *
 * Every negative case ends with a control that removes the thing that made it
 * negative and expects true, so a false never comes from another step.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';
import { locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';

const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';
const OTHER_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000000';
const TRANSCRIPT_FILE_NAME = `${AGENT_SESSION_ID}.jsonl`;
const TRANSCRIPT_BODY = '{"type":"user"}\n';

let workDir: string;
let tempHome: string;
/** Stands in for `~/.claude/projects`: the root the folder scan reads. */
let projectsRoot: string;
/** Absolute, names this conversation's file, and the file is not on disk. */
let reportedPath: string;
let cwd: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-conversation-gone-'));
  tempHome = path.join(workDir, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  projectsRoot = path.join(workDir, 'claude-projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  reportedPath = path.join(projectsRoot, '-work-project', TRANSCRIPT_FILE_NAME);
  cwd = path.join(workDir, 'work-project');
  // Every case runs against a temp home, so the real ~/.claude never decides one.
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function prove(reportedPaths: ReadonlyArray<string> = [reportedPath]): Promise<boolean> {
  return proveClaudeConversationGone({ agentSessionId: AGENT_SESSION_ID, reportedPaths, cwd });
}

function writeTranscript(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, TRANSCRIPT_BODY, 'utf8');
}

describe('proveClaudeConversationGone - the baseline the negative cases flip', () => {
  it('is true when the reported file is gone and no project folder holds it', async () => {
    await expect(prove()).resolves.toBe(true);
  });

  it('is true with sibling project folders that do not hold the file', async () => {
    fs.mkdirSync(path.join(projectsRoot, '-work-project-renamed'));
    fs.mkdirSync(path.join(projectsRoot, '-other-project'));
    await expect(prove()).resolves.toBe(true);
  });

  it('is true with a stray non-folder entry in the projects root', async () => {
    // Only folders can hold a transcript. A loose file (a stray marker, an
    // editor backup) must not block the proof.
    fs.writeFileSync(path.join(projectsRoot, 'notes.txt'), 'stray', 'utf8');
    await expect(prove()).resolves.toBe(true);
  });

  it('is false with no reported paths at all', async () => {
    await expect(prove([])).resolves.toBe(false);
  });
});

describe('proveClaudeConversationGone - the cwd locator path', () => {
  it('is false when the locator path for the cwd exists while the reported path is gone', async () => {
    // The adapter itself would look here first. A file at this path means the
    // conversation resumes, whatever the reported path says.
    const locatorPath = locateClaudeTranscriptFile(AGENT_SESSION_ID, cwd);
    expect(locatorPath.startsWith(tempHome)).toBe(true);
    // The locator's projects root is not the one the folder scan reads, so the
    // scan cannot be what answers false.
    expect(path.dirname(path.dirname(locatorPath))).not.toBe(projectsRoot);
    writeTranscript(locatorPath);
    expect(fs.existsSync(reportedPath)).toBe(false);

    await expect(prove()).resolves.toBe(false);

    // Control: with the locator's file removed the same call proves it gone.
    fs.rmSync(locatorPath);
    await expect(prove()).resolves.toBe(true);
  });
});

describe('proveClaudeConversationGone - the folder scan batches', () => {
  // The scan stats 32 folders at a time. 70 folders is three batches (32, 32,
  // 6), and the positions below sit on both sides of each batch boundary.
  const FOLDER_COUNT = 70;
  const LAST_POSITION = FOLDER_COUNT - 1;

  /** Creates the folders and returns their names in the order the scan lists them. */
  function createSiblingFolders(): string[] {
    for (let index = 0; index < FOLDER_COUNT; index++) {
      fs.mkdirSync(path.join(projectsRoot, `-sibling-${String(index).padStart(3, '0')}`));
    }
    // readdir order is the OS's (hash order on ext4), so position in the scan
    // comes from the listing itself, never from the folder names.
    const listing = fs.readdirSync(projectsRoot);
    expect(listing).toHaveLength(FOLDER_COUNT);
    return listing;
  }

  it('is true when the file is in none of the folders', async () => {
    createSiblingFolders();
    await expect(prove()).resolves.toBe(true);
  });

  it.each([0, 31, 32, 63, 64, LAST_POSITION])(
    'is false when the only copy sits at scan position %i of 70 project folders',
    async (position) => {
      const listing = createSiblingFolders();
      const holder = path.join(projectsRoot, listing[position], TRANSCRIPT_FILE_NAME);
      writeTranscript(holder);

      await expect(prove()).resolves.toBe(false);

      // Control: with the file removed the same 70 folders prove it gone.
      fs.rmSync(holder);
      await expect(prove()).resolves.toBe(true);
    },
  );
});

describe('proveClaudeConversationGone - a symlinked or junctioned project folder', () => {
  it('is false when a linked project folder holds the file', async () => {
    // A user who moved their project folders elsewhere and linked them back in.
    // The directory entry of a link reads as a link, not as a directory, and the
    // stat of the file inside follows it. The target sits outside the projects
    // root, so the only way the scan sees the file is through the link.
    const linkTarget = path.join(workDir, 'moved-project-folder');
    fs.mkdirSync(linkTarget);
    const holder = path.join(linkTarget, TRANSCRIPT_FILE_NAME);
    fs.writeFileSync(holder, TRANSCRIPT_BODY, 'utf8');
    const linkPath = path.join(projectsRoot, '-linked-project');
    // 'junction' needs no privilege on Windows and is ignored on POSIX, where
    // this makes an ordinary symlink.
    fs.symlinkSync(linkTarget, linkPath, 'junction');

    const linkEntry = fs.readdirSync(projectsRoot, { withFileTypes: true }).find((entry) => entry.name === '-linked-project');
    expect(linkEntry?.isSymbolicLink()).toBe(true);
    expect(linkEntry?.isDirectory()).toBe(false);

    await expect(prove()).resolves.toBe(false);

    // Control: the link is still there, but empty, so the conversation is gone.
    fs.rmSync(holder);
    await expect(prove()).resolves.toBe(true);
  });
});

describe('proveClaudeConversationGone - only an absolute reported path names a file', () => {
  // A relative path would resolve against Kangentic's own working folder, which
  // has nothing to do with where Claude wrote the transcript. Bare and one-level
  // paths make the projects root resolve to that working folder (a readable
  // folder holding no such file), so they would read as gone if a relative path
  // were accepted.
  it.each([
    ['a bare file name', TRANSCRIPT_FILE_NAME],
    ['one folder deep', path.join('-work-project', TRANSCRIPT_FILE_NAME)],
    ['two folders deep', path.join('some', 'dir', TRANSCRIPT_FILE_NAME)],
  ])('is false for a relative reported path (%s)', async (_label, relativePath) => {
    expect(path.isAbsolute(relativePath)).toBe(false);
    await expect(prove([relativePath])).resolves.toBe(false);
  });

  it('does not let a relative path hide an absolute one that exists', async () => {
    writeTranscript(reportedPath);
    await expect(prove([TRANSCRIPT_FILE_NAME, reportedPath])).resolves.toBe(false);
  });

  it('is false when the only absolute path names another conversation (a record from before a /clear fork)', async () => {
    const otherConversationPath = path.join(projectsRoot, '-work-project', `${OTHER_SESSION_ID}.jsonl`);
    await expect(prove([otherConversationPath])).resolves.toBe(false);
  });

  it('skips a path that names another conversation and judges the one that names this one', async () => {
    const otherConversationPath = path.join(projectsRoot, '-work-project', `${OTHER_SESSION_ID}.jsonl`);
    await expect(prove([otherConversationPath, reportedPath])).resolves.toBe(true);
  });
});
