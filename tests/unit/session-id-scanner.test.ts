import { describe, it, expect } from 'vitest';
import { SessionIdScanner } from '../../src/main/pty/lifecycle/session-id-manager';

const UUID_REGEX = /session id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const fromOutput = (data: string): string | null => {
  const match = data.match(UUID_REGEX);
  return match ? match[1] : null;
};

describe('SessionIdScanner', () => {
  describe('scanChunk', () => {
    it('captures a UUID that arrives in a single chunk', () => {
      const scanner = new SessionIdScanner();
      const result = scanner.scanChunk(
        'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n',
        fromOutput,
      );
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('captures a UUID that spans a chunk boundary', () => {
      const scanner = new SessionIdScanner();
      expect(scanner.scanChunk('session id: 019d60ac-b67c-7a22-bcbb', fromOutput)).toBeNull();
      const result = scanner.scanChunk('-af55c8295c38\n--------\n', fromOutput);
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('captures a UUID that arrives across three small chunks', () => {
      const scanner = new SessionIdScanner();
      expect(scanner.scanChunk('session id: 019d60ac', fromOutput)).toBeNull();
      expect(scanner.scanChunk('-b67c-7a22', fromOutput)).toBeNull();
      const result = scanner.scanChunk('-bcbb-af55c8295c38\n', fromOutput);
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('strips ANSI escapes before matching (Windows ConPTY cursor positioning)', () => {
      const scanner = new SessionIdScanner();
      const withEscapes
        = '\x1b[2Jsession id: \x1b[0m019d60ac-b67c-7a22-bcbb-af55c8295c38\x1b[H\n';
      const result = scanner.scanChunk(withEscapes, fromOutput);
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('returns null for unrelated output', () => {
      const scanner = new SessionIdScanner();
      expect(scanner.scanChunk('hello world\n', fromOutput)).toBeNull();
      expect(scanner.scanChunk('more unrelated text\n', fromOutput)).toBeNull();
    });

    it('preserves matches after buffer slicing with 8KB window', () => {
      const scanner = new SessionIdScanner(8192);
      // Chunk 1: ~4KB of noise then partial UUID at the end
      const noise = 'x'.repeat(4000);
      expect(scanner.scanChunk(noise + 'session id: 019d60ac-b67c', fromOutput)).toBeNull();
      // Chunk 2: ~4KB of additional noise. Combined ~8KB. The UUID's first half
      // sits in the slice we'd otherwise drop -- the rolling window must keep it.
      const result = scanner.scanChunk('-7a22-bcbb-af55c8295c38' + 'y'.repeat(4000), fromOutput);
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });
  });

  describe('scanScrollback', () => {
    it('captures a UUID from a full scrollback buffer', () => {
      const scanner = new SessionIdScanner();
      const scrollback = [
        'Gemini CLI v0.31.0',
        'Exiting...',
        'Session ID: 4231e6aa-5409-4749-9272-270e9aab079b',
        'To resume: gemini --resume \'4231e6aa-5409-4749-9272-270e9aab079b\'',
      ].join('\n');
      const result = scanner.scanScrollback(
        scrollback,
        (d) => d.match(/Session ID:\s+([0-9a-f-]{36})/)?.[1] ?? null,
      );
      expect(result).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('does not mutate the rolling buffer', () => {
      const scanner = new SessionIdScanner();
      scanner.scanChunk('ongoing data ', fromOutput);
      scanner.scanScrollback('old scrollback', fromOutput);
      // Subsequent chunks should still see the rolling buffer state
      const result = scanner.scanChunk(
        'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n',
        fromOutput,
      );
      expect(result).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });
  });

  describe('reset', () => {
    it('clears the rolling buffer so subsequent chunks start fresh', () => {
      const scanner = new SessionIdScanner();
      scanner.scanChunk('session id: 019d60ac-b67c-7a22-bcbb', fromOutput);
      scanner.reset();
      // After reset, the partial from before is gone -- a chunk with only
      // the tail shouldn't match
      const result = scanner.scanChunk('-af55c8295c38\n', fromOutput);
      expect(result).toBeNull();
    });
  });
});
