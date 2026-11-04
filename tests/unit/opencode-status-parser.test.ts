/**
 * The OpenCode adapter's `parseStatus`, over the `status.json` its OpenCode 1
 * plugin writes. The file is the plugin's own (`createSessionTracker().status()`),
 * so the fixture is built by running the real tracker over OpenCode-shaped
 * plugin inputs rather than written out by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KangenticActivity } from '../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs';
import { parseOpenCodeStatus } from '../../src/main/agent/adapters/opencode/status-parser';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'opencode-plugin-events.json'), 'utf-8'));

function statusAfter(events: unknown[], withParams = true): string {
  const tracker = KangenticActivity.helpers.createSessionTracker();
  if (withParams) tracker.onChatParams(fixtures.chat_params_root);
  for (const event of events) tracker.onEvent(event, 1717000000000);
  return JSON.stringify(tracker.status());
}

describe('parseOpenCodeStatus', () => {
  it('reports the model by its CLI name, the root\'s context against the model\'s limit, and the cost', () => {
    const usage = parseOpenCodeStatus(statusAfter([
      fixtures.event_child_session_created,
      fixtures.event_message_updated_root_1,
      fixtures.event_message_updated_child,
      fixtures.event_message_updated_root_2,
    ]));
    expect(usage).toEqual({
      contextWindow: {
        usedPercentage: ((600 + 9600 + 200) / 200000) * 100,
        usedTokens: 600 + 9600 + 200,
        cacheTokens: 9600 + 200,
        totalInputTokens: (1200 + 600) + (8000 + 9600) + (400 + 200),
        totalOutputTokens: (300 + 900) + 50,
        contextWindowSize: 200000,
      },
      cost: { totalCostUsd: expect.closeTo(0.035, 10), totalDurationMs: 0 },
      model: { id: 'anthropic/claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', reportedByAgent: true },
    });
  });

  it('names no session id, so a subagent can never read as a conversation switch', () => {
    const usage = parseOpenCodeStatus(statusAfter([fixtures.event_message_updated_root_1]));
    expect(usage).not.toHaveProperty('sessionId');
  });

  it('reports an unknown context size as 0 and 0 percent, never a guessed one', () => {
    const usage = parseOpenCodeStatus(statusAfter([fixtures.event_message_updated_root_1], false));
    expect(usage?.contextWindow.contextWindowSize).toBe(0);
    expect(usage?.contextWindow.usedPercentage).toBe(0);
    // With no name from chat.params, the id is the label.
    expect(usage?.model.displayName).toBe('anthropic/claude-sonnet-4-5');
  });

  it('caps the context percentage at 100 when the used tokens exceed the limit', () => {
    const usage = parseOpenCodeStatus(JSON.stringify({
      kangenticOpenCodeStatus: 1,
      model: { id: 'p/m' },
      context: { input: 150000, cacheRead: 100000 },
      contextLimit: 200000,
    }));
    expect(usage?.contextWindow.usedTokens).toBe(250000);
    expect(usage?.contextWindow.usedPercentage).toBe(100);
  });

  it('reads a negative, NaN or string number as 0', () => {
    const usage = parseOpenCodeStatus(JSON.stringify({
      kangenticOpenCodeStatus: 1,
      model: { id: 'p/m' },
      context: { input: -5, output: 'many', cacheRead: '1000', cacheWrite: null },
      totals: { input: -1, output: Number.NaN, reasoning: '7' },
      contextLimit: '200000',
      costUsd: -3,
    }));
    expect(usage).toMatchObject({
      contextWindow: { usedTokens: 0, cacheTokens: 0, usedPercentage: 0, totalInputTokens: 0, totalOutputTokens: 0, contextWindowSize: 0 },
      cost: { totalCostUsd: 0 },
    });
  });

  it('falls back to the id when the model name is only whitespace', () => {
    const usage = parseOpenCodeStatus(JSON.stringify({ kangenticOpenCodeStatus: 1, model: { id: 'p/m', name: '   ' } }));
    expect(usage?.model.displayName).toBe('p/m');
  });

  it('returns null for an empty file, bad JSON, another writer\'s file, or no model', () => {
    expect(parseOpenCodeStatus('')).toBeNull();
    expect(parseOpenCodeStatus('{not json')).toBeNull();
    expect(parseOpenCodeStatus(JSON.stringify({ model: { id: 'x' } }))).toBeNull();
    expect(parseOpenCodeStatus(JSON.stringify({ kangenticOpenCodeStatus: 1, model: {} }))).toBeNull();
    expect(parseOpenCodeStatus('null')).toBeNull();
  });

  it('is the adapter\'s parseStatus, on a status file the plugin rewrites whole', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.runtime.statusFile?.parseStatus).toBe(parseOpenCodeStatus);
    expect(adapter.runtime.statusFile?.isFullRewrite).toBe(true);
  });
});
