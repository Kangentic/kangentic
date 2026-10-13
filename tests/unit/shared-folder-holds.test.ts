/**
 * SharedFolderHolds: which sessions still need a file every session in a
 * folder shares. Holds are keyed by session id (a task's sessions overlap), and
 * a release strips the folder the hold was taken in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { SharedFolderHolds, sharedFolderKey } from '../../src/main/agent/shared/shared-folder-holds';

const FOLDER = path.join('/mock', 'project');
const WORKTREE = path.join('/mock', 'project', '.kangentic', 'worktrees', 'task-1');

describe('SharedFolderHolds', () => {
  it('strips only when the folder\'s last session releases', () => {
    const holds = new SharedFolderHolds();
    holds.retain('session-a', FOLDER);
    holds.retain('session-b', FOLDER);

    expect(holds.release('session-a', FOLDER)).toBeNull();
    expect(holds.isHeld(FOLDER)).toBe(true);
    expect(holds.release('session-b', FOLDER)).toBe(FOLDER);
    expect(holds.isHeld(FOLDER)).toBe(false);
  });

  it('a second release of one session never ends another session\'s hold', () => {
    // The suspend path releases, then the PTY exit releases again. Keyed by
    // task, the second release took the hold of the task's next session.
    const holds = new SharedFolderHolds();
    holds.retain('old-session', FOLDER);
    expect(holds.release('old-session', FOLDER)).toBe(FOLDER);
    holds.retain('new-session', FOLDER);

    expect(holds.release('old-session', FOLDER)).toBeNull();
    expect(holds.isHeld(FOLDER)).toBe(true);
  });

  it('a late release of an older session keeps the newer session\'s hold', () => {
    const holds = new SharedFolderHolds();
    holds.retain('old-session', FOLDER);
    holds.retain('new-session', FOLDER);

    expect(holds.release('old-session', FOLDER)).toBeNull();
    expect(holds.release('new-session', FOLDER)).toBe(FOLDER);
  });

  it('strips the folder the hold was taken in, not the one the release names', () => {
    // An adapter that writes into the project root holds the root, while a
    // worktree session's release arrives with the worktree path.
    const holds = new SharedFolderHolds();
    holds.retain('session-a', FOLDER);

    expect(holds.release('session-a', WORKTREE)).toBe(FOLDER);
  });

  it('a session that took no hold strips the named folder only when nobody holds it', () => {
    const holds = new SharedFolderHolds();
    expect(holds.release('never-held', FOLDER)).toBe(FOLDER);

    holds.retain('session-a', FOLDER);
    expect(holds.release('never-held', FOLDER)).toBeNull();
    expect(holds.isHeld(FOLDER)).toBe(true);
  });

  it('no session id drops every hold on the folder and strips it', () => {
    // Project delete's sweep, after every session is gone.
    const holds = new SharedFolderHolds();
    holds.retain('session-a', FOLDER);
    holds.retain('session-b', FOLDER);
    holds.retain('session-c', WORKTREE);

    expect(holds.release(undefined, FOLDER)).toBe(FOLDER);
    expect(holds.isHeld(FOLDER)).toBe(false);
    expect(holds.isHeld(WORKTREE)).toBe(true);
    // The dropped holds are gone, so their own later release is unheld.
    expect(holds.release('session-a', FOLDER)).toBe(FOLDER);
  });

  it('retain with no session id records nothing', () => {
    const holds = new SharedFolderHolds();
    holds.retain(undefined, FOLDER);
    expect(holds.isHeld(FOLDER)).toBe(false);
  });

  it('a trailing separator does not make a second folder', () => {
    const holds = new SharedFolderHolds();
    holds.retain('session-a', FOLDER + path.sep);
    holds.retain('session-b', FOLDER);

    expect(holds.release('session-b', FOLDER)).toBeNull();
    expect(holds.release('session-a', FOLDER)).toBe(FOLDER + path.sep);
  });

  describe('letter case', () => {
    const originalPlatform = process.platform;
    const UPPER = path.join('/Mock', 'Project');
    const LOWER = path.join('/mock', 'project');

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    // Windows paths ignore case, so a drive letter or folder spelled in other
    // case is the same folder, and a release in that spelling must not strip
    // the file under the session that holds it.
    it('is ignored on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const holds = new SharedFolderHolds();
      holds.retain('session-a', UPPER);

      expect(holds.isHeld(LOWER)).toBe(true);
      expect(holds.release('never-held', LOWER)).toBeNull();
      expect(sharedFolderKey(UPPER)).toBe(sharedFolderKey(LOWER));
      expect(holds.release(undefined, LOWER)).toBe(LOWER);
      expect(holds.isHeld(UPPER)).toBe(false);
    });

    // A macOS or Linux volume can be case-sensitive, where the two spellings
    // are two real folders.
    it.each(['darwin', 'linux'])('is kept on %s', (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const holds = new SharedFolderHolds();
      holds.retain('session-a', UPPER);

      expect(holds.isHeld(LOWER)).toBe(false);
      expect(holds.release('never-held', LOWER)).toBe(LOWER);
      expect(holds.isHeld(UPPER)).toBe(true);
    });
  });
});
