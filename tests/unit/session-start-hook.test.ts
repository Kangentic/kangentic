import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude';
import { sessionStartOfLine } from '../../src/main/agent/shared/session-start-hook';
import type { AdapterRuntimeStrategy, SessionStartReport } from '../../src/shared/types';

type StatusFileHook = NonNullable<AdapterRuntimeStrategy['statusFile']>;

/**
 * The SessionStart line parser and Claude's SessionStart reader, run over real
 * hooks. The fixture is a sanitized live capture: the three events.jsonl lines
 * Claude Code 2.1.316's hooks wrote through event-bridge.js when a live task's
 * conversation moved into Claude's background daemon (`/bg`), with paths
 * replaced by generic placeholders. Unlike the hand-built helper in
 * helpers/claude-session-start.ts, they carry the fields Claude really sends
 * (`prompt_cache_likely_expired`, `estimated_cache_write_usd`, ...).
 */
const fixtureLines = fs
  .readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-background-move', 'session-starts.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.length > 0);

// Line 1 is the spawn's own resume, line 2 the daemon's empty spare, line 3 the moved conversation.
const [RESUME_LINE, STARTUP_LINE, FORK_LINE] = fixtureLines;
const RESUME_SESSION_ID = '206fcc54-ddb8-497b-9d57-a0f6defcced9';
const STARTUP_SESSION_ID = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';
const FORK_SESSION_ID = '58bd8a86-0d47-4861-8449-63202d8e6a43';

// Written out here, never derived from the parser under test.
const RESUME_REPORT: SessionStartReport = { agentSessionId: RESUME_SESSION_ID, movesConversation: true, inBackgroundSession: false };
const STARTUP_REPORT: SessionStartReport = { agentSessionId: STARTUP_SESSION_ID, movesConversation: false, inBackgroundSession: false };
const FORK_REPORT: SessionStartReport = { agentSessionId: FORK_SESSION_ID, movesConversation: true, inBackgroundSession: true };

/** The hook payload a line carries, as the JSON string event-bridge.js stored in `hookContext`. */
function hookContextOf(line: string): string {
  return (JSON.parse(line) as { hookContext: string }).hookContext;
}

// Read before any test installs a JSON.parse spy, so setup never counts as a call.
const RESUME_CONTEXT = hookContextOf(RESUME_LINE);
const STARTUP_CONTEXT = hookContextOf(STARTUP_LINE);
const FORK_CONTEXT = hookContextOf(FORK_LINE);

const TOOL_LINE = '{"ts":2,"type":"tool_start","tool":"Read"}';

/** event-bridge.js stores `JSON.stringify(ctx).slice(0, 2048)`. */
const BRIDGE_HOOK_CONTEXT_CAP = 2048;

/**
 * What the bridge's cap does to a real payload that runs past it. The three
 * captured payloads are all well under 2048 characters, so a plain slice would
 * return them whole and valid. Appending a long trailing field after every real
 * field (key order is kept) makes the payload overrun the cap the way a long
 * one does, with `session_id` and `source` inside the kept prefix.
 */
function cappedLikeEventBridge(hookContext: string): string {
  const payload = JSON.parse(hookContext) as Record<string, unknown>;
  payload.trailing_filler = 'x'.repeat(BRIDGE_HOOK_CONTEXT_CAP);
  return JSON.stringify(payload).slice(0, BRIDGE_HOOK_CONTEXT_CAP);
}

function statusFileHookWith(parseSessionStart?: StatusFileHook['parseSessionStart']): StatusFileHook {
  const hook: Record<string, unknown> = { parseStatus: () => null, parseEvent: () => null, isFullRewrite: true };
  if (parseSessionStart) hook.parseSessionStart = parseSessionStart;
  return hook as unknown as StatusFileHook;
}

