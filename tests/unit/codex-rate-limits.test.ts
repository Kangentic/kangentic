import { describe, expect, it } from 'vitest';
import { parseCodexRateLimits } from '../../src/main/agent/adapters/codex/rate-limits';
import { CodexSessionHistoryParser } from '../../src/main/agent/adapters/codex/session-history-parser';

// The `token_count` record's `rate_limits` as Codex writes it (`RateLimitSnapshot`,
// codex-rs/protocol/src/protocol.rs): `used_percent` is a float, `resets_at` Unix seconds.
const RECORD_TIME_MS = Date.parse('2026-11-09T12:00:00.000Z');
const RECORD_SECONDS = RECORD_TIME_MS / 1000;
const SNAPSHOT = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 42.6, window_minutes: 300, resets_at: RECORD_SECONDS + 3600 },
  secondary: { used_percent: 12, window_minutes: 10080, resets_at: RECORD_SECONDS + 3 * 86_400 },
  credits: null,
  plan_type: 'pro',
};

describe('parseCodexRateLimits', () => {
  it('reads the primary and secondary windows as the context bar draws them', () => {
    expect(parseCodexRateLimits(SNAPSHOT, RECORD_TIME_MS)).toEqual([
      { id: 'codex-primary', label: '5h session', iconKind: 'session', usedPercentage: 42.6, resetsAt: RECORD_SECONDS + 3600, windowDurationSeconds: 18_000 },
      { id: 'codex-secondary', label: '7d weekly', iconKind: 'period', usedPercentage: 12, resetsAt: RECORD_SECONDS + 3 * 86_400, windowDurationSeconds: 604_800 },
    ]);
  });

  it('reads a reset given relative to the record, as older builds wrote it', () => {
    const windows = parseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 900 } }, RECORD_TIME_MS);
    expect(windows?.[0].resetsAt).toBe(RECORD_SECONDS + 900);
  });

  it('is null for an API-key session, whose snapshot and windows are null', () => {
    expect(parseCodexRateLimits(null, RECORD_TIME_MS)).toBeNull();
    expect(parseCodexRateLimits({ limit_id: 'codex', primary: null, secondary: null }, RECORD_TIME_MS)).toBeNull();
  });

  it('keeps another limit bucket apart from the main one, and clamps the share', () => {
    const windows = parseCodexRateLimits({ limit_id: 'gpt-max', primary: { used_percent: 120, window_minutes: 300, resets_at: RECORD_SECONDS } }, RECORD_TIME_MS);
    expect(windows?.[0]).toMatchObject({ id: 'codex-gpt-max-primary', usedPercentage: 100 });
  });
});

describe('Codex history parser', () => {
  it('reports the windows on usage, and a later null snapshot leaves them in place', () => {
    const line = (rateLimits: unknown): string => JSON.stringify({
      timestamp: '2026-11-09T12:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: rateLimits },
    });
    const result = CodexSessionHistoryParser.parse(`${line(SNAPSHOT)}\n${line(null)}\n`, 'append');
    expect(result.usage?.rateLimits?.map((window) => [window.id, window.usedPercentage])).toEqual([
      ['codex-primary', 42.6],
      ['codex-secondary', 12],
    ]);
  });
});
