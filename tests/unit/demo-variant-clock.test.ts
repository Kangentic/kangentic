/**
 * A session's clock is its single recording's, whichever recording its terminal plays
 * (`sessionDurationMs` inside buildDemoPreConfig's generated script,
 * tests/captures/helpers/demo-dataset.ts). Before this the live path re-based the clock on
 * whichever recording the terminal fetched, so a window that opened at the tiled width on a
 * variant shorter than the stretch the session had already run finished the session on the spot:
 * the board's working card flipped to needs-you the moment its window opened, and CI's demo tier
 * caught it as a flake on the 125 percent display case (Linux fonts fit 141 columns there, under
 * the single recording's 154, so that pane takes the variant).
 *
 * The function is lifted from the GENERATED seed for the reason demo-frame-fit.test.ts gives: the
 * seed is a template literal, and the program the page runs is the evaluated one. It reads
 * `data.ends`, so the factory is given a stand-in `data`.
 */
import { describe, expect, it } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Recording { stream: Array<{ t: number; data: string }> }
interface Clock {
  sessionDurationMs: (sessionId: string, recording: Recording) => number;
  recordingEndMs: (recording: Recording) => number;
}

function extractClock(ends: Record<string, { durationMs: number }>): Clock {
  const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
  const start = script.indexOf('function sessionDurationMs(');
  if (start === -1) throw new Error('function sessionDurationMs not found in the generated seed');
  const marker = 'function recordingEndMs(';
  const endStart = script.indexOf(marker, start);
  if (endStart === -1) throw new Error('function recordingEndMs not found in the generated seed');
  const open = script.indexOf('{', endStart);
  let depth = 0;
  let end = -1;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end === -1) throw new Error('unbalanced recordingEndMs in the generated seed');
  const factory = new Function('data', `${script.slice(start, end)}\nreturn { sessionDurationMs, recordingEndMs };`) as (data: unknown) => Clock;
  return factory({ ends });
}

const single: Recording = { stream: [{ t: 0, data: 'a' }, { t: 128_460, data: 'b' }] };
const shorterVariant: Recording = { stream: [{ t: 0, data: 'a' }, { t: 63_831, data: 'b' }] };
const longerVariant: Recording = { stream: [{ t: 0, data: 'a' }, { t: 151_748, data: 'b' }] };

describe('a variant recording on the session clock', () => {
  const clock = extractClock({ 'sess-seeded': { durationMs: 128_460 } });

  it('keeps the session clock at the single recording\'s length whichever recording is fetched', () => {
    expect(clock.sessionDurationMs('sess-seeded', single)).toBe(128_460);
    expect(clock.sessionDurationMs('sess-seeded', shorterVariant)).toBe(128_460);
    expect(clock.sessionDurationMs('sess-seeded', longerVariant)).toBe(128_460);
  });

  it('reads a recording\'s own end from its last chunk, which is what decides whether it has finished behind the clock', () => {
    expect(clock.recordingEndMs(single)).toBe(128_460);
    expect(clock.recordingEndMs(shorterVariant)).toBe(63_831);
    expect(clock.recordingEndMs({ stream: [] })).toBe(0);
  });

  it('leaves a session the seed did not clock (a spawn, a Command Terminal boot) on its own recording', () => {
    expect(clock.sessionDurationMs('sess-spawned', longerVariant)).toBe(151_748);
    expect(clock.sessionDurationMs('sess-spawned', { stream: [] })).toBe(0);
  });
});
