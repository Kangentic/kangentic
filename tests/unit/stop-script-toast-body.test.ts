/**
 * The words of the "Stop script failed" toast (src/renderer/lib/stop-script-toast.ts):
 * the task in quotes, then what happened to the script in the script's own words,
 * with no advice. Main pushes the facts (`StopScriptFailure`) and this words them.
 * English, since no other catalog is loaded here.
 */
import { describe, it, expect } from 'vitest';
import { stopScriptFailureBody } from '../../src/renderer/lib/stop-script-toast';
import type { StopScriptFailure } from '../../src/shared/types';

function body(failure: StopScriptFailure, taskTitle = 'Fix login'): string {
  return stopScriptFailureBody({ taskTitle, failure });
}

describe('stopScriptFailureBody', () => {
  describe('exit-code', () => {
    it('gives the code, then the last line the script printed as a sentence', () => {
      expect(body({ kind: 'exit-code', exitCode: 2, detail: 'compose: no such service' }))
        .toBe('"Fix login": exited with code 2. Compose: no such service.');
    });

    it('keeps a full stop the script already ended with', () => {
      expect(body({ kind: 'exit-code', exitCode: 1, detail: 'Could not reach the daemon.' }))
        .toBe('"Fix login": exited with code 1. Could not reach the daemon.');
    });

    it('gives the code alone, with no trailing space, when the script printed nothing', () => {
      expect(body({ kind: 'exit-code', exitCode: 127, detail: '' })).toBe('"Fix login": exited with code 127.');
    });
  });

  describe('timeout', () => {
    it('counts seconds under a minute, and says one second in the singular', () => {
      expect(body({ kind: 'timeout', timeoutMs: 30_000 })).toBe('"Fix login": timed out after 30 seconds.');
      expect(body({ kind: 'timeout', timeoutMs: 1_000 })).toBe('"Fix login": timed out after 1 second.');
    });

    it('counts minutes from a minute up', () => {
      expect(body({ kind: 'timeout', timeoutMs: 60_000 })).toBe('"Fix login": timed out after 1 minute.');
      expect(body({ kind: 'timeout', timeoutMs: 120_000 })).toBe('"Fix login": timed out after 2 minutes.');
    });
  });

  describe('error', () => {
    it('gives the raw detail as a sentence', () => {
      expect(body({ kind: 'error', detail: 'spawn failed' })).toBe('"Fix login": Spawn failed.');
    });

    it('says why there is no reason when there is none', () => {
      expect(body({ kind: 'error', detail: '' })).toBe('"Fix login": No reason was given.');
    });
  });

  it('names the task it is given', () => {
    expect(body({ kind: 'timeout', timeoutMs: 30_000 }, 'Add search')).toContain('"Add search"');
  });
});
