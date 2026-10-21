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

  // Every regex the block builds at run time comes from the bridge's argv, which
  // CodeQL reports as js/regex-injection. The one it keeps is an id source's
  // pattern: adapter data that has to travel, so that alert is dismissed. CodeQL
  // runs only after a merge to main, so this test is what stops a second one, such
  // as the id shape the block used to read from its payload, from landing unflagged.
  it('builds a regex at run time only from an id source pattern', () => {
    const block = matcherBlockOf('event-bridge.js');
    expect(block.match(/new RegExp\(/g)).toEqual(['new RegExp(']);
    expect(block).toContain('new RegExp(source.pattern)');
  });
});

describe('shell id pattern parity', () => {
  // Both bridges check a shell id against one literal in the shared block, since
  // a workspace copy of either bridge is one file and cannot import
  // SHELL_ID_PATTERN_SOURCE. The block is byte-identical across the two (above),
  // so pinning the event bridge's copy pins both.
  it('is the same in the shared block literal and SHELL_ID_PATTERN_SOURCE', () => {
    const block = matcherBlockOf('event-bridge.js');
    const literal = /^const SHELL_ID_PATTERN = \/(.+)\/;$/m.exec(block);
    expect(literal, 'the background-call-match block has no `const SHELL_ID_PATTERN = /.../;` literal').not.toBeNull();
    expect(literal?.[1]).toBe(SHELL_ID_PATTERN_SOURCE);
  });
});
