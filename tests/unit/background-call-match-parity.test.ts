/**
 * The event bridge and the background shell hint bridge carry the same
 * background call matcher, verbatim, between `// BEGIN background-call-match`
 * and `// END background-call-match` (task #859). They cannot share a module:
 * a CLI whose hooks take bare tokens runs a one-file workspace copy of either.
 * The hold (`appendBackgroundLaunch`) and the hint must answer exactly the same
 * calls, so the two copies must stay byte-identical.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SHELL_ID_PATTERN_SOURCE } from '../../src/shared/background-command-spec';

const AGENT_DIR = path.resolve(__dirname, '../../src/main/agent');
const BEGIN = '// BEGIN background-call-match';
const END = '// END background-call-match';

function matcherBlockOf(file: string): string {
  const source = fs.readFileSync(path.join(AGENT_DIR, file), 'utf-8').replace(/\r\n/g, '\n');
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  expect(start, `${file} has no ${BEGIN}`).toBeGreaterThanOrEqual(0);
  expect(end, `${file} has no ${END}`).toBeGreaterThan(start);
  expect(source.indexOf(BEGIN, start + 1), `${file} has two ${BEGIN}`).toBe(-1);
  return source.slice(start, end + END.length);
}

describe('background call matcher parity', () => {
  it('is byte-identical in event-bridge.js and background-shell-hint-bridge.js', () => {
    const eventBridgeBlock = matcherBlockOf('event-bridge.js');
    const hintBridgeBlock = matcherBlockOf('background-shell-hint-bridge.js');
    expect(eventBridgeBlock.length).toBeGreaterThan(200);
    expect(hintBridgeBlock).toBe(eventBridgeBlock);
  });

  it('defines the functions both bridges call', () => {
    const block = matcherBlockOf('event-bridge.js');
    for (const name of ['valueAtPath', 'conditionHolds', 'idFromSources', 'matchBackgroundCall', 'commandCarries']) {
      expect(block).toContain(`function ${name}(`);
    }
  });
});

describe('shell id pattern parity', () => {
  // The hint bridge's v1 path (Claude's spec) checks a shell id against its own
  // literal, since a workspace copy of the bridge is one file and cannot import
  // SHELL_ID_PATTERN_SOURCE. The v2 path and the event bridge take the pattern from
  // the directive or spec payload, so only this literal can drift from the source.
  it('is the same in the hint bridge v1 literal and SHELL_ID_PATTERN_SOURCE', () => {
    const source = fs.readFileSync(path.join(AGENT_DIR, 'background-shell-hint-bridge.js'), 'utf-8').replace(/\r\n/g, '\n');
    const literal = /^const SHELL_ID_PATTERN = \/(.+)\/;$/m.exec(source);
    expect(literal, 'background-shell-hint-bridge.js has no `const SHELL_ID_PATTERN = /.../;` literal').not.toBeNull();
    expect(literal?.[1]).toBe(SHELL_ID_PATTERN_SOURCE);
  });
});
