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

function bridgeSourceOf(file: string): string {
  return fs.readFileSync(path.join(AGENT_DIR, file), 'utf-8').replace(/\r\n/g, '\n');
}

function matcherBlockOf(file: string): string {
  const source = bridgeSourceOf(file);
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

describe('regexes the bridges build at run time', () => {
  // Every regex a bridge builds at run time comes from its argv, which CodeQL
  // reports as js/regex-injection. The only ones left are the event bridge's
  // three detail match directives, whose alerts are won't-fix. The shared block
  // builds none: an id source frames its id with literal text, found by plain
  // string search (alerts #28 and #30, fixed). CodeQL runs only after a merge to
  // main, so this list is what stops another one from landing unflagged.
  it.each([
    ['event-bridge.js', ['new RegExp(payload.pattern)', 'new RegExp(payload.pattern)', 'new RegExp(payload.pattern)']],
    ['background-shell-hint-bridge.js', []],
  ])('%s builds a regex only from a detail pattern an adapter sends', (file, expectedCalls) => {
    expect(bridgeSourceOf(file).match(/(?:\bnew\s+)?\bRegExp\s*\([^)]*\)/g) ?? []).toEqual(expectedCalls);
  });

  // The scan above sees only an explicit RegExp call. A string handed to
  // `.match`, `.matchAll` or `.search` is compiled as a regex too, so the shared
  // block, which both bridges run over hook payloads, calls none of them.
  it('the background-call-match block hands nothing to a regex API', () => {
    const block = matcherBlockOf('event-bridge.js');
    expect(block).not.toMatch(/\bRegExp\s*\(|\.(?:match|matchAll|search)\s*\(/);
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

  // An id inside result text is read as a run of at most ID_RUN_SCAN_LENGTH characters. One past
  // the longest id lets a run that is too long fail the pattern instead of being cut to fit it.
  it('reads an id run one character past the longest id SHELL_ID_PATTERN_SOURCE allows', () => {
    const longestId = /\{1,(\d+)\}/.exec(SHELL_ID_PATTERN_SOURCE);
    expect(longestId, 'SHELL_ID_PATTERN_SOURCE has no {1,N} length bound').not.toBeNull();
    const scanLength = /^const ID_RUN_SCAN_LENGTH = (\d+);$/m.exec(matcherBlockOf('event-bridge.js'));
    expect(scanLength, 'the background-call-match block has no `const ID_RUN_SCAN_LENGTH = N;` literal').not.toBeNull();
    expect(Number(scanLength?.[1])).toBe(Number(longestId?.[1]) + 1);
  });
});