const claudeStatusFileHook = statusFileHookWith(ClaudeStatusParser.parseSessionStart);
const hookWithoutSessionStart = statusFileHookWith();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session-starts.jsonl fixture', () => {
  it('holds the three live lines, with fields the hand-built helper lacks', () => {
    expect(fixtureLines).toHaveLength(3);
    expect(JSON.parse(RESUME_CONTEXT)).toMatchObject({ source: 'resume', prompt_cache_likely_expired: true, estimated_cache_write_usd: 4.4949 });
    expect(JSON.parse(STARTUP_CONTEXT)).toMatchObject({ source: 'startup', agent_type: 'claude' });
    expect(JSON.parse(FORK_CONTEXT)).toMatchObject({ source: 'fork', prompt_cache_likely_expired: false, estimated_cache_write_usd: 5.0366 });
  });
});

describe('sessionStartOfLine over the real hooks', () => {
  it('reads the spawn\'s own resume as moving the conversation, not into a background session', () => {
    expect(sessionStartOfLine(claudeStatusFileHook, RESUME_LINE)).toEqual(RESUME_REPORT);
  });

  it('reads the daemon\'s empty spare (startup) as not moving the conversation', () => {
    expect(sessionStartOfLine(claudeStatusFileHook, STARTUP_LINE)).toEqual(STARTUP_REPORT);
  });

  it('reads the moved conversation (fork) as moving it, into a background session', () => {
    expect(sessionStartOfLine(claudeStatusFileHook, FORK_LINE)).toEqual(FORK_REPORT);
  });
});

describe('ClaudeStatusParser.parseSessionStart over the real hookContext', () => {
  it('reads resume as moving the conversation, in the terminal', () => {
    expect(ClaudeStatusParser.parseSessionStart(RESUME_CONTEXT)).toEqual(RESUME_REPORT);
  });

  it('reads startup as not moving the conversation', () => {
    expect(ClaudeStatusParser.parseSessionStart(STARTUP_CONTEXT)).toEqual(STARTUP_REPORT);
  });

  it('reads fork as moving the conversation into a background session', () => {
    expect(ClaudeStatusParser.parseSessionStart(FORK_CONTEXT)).toEqual(FORK_REPORT);
  });

  it('reads the id and fork by pattern when the bridge\'s 2048-character cap cut the payload short', () => {
    const capped = cappedLikeEventBridge(FORK_CONTEXT);
    expect(capped).toHaveLength(BRIDGE_HOOK_CONTEXT_CAP);
    expect(() => JSON.parse(capped)).toThrow();
    expect(ClaudeStatusParser.parseSessionStart(capped)).toEqual(FORK_REPORT);
  });

  it('confirms nothing from a real payload cut before its source', () => {
    const cutBeforeSource = FORK_CONTEXT.slice(0, FORK_CONTEXT.indexOf('"source"'));
    expect(cutBeforeSource).toContain(FORK_SESSION_ID);
    expect(() => JSON.parse(cutBeforeSource)).toThrow();
    expect(ClaudeStatusParser.parseSessionStart(cutBeforeSource)).toEqual({
      agentSessionId: FORK_SESSION_ID,
      movesConversation: false,
      inBackgroundSession: false,
    });
  });
});

