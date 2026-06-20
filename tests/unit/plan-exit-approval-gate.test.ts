/**
 * Plan-exit approval gate: SessionTelemetry must fire `onPlanExit` (which
 * drives the Planning -> Executing auto-move and Fable -> Opus respawn) ONLY
 * when the user approves the plan, never when the agent merely invokes
 * ExitPlanMode.
 *
 * Empirically (real captured production events.jsonl), ExitPlanMode emits:
 *   - `tool_start` at invocation, BEFORE the user decides (always);
 *   - `tool_end` (PostToolUse) ONLY when the user approves the plan;
 *   - on rejection ("keep planning") NO `tool_end` ever fires and the session
 *     stays in plan mode.
 * So the gate is `EventType.ToolEnd` for `ExitPlanMode`. Firing on
 * `ToolStart` (the old behavior) fabricated approval and moved the task before
 * the user saw the dialog.
 *
 * Fixtures are real captured sequences (sanitized):
 *   - approve: session-007-exit-plan-mode-resume.jsonl (tool_start -> idle
 *     permission -> tool_end)
 *   - reject:  session-011-exit-plan-mode-rejected.jsonl (tool_start -> idle
 *     permission -> prompt -> continued planning tools, NO ExitPlanMode tool_end)
 *
 * Red-green: reverting detectExitPlanMode to EventType.ToolStart makes the
 * "not fired before tool_end" assertion and the rejection test both fail,
 * reproducing the premature-move bug.
 *
 * Test tier: Unit (vitest, no browser, no Electron, no real OS processes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/activity-engine/session-telemetry';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');
const SESSION_ID = 'plan-exit-session';

function loadFixture(name: string): SessionEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('SessionTelemetry: plan-exit fires only on user approval', () => {
  let telemetry: SessionTelemetry;
  let planExitCalls: string[];

  beforeEach(() => {
    planExitCalls = [];
    const options: SessionTelemetryOptions = {
      // No background-shell watcher: this test only exercises the plan-exit
      // detector, so we avoid the OS process-tree probe entirely.
      disableBgShellWatcher: true,
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    };
    telemetry = new SessionTelemetry(
      {
        onUsageChange: (): void => {},
        onActivityChange: (): void => {},
        onEvent: (): void => {},
        onIdleTimeout: (): void => {},
        onPlanExit: (sessionId: string): void => {
          planExitCalls.push(sessionId);
        },
        onPRCandidate: (): void => {},
        requestSuspend: (): void => {},
        isSessionRunning: (): boolean => true,
      },
      options,
    );
    telemetry.initSession(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
  });

  it('approval path: does not fire on ExitPlanMode invocation, fires exactly once on completion', () => {
    const events = loadFixture('session-007-exit-plan-mode-resume.jsonl');

    // Feed events one at a time so we can observe the exact firing point.
    for (const event of events) {
      const isExitPlanStart =
        event.type === EventType.ToolStart && event.tool === AgentTool.ExitPlanMode;
      telemetry.ingestEvents(SESSION_ID, [event]);

      // Red-green guard: with the old ToolStart gate, onPlanExit fires here,
      // BEFORE the user has approved (the premature-move bug).
      if (isExitPlanStart) {
        expect(planExitCalls).toHaveLength(0);
      }
    }

    // tool_end (PostToolUse) is the approval signal: fired exactly once.
    expect(planExitCalls).toEqual([SESSION_ID]);
  });

  it('rejection path: never fires (no ExitPlanMode completion in the stream)', () => {
    const events = loadFixture('session-011-exit-plan-mode-rejected.jsonl');

    // Sanity: the fixture genuinely contains an ExitPlanMode invocation but no
    // matching completion, so it exercises the reject path, not an empty stream.
    const hasExitPlanStart = events.some(
      (event) => event.type === EventType.ToolStart && event.tool === AgentTool.ExitPlanMode,
    );
    const hasExitPlanEnd = events.some(
      (event) => event.type === EventType.ToolEnd && event.tool === AgentTool.ExitPlanMode,
    );
    expect(hasExitPlanStart).toBe(true);
    expect(hasExitPlanEnd).toBe(false);

    telemetry.ingestEvents(SESSION_ID, events);

    expect(planExitCalls).toHaveLength(0);
  });
});
