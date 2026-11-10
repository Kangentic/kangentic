/**
 * A real `token_count` record from a Codex rollout, with its values made up and its keys and
 * nesting kept (tests/fixtures/codex-token-count-no-windows.jsonl). It is the shape an API-key
 * session writes: a snapshot object whose `primary` and `secondary` are both null. No record with
 * a window was available when this was written, so the windowed path stays covered only by
 * codex-rate-limits.test.ts's hand-built sample.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexRateLimits } from '../../src/main/agent/adapters/codex/rate-limits';

describe('parseCodexRateLimits on a real-shape record', () => {
  it('reads a snapshot with null windows as no limits, without throwing', () => {
    const line = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-token-count-no-windows.jsonl'), 'utf8').trim();
    const record = JSON.parse(line) as { timestamp: string; payload: { type: string; rate_limits: unknown } };
    expect(record.payload.type).toBe('token_count');
    expect(parseCodexRateLimits(record.payload.rate_limits, Date.parse(record.timestamp))).toBeNull();
  });
});
