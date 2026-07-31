import { describe, it, expect } from 'vitest';
import { resolveEffortDisplay, resolveModelDisplay } from '../../src/renderer/utils/pill-provenance';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';

/**
 * The context bar showed a stored effort override with exactly the same visual
 * weight as live telemetry, so a session running on a model with no effort
 * levels displayed a confident, wrong `high`. These lock the derivation that
 * separates "the agent reports this" from "this is what you configured".
 */
describe('pill provenance', () => {
  describe('resolveEffortDisplay', () => {
    it('reports a live effort as live', () => {
      expect(resolveEffortDisplay({
        liveEffort: 'low',
        taskEffortOverride: 'high',
        swimlaneEffortOverride: null,
        projectDefaultEffort: null,
      })).toEqual({ value: 'low', isLive: true });
    });

    it('falls through task -> swimlane -> project, never claiming live', () => {
      const chain = {
        liveEffort: null,
        taskEffortOverride: 'task',
        swimlaneEffortOverride: 'swimlane',
        projectDefaultEffort: 'project',
      };
      expect(resolveEffortDisplay(chain)).toEqual({ value: 'task', isLive: false });
      expect(resolveEffortDisplay({ ...chain, taskEffortOverride: null }))
        .toEqual({ value: 'swimlane', isLive: false });
      expect(resolveEffortDisplay({ ...chain, taskEffortOverride: null, swimlaneEffortOverride: null }))
        .toEqual({ value: 'project', isLive: false });
    });

    it('has nothing to show when neither telemetry nor any override exists', () => {
      expect(resolveEffortDisplay({
        liveEffort: null,
        taskEffortOverride: null,
        swimlaneEffortOverride: null,
        projectDefaultEffort: null,
      })).toEqual({ value: null, isLive: false });
    });

    it('a Haiku status payload never yields a live effort, whatever the override says', () => {
      // The resolver's half of the fix. The COMPONENT goes further for this
      // exact case and hides the pill entirely (a model with no effort levels
      // has nothing for the picker to apply) - see the `agentReportsNoEffort`
      // gate in ModelEffortPicker and its UI spec. What matters here is that a
      // configured value can never come back flagged as live.
      // Same Haiku-shaped payload as the status-parser spec: Claude Code omits
      // the effort key for models with no effort levels.
      const usage = ClaudeStatusParser.parseStatus(JSON.stringify({
        model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
        context_window: { used_percentage: 38, context_window_size: 200_000 },
        cost: { total_cost_usd: 0.57, total_duration_ms: 176_000 },
      }));
      expect(usage).not.toBeNull();

      const display = resolveEffortDisplay({
        liveEffort: usage!.model.effort ?? null,
        taskEffortOverride: 'high',
        swimlaneEffortOverride: null,
        projectDefaultEffort: null,
      });

      // The pill still shows a value (the fallback chain exists for a reason and
      // must not be deleted), but it is no longer indistinguishable from live.
      expect(display).toEqual({ value: 'high', isLive: false });
    });
  });

  describe('resolveModelDisplay', () => {
    const overrides = {
      taskModelOverride: null,
      swimlaneModelOverride: null,
      projectDefaultModel: null,
    };

    it('treats a reported model as live', () => {
      expect(resolveModelDisplay({
        liveModelName: 'Haiku 4.5',
        telemetryLanded: true,
        ...overrides,
      })).toEqual({ value: 'Haiku 4.5', isLive: true });
    });

    it('shows a spawn-seeded model name but does not call it live', () => {
      // A spawn seeds the display name from the `--model` flag so a background
      // session shows its model immediately. That name is worth displaying and
      // is NOT agent-confirmed, which is the whole reason telemetryLanded exists.
      expect(resolveModelDisplay({
        liveModelName: 'Opus 4.8',
        telemetryLanded: false,
        ...overrides,
      })).toEqual({ value: 'Opus 4.8', isLive: false });
    });

    it('falls back to the configured override id when nothing is running', () => {
      expect(resolveModelDisplay({
        liveModelName: null,
        telemetryLanded: false,
        taskModelOverride: null,
        swimlaneModelOverride: 'opus',
        projectDefaultModel: 'sonnet',
      })).toEqual({ value: 'opus', isLive: false });
    });

    it('has nothing to show with no live name and no override', () => {
      expect(resolveModelDisplay({
        liveModelName: null,
        telemetryLanded: false,
        ...overrides,
      })).toEqual({ value: null, isLive: false });
    });
  });
});
