/**
 * Where an answer run starts, in a temp folder other users may share.
 *
 * On Linux `/tmp` is shared, so a fixed answer-home name can be created first by
 * another user, who plants a CLI's workspace config in it. These pin that the
 * home is private to this user and that a home someone else could have written
 * into is never used. The POSIX cases need modes, owners and links, so they skip
 * on Windows and run on the Linux CI runner. Every case works under its own
 * temp root, never the machine's real answer home.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ANSWER_HOME_DIRECTORY_NAME,
  ANSWER_RUN_DIRECTORY_PREFIX,
  STALE_ANSWER_RUN_DIRECTORY_MS,
  answerHomeDirectory,
  ensureAnswerHomeDirectory,
  sweepStaleAnswerRunDirectories,
} from '../../src/main/agent/shared/answer-run-directory';

const isPosix = typeof process.getuid === 'function';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-home-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function modeOf(directory: string): number {
  return fs.statSync(directory).mode & 0o777;
}

describe('the answer home', () => {
  it('carries the user id in its name where the temp folder can be shared', () => {
    const expectedName = isPosix ? `${ANSWER_HOME_DIRECTORY_NAME}-${process.getuid?.()}` : ANSWER_HOME_DIRECTORY_NAME;
    expect(answerHomeDirectory(root)).toBe(path.join(root, expectedName));
  });

  it('is created, and the same folder comes back on the next call, as its real path', async () => {
    const first = await ensureAnswerHomeDirectory({ root });
    const second = await ensureAnswerHomeDirectory({ root });
    expect(first).toBe(fs.realpathSync(answerHomeDirectory(root)));
    expect(second).toBe(first);
    expect(fs.statSync(first).isDirectory()).toBe(true);
  });

  describe.skipIf(!isPosix)('on a shared POSIX temp folder', () => {
    it('is created private to this user', async () => {
      const home = await ensureAnswerHomeDirectory({ root });
      expect(modeOf(home)).toBe(0o700);
      expect(fs.statSync(home).uid).toBe(process.getuid?.());
    });

    it('closes a home this user made readable to others, and keeps it', async () => {
      const home = answerHomeDirectory(root);
      fs.mkdirSync(home);
      fs.chmodSync(home, 0o755);

      await expect(ensureAnswerHomeDirectory({ root })).resolves.toBe(fs.realpathSync(home));
      expect(modeOf(home)).toBe(0o700);
    });

    it('never uses a home others can write to, and keeps one private folder in its place', async () => {
      const home = answerHomeDirectory(root);
      fs.mkdirSync(home);
      fs.chmodSync(home, 0o777);

      const used = await ensureAnswerHomeDirectory({ root });
      expect(used).not.toBe(fs.realpathSync(home));
      expect(modeOf(used)).toBe(0o700);
      // Once per launch, not once per question.
      await expect(ensureAnswerHomeDirectory({ root })).resolves.toBe(used);
    });

    it('never follows a link planted at the home path', async () => {
      const planted = fs.mkdtempSync(path.join(root, 'planted-'));
      const home = answerHomeDirectory(root);
      fs.symlinkSync(planted, home);

      const used = await ensureAnswerHomeDirectory({ root });
      expect(used).not.toBe(home);
      expect(fs.lstatSync(used).isSymbolicLink()).toBe(false);
    });
  });
});

describe.skipIf(!isPosix)('sweeping stale run directories from a shared temp folder', () => {
  it('leaves a link carrying the prefix alone, and never reaches what it points at', async () => {
    const target = fs.mkdtempSync(path.join(root, 'someone-else-'));
    fs.writeFileSync(path.join(target, 'keep.txt'), 'not ours');
    const link = path.join(root, `${ANSWER_RUN_DIRECTORY_PREFIX}planted`);
    fs.symlinkSync(target, link);
    // Both old: a sweep that followed the link would find a stale directory
    // behind it and remove it.
    const old = new Date(Date.now() - STALE_ANSWER_RUN_DIRECTORY_MS * 2);
    fs.utimesSync(target, old, old);
    fs.lutimesSync(link, old, old);

    await expect(sweepStaleAnswerRunDirectories({ root })).resolves.toBe(0);
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });
});
