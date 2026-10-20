/**
 * The background shell hint's hook entry (task #859): where each adapter
 * registers it, and that a session not offered the MCP tool gets none.
 *
 * Qwen and Gemini write it as a second nested `{ matcher, hooks }` entry on
 * their post-tool event, built by `nestedBackgroundShellHintEntries`. Copilot
 * pushes a flat `{ command, timeout, matcher }` entry on `postToolUse`. All
 * three scope it to the spec's launch tools with `backgroundToolMatcher`, so it
 * runs for the shell tool alone, and the expected matchers are computed from
 * the exported specs instead of repeating tool names here.
 *
 * Whether a spawn builds a hint command at all (the session-URL, token and
 * enabled gates) is pinned beside each command builder's tests.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock bridge-utils so Copilot's buildHooks does not depend on built assets.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

import {
  buildHooks as buildQwenHooks,
  QWEN_BACKGROUND_COMMAND_SPEC,
  QwenHookEvent,
} from '../../src/main/agent/adapters/qwen-code/hook-manager';
import {
  buildHooks as buildGeminiHooks,
  GEMINI_BACKGROUND_COMMAND_SPEC,
  GeminiHookEvent,
} from '../../src/main/agent/adapters/gemini/hook-manager';
import {
  buildHooks as buildCopilotHooks,
  COPILOT_BACKGROUND_COMMAND_SPEC,
} from '../../src/main/agent/adapters/copilot/hook-manager';
import {
  backgroundToolMatcher,
  nestedBackgroundShellHintEntries,
  type NestedHookEntry,
} from '../../src/main/agent/shared/background-command-hooks';
import type { BackgroundCommandSpec } from '../../src/shared/background-command-spec';
import { EventType } from '../../src/shared/types';

const EVENT_BRIDGE = '/mock/.kangentic/event-bridge.js';
const EVENTS_PATH = '/mock/.kangentic/sessions/abc/events.jsonl';
const HINT_COMMAND = 'node hint-bridge spec';
/** The name a nested hint entry carries in the CLI's settings file. */
const HINT_HOOK_NAME = 'kangentic-background-shell-hint';
/** A hint command the stale-hook sweep recognizes as Kangentic's (it names the bridge under .kangentic). */
const SWEPT_HINT_COMMAND = 'node /mock/.kangentic/background-shell-hint-bridge.js c3BlYw==';

type HookOptions = { backgroundShellHintCommand?: string | null };

interface NestedAdapter {
  label: string;
  postToolEvent: string;
  spec: BackgroundCommandSpec;
  build: (existingHooks: Record<string, NestedHookEntry[]>, options?: HookOptions) => Record<string, NestedHookEntry[]>;
}

const NESTED_ADAPTERS: NestedAdapter[] = [
  {
    label: 'Qwen',
    postToolEvent: QwenHookEvent.PostToolUse,
    spec: QWEN_BACKGROUND_COMMAND_SPEC,
    build: (existingHooks, options) => buildQwenHooks(EVENT_BRIDGE, EVENTS_PATH, existingHooks, options),
  },
  {
    label: 'Gemini',
    postToolEvent: GeminiHookEvent.AfterTool,
    spec: GEMINI_BACKGROUND_COMMAND_SPEC,
    build: (existingHooks, options) => buildGeminiHooks(EVENT_BRIDGE, EVENTS_PATH, existingHooks, options),
  },
];

/** The entries on one event that carry the hint hook. */
function hintEntriesOf(entries: NestedHookEntry[]): NestedHookEntry[] {
  return entries.filter((entry) => entry.hooks.some((hook) => hook.name === HINT_HOOK_NAME));
}

/** The entries on one event that run the event bridge. */
function bridgeEntriesOf(entries: NestedHookEntry[]): NestedHookEntry[] {
  return entries.filter((entry) => entry.hooks.some((hook) => hook.command.includes(EVENT_BRIDGE)));
}

describe('nestedBackgroundShellHintEntries', () => {
  it.each([null, undefined, ''])('is empty for the hint command %j, so a session not offered the tool gets no entry', (hintCommand) => {
    expect(nestedBackgroundShellHintEntries(QWEN_BACKGROUND_COMMAND_SPEC, hintCommand)).toEqual([]);
  });

  it('is one entry matcher-scoped to the spec launch tools, naming the hint hook', () => {
    expect(nestedBackgroundShellHintEntries(GEMINI_BACKGROUND_COMMAND_SPEC, HINT_COMMAND)).toEqual([{
      matcher: backgroundToolMatcher(GEMINI_BACKGROUND_COMMAND_SPEC.launch.tools),
      hooks: [{ name: HINT_HOOK_NAME, type: 'command', command: HINT_COMMAND }],
    }]);
  });
});

