/**
 * Unit tests for the typed directive builders. These assert the wire-format
 * CONTRACT the event-bridge depends on:
 *   - every directive is `<kind>:<base64(JSON(payload))>`,
 *   - the encoded token is shell-safe (no whitespace / shell metacharacters),
 *   - the payload round-trips to the documented shape.
 *
 * End-to-end behavior (feeding these through event-bridge.js) is covered by
 * event-bridge.test.ts / event-bridge-remap.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { EventType } from '../../src/shared/types';
import {
  extractTool,
  extractToolId,
  extractToolPath,
  extractDetail,
  extractDetailPath,
  captureHookContext,
  setDetail,
  setTypeWhen,
  setTypeWhenDetailContains,
  setTypeWhenDetailMatches,
  extractDetailPattern,
  emitOnlyWhenDetailMatches,
} from '../../src/main/agent/shared/directive-builders';

/** Split a `<kind>:<base64>` directive and decode the JSON payload. */
function decode(directive: string): { kind: string; payload: unknown } {
  const colonIndex = directive.indexOf(':');
  const kind = directive.slice(0, colonIndex);
  const payload = JSON.parse(Buffer.from(directive.slice(colonIndex + 1), 'base64').toString('utf8'));
  return { kind, payload };
}

// A token that survives any shell: a kind (word chars) + ':' + standard base64.
const SHELL_SAFE = /^[A-Za-z]+:[A-Za-z0-9+/]+=*$/;

