/**
 * Gap B: OpenCodeAdapter.runtime.sessionId.fromFilesystem wiring test.
 *
 * Verifies that the adapter's arrow-function wrapper injects a
 * `getAgentVersion` callback into OpenCodeSessionHistoryParser and that
 * the callback delegates to `this.detector.getCachedVersion()`.
 *
 * A refactor that drops the `getAgentVersion` injection from line 135 of
 * opencode-adapter.ts would cause the callback to be absent from the call
 * and break the assertion. A refactor that hardcodes the version instead
 * of reading from the detector cache would cause the version mismatch.
 *
 * This test does NOT need better-sqlite3 to be loadable: it spies on the
 * static method and never instantiates a real database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { OpenCodeSessionHistoryParser } from '../../src/main/agent/adapters/opencode/session-history-parser';

describe('OpenCodeAdapter - fromFilesystem getAgentVersion wiring', () => {
  let parserSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the static method so we can inspect the options it receives
    // without actually touching the filesystem or SQLite.
    parserSpy = vi
      .spyOn(OpenCodeSessionHistoryParser, 'captureSessionIdFromFilesystem')
      .mockResolvedValue(null);
  });

  afterEach(() => {
    parserSpy.mockRestore();
  });

  it('calls captureSessionIdFromFilesystem with a getAgentVersion function', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.runtime.sessionId.fromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project',
    });

    expect(parserSpy).toHaveBeenCalledTimes(1);
    const callOptions = parserSpy.mock.calls[0]?.[0];
    expect(callOptions).toBeDefined();
    expect(typeof callOptions?.getAgentVersion).toBe('function');
  });

  it('getAgentVersion callback returns the detector cached version', async () => {
    const adapter = new OpenCodeAdapter();

    // Access the private detector and stub its getCachedVersion so we can
    // verify the adapter's closure reads from the correct source without
    // spawning the real CLI.
    const detector = (adapter as unknown as { detector: { getCachedVersion: () => string | null } }).detector;
    const getCachedVersionSpy = vi
      .spyOn(detector, 'getCachedVersion')
      .mockReturnValue('1.14.25');

    await adapter.runtime.sessionId.fromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project',
    });

    const callOptions = parserSpy.mock.calls[0]?.[0];
    expect(callOptions?.getAgentVersion).toBeDefined();
    // Invoke the callback directly - it must delegate to getCachedVersion.
    const versionResult = callOptions?.getAgentVersion?.();
    expect(versionResult).toBe('1.14.25');
    expect(getCachedVersionSpy).toHaveBeenCalledTimes(1);

    getCachedVersionSpy.mockRestore();
  });

  it('getAgentVersion callback returns null when detector has no cached version', async () => {
    const adapter = new OpenCodeAdapter();

    const detector = (adapter as unknown as { detector: { getCachedVersion: () => string | null } }).detector;
    const getCachedVersionSpy = vi
      .spyOn(detector, 'getCachedVersion')
      .mockReturnValue(null);

    await adapter.runtime.sessionId.fromFilesystem({
      spawnedAt: new Date(),
      cwd: '/some/project',
    });

    const callOptions = parserSpy.mock.calls[0]?.[0];
    const versionResult = callOptions?.getAgentVersion?.();
    expect(versionResult).toBeNull();

    getCachedVersionSpy.mockRestore();
  });

  it('passes spawnedAt and cwd through to the parser unchanged', async () => {
    const adapter = new OpenCodeAdapter();
    const spawnedAt = new Date('2026-01-01T00:00:00.000Z');
    const cwd = '/projects/my-feature';

    await adapter.runtime.sessionId.fromFilesystem({ spawnedAt, cwd });

    const callOptions = parserSpy.mock.calls[0]?.[0];
    expect(callOptions?.spawnedAt).toBe(spawnedAt);
    expect(callOptions?.cwd).toBe(cwd);
  });
});
