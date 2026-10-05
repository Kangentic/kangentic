/**
 * The archived-run recorder (scripts/capture-demo-archived-runs.mjs) reads two things from outside
 * the TypeScript boundary: the result `claude -p --output-format json` prints, and the run's history
 * file. Both are replayed here from real samples.
 *
 * tests/fixtures/claude-print-result-success.json is one real headless run's result, captured once.
 * tests/fixtures/claude-transcript-advisor-turn.jsonl is eight real lines of an archived run's
 * history (sanitized): the advisor tool's attachment, then main-conversation turns whose usage
 * carries an advisor call on another model. That run was once recorded on the advisor's model,
 * because the recorder named the model with the most output in the result's `modelUsage`, and the
 * advisor had written more than the main conversation.
 */
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mainLoopModel, measureClaudeRun, readHeadlessRunResult } from '../captures/helpers/archived-run-metrics';
import { resetToolCallCursorsForTests } from '../../src/main/agent/adapters/claude/transcript-parser';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const RESULT_PATH = path.join(FIXTURES_DIR, 'claude-print-result-success.json');
const ADVISOR_TRANSCRIPT_PATH = path.join(FIXTURES_DIR, 'claude-transcript-advisor-turn.jsonl');

const realResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf-8')) as Record<string, unknown>;
const advisorTranscript = fs.readFileSync(ADVISOR_TRANSCRIPT_PATH, 'utf-8');

afterEach(() => {
  resetToolCallCursorsForTests();
});

describe('readHeadlessRunResult', () => {
  it('reads the session, duration, cost and turns of a real result, the cost as reported', () => {
    expect(readHeadlessRunResult(realResult)).toEqual({
      sessionId: realResult.session_id,
      durationMs: realResult.duration_ms,
      costUsd: realResult.total_cost_usd,
      numTurns: realResult.num_turns,
    });
    // Not rounded: a cheap run is still a cost above zero, which the Completed Tasks cell needs.
    expect(readHeadlessRunResult(realResult).costUsd).toBe(0.020622);
  });

  // The cases below are DERIVED from the real result by changing one field, not captured.
  it('refuses a run that did not finish successfully', () => {
    expect(() => readHeadlessRunResult({ ...realResult, subtype: 'error_max_turns', is_error: false })).toThrow(/error_max_turns/);
    expect(() => readHeadlessRunResult({ ...realResult, is_error: true })).toThrow(/ended in/);
  });

  it('refuses a result missing a field the record needs', () => {
    const withoutSession: Record<string, unknown> = { ...realResult };
    delete withoutSession.session_id;
    expect(() => readHeadlessRunResult(withoutSession)).toThrow(/session_id/);
    expect(() => readHeadlessRunResult({ ...realResult, duration_ms: '2918' })).toThrow(/duration_ms/);
    expect(() => readHeadlessRunResult({ ...realResult, total_cost_usd: null })).toThrow(/total_cost_usd/);
    expect(() => readHeadlessRunResult({ ...realResult, num_turns: -1 })).toThrow(/num_turns/);
    expect(() => readHeadlessRunResult(['not', 'a', 'result'])).toThrow(/no result object/);
  });
});

describe('mainLoopModel', () => {
  it('names the main conversation\'s model, not the advisor\'s, in a real advisor call', () => {
    // Vacuity guard: the excerpt really carries an advisor call on a different model.
    expect(advisorTranscript).toContain('"type":"advisor_message","model":"claude-opus-5-5"');
    expect(mainLoopModel(advisorTranscript)).toBe('claude-opus-5');
  });

  // The lines below are DERIVED from a real assistant line of the excerpt, to pin the two exclusions.
  it('counts neither a subagent\'s turns nor a synthetic one, however many there are', () => {
    const realAssistant = advisorTranscript.split('\n').map((line) => (line.trim() ? JSON.parse(line) : null))
      .find((record) => record?.type === 'assistant') as Record<string, unknown> & { message: Record<string, unknown> };
    const asLine = (overrides: Record<string, unknown>, model: string): string => JSON.stringify({ ...realAssistant, ...overrides, message: { ...realAssistant.message, model } });
    const noise = [
      ...Array.from({ length: 20 }, () => asLine({ isSidechain: true }, 'claude-haiku-4-5')),
      ...Array.from({ length: 20 }, () => asLine({}, '<synthetic>')),
    ];
    expect(mainLoopModel([advisorTranscript, ...noise].join('\n'))).toBe('claude-opus-5');
  });

  it('answers null for a history with no assistant turn, so the recorder falls back to the model it asked for', () => {
    expect(mainLoopModel('')).toBeNull();
    expect(mainLoopModel(advisorTranscript.split('\n').filter((line) => !line.includes('"type":"assistant"')).join('\n'))).toBeNull();
  });
});

describe('measureClaudeRun', () => {
  it('measures a real history with main\'s parsers and the main conversation\'s model', async () => {
    const measured = await measureClaudeRun(ADVISOR_TRANSCRIPT_PATH);
    expect(measured).not.toBeNull();
    expect(measured?.model).toBe('claude-opus-5');
    expect(measured?.outputTokens).toBeGreaterThan(0);
    expect(Object.values(measured?.tools ?? {}).reduce((sum, calls) => sum + calls, 0)).toBeGreaterThan(0);
  });
});