describe('directive builders - wire format contract', () => {
  const cases: Array<[string, string, string, unknown]> = [
    ['extractTool', extractTool('tool_name'), 'extractTool', { field: 'tool_name' }],
    ['extractToolId top-level', extractToolId(['tool_use_id']), 'extractToolId', { fields: ['tool_use_id'] }],
    ['extractToolId nested', extractToolId(['tool_use_id'], { nested: 'tool_response' }), 'extractToolId', { fields: ['tool_use_id'], nested: 'tool_response' }],
    ['extractDetail top-level', extractDetail(['message', 'notification']), 'extractDetail', { fields: ['message', 'notification'] }],
    ['extractDetail nested', extractDetail(['model'], { nested: 'llm_request' }), 'extractDetail', { fields: ['model'], nested: 'llm_request' }],
    // `whenTool` scopes the extraction to one tool and, unlike `nested`, also
    // flips the WIRE KIND (fail-closed against a stale bridge copy - see the
    // comment on extractDetail in directive-builders.ts). This top-level-only
    // (no `nested`) shape is exercised nowhere else in the repo: every other
    // whenTool-scoped call site (hook-manager.ts's Monitor extractor) also
    // passes `nested`, so only this contract test pins that `nested` is truly
    // optional alongside `whenTool`.
    ['extractDetail whenTool-only (no nested)', extractDetail(['taskId'], { whenTool: 'Monitor' }), 'extractDetailWhenTool', { fields: ['taskId'], whenTool: 'Monitor' }],
    ['extractDetail nested + whenTool', extractDetail(['taskId'], { nested: 'tool_response', whenTool: 'Monitor' }), 'extractDetailWhenTool', { fields: ['taskId'], nested: 'tool_response', whenTool: 'Monitor' }],
    ['setDetail', setDetail('permission'), 'setDetail', { value: 'permission' }],
    ['setTypeWhen', setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }), 'setTypeWhen', { whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: 'background_shell_start' }],
    ['setTypeWhenDetailContains', setTypeWhenDetailContains('waiting for your input', EventType.IdleHint), 'setTypeWhenDetailContains', { contains: 'waiting for your input', to: 'idle_hint' }],
    ['setTypeWhenDetailMatches', setTypeWhenDetailMatches('^[\\w-]{1,64}$', EventType.BackgroundShellStart), 'setTypeWhenDetailMatches', { pattern: '^[\\w-]{1,64}$', to: 'background_shell_start' }],
    ['extractDetailPattern', extractDetailPattern('prompt', '<task-id>([\\w-]+)</task-id>'), 'extractDetailPattern', { field: 'prompt', pattern: '<task-id>([\\w-]+)</task-id>' }],
    ['emitOnlyWhenDetailMatches', emitOnlyWhenDetailMatches('^[\\w-]{1,64}$'), 'emitOnlyWhenDetailMatches', { pattern: '^[\\w-]{1,64}$' }],
    // Nested-payload siblings (Antigravity's `ctx.toolCall.name` /
    // `ctx.toolCall.args.TargetFile` shape) and the no-once-per-session
    // hookContext opt-in. Each is its OWN wire kind for the fail-closed
    // reason documented on the builders (a stale bridge copy rejects an
    // unknown kind via `default` instead of misreading the payload) - a
    // lockstep rename of the kind string here goes red the moment it drifts
    // from event-bridge.js's `case` labels, since that would silently no-op
    // on any deployed bridge copy still running the old kind name.
    ['extractToolPath', extractToolPath(['toolCall', 'name']), 'extractToolPath', { path: ['toolCall', 'name'] }],
    ['extractDetailPath', extractDetailPath(['toolCall', 'args'], ['TargetFile', 'CommandLine']), 'extractDetailPath', { parents: ['toolCall', 'args'], fields: ['TargetFile', 'CommandLine'] }],
    ['captureHookContext', captureHookContext(), 'captureHookContext', {}],
  ];

  it.each(cases)('%s encodes to <kind>:<base64> and round-trips', (_label, directive, expectedKind, expectedPayload) => {
    expect(directive.startsWith(`${expectedKind}:`)).toBe(true);
    const { kind, payload } = decode(directive);
    expect(kind).toBe(expectedKind);
    expect(payload).toEqual(expectedPayload);
  });

  it.each(cases)('%s is a single shell-safe token (no whitespace / metacharacters)', (_label, directive) => {
    expect(directive).toMatch(SHELL_SAFE);
    expect(directive).not.toMatch(/\s/);
  });

  it('encodes values with spaces, quotes and colons without breaking the token', () => {
    const directive = setTypeWhenDetailContains('a: "b" c\td', EventType.Idle);
    expect(directive).toMatch(SHELL_SAFE);
    expect(decode(directive).payload).toEqual({ contains: 'a: "b" c\td', to: 'idle' });
  });

  it('omits the nested key when no nested option is given (top-level extraction)', () => {
    expect(decode(extractDetail(['error'])).payload).toEqual({ fields: ['error'] });
    expect(decode(extractToolId(['tool_use_id'])).payload).toEqual({ fields: ['tool_use_id'] });
  });

  it('throws on an empty field list (authoring mistake caught at build time)', () => {
    expect(() => extractDetail([])).toThrow();
    expect(() => extractToolId([])).toThrow();
  });

  it('extractToolPath and extractDetailPath throw on an empty segment list (authoring mistake caught at build time)', () => {
    expect(() => extractToolPath([])).toThrow();
    expect(() => extractDetailPath([], ['field'])).toThrow();
    expect(() => extractDetailPath(['parent'], [])).toThrow();
  });

  it('setTypeWhen throws when both nested and field are provided (mutually exclusive)', () => {
    expect(() =>
      setTypeWhen({
        nested: ['tool_input', 'run_in_background'],
        field: 'tool_name',
        equals: 'true',
        to: EventType.BackgroundShellStart,
      }),
    ).toThrow('setTypeWhen: `nested` and `field` are mutually exclusive');
  });

  it('setTypeWhen succeeds with nested-only (no false positive)', () => {
    expect(() =>
      setTypeWhen({
        nested: ['tool_input', 'run_in_background'],
        equals: 'true',
        to: EventType.BackgroundShellStart,
      }),
    ).not.toThrow();
  });

  it('setTypeWhen succeeds with field-only (no false positive)', () => {
    expect(() =>
      setTypeWhen({
        field: 'is_interrupt',
        equals: 'true',
        to: EventType.Interrupted,
      }),
    ).not.toThrow();
  });
});
