/**
 * `parseBridgeEventLine` (src/main/agent/shared/hook-utils.ts): the one reader
 * of an events.jsonl line for the adapters whose hooks write through the event
 * bridge and need no translation (Droid, Goose). Each adapter's own test
 * reaches it through `runtime.statusFile.parseEvent`; this pins the function
 * directly, plus that both adapters hand it over as-is rather than keeping a
 * private copy that could drift.
 */
import { describe, it, expect } from 'vitest';
import { parseBridgeEventLine } from '../../src/main/agent/shared/hook-utils';
import { DroidAdapter } from '../../src/main/agent/adapters/droid/droid-adapter';
import { GooseAdapter } from '../../src/main/agent/adapters/goose/goose-adapter';

describe('parseBridgeEventLine', () => {
  it('returns the event object the bridge wrote, extra fields intact', () => {
    expect(parseBridgeEventLine('{"ts":5,"type":"tool_start","tool":"Execute","detail":"ls"}'))
      .toEqual({ ts: 5, type: 'tool_start', tool: 'Execute', detail: 'ls' });
  });

  it('tolerates the line ending and padding the file read leaves on a line', () => {
    expect(parseBridgeEventLine('  {"ts":1,"type":"idle"}\r\n')).toEqual({ ts: 1, type: 'idle' });
    expect(parseBridgeEventLine('{"ts":1,"type":"idle"}\n')).toEqual({ ts: 1, type: 'idle' });
  });

  it('returns null for a blank or whitespace-only line', () => {
    expect(parseBridgeEventLine('')).toBeNull();
    expect(parseBridgeEventLine(' \t \r\n')).toBeNull();
  });

  it('returns null for malformed or truncated JSON instead of throwing', () => {
    // A half-written last line is what a watcher sees mid-append.
    expect(parseBridgeEventLine('{"ts":1,"type":"tool_st')).toBeNull();
    expect(parseBridgeEventLine('not json')).toBeNull();
  });

  it('returns null unless the value is an object with a string type', () => {
    for (const line of ['{"ts":1}', '{"type":5}', '{"type":null}', '{"type":["idle"]}', 'null', '[]', '[{"type":"idle"}]', '"idle"', '7', 'true']) {
      expect(parseBridgeEventLine(line), line).toBeNull();
    }
  });

  it('is the reader both Droid and Goose declare for their events file', () => {
    expect(new DroidAdapter().runtime.statusFile?.parseEvent).toBe(parseBridgeEventLine);
    expect(new GooseAdapter().runtime.statusFile?.parseEvent).toBe(parseBridgeEventLine);
  });
});
