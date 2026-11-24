import { describe, it, expect } from 'vitest';
import { asSentence, capitalizeFirstWord, describeIpcError, ipcErrorClassName, ipcErrorWasReported, ipcFailureToastFields, rejectionMessage } from '../../src/renderer/lib/ipc-error';
import { RefusalError, SIGN_IN_REFUSED_ERROR_NAME, SignInRefusedError } from '../../src/shared/refusal';
import { REPORTED_FAILURE_MARKER, hasReportedFailureMarker, withoutReportedFailureMarker } from '../../src/shared/reported-failure-marker';

// What Electron hands the renderer for a rejection main marked as reported (#1188).
const reportedRejection = new Error(
  `Error invoking remote method 'session:resume': TypeError: Cannot read properties of undefined (reading 'cwd')${REPORTED_FAILURE_MARKER}`,
);

describe('the reported marker', () => {
  it('is stripped from every reason and read as reported', () => {
    expect(describeIpcError(reportedRejection)).toBe("Cannot read properties of undefined (reading 'cwd')");
    expect(ipcErrorWasReported(reportedRejection)).toBe(true);
    expect(ipcErrorClassName(reportedRejection)).toBe('TypeError');
  });

  it('is absent from a refusal, a plain rejection and a non-Error', () => {
    expect(ipcErrorWasReported(new Error("Error invoking remote method 'session:resume': Error: The task is in Done."))).toBe(false);
    expect(ipcErrorWasReported('a string')).toBe(false);
    expect(ipcErrorWasReported(null)).toBe(false);
  });

  it('gives a toast its sentence body and the reported flag', () => {
    expect(ipcFailureToastFields(reportedRejection)).toEqual({
      message: "Cannot read properties of undefined (reading 'cwd').",
      reported: true,
    });
    expect(ipcFailureToastFields('not an error', '', 'Nothing was saved.')).toEqual({ message: 'Nothing was saved.', reported: false });
  });
});

describe('rejectionMessage', () => {
  it('drops a trailing marker but keeps the Electron channel prefix', () => {
    expect(rejectionMessage(reportedRejection)).toBe(
      "Error invoking remote method 'session:resume': TypeError: Cannot read properties of undefined (reading 'cwd')",
    );
  });

  it('returns an unmarked Error message unchanged and String(value) for a non-Error', () => {
    const plain = "Error invoking remote method 'x': Error: disk full ";
    expect(rejectionMessage(new Error(plain))).toBe(plain);
    expect(rejectionMessage('a string')).toBe('a string');
    expect(rejectionMessage(42)).toBe('42');
    expect(rejectionMessage(null)).toBe('null');
  });
});

describe('the reported failure marker text helpers', () => {
  it('reads a marker followed only by whitespace as marked, and strips it with the whitespace', () => {
    const text = `Disk full${REPORTED_FAILURE_MARKER}  \n`;
    expect(hasReportedFailureMarker(text)).toBe(true);
    expect(withoutReportedFailureMarker(text)).toBe('Disk full');
  });

  it('leaves a marker in the middle of a message alone', () => {
    const text = `Disk full${REPORTED_FAILURE_MARKER} while saving`;
    expect(hasReportedFailureMarker(text)).toBe(false);
    expect(withoutReportedFailureMarker(text)).toBe(text);
  });

  it('turns a message that is only the marker into an empty string', () => {
    expect(withoutReportedFailureMarker(REPORTED_FAILURE_MARKER)).toBe('');
  });

  it('does not count the marker text without its leading space', () => {
    const text = 'Disk full(kangentic:reported)';
    expect(hasReportedFailureMarker(text)).toBe(false);
    expect(withoutReportedFailureMarker(text)).toBe(text);
  });

  it('returns an unmarked message as the same string, trailing whitespace kept', () => {
    const text = 'Disk full \n';
    expect(withoutReportedFailureMarker(text)).toBe(text);
  });
});

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

/**
 * Add Source opens Connect when the class says the saved sign-in is what failed. A user with a
 * sign-in the provider refuses otherwise reads the refusal and has no way to replace it. The
 * class is read, never the wording, because GitLab's refusal is GitLab's own text.
 */
describe('ipcErrorClassName', () => {
  /** What Electron hands the renderer for an error main threw from a handler. */
  function overIpc(thrown: Error): Error {
    return new Error(`Error invoking remote method 'backlog:importSourcesAdd': ${thrown.name}: ${thrown.message}`);
  }

  it('reads the class main threw, for a refused sign-in and for any other refusal', () => {
    expect(ipcErrorClassName(overIpc(new SignInRefusedError('401 Unauthorized')))).toBe(SIGN_IN_REFUSED_ERROR_NAME);
    expect(ipcErrorClassName(overIpc(new RefusalError('No board 12 that this account can open.')))).toBe('RefusalError');
    expect(ipcErrorClassName(overIpc(new Error('disk full')))).toBe('Error');
  });

  it('keeps the message a refused sign-in carries, with the class stripped', () => {
    expect(describeIpcError(overIpc(new SignInRefusedError('Jira rejected the saved token.')))).toBe('Jira rejected the saved token.');
  });

  it('names no class for text that only looks like one, or for no error at all', () => {
    expect(ipcErrorClassName(new Error('fatal: not a git repository'))).toBeNull();
    expect(ipcErrorClassName(new Error('Cannot read C:\\proj'))).toBeNull();
    // A message that mentions the class further in is not an error of that class.
    expect(ipcErrorClassName(new Error("Error invoking remote method 'x': RefusalError: see SignInRefusedError: docs"))).toBe('RefusalError');
    expect(ipcErrorClassName('a string')).toBeNull();
    expect(ipcErrorClassName(new Error(''))).toBeNull();
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
