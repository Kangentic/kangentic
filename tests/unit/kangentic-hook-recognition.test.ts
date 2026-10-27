/**
 * How `isKangenticHookCommand` recognizes a hook that carries none of the
 * `.kangentic` / `/kangentic/` path markers or the events-path variable: by the
 * background shell hint spec it carries (branch b), or by the exact bridge path
 * this running app ships (branch c).
 *
 * This is its own file because `hook-utils.ts` keeps the shipped bridge paths in a
 * module-level `let`, resolved on first use. `resolveBridgeScript` is mocked here
 * to answer a backslash Windows install path for the whole file, and the memo
 * would hold that answer for any other suite sharing the module instance. Vitest
 * gives each test file its own module instance.
 */
import { describe, it, expect, vi } from 'vitest';

const { WINDOWS_BUILD_DIRECTORY } = vi.hoisted(() => ({
  // Backslashes, as `resolveBridgeScript` answers on a Windows install.
  WINDOWS_BUILD_DIRECTORY: 'C:\\Program Files\\Kangentic\\resources\\app.asar.unpacked\\.vite\\build',
}));

vi.mock('../../src/main/agent/shared/bridge-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/bridge-utils')>();
  return { ...actual, resolveBridgeScript: (name: string) => `${WINDOWS_BUILD_DIRECTORY}\\${name}.js` };
});

import { isKangenticHookCommand } from '../../src/main/agent/shared/hook-utils';
import { buildBackgroundShellHintCommand } from '../../src/main/agent/shared/background-shell-hint-hook';
import { CLAUDE_BACKGROUND_SHELL_HINT_SPEC, CLAUDE_BRIDGE_SHELL } from '../../src/main/agent/adapters/claude/hook-manager';

/** An install directory with no `.kangentic` or `/kangentic/` in it, and not the mocked shipped path. */
const OTHER_APP_BUILD_DIRECTORY = '/opt/Other/build';
const OTHER_APP_HINT_BRIDGE = `${OTHER_APP_BUILD_DIRECTORY}/background-shell-hint-bridge.js`;

