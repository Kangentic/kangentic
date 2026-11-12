/**
 * `SessionManager` re-emits a telemetry publish as `artifact-links` (#1056).
 * A user loses: a page an agent published never reaching the task's Artifacts
 * list because the manager stopped forwarding the telemetry callback, or the
 * links arriving under a source other than `agent`.
 *
 * The real manager and the real `SessionTelemetry` it builds; a tool-end event
 * carrying `urls` is ingested the way the event bridge's output is. Modelled on
 * session-manager-remove-emit.test.ts.
 *
 * Red-green: drop the `this.emit('artifact-links', ...)` in `onArtifactPublished`
 * and the forwarding case fails; change its source and the source assertion fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';

const PAGE = 'https://claude.ai/public/artifacts/abc-123';

describe('SessionManager artifact-links emit', () => {
  let manager: SessionManager;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    const internals = manager as unknown as { registry: SessionRegistry; telemetry: SessionTelemetry };
    internals.registry.set('sess-art-1', {
      id: 'sess-art-1',
      taskId: 'task-art',
      projectId: 'project-art',
      pty: null,
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
    telemetry = internals.telemetry;
    telemetry.initSession('sess-art-1');
  });

  afterEach(() => {
    manager.dispose();
  });

  it('re-emits a publish as artifact-links with the links, the title and source agent', () => {
    const emitted: unknown[][] = [];
    manager.on('artifact-links', (...args: unknown[]) => emitted.push(args));

    telemetry.ingestEvents('sess-art-1', [
      { ts: Date.now(), type: EventType.ToolEnd, tool: 'Artifact', toolId: 'tool-a', urls: [PAGE], urlsTitle: 'Checkout mock' },
    ]);

    expect(emitted).toEqual([['sess-art-1', { urls: [PAGE], title: 'Checkout mock', source: 'agent' }]]);
  });

  it('emits nothing for a tool end that carries no links', () => {
    const listener = vi.fn();
    manager.on('artifact-links', listener);

    telemetry.ingestEvents('sess-art-1', [
      { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash', toolId: 'tool-b' },
    ]);

    expect(listener).not.toHaveBeenCalled();
  });
});
