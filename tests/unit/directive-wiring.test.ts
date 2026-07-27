/**
 * Guard: every directive an adapter wires into a hook command is well-formed -
 * `<kind>:<base64(JSON)>` with a known kind. This prevents a regression to
 * hand-authored / raw directives (which a shell could split on whitespace) and
 * catches a kind typo at build time, complementing the bridge's runtime
 * unknown-directive diagnostic and the per-adapter wiring assertions.
 *
 * Runs every adapter that wires bridge directives through `buildHooks` and
 * scans the resulting command strings. Codex is excluded: it wires no bridge
 * directives (its hook-manager only cleans up legacy files), and OpenCode uses
 * an inline plugin that writes JSONL directly rather than the event-bridge.
 */
import { describe, it, expect, vi } from 'vitest';

// Copilot resolves its bridge script path at buildHooks time; stub it so the
// test does not need built assets. Claude/Gemini/Qwen receive the bridge path
// as a parameter and are unaffected by this mock.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: (name: string) => `/fake/scripts/${name}.js`,
}));

import { buildHooks as buildClaudeHooks } from '../../src/main/agent/adapters/claude';
import { buildHooks as buildGeminiHooks } from '../../src/main/agent/adapters/gemini';
import { buildHooks as buildQwenHooks } from '../../src/main/agent/adapters/qwen-code';
import { buildHooks as buildCopilotHooks } from '../../src/main/agent/adapters/copilot';

const EVENT_BRIDGE = '/fake/.kangentic/event-bridge.js';
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';

const KNOWN_KINDS = new Set([
  'extractTool',
  'extractToolId',
  'extractDetail',
  'extractDetailWhenTool',
  'setDetail',
  'setTypeWhen',
  'setTypeWhenDetailContains',
  'setTypeWhenDetailMatches',
  'extractDetailPattern',
  'emitOnlyWhenDetailMatches',
]);

// A directive token is `<kind>:<base64>`: letters, a colon, then standard
// base64. Quoted paths (start with `"`) and bare event types (no colon) do
// not match, so this isolates the directive arguments.
const DIRECTIVE_TOKEN = /^[A-Za-z]+:[A-Za-z0-9+/]+=*$/;

/** Collect every hook command string from a buildHooks result. */
function commandsOf(hooks: Record<string, unknown>): string[] {
  const commands: string[] = [];
  for (const entries of Object.values(hooks)) {
    for (const entry of entries as Array<{ command?: string; hooks?: Array<{ command: string }> }>) {
      if (typeof entry.command === 'string') commands.push(entry.command);
      for (const inner of entry.hooks ?? []) commands.push(inner.command);
    }
  }
  return commands;
}

/** Assert every directive token decodes as a known-kind JSON payload; return the count seen. */
function assertWellFormed(commands: string[]): number {
  let directiveCount = 0;
  for (const command of commands) {
    for (const token of command.split(' ')) {
      if (!DIRECTIVE_TOKEN.test(token)) continue;
      directiveCount += 1;
      const colonIndex = token.indexOf(':');
      const kind = token.slice(0, colonIndex);
      expect(KNOWN_KINDS.has(kind), `unknown directive kind '${kind}' in token: ${token}`).toBe(true);
      const json = Buffer.from(token.slice(colonIndex + 1), 'base64').toString('utf8');
      expect(() => JSON.parse(json), `non-JSON payload in token: ${token}`).not.toThrow();
    }
  }
  return directiveCount;
}

describe('adapter directive wiring is well-formed (no raw/hand-authored directives)', () => {
  it('claude wires only <kind>:<base64> directives', () => {
    expect(assertWellFormed(commandsOf(buildClaudeHooks(EVENT_BRIDGE, EVENTS_PATH, {})))).toBeGreaterThan(0);
  });

  it('gemini wires only <kind>:<base64> directives', () => {
    expect(assertWellFormed(commandsOf(buildGeminiHooks(EVENT_BRIDGE, EVENTS_PATH, {})))).toBeGreaterThan(0);
  });

  it('qwen wires only <kind>:<base64> directives', () => {
    expect(assertWellFormed(commandsOf(buildQwenHooks(EVENT_BRIDGE, EVENTS_PATH, {})))).toBeGreaterThan(0);
  });

  it('copilot wires only <kind>:<base64> directives', () => {
    expect(assertWellFormed(commandsOf(buildCopilotHooks(EVENTS_PATH)))).toBeGreaterThan(0);
  });
});
