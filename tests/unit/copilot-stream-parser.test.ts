/**
 * Unit tests for CopilotStreamParser - pulls model + usage out of both
 * Copilot CLI's interactive TUI status bar AND its `--output-format json`
 * NDJSON stream. Fixtures below are lifted verbatim from empirically
 * captured Copilot v1.0.27 output (debug-traces/copilot-ptyout.log and
 * debug-traces/copilot-json-output.jsonl, 2026-04-15).
 *
 * Pure logic; no Electron, no IPC, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import { CopilotStreamParser } from '../../src/main/agent/adapters/copilot/stream-parser';

// Real Copilot `--output-format json` events.
const toolsUpdatedLine = JSON.stringify({
  type: 'session.tools_updated',
  data: { model: 'gpt-5-mini' },
  id: 'f32ce8d7-dc2e-44af-bb3f-b6e939981f47',
  timestamp: '2026-04-15T17:15:24.552Z',
  parentId: '06571418-8729-470d-bbac-fa1d6ddbb0af',
  ephemeral: true,
});

const modelChangeLine = JSON.stringify({
  type: 'session.model_change',
  data: { newModel: 'claude-sonnet-4.6' },
  id: 'cd1bf8b3-30f8-4b87-9557-9d1a4f4b3190',
  timestamp: '2026-04-15T17:13:08.847Z',
  parentId: '908cd18a-3840-4d03-a520-636ebee72b95',
});

const resultLine = JSON.stringify({
  type: 'result',
  timestamp: '2026-04-15T17:15:33.525Z',
  sessionId: 'f1415cd5-80b2-41cf-8f05-c8ff5cc0131a',
  exitCode: 0,
  usage: {
    premiumRequests: 1,
    totalApiDurationMs: 8512,
    sessionDurationMs: 13065,
    codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
  },
});

// Real Copilot TUI status-bar snippet (from debug-traces/copilot-ptyout.log,
// Windows ConPTY render of `GPT-5 mini (medium)` with surrounding ANSI).
const ptyStatusBarGpt5Mini =
  '\u001b[25;1H ~\\Documents\\GitHub\\kangentic\\.kangentic\\worktrees\\cursor-and... ' +
  '[\u2387 cursor-and-copilot-s-e5529ec5%] GPT-5 mini (medium) ';

const ptyStatusBarClaudeSonnet46 =
  '\u001b[25;1H ~\\Documents\\GitHub\\project [\u2387 main%] Claude Sonnet 4.6 ';

describe('CopilotStreamParser - NDJSON (--output-format json)', () => {
  it('extracts model from session.tools_updated', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry(`${toolsUpdatedLine}\n`);
    expect(result?.usage?.model).toEqual({
      id: 'gpt-5-mini',
      displayName: 'GPT-5 mini',
    });
  });

  it('extracts model from session.model_change', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry(`${modelChangeLine}\n`);
    expect(result?.usage?.model?.id).toBe('claude-sonnet-4.6');
    expect(result?.usage?.model?.displayName).toContain('Claude Sonnet');
  });

  it('extracts total duration from result event', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry(`${resultLine}\n`);
    expect(result?.usage?.cost?.totalDurationMs).toBe(8512);
  });

  it('returns null for chunks with no recognized NDJSON and no model label', () => {
    const parser = new CopilotStreamParser();
    const noise = JSON.stringify({ type: 'session.mcp_server_status_changed', data: {} });
    expect(parser.parseTelemetry(`${noise}\n`)).toBeNull();
  });

  it('skips malformed lines without throwing', () => {
    const parser = new CopilotStreamParser();
    const garbage = '{this is not json}\n';
    const result = parser.parseTelemetry(`${garbage}${toolsUpdatedLine}\n`);
    expect(result?.usage?.model?.id).toBe('gpt-5-mini');
  });

  it('reassembles a model event across a mid-line chunk boundary', () => {
    const parser = new CopilotStreamParser();
    const cutPoint = 40;
    const first = parser.parseTelemetry(toolsUpdatedLine.slice(0, cutPoint));
    expect(first).toBeNull();
    const second = parser.parseTelemetry(`${toolsUpdatedLine.slice(cutPoint)}\n`);
    expect(second?.usage?.model?.id).toBe('gpt-5-mini');
  });
});

describe('CopilotStreamParser - PTY TUI regex fallback', () => {
  it('extracts GPT-5 mini from the ConPTY-rendered status bar', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry(ptyStatusBarGpt5Mini);
    expect(result?.usage?.model?.displayName).toBe('GPT-5 mini');
    // Canonical Copilot model id (same value the NDJSON path sets), so
    // downstream consumers that key off `id` see a stable identifier
    // regardless of whether the parser matched via regex or NDJSON.
    expect(result?.usage?.model?.id).toBe('gpt-5-mini');
  });

  it('produces the same { id, displayName } shape from the regex path as the NDJSON path', () => {
    const ndjsonParser = new CopilotStreamParser();
    const regexParser = new CopilotStreamParser();
    const fromNdjson = ndjsonParser.parseTelemetry(`${toolsUpdatedLine}\n`)?.usage?.model;
    const fromRegex = regexParser.parseTelemetry(ptyStatusBarGpt5Mini)?.usage?.model;
    expect(fromNdjson).toEqual(fromRegex);
  });

  it('extracts Claude Sonnet 4.6 from a TUI status line', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry(ptyStatusBarClaudeSonnet46);
    expect(result?.usage?.model?.displayName).toBe('Claude Sonnet 4.6');
  });

  it('emits the model exactly once, even when the status bar redraws', () => {
    const parser = new CopilotStreamParser();
    const first = parser.parseTelemetry(ptyStatusBarGpt5Mini);
    const second = parser.parseTelemetry(ptyStatusBarGpt5Mini);
    expect(first?.usage?.model?.displayName).toBe('GPT-5 mini');
    expect(second).toBeNull();
  });

  it('prefers the more specific model label (4.6 over 4.5)', () => {
    const parser = new CopilotStreamParser();
    // A chunk that contains 4.6 first should match 4.6, not accidentally 4.5.
    const text = 'Status: Claude Sonnet 4.6 is active. Previously: Claude Sonnet 4.5.';
    const result = parser.parseTelemetry(text);
    expect(result?.usage?.model?.displayName).toBe('Claude Sonnet 4.6');
  });

  it('prefers Opus 4.6 Fast over Opus 4.6 when both could match', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Model: Claude Opus 4.6 Fast selected.');
    expect(result?.usage?.model?.displayName).toBe('Claude Opus 4.6 Fast');
  });

  it('does not confuse Opus 4.6 with Opus 4.6 Fast when Fast is absent', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Model: Claude Opus 4.6 selected.');
    expect(result?.usage?.model?.displayName).toBe('Claude Opus 4.6');
  });

  it('returns null when no known model label is present', () => {
    const parser = new CopilotStreamParser();
    expect(parser.parseTelemetry('regular terminal noise with no model name')).toBeNull();
  });

  it('tolerates GPT-5 vs GPT 5 label variation', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Model is GPT 5 mini right now.');
    expect(result?.usage?.model?.displayName).toBe('GPT-5 mini');
  });

  // Gap 7: GPT-family disambiguation analogous to the Opus 4.6 / Opus 4.6 Fast tests.
  it('matches GPT-5.4 and not GPT-5.4 mini when mini is absent', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Active model: GPT-5.4 is running.');
    expect(result?.usage?.model?.displayName).toBe('GPT-5.4');
    expect(result?.usage?.model?.id).toBe('gpt-5.4');
  });

  it('matches GPT-5.4 mini and not GPT-5.4 when mini is present', () => {
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Active model: GPT-5.4 mini is running.');
    expect(result?.usage?.model?.displayName).toBe('GPT-5.4 mini');
    expect(result?.usage?.model?.id).toBe('gpt-5.4-mini');
  });

  it('does not confuse GPT-5.4 with GPT-5.4 mini when mini appears later in text', () => {
    // The more-specific GPT-5.4 mini pattern must win when "mini" follows "GPT-5.4".
    const parser = new CopilotStreamParser();
    const result = parser.parseTelemetry('Upgraded from GPT-5.4 mini to GPT-5.4 mini.');
    expect(result?.usage?.model?.displayName).toBe('GPT-5.4 mini');
  });
});

describe('CopilotStreamParser - additional branches', () => {
  // Gap 1: prettifyModelId passthrough + edge cases exercised via NDJSON path.
  it('passes through an unknown model id unchanged', () => {
    const parser = new CopilotStreamParser();
    const line = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'o4-mini' },
    });
    const result = parser.parseTelemetry(`${line}\n`);
    // Unknown id (no gpt- / claude- prefix) - must not be mangled.
    expect(result?.usage?.model?.id).toBe('o4-mini');
    expect(result?.usage?.model?.displayName).toBe('o4-mini');
  });

  it('prettifies a GPT id with no sub-version (gpt-5 -> GPT-5)', () => {
    const parser = new CopilotStreamParser();
    const line = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'gpt-5' },
    });
    const result = parser.parseTelemetry(`${line}\n`);
    expect(result?.usage?.model?.id).toBe('gpt-5');
    expect(result?.usage?.model?.displayName).toBe('GPT-5');
  });

  it('prettifies a Claude id with exactly one segment (claude-opus -> Claude Opus)', () => {
    const parser = new CopilotStreamParser();
    const line = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'claude-opus' },
    });
    const result = parser.parseTelemetry(`${line}\n`);
    expect(result?.usage?.model?.id).toBe('claude-opus');
    expect(result?.usage?.model?.displayName).toBe('Claude Opus');
  });

  // Gap 2: stripAnsiEscapes DCS + bare-ESC + control-char branches.
  it('strips DCS sequences and still extracts a model label', () => {
    const parser = new CopilotStreamParser();
    // DCS: \x1bP...\x1b\ wraps real terminal string; the label must survive.
    const withDcs = '\x1bPsome dcs payload\x1b\\ GPT-5 mini (medium) ';
    const result = parser.parseTelemetry(withDcs);
    expect(result?.usage?.model?.displayName).toBe('GPT-5 mini');
  });

  it('strips bare ESC= / ESC> and still extracts a model label', () => {
    const parser = new CopilotStreamParser();
    const withBareEsc = '\x1b= \x1b> Claude Sonnet 4.6 ready';
    const result = parser.parseTelemetry(withBareEsc);
    expect(result?.usage?.model?.displayName).toBe('Claude Sonnet 4.6');
  });

  it('strips control chars in 0x00-0x08 / 0x0b-0x1f / 0x7f range and still extracts a model label', () => {
    const parser = new CopilotStreamParser();
    // Insert a BEL (0x07) and a DEL (0x7f) into a known model label's context.
    const withControlChars = '\x07Status: GPT-5 mini\x7f (medium)';
    const result = parser.parseTelemetry(withControlChars);
    expect(result?.usage?.model?.displayName).toBe('GPT-5 mini');
  });

  // Gap 3: MAX_CARRY overflow - mirrors cursor-stream-parser.test.ts line 104.
  it('caps the carry buffer when input has no newlines, then still parses subsequent events', () => {
    const parser = new CopilotStreamParser();
    // Feed 32 KB without a newline - must not grow carry unbounded.
    const noNewlines = 'x'.repeat(32 * 1024);
    expect(parser.parseTelemetry(noNewlines)).toBeNull();
    // Now send a complete tools_updated line; the cap must not have eaten it.
    const line = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'gpt-5-mini' },
    });
    const result = parser.parseTelemetry(`\n${line}\n`);
    expect(result?.usage?.model?.id).toBe('gpt-5-mini');
  });

  // Gap 4: modelEmitted does NOT gate subsequent NDJSON model updates.
  it('propagates a later session.model_change even after modelEmitted is true', () => {
    const parser = new CopilotStreamParser();
    // First chunk: tools_updated sets gpt-5-mini and flips modelEmitted.
    const first = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'gpt-5-mini' },
    });
    const firstResult = parser.parseTelemetry(`${first}\n`);
    expect(firstResult?.usage?.model?.id).toBe('gpt-5-mini');

    // Second chunk: model_change mid-session - must still propagate.
    const second = JSON.stringify({
      type: 'session.model_change',
      data: { newModel: 'claude-sonnet-4.6' },
    });
    const secondResult = parser.parseTelemetry(`${second}\n`);
    expect(secondResult?.usage?.model?.id).toBe('claude-sonnet-4.6');
    expect(secondResult?.usage?.model?.displayName).toContain('Claude Sonnet');
  });

  // Gap 5: result with zero / missing totalApiDurationMs returns null cost.
  it('returns null (no cost) when result.usage.totalApiDurationMs is 0', () => {
    const parser = new CopilotStreamParser();
    const line = JSON.stringify({
      type: 'result',
      timestamp: '2026-04-15T00:00:00.000Z',
      usage: { premiumRequests: 1, totalApiDurationMs: 0, sessionDurationMs: 500 },
    });
    const result = parser.parseTelemetry(`${line}\n`);
    // A zero-duration result must not produce a cost entry.
    expect(result).toBeNull();
  });

  it('returns null (no cost) when result event has no usage block', () => {
    const parser = new CopilotStreamParser();
    const line = JSON.stringify({
      type: 'result',
      timestamp: '2026-04-15T00:00:00.000Z',
      exitCode: 0,
    });
    const result = parser.parseTelemetry(`${line}\n`);
    expect(result).toBeNull();
  });

  // Gap 6: full-session NDJSON end-to-end - mirrors cursor-stream-parser.test.ts line 150.
  it('processes a complete NDJSON session sequence end-to-end', () => {
    const parser = new CopilotStreamParser();
    const toolsUpdated = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'gpt-5-mini' },
      id: 'aaa',
      timestamp: '2026-04-15T17:15:24.552Z',
    });
    const result = JSON.stringify({
      type: 'result',
      timestamp: '2026-04-15T17:15:33.525Z',
      sessionId: 'bbb',
      exitCode: 0,
      usage: {
        premiumRequests: 1,
        totalApiDurationMs: 9000,
        sessionDurationMs: 14000,
        codeChanges: { linesAdded: 2, linesRemoved: 0, filesModified: ['foo.ts'] },
      },
    });
    const stream = `${toolsUpdated}\n${result}\n`;
    const parsed = parser.parseTelemetry(stream);
    expect(parsed?.usage?.model?.id).toBe('gpt-5-mini');
    expect(parsed?.usage?.cost?.totalDurationMs).toBe(9000);
  });
});
