/**
 * Cursor and Grok both publish a PATH shim named `agent`.
 *
 * Cursor installs `cursor-agent` AND `agent`; xAI's Grok CLI installs `agent`
 * and `grok`. On Windows Grok's `agent.exe` beats Cursor's `agent.cmd` in
 * PATHEXT order, so a detector that probes `agent` asks Grok whether Cursor is
 * installed. Observed on a real machine:
 *
 *   agent --version         -> grok 1.0.0 (3cd0d0cbce) [stable]
 *   grok --version          -> grok 1.0.0 (3cd0d0cbce) [stable]
 *   cursor-agent --version  -> 2026.04.29-c83a488
 *
 * Two independent properties keep that safe, and this file pins both:
 *
 *   1. SAFETY - Grok's version output must never parse as Cursor. If it did,
 *      selecting Cursor would spawn Grok, and every downstream assumption
 *      (command shape, session history, verification) would be wrong.
 *   2. AVAILABILITY - Cursor must still be found when Grok owns `agent`. The
 *      first version of this guard was safe but not available: it refused Grok
 *      and then reported Cursor missing, on a machine where Cursor was
 *      installed.
 */
import { describe, it, expect } from 'vitest';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor/cursor-adapter';
import { GrokDetector, parseGrokVersion } from '../../src/main/agent/adapters/grok/detector';

/** Reach the detector config the adapter constructed. */
function detectorConfig(): { binaryName: string; binaryAliases?: string[]; parseVersion(raw: string): string | null } {
  const adapter = new CursorAdapter() as unknown as {
    detector: { config: { binaryName: string; binaryAliases?: string[]; parseVersion(raw: string): string | null } };
  };
  return adapter.detector.config;
}

describe('Cursor / Grok `agent` shim collision', () => {
  it('probes the unambiguous name first, with `agent` only as a fallback', () => {
    const config = detectorConfig();
    // `cursor-agent` is Cursor's alone. `agent` is shared, so it must never be
    // the primary probe.
    expect(config.binaryName).toBe('cursor-agent');
    expect(config.binaryAliases).toContain('agent');
    expect(config.binaryAliases?.indexOf('agent')).toBeGreaterThanOrEqual(0);
  });

  it('rejects Grok CLI version output verbatim', () => {
    const { parseVersion } = detectorConfig();
    // The exact string a real `agent --version` returned when Grok owned the
    // shim. Accepting it would make Kangentic spawn Grok for a Cursor task.
    expect(parseVersion('grok 1.0.0 (3cd0d0cbce) [stable]')).toBeNull();
    expect(parseVersion('grok 1.0.0')).toBeNull();
  });

  it('accepts real cursor-agent version output', () => {
    const { parseVersion } = detectorConfig();
    // Verified against cursor-agent 2026.04.29: CalVer plus a short hash.
    expect(parseVersion('2026.04.29-c83a488')).toBe('2026.04.29-c83a488');
    expect(parseVersion('agent 1.0.0')).toBe('1.0.0');
    expect(parseVersion('Cursor Agent 1.0.0')).toBe('1.0.0');
  });

  it('rejects any other product name answering on the shared shim', () => {
    const { parseVersion } = detectorConfig();
    // The guard is "must start with a digit once a cursor/agent prefix is
    // stripped", so an unrelated tool that prints its own name is refused.
    for (const foreign of ['aider 0.9.1', 'codex-cli 0.128.0', 'some-tool v2', 'not a version']) {
      expect(parseVersion(foreign)).toBeNull();
    }
  });
});

/**
 * The REVERSE direction, added with the Grok adapter itself: Grok's own
 * detector must never resolve through the shared `agent` shim, and its
 * parseVersion must reject every banner that is not Grok's - otherwise a
 * machine where Cursor's `agent` wins the PATH race would mis-identify
 * Cursor as Grok, the mirror image of the original defect.
 */
describe('Grok detector side of the `agent` shim collision', () => {
  function grokConfig(): { binaryName: string; binaryAliases?: string[] } {
    const detector = new GrokDetector() as unknown as {
      config: { binaryName: string; binaryAliases?: string[] };
    };
    return detector.config;
  }

  it('probes only the unambiguous `grok` name, never the shared `agent` shim', () => {
    const config = grokConfig();
    expect(config.binaryName).toBe('grok');
    expect(config.binaryAliases ?? []).not.toContain('agent');
  });

  it('accepts the real grok version banner', () => {
    // The exact string a real `grok --version` returned (grok 1.0.0).
    expect(parseGrokVersion('grok 1.0.0 (3cd0d0cbce) [stable]')).toBe('1.0.0');
    expect(parseGrokVersion('grok 1.2.3')).toBe('1.2.3');
  });

  it("rejects Cursor's banners and every other foreign product", () => {
    for (const foreign of [
      '2026.04.29-c83a488',
      'agent 1.0.0',
      'Cursor Agent 1.0.0',
      'codex-cli 0.128.0',
      'aider 0.9.1',
      'not a version',
    ]) {
      expect(parseGrokVersion(foreign)).toBeNull();
    }
  });
});
