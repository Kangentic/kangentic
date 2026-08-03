import { describe, it, expect } from 'vitest';
import { HeadlessFrameBuffer } from '../../src/main/pty/buffer/headless-frame';

/**
 * HeadlessFrameBuffer.serialize underlies both the mobile seed
 * (PtyBufferManager.getSerializedFrame) and the desktop alt-screen replay
 * (PtyBufferManager.getReplaySnapshot). Both call sites, and the atomic
 * flush-barrier boundary that makes serialize()'s content cutoff exact, are
 * already exercised through PtyBufferManager in pty-buffer-manager.test.ts.
 *
 * This file targets the one behavior that lives entirely inside
 * HeadlessFrameBuffer and is not observable through those higher-level
 * callers: serialize() REJECTS (rather than throwing into xterm's own
 * write/parse loop as an uncaught main-process exception) when the
 * serializer itself throws mid-callback.
 *
 * Real timers throughout: serialize() awaits xterm's own macrotask flush
 * barrier (a zero-length terminal.write callback), matching the real-timer
 * discipline of the getSerializedFrame / getReplaySnapshot blocks in
 * pty-buffer-manager.test.ts.
 */
describe('HeadlessFrameBuffer', () => {
  describe('serialize', () => {
    it('rejects, rather than throwing uncaught, when the serializer throws mid-callback', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('some content');

      // The callback that invokes serializer.serialize() runs inside xterm's
      // own write/parse loop (see the comment on HeadlessFrameBuffer.serialize),
      // not in this test's stack frame - so reaching into the private
      // serializer to force a throw from exactly there is the only way to
      // exercise the boundary the try/catch guards. A cast through `unknown`
      // (never `any`) is the narrowest way to reach it from a test.
      interface SerializerAccessor {
        serializer: { serialize: (...args: unknown[]) => string };
      }
      (buffer as unknown as SerializerAccessor).serializer.serialize = () => {
        throw new Error('serializer disposed mid-sample');
      };

      await expect(buffer.serialize()).rejects.toThrow('serializer disposed mid-sample');

      buffer.dispose();
    });
  });
});
