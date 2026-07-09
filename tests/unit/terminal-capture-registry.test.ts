import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTerminalCapture,
  unregisterTerminalCapture,
  captureTerminalScrollback,
} from '../../src/renderer/utils/terminal-capture-registry';

/**
 * `unregisterTerminalCapture` must be safe against a STALE unmount cleanup
 * firing after a newer mount has already registered its own reader for the
 * same session id - the exact race that let the open-at-TUI-position feature
 * silently end up with no reader registered at all (see the bottom-panel /
 * task-dialog terminal ownership handoff, and React StrictMode's dev-only
 * double-invoke cleanup).
 */
describe('terminal-capture-registry identity-guarded unregister', () => {
  const sessionId = 'sess-registry-test';

  beforeEach(() => {
    unregisterTerminalCapture(sessionId);
  });

  it('captures the registered reader for a session', () => {
    const reader = () => ({ visibleLines: ['hello'], atBottom: false });
    registerTerminalCapture(sessionId, reader);

    expect(captureTerminalScrollback(sessionId)).toEqual({ visibleLines: ['hello'], atBottom: false });
  });

  it('unregisters by identity: a stale reader does not clobber a newer registration', () => {
    const staleReader = () => ({ visibleLines: ['stale'], atBottom: true });
    const freshReader = () => ({ visibleLines: ['fresh'], atBottom: false });

    registerTerminalCapture(sessionId, staleReader);
    registerTerminalCapture(sessionId, freshReader);

    // The stale mount's cleanup fires AFTER the fresh mount already
    // registered - it must not delete the fresh registration.
    unregisterTerminalCapture(sessionId, staleReader);

    expect(captureTerminalScrollback(sessionId)).toEqual({ visibleLines: ['fresh'], atBottom: false });
  });

  it('unregisters normally when the identity matches the current reader', () => {
    const reader = () => ({ visibleLines: ['only'], atBottom: true });
    registerTerminalCapture(sessionId, reader);

    unregisterTerminalCapture(sessionId, reader);

    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });

  it('falls back to an unconditional delete when no reader is passed', () => {
    const reader = () => ({ visibleLines: ['x'], atBottom: false });
    registerTerminalCapture(sessionId, reader);

    unregisterTerminalCapture(sessionId);

    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });

  it('returns null for a session with no registered reader, or when the reader itself throws', () => {
    expect(captureTerminalScrollback('sess-never-registered')).toBeNull();
    expect(captureTerminalScrollback(null)).toBeNull();

    registerTerminalCapture(sessionId, () => {
      throw new Error('boom');
    });
    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });
});