describe('sessionStartOfLine skips what is not a SessionStart', () => {
  it('returns null for a tool line, and skips it before it is parsed', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    expect(sessionStartOfLine(claudeStatusFileHook, TOOL_LINE)).toBeNull();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('parses a SessionStart line, so the spy above can tell a skip from a parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    expect(sessionStartOfLine(claudeStatusFileHook, FORK_LINE)).toEqual(FORK_REPORT);
    expect(parseSpy).toHaveBeenCalled();
  });

  it('never hands a tool line to the adapter\'s reader', () => {
    const parseSessionStart = vi.fn<(hookContext: string) => SessionStartReport | null>(() => FORK_REPORT);
    expect(sessionStartOfLine(statusFileHookWith(parseSessionStart), TOOL_LINE)).toBeNull();
    expect(parseSessionStart).not.toHaveBeenCalled();
  });

  it('hands a SessionStart line\'s hookContext to the adapter\'s reader and returns its report', () => {
    const stubReport: SessionStartReport = { agentSessionId: 'stub-session', movesConversation: false, inBackgroundSession: false };
    const parseSessionStart = vi.fn<(hookContext: string) => SessionStartReport | null>(() => stubReport);
    expect(sessionStartOfLine(statusFileHookWith(parseSessionStart), FORK_LINE)).toBe(stubReport);
    expect(parseSessionStart).toHaveBeenCalledTimes(1);
    expect(parseSessionStart).toHaveBeenCalledWith(FORK_CONTEXT);
  });

  it('returns null for a line torn before its type value ends, without parsing it', () => {
    const tornEarly = FORK_LINE.slice(0, 40);
    // Cut inside the "session_start" value, so the pre-check alone rejects it.
    expect(tornEarly.includes('session_start')).toBe(false);
    const parseSpy = vi.spyOn(JSON, 'parse');
    expect(sessionStartOfLine(claudeStatusFileHook, tornEarly)).toBeNull();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('returns null for a line torn mid-payload, after its type, instead of throwing', () => {
    const tornLate = FORK_LINE.slice(0, FORK_LINE.indexOf('transcript_path'));
    // Names the SessionStart, so it gets past the pre-check and JSON.parse rejects it.
    expect(tornLate).toContain('session_start');
    expect(() => JSON.parse(tornLate)).toThrow();
    expect(sessionStartOfLine(claudeStatusFileHook, tornLate)).toBeNull();
  });

  it.each([
    ['an object', JSON.parse(FORK_CONTEXT) as unknown],
    ['a number', 42],
    ['null', null],
  ])('returns null for a session_start line whose hookContext is %s, not a string', (_label, hookContext) => {
    const line = JSON.stringify({ ts: 3, type: 'session_start', hookContext });
    const parseSessionStart = vi.fn<(hookContext: string) => SessionStartReport | null>(() => FORK_REPORT);
    expect(sessionStartOfLine(statusFileHookWith(parseSessionStart), line)).toBeNull();
    expect(parseSessionStart).not.toHaveBeenCalled();
    expect(sessionStartOfLine(claudeStatusFileHook, line)).toBeNull();
  });

  it('returns null for an adapter whose hook has no parseSessionStart, even on a real SessionStart line', () => {
    expect(sessionStartOfLine(hookWithoutSessionStart, FORK_LINE)).toBeNull();
  });
});

describe('sessionStartOfLine, by the record a line parses to', () => {
  it('returns null for a record of another type, even one carrying a real SessionStart payload', () => {
    const parseSessionStart = vi.fn<(hookContext: string) => SessionStartReport | null>(() => FORK_REPORT);
    // The tool name puts the event name in the line, so the line reaches the record's type check.
    const line = JSON.stringify({ ts: 2, type: 'tool_start', tool: 'session_start', hookContext: FORK_CONTEXT });
    expect(sessionStartOfLine(statusFileHookWith(parseSessionStart), line)).toBeNull();
    expect(parseSessionStart).not.toHaveBeenCalled();
    expect(sessionStartOfLine(claudeStatusFileHook, line)).toBeNull();
  });

  it('reads each real record by its own source', () => {
    expect(sessionStartOfLine(claudeStatusFileHook, RESUME_LINE)).toEqual(RESUME_REPORT);
    expect(sessionStartOfLine(claudeStatusFileHook, STARTUP_LINE)).toEqual(STARTUP_REPORT);
    expect(sessionStartOfLine(claudeStatusFileHook, FORK_LINE)).toEqual(FORK_REPORT);
  });

  it.each([
    ['an array', '[{"type":"session_start"}]'],
    ['a string', '"session_start"'],
  ])('returns null for a line that parses to %s, not a record', (_label, line) => {
    expect(sessionStartOfLine(claudeStatusFileHook, line)).toBeNull();
  });
});
