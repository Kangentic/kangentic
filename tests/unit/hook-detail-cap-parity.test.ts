import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_DETAIL_CAP } from '../../src/main/git/push-command';

/**
 * `HOOK_DETAIL_CAP` is a hand-duplicated copy of the cap the hook bridge
 * applies to every extracted field (`firstNonNull` in event-bridge.js). The
 * bridge is unbundled CommonJS injected into the agent CLI, so it cannot import
 * the TypeScript constant, and the two can only be kept equal by a test.
 *
 * It is load-bearing for the push capture: the parser refuses a refspec that
 * runs to the very end of an input AT the cap, because such a name may be a
 * prefix of the real one. A bridge cap raised without this constant following
 * would silently stop that guard (an input cut at the new cap is no longer "at
 * the cap" the parser knows), and a cap lowered without it would refuse whole
 * names.
 */
function readCap(relativePath: string, constantName: string): number {
  const source = fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
  const match = new RegExp(`const ${constantName} = (\\d+);`).exec(source);
  expect(match, `${relativePath} no longer declares \`const ${constantName} = <number>;\``).not.toBeNull();
  return Number(match?.[1]);
}

describe('HOOK_DETAIL_CAP matches the hook bridge', () => {
  it('equals FIELD_CAP in event-bridge.js, which firstNonNull applies', () => {
    const bridgePath = 'src/main/agent/event-bridge.js';
    expect(readCap(bridgePath, 'FIELD_CAP')).toBe(HOOK_DETAIL_CAP);

    const source = fs.readFileSync(path.resolve(__dirname, '../..', bridgePath), 'utf8');
    const functionStart = source.indexOf('function firstNonNull(');
    expect(functionStart, 'firstNonNull moved or was renamed; re-point this test').toBeGreaterThan(-1);
    const functionSource = source.slice(functionStart, source.indexOf('\n}\n', functionStart));
    expect(functionSource, 'firstNonNull no longer caps with FIELD_CAP').toContain('.slice(0, FIELD_CAP)');
    // The only bare literal left is the `hookContext` capture's whole-payload
    // cap (2048, used at session_start and by the captureHookContext
    // directive), which is deliberately its own number. Every `tool` /
    // `detail` field cap goes through FIELD_CAP, so any other bare literal
    // means a field slipped back onto a private cap.
    const bareCaps = source.match(/\.slice\(0,\s*\d+\)/g) ?? [];
    const HOOK_CONTEXT_CAP = '.slice(0, 2048)';
    expect(bareCaps.length, 'the hookContext capture moved off its bare cap; re-point this test').toBeGreaterThan(0);
    expect(
      bareCaps.filter((cap) => cap !== HOOK_CONTEXT_CAP),
      'a bridge field is capped by a bare literal instead of FIELD_CAP',
    ).toEqual([]);
  });

  it('equals the OpenCode plugin cap, which writes the same event shape directly', () => {
    expect(readCap('src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs', 'FIELD_CAP')).toBe(HOOK_DETAIL_CAP);
  });
});
