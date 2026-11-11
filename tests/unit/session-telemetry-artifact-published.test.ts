/**
 * Wiring test for SessionTelemetry's artifact publish callback (#1056): an
 * event carrying `urls` (what the bridge's `extractToolUrls` sets) fires
 * `onArtifactPublished` with the session, the links and the title, and an
 * event without links never does. A user loses: a page Claude published never
 * reaching the task's Artifacts, or a callback firing on every tool call.
 *
 * Test tier: Unit (vitest). The bg-shell watcher is disabled so no OS probe
 * is constructed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

function makeTelemetry(onArtifactPublished?: (sessionId: string, urls: string[], title: string | null) => void): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      onArtifactPublished,
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    {
      disableBgShellWatcher: true,
      activityEngineOptions: { idleStabilityWindowMs: 0 },
    },
  );
}

function event(partial: Partial<SessionEvent> & { type: EventType }): SessionEvent {
  return { ts: Date.now(), ...partial };
}

describe('SessionTelemetry: a publish event fires onArtifactPublished', () => {
  let telemetry: SessionTelemetry | null = null;
  const PAGE = 'https://claude.ai/public/artifacts/abc-123';

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
  });

  it('fires with the session, the links and the title', () => {
    const onArtifactPublished = vi.fn();
    telemetry = makeTelemetry(onArtifactPublished);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolEnd, tool: 'Artifact', toolId: 'tool-a', urls: [PAGE], urlsTitle: 'Checkout mock' }),
    ]);

    expect(onArtifactPublished).toHaveBeenCalledTimes(1);
    expect(onArtifactPublished).toHaveBeenCalledWith('s1', [PAGE], 'Checkout mock');
  });

  it('passes a null title when the publish had none', () => {
    const onArtifactPublished = vi.fn();
    telemetry = makeTelemetry(onArtifactPublished);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [event({ type: EventType.ToolEnd, tool: 'Artifact', toolId: 'tool-a', urls: [PAGE] })]);

    expect(onArtifactPublished).toHaveBeenCalledWith('s1', [PAGE], null);
  });

  it('does not fire for an event with no links or an empty list', () => {
    const onArtifactPublished = vi.fn();
    telemetry = makeTelemetry(onArtifactPublished);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId: 'tool-a' }),
      event({ type: EventType.ToolEnd, tool: 'Artifact', toolId: 'tool-b', urls: [] }),
    ]);

    expect(onArtifactPublished).not.toHaveBeenCalled();
  });

  it('is optional: an event with links is ingested without a listener', () => {
    telemetry = makeTelemetry(undefined);
    telemetry.initSession('s1');
    expect(() => telemetry?.ingestEvents('s1', [event({ type: EventType.ToolEnd, tool: 'Artifact', toolId: 'tool-a', urls: [PAGE] })])).not.toThrow();
  });
});