function base64Of(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

// Pins `carriesKangenticHintSpec` in src/main/agent/shared/hook-utils.ts. The
// three negatives guard against over-matching: a rewrite that tests the raw
// command for the tool name, that takes any hint bridge command as Kangentic's,
// or that drops the decoded `includes(MARK_BACKGROUND_SERVICE_TOOL)` check after
// the base64 shape test flips them to true. They cannot catch the removal of the
// hint branch altogether, because a false answer is also what a missing branch
// gives. The positive is what proves the branch is live: it is true only through
// the hint spec, since nothing else in the command or the mocked shipped path
// matches, and it fails if the branch is removed or stops decoding the spec.
describe('a background shell hint command is recognized by its spec, not by where it points (H5)', () => {
  it('does not take raw text that names the MCP tool, with no base64 spec, for Kangentic\'s', () => {
    expect(isKangenticHookCommand(`node '${OTHER_APP_HINT_BRIDGE}' 'call kangentic_mark_background_service'`)).toBe(false);
  });

  it('does not take a hint bridge command with no argument at all for Kangentic\'s', () => {
    expect(isKangenticHookCommand(`node '${OTHER_APP_HINT_BRIDGE}'`)).toBe(false);
    expect(isKangenticHookCommand(`node ${OTHER_APP_HINT_BRIDGE}   `)).toBe(false);
  });

  it('does not take a valid base64 spec that does not name the MCP tool for Kangentic\'s', () => {
    const unrelatedSpec = base64Of(JSON.stringify({ reply: 'Remember to commit your work before the turn ends.' }));
    expect(isKangenticHookCommand(`node '${OTHER_APP_HINT_BRIDGE}' ${unrelatedSpec}`)).toBe(false);
  });

  it('takes a real Kangentic hint spec from the same other-app path for Kangentic\'s', () => {
    const command = buildBackgroundShellHintCommand(CLAUDE_BRIDGE_SHELL, OTHER_APP_HINT_BRIDGE, CLAUDE_BACKGROUND_SHELL_HINT_SPEC);

    // Nothing but the hint spec can make this true, which keeps the negatives above from passing vacuously.
    expect(command).not.toContain('.kangentic');
    expect(command).not.toContain('/kangentic/');
    expect(command).not.toContain('KANGENTIC_EVENTS_PATH');
    expect(command).not.toContain('Program Files');
    expect(isKangenticHookCommand(command)).toBe(true);
  });
});

// Pins the `wsl-hook.sh` clause of `isKangenticHookCommand`. The WSL hook
// transport's commands run `sh <script> <verb> ...` instead of a node bridge, so
// no `*-bridge` name is in them, and without that clause a stale entry in a
// distro CLI's settings would never be swept. Like the node bridges, the script
// name alone is not enough: a user's own `wsl-hook.sh` must survive, so the
// command also has to point into `.kangentic`. The negatives name an install the
// mocked shipped paths do not match, so branch (c) cannot rescue them.
describe('a WSL hook transport command is recognized by its script and a .kangentic path', () => {
  const NODE_BRIDGE_NAMES = ['activity-bridge', 'event-bridge', 'plan-approval-bridge', 'background-shell-hint-bridge'];

  it.each([
    ['a session\'s own script', 'sh "/mnt/c/p/.kangentic/sessions/s/wsl-hooks/wsl-hook.sh" event tool_start'],
    ['a workspace copy', 'sh .kangentic/gemini-wsl-hook.sh event x'],
  ])('takes %s for Kangentic\'s', (_label, command) => {
    // Only the wsl-hook.sh clause can name the bridge here, and only `.kangentic` can vouch for it.
    for (const bridgeName of NODE_BRIDGE_NAMES) expect(command).not.toContain(bridgeName);
    expect(command).not.toContain('KANGENTIC_EVENTS_PATH');
    expect(command).not.toContain('/kangentic/');

    expect(isKangenticHookCommand(command)).toBe(true);
  });

  it('does not take a wsl-hook.sh outside .kangentic, which is the user\'s own script', () => {
    const command = 'sh /home/dev/scripts/wsl-hook.sh event x';
    expect(command).not.toContain('.kangentic');
    expect(command).not.toContain('/kangentic/');

    expect(isKangenticHookCommand(command)).toBe(false);
  });

  it('does not take a .kangentic path that runs no bridge script at all', () => {
    expect(isKangenticHookCommand('sh "/mnt/c/p/.kangentic/sessions/s/wsl-hooks/other.sh" event x')).toBe(false);
  });
});

// Pins `ownBridgePaths` in src/main/agent/shared/hook-utils.ts, which maps every
// `resolveBridgeScript` answer through `toForwardSlash`. A hook command names
// the bridge forward-slashed, so without the mapping the memoized backslash
// path is never a substring of it and the positives below turn false. The
// negative holds the other way: a command for another install's bridge is not
// swept up by branch (c). `/Program Files/Kangentic/` has a capital K, so
// no earlier branch matches these commands.
describe('the exact shipped bridge path is recognized forward-slashed from a Windows install (H6)', () => {
  const SHIPPED = 'C:/Program Files/Kangentic/resources/app.asar.unpacked/.vite/build';
  const OTHER_INSTALL = 'C:/Program Files/Other/resources/app.asar.unpacked/.vite/build';

  it.each([
    ['plan-approval-bridge', `node "${SHIPPED}/plan-approval-bridge.js" "C:/Users/dev/decision.json"`],
    ['event-bridge', `node "${SHIPPED}/event-bridge.js" "C:/Users/dev/events.jsonl" tool_start`],
    ['background-shell-hint-bridge', `node "${SHIPPED}/background-shell-hint-bridge.js" e30=`],
  ])('takes a %s command naming the shipped path for Kangentic\'s', (_bridgeName, command) => {
    // Only branch (c) can match: no marker, no events variable, no Kangentic hint spec (`e30=` is `{}`).
    expect(command).not.toContain('.kangentic');
    expect(command).not.toContain('/kangentic/');
    expect(command).not.toContain('KANGENTIC_EVENTS_PATH');

    expect(isKangenticHookCommand(command)).toBe(true);
  });

  it('does not take the same bridge from another install for Kangentic\'s', () => {
    expect(isKangenticHookCommand(`node "${OTHER_INSTALL}/plan-approval-bridge.js" "C:/Users/dev/decision.json"`)).toBe(false);
    expect(isKangenticHookCommand(`node "${OTHER_INSTALL}/event-bridge.js" "C:/Users/dev/events.jsonl" tool_start`)).toBe(false);
  });
});
