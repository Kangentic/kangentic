/**
 * A status line's `transcriptPath` for a CLI that runs in a WSL distro.
 *
 * Such a CLI reports a Linux path (`/home/dev/.claude/projects/.../x.jsonl`).
 * Every reader of the usage cache (the metrics refine, the resume guard) opens
 * that path from Windows, where it names nothing, so `SessionManager` maps it
 * to the distro's share (`\\wsl.localhost\Ubuntu\home\dev\...`) before the
 * telemetry sees the usage (`usageOnHost`, wired as the status reader's
 * `onUsageParsed`).
 *
 * This file crosses the REAL SessionManager and its REAL status reader's
 * `onUsageParsed` callback, with the telemetry's `processStatusUpdate` as the
 * observation point, so a callback that stops mapping (or maps for the wrong
 * session) goes red here. The mapping itself (`hostPathForTarget`) has its own
 * suite; the expected paths below are written out by hand rather than computed
 * with it.
 *
 * Red-green: passing `usage` straight to `processStatusUpdate` (dropping
 * `usageOnHost`) leaves the Linux path in the mapped case; making `usageOnHost`
 * map every session leaves the unmapped cases with a share path.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SessionUsage, StoredCliTarget } from '../../src/shared/types';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';

/** The parts of the manager this file reaches into: its registry, telemetry and status reader. */
interface ManagerInternals {
  registry: { set(sessionId: string, session: unknown): void; delete(sessionId: string): boolean };
  telemetry: { processStatusUpdate(sessionId: string, usage: SessionUsage): void };
  statusFileReader: { callbacks: { onUsageParsed(sessionId: string, usage: SessionUsage): void } };
}

const LINUX_TRANSCRIPT = '/home/dev/.claude/projects/-home-dev-project/3f2a9c10.jsonl';
const SHARE_TRANSCRIPT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-home-dev-project\\3f2a9c10.jsonl';

/** A target that recorded its homes, as a session spawned in a distro stores it. */
const TARGET_WITH_HOMES: StoredCliTarget = {
  kind: 'wsl',
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  env: {},
};

function makeUsage(transcriptPath?: string): SessionUsage {
  return {
    contextWindow: { usedPercentage: 12, usedTokens: 24000, cacheTokens: 0, totalInputTokens: 24000, totalOutputTokens: 500, contextWindowSize: 200000 },
    cost: { totalCostUsd: 0.02, totalDurationMs: 5000 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

describe('SessionManager: a distro CLI\'s transcript path reaches telemetry as this machine reads it', () => {
  let manager: SessionManager;
  let internals: ManagerInternals;
  let processStatusUpdate: MockInstance<(sessionId: string, usage: SessionUsage) => void>;
  const registeredSessionIds: string[] = [];

  /** Put a session row in the registry with the target it spawned under (null for this machine). */
  function registerSession(sessionId: string, cliTarget: StoredCliTarget | null): void {
    internals.registry.set(sessionId, { id: sessionId, cliTarget });
    registeredSessionIds.push(sessionId);
  }

  /** Deliver a status line's usage the way the status reader does after it parses status.json. */
  function deliverStatus(sessionId: string, usage: SessionUsage): void {
    internals.statusFileReader.callbacks.onUsageParsed(sessionId, usage);
  }

  beforeEach(() => {
    manager = new SessionManager();
    internals = manager as unknown as ManagerInternals;
    processStatusUpdate = vi.spyOn(internals.telemetry, 'processStatusUpdate').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Rows made of a bare object have no PTY to tear down; drop them before dispose walks the registry.
    for (const sessionId of registeredSessionIds.splice(0)) internals.registry.delete(sessionId);
    manager.dispose();
  });

  it('hands telemetry the distro share path for a session whose stored target carries its homes', () => {
    registerSession('session-wsl', TARGET_WITH_HOMES);
    const usage = makeUsage(LINUX_TRANSCRIPT);

    deliverStatus('session-wsl', usage);

    expect(processStatusUpdate).toHaveBeenCalledTimes(1);
    // Everything else the status line reported rides along; only the path moved.
    expect(processStatusUpdate).toHaveBeenCalledWith('session-wsl', { ...makeUsage(), transcriptPath: SHARE_TRANSCRIPT });
    // The parsed usage the reader handed over is not rewritten in place.
    expect(usage.transcriptPath).toBe(LINUX_TRANSCRIPT);
  });

  it('maps a path under a Windows drive mount back to the drive', () => {
    registerSession('session-wsl', TARGET_WITH_HOMES);

    deliverStatus('session-wsl', makeUsage('/mnt/c/Users/dev/transcripts/3f2a9c10.jsonl'));

    expect(processStatusUpdate).toHaveBeenCalledWith('session-wsl', expect.objectContaining({ transcriptPath: 'C:\\Users\\dev\\transcripts\\3f2a9c10.jsonl' }));
  });

  it('passes the path unchanged for a session with no stored target', () => {
    registerSession('session-local', null);
    const usage = makeUsage('/home/dev/.claude/projects/-home-dev-project/3f2a9c10.jsonl');

    deliverStatus('session-local', usage);

    expect(processStatusUpdate).toHaveBeenCalledTimes(1);
    expect(processStatusUpdate).toHaveBeenCalledWith('session-local', usage);
  });

  it('passes the path unchanged for a session the registry does not hold', () => {
    deliverStatus('session-unknown', makeUsage(LINUX_TRANSCRIPT));

    expect(processStatusUpdate).toHaveBeenCalledWith('session-unknown', makeUsage(LINUX_TRANSCRIPT));
  });

  it('passes the path unchanged when the stored target recorded no homes: it reads as this machine', () => {
    // A row from before the homes were kept: the distro is named, nothing to map with.
    registerSession('session-old-wsl', { kind: 'wsl', distro: 'Ubuntu' });

    deliverStatus('session-old-wsl', makeUsage(LINUX_TRANSCRIPT));

    expect(processStatusUpdate).toHaveBeenCalledWith('session-old-wsl', makeUsage(LINUX_TRANSCRIPT));
  });

  it('passes a status line with no transcript path through untouched, whatever the target', () => {
    registerSession('session-wsl', TARGET_WITH_HOMES);
    const usage = makeUsage();

    deliverStatus('session-wsl', usage);

    expect(processStatusUpdate).toHaveBeenCalledWith('session-wsl', usage);
    expect(processStatusUpdate.mock.calls[0][1]).not.toHaveProperty('transcriptPath');
  });

  it('maps by the session that reported, so two sessions on different machines never cross', () => {
    registerSession('session-wsl', TARGET_WITH_HOMES);
    registerSession('session-local', null);

    deliverStatus('session-local', makeUsage(LINUX_TRANSCRIPT));
    deliverStatus('session-wsl', makeUsage(LINUX_TRANSCRIPT));

    const mapped = processStatusUpdate.mock.calls.map(([sessionId, usage]) => [sessionId, (usage as SessionUsage).transcriptPath]);
    expect(mapped).toEqual([
      ['session-local', LINUX_TRANSCRIPT],
      ['session-wsl', SHARE_TRANSCRIPT],
    ]);
  });
});
