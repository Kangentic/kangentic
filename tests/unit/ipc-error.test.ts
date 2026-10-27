import { describe, it, expect } from 'vitest';
import { asSentence, capitalizeFirstWord, describeIpcError } from '../../src/renderer/lib/ipc-error';

describe('capitalizeFirstWord', () => {
  it('capitalizes a leading lowercase word and changes nothing else, adding no stop', () => {
    expect(capitalizeFirstWord('the file does not exist on disk')).toBe('The file does not exist on disk');
    expect(capitalizeFirstWord('fetch failed: connect ECONNREFUSED 127.0.0.1:4100')).toBe('Fetch failed: connect ECONNREFUSED 127.0.0.1:4100');
  });

  it('leaves a path, a file name or an already capitalized word as written', () => {
    expect(capitalizeFirstWord("/usr/bin/env: 'node': No such file or directory")).toBe("/usr/bin/env: 'node': No such file or directory");
    expect(capitalizeFirstWord('kangentic.json is missing')).toBe('kangentic.json is missing');
    expect(capitalizeFirstWord('From Ubuntu: HTTP 401')).toBe('From Ubuntu: HTTP 401');
  });
});

/**
 * Observed live in a preview before this existed, on the branch-checkout guard:
 *
 *   Failed to move task: Error invoking remote method 'task:move':
 *   BranchCheckoutBlockedError: Cannot switch branches in C:\... "Task A" is
 *   already running an agent there. Stop that task, or enable worktree mode.
 *
 * Two layers of plumbing in front of a sentence written for the user.
 */
describe('describeIpcError', () => {
  it('strips the Electron channel decoration and the Error class name', () => {
    const raw = new Error(
      "Error invoking remote method 'task:move': BranchCheckoutBlockedError: "
      + 'Cannot switch branches in C:\\proj: "Task A" is already running an agent there.',
    );
    expect(describeIpcError(raw)).toBe(
      'Cannot switch branches in C:\\proj: "Task A" is already running an agent there.',
    );
  });

  it('strips a plain Error: prefix too', () => {
    expect(describeIpcError(new Error("Error invoking remote method 'task:move': Error: Worktree setup failed")))
      .toBe('Worktree setup failed');
  });

  it('leaves an undecorated message untouched', () => {
    expect(describeIpcError(new Error('Worktree setup failed: disk full'))).toBe('Worktree setup failed: disk full');
  });

  it('does not eat a colon that is part of the message', () => {
    // `fatal:` is lowercase and does not end in Error, so it is not a class name.
    expect(describeIpcError(new Error('fatal: not a git repository'))).toBe('fatal: not a git repository');
    // A drive letter must survive.
    expect(describeIpcError(new Error('Cannot read C:\\proj'))).toBe('Cannot read C:\\proj');
  });

  it('falls back for a non-Error or empty rejection', () => {
    expect(describeIpcError('a string')).toBe('Unknown error');
    expect(describeIpcError(undefined)).toBe('Unknown error');
    expect(describeIpcError(new Error(''))).toBe('Unknown error');
    expect(describeIpcError(new Error("Error invoking remote method 'x': "), 'Move failed')).toBe('Move failed');
  });
});

/** Every failure toast's body goes through this, so one rule holds for every caller. */
describe('asSentence', () => {
  it('ends a reason with a period once', () => {
    expect(asSentence('Worktree setup failed')).toBe('Worktree setup failed.');
    expect(asSentence('Worktree setup failed.')).toBe('Worktree setup failed.');
  });

  it('keeps a reason that already ends in a question or exclamation mark', () => {
    expect(asSentence('Is the drive connected?')).toBe('Is the drive connected?');
    expect(asSentence('Out of disk!')).toBe('Out of disk!');
  });

  it('capitalizes a plain lowercase first word', () => {
    expect(asSentence('fatal: not a git repository')).toBe('Fatal: not a git repository.');
    expect(asSentence('disk full')).toBe('Disk full.');
  });

  it('leaves a file or path at the start in its own case', () => {
    expect(asSentence('kangentic.json is not valid JSON')).toBe('kangentic.json is not valid JSON.');
    expect(asSentence('./scripts/setup.sh exited with code 1')).toBe('./scripts/setup.sh exited with code 1.');
  });

  it('trims, and falls back for an empty reason', () => {
    expect(asSentence('  Worktree setup failed \n')).toBe('Worktree setup failed.');
    expect(asSentence('')).toBe('No reason was given.');
    expect(asSentence(null)).toBe('No reason was given.');
    expect(asSentence('   ', 'Try again.')).toBe('Try again.');
  });
});
