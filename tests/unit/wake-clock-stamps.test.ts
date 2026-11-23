/**
 * What is lost if these stamps go: a Browser-pane screenshot timeout reports
 * `since_wake`, read from the wake clock, and `cpu_speed_limit`, read from the CPU
 * speed-limit record. Only `src/main/index.ts` stamps them, from the powerMonitor's
 * resume and unlock-screen events and its speed-limit-change event. If a call is
 * dropped, its tag reads `none` or `unknown` forever and says nothing. index.ts cannot
 * be imported by a test, so this reads its source, and reads each handler's own body.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

/** The text between the braces of the arrow function passed to `powerMonitor.on('<event>', ...)`. */
function handlerBody(source: string, eventName: string): string {
  const marker = `powerMonitor.on('${eventName}'`;
  const start = source.indexOf(marker);
  expect(start, `index.ts registers powerMonitor.on('${eventName}')`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++;
    else if (source[cursor] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, cursor);
    }
  }
  throw new Error(`Unbalanced braces after ${marker}`);
}

describe('the wake clock and the CPU speed limit are stamped from index.ts', () => {
  it('extracts a handler body rather than the whole file', () => {
    expect(handlerBody(indexSource, 'resume')).not.toContain("powerMonitor.on('unlock-screen'");
  });

  it.each(['resume', 'unlock-screen'])('calls noteWake() in the %s handler', (eventName) => {
    expect(handlerBody(indexSource, eventName)).toMatch(/\bnoteWake\(/);
  });

  it('records the limit the speed-limit-change event carries', () => {
    expect(handlerBody(indexSource, 'speed-limit-change')).toMatch(/\bnoteCpuSpeedLimit\(\s*details\.limit\s*\)/);
  });
});