describe.each(NESTED_ADAPTERS)('$label hint entry', ({ postToolEvent, spec, build }) => {
  it('is a second entry after the event bridge, named and matcher-scoped to the launch tools', () => {
    const entries = build({}, { backgroundShellHintCommand: HINT_COMMAND })[postToolEvent];

    expect(entries).toHaveLength(2);
    // The first entry stays the event bridge's tool_end entry, answering every tool.
    expect(entries[0].matcher).toBe('*');
    expect(entries[0].hooks[0].name).toBe(`kangentic-${EventType.ToolEnd}`);
    expect(entries[0].hooks[0].command).toContain(EVENT_BRIDGE);
    // The second is the hint, scoped to the shell tools.
    expect(entries[1]).toEqual({
      matcher: backgroundToolMatcher(spec.launch.tools),
      hooks: [{ name: HINT_HOOK_NAME, type: 'command', command: HINT_COMMAND }],
    });
    expect(entries[1].matcher).not.toBe('*');
  });

  it.each([
    ['no options', undefined],
    ['no hint command', {}],
    ['a null hint command', { backgroundShellHintCommand: null }],
    ['an empty hint command', { backgroundShellHintCommand: '' }],
  ])('leaves exactly one Kangentic entry and no hint with %s', (_label, options) => {
    const entries = build({}, options)[postToolEvent];

    expect(entries).toHaveLength(1);
    expect(bridgeEntriesOf(entries)).toHaveLength(1);
    expect(hintEntriesOf(entries)).toEqual([]);
  });

  it('registers the hint on the post-tool event alone', () => {
    const hooks = build({}, { backgroundShellHintCommand: HINT_COMMAND });

    for (const [event, entries] of Object.entries(hooks)) {
      if (event === postToolEvent) continue;
      expect(hintEntriesOf(entries), event).toEqual([]);
    }
  });

  it('keeps one hint entry across a re-spawn, swapping the stale one for the new command', () => {
    const first = build({}, { backgroundShellHintCommand: SWEPT_HINT_COMMAND });
    expect(hintEntriesOf(first[postToolEvent])).toHaveLength(1);

    const newCommand = SWEPT_HINT_COMMAND.replace('c3BlYw==', 'bmV3');
    const second = build(first, { backgroundShellHintCommand: newCommand });

    const hintEntries = hintEntriesOf(second[postToolEvent]);
    expect(hintEntries).toHaveLength(1);
    expect(hintEntries[0].hooks[0].command).toBe(newCommand);
    expect(bridgeEntriesOf(second[postToolEvent])).toHaveLength(1);
  });

  it('drops a stale hint when the next spawn is not offered the tool', () => {
    const first = build({}, { backgroundShellHintCommand: SWEPT_HINT_COMMAND });
    const second = build(first, {});

    expect(second[postToolEvent]).toHaveLength(1);
    expect(hintEntriesOf(second[postToolEvent])).toEqual([]);
  });
});

describe('Copilot hint entry', () => {
  const POST_TOOL_EVENT = 'postToolUse';

  it('is a second flat entry after the event bridge, matcher-scoped to the launch tools', () => {
    const hooks = buildCopilotHooks(EVENTS_PATH, { backgroundShellHintCommand: HINT_COMMAND });
    const entries = hooks[POST_TOOL_EVENT];

    expect(entries).toHaveLength(2);
    // The first entry is the event bridge's, with no matcher, so it answers every tool.
    expect(entries[0].command).toContain('event-bridge');
    expect(entries[0].matcher).toBeUndefined();
    expect(entries[1]).toEqual({
      command: HINT_COMMAND,
      timeout: 10,
      matcher: backgroundToolMatcher(COPILOT_BACKGROUND_COMMAND_SPEC.launch.tools),
    });
  });

  it.each([
    ['no options', undefined],
    ['no hint command', {}],
    ['a null hint command', { backgroundShellHintCommand: null }],
    ['an empty hint command', { backgroundShellHintCommand: '' }],
  ])('leaves exactly one Kangentic entry and no hint with %s', (_label, options) => {
    const entries = buildCopilotHooks(EVENTS_PATH, options)[POST_TOOL_EVENT];

    expect(entries).toHaveLength(1);
    expect(entries[0].command).toContain('event-bridge');
    expect(entries.some((entry) => entry.matcher !== undefined || entry.command === HINT_COMMAND)).toBe(false);
  });

  it('registers the hint on postToolUse alone', () => {
    const hooks = buildCopilotHooks(EVENTS_PATH, { backgroundShellHintCommand: HINT_COMMAND });

    for (const [event, entries] of Object.entries(hooks)) {
      if (event === POST_TOOL_EVENT) continue;
      expect(entries, event).toHaveLength(1);
      expect(entries.some((entry) => entry.command === HINT_COMMAND), event).toBe(false);
    }
  });
});
