import { describe, it, expect } from 'vitest';
import {
  buildBlockProbeScript,
  buildCopyBlockDispatchScript,
  parseProbeResult,
  probeTerminalBlock,
  PROBE_TIMEOUT_MS,
} from '../../src/main/terminal-context-menu';

describe('buildBlockProbeScript', () => {
  it('rounds coordinates and interpolates only numbers', () => {
    const script = buildBlockProbeScript(12.7, 40.2);
    expect(script).toContain('__kangenticTerminalBlockHitTest(13, 40)');
    // No raw floats leak into the script.
    expect(script).not.toContain('12.7');
    expect(script).not.toContain('40.2');
  });

  it('falls back to a no-block object when the global is absent', () => {
    const script = buildBlockProbeScript(0, 0);
    expect(script).toContain('isTerminal: false');
  });
});

describe('buildCopyBlockDispatchScript', () => {
  it('dispatches a terminal-copy-block event with rounded coordinates', () => {
    const script = buildCopyBlockDispatchScript(5.9, 9.1);
    expect(script).toContain("CustomEvent('terminal-copy-block'");
    expect(script).toContain('x: 6');
    expect(script).toContain('y: 9');
  });
});

describe('parseProbeResult', () => {
  it('accepts a well-formed quote result', () => {
    expect(parseProbeResult({ isTerminal: true, blockKind: 'quote' })).toEqual({
      isTerminal: true,
      blockKind: 'quote',
    });
  });

  it('accepts a well-formed box result', () => {
    expect(parseProbeResult({ isTerminal: true, blockKind: 'box' })).toEqual({
      isTerminal: true,
      blockKind: 'box',
    });
  });

  it('accepts a well-formed text result', () => {
    expect(parseProbeResult({ isTerminal: true, blockKind: 'text' })).toEqual({
      isTerminal: true,
      blockKind: 'text',
    });
  });

  it('accepts a well-formed message result', () => {
    // The renderer's blockKindAtPoint returns 'text' / 'message' for plain
    // assistant output; the right-click "Copy Block" item depends on these
    // round-tripping through parseProbeResult (regression: they were coerced to
    // null, so the menu item never appeared for those kinds).
    expect(parseProbeResult({ isTerminal: true, blockKind: 'message' })).toEqual({
      isTerminal: true,
      blockKind: 'message',
    });
  });

  it('coerces an unknown blockKind to null', () => {
    expect(parseProbeResult({ isTerminal: true, blockKind: 'banana' })).toEqual({
      isTerminal: true,
      blockKind: null,
    });
  });

  it('defaults to no block for non-object values', () => {
    expect(parseProbeResult(null)).toEqual({ isTerminal: false, blockKind: null });
    expect(parseProbeResult('nope')).toEqual({ isTerminal: false, blockKind: null });
    expect(parseProbeResult(undefined)).toEqual({ isTerminal: false, blockKind: null });
  });

  it('treats a missing isTerminal flag as false', () => {
    expect(parseProbeResult({ blockKind: 'quote' })).toEqual({ isTerminal: false, blockKind: 'quote' });
  });
});

describe('probeTerminalBlock', () => {
  it('returns the parsed result when the renderer answers', async () => {
    const result = await probeTerminalBlock(async () => ({ isTerminal: true, blockKind: 'box' }), 1, 2);
    expect(result).toEqual({ isTerminal: true, blockKind: 'box' });
  });

  it('resolves to no block when the renderer rejects', async () => {
    const result = await probeTerminalBlock(async () => { throw new Error('detached'); }, 1, 2);
    expect(result).toEqual({ isTerminal: false, blockKind: null });
  });

  it('resolves to no block when the renderer never answers within the timeout', async () => {
    const result = await probeTerminalBlock(() => new Promise(() => { /* never resolves */ }), 1, 2);
    expect(result).toEqual({ isTerminal: false, blockKind: null });
  }, PROBE_TIMEOUT_MS + 2000);
});
