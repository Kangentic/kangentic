import { describe, it, expect, vi } from 'vitest';
import type * as pty from 'node-pty';
import { writeExitSequence } from '../../src/main/pty/shutdown/session-shutdown';

describe('writeExitSequence', () => {
  it('writes every command in order', () => {
    const writes: string[] = [];
    const ptyRef = { write: (d: string) => { writes.push(d); } } as unknown as pty.IPty;
    writeExitSequence(ptyRef, ['\x03', '/exit\r']);
    expect(writes).toEqual(['\x03', '/exit\r']);
  });

  it('swallows individual write errors and keeps trying subsequent commands', () => {
    let callCount = 0;
    const writes: string[] = [];
    const ptyRef = {
      write: (d: string) => {
        callCount++;
        if (callCount === 1) throw new Error('EIO: PTY dead');
        writes.push(d);
      },
    } as unknown as pty.IPty;
    expect(() => writeExitSequence(ptyRef, ['\x03', '/exit\r'])).not.toThrow();
    // First write threw; second write still attempted
    expect(writes).toEqual(['/exit\r']);
  });

  it('is a no-op for an empty exit sequence', () => {
    const ptyRef = { write: vi.fn() } as unknown as pty.IPty;
    writeExitSequence(ptyRef, []);
    expect((ptyRef.write as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// Note: suspendAllSessions and killAllSessions are covered end-to-end via
// tests/unit/session-suspend.test.ts and session-manager.test.ts integration paths.
// A direct unit test here would require mocking 4 collaborators and would
// duplicate coverage without adding signal.
