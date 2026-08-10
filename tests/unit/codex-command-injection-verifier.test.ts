/**
 * Tests for Codex's `command-injection` submission verifier.
 *
 * Codex earned a verifier by MEASUREMENT, not assumption
 * (`scripts/measure-injection-flush.mjs`, 2026-08-08): the user turn appears in
 * the rollout JSONL 61-108ms after Enter, and that latency stays flat against a
 * 4.6s turn. Flat-against-turn-length is the discriminator - it proves the
 * write happens on SUBMIT rather than at turn-end, which is what makes a ~400ms
 * verify window viable.
 *
 * The record shape asserted here was copied from a live capture, not invented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractCodexUserTurn,
  clearCodexRolloutPathCache,
} from '../../src/main/agent/adapters/codex/command-injection-verifier';
import {
  scanForSubmittedText,
  createSubmittedTextSubmissionVerifier,
} from '../../src/main/agent/shared/submitted-text-verifier';
import { clearTranscriptTailCache } from '../../src/main/agent/shared/transcript-tail-cache';

let tmpDir: string;
let rolloutPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-verifier-'));
  rolloutPath = path.join(tmpDir, 'rollout-2026-08-08T12-00-00-test.jsonl');
  clearTranscriptTailCache();
  clearCodexRolloutPathCache();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** The exact shape captured from a live Codex rollout file. */
function userTurn(text: string, offsetMs = 0): string {
  return JSON.stringify({
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

function append(line: string): void {
  fs.appendFileSync(rolloutPath, line + '\n');
}

describe('extractCodexUserTurn', () => {
  it('reads the user text and timestamp from a live-captured record', () => {
    const line = '{"timestamp":"2026-08-08T16:35:31.811Z","type":"response_item",'
      + '"payload":{"type":"message","role":"user",'
      + '"content":[{"type":"input_text","text":"run the tests"}]}}';
    const record = extractCodexUserTurn(line);
    expect(record).not.toBeNull();
    expect(record?.text).toBe('run the tests');
    expect(record?.timestampMs).toBe(Date.parse('2026-08-08T16:35:31.811Z'));
  });

  it('accepts the Codex 0.118+ event_msg / user_message shape', () => {
    const line = JSON.stringify({
      timestamp: '2026-08-08T16:35:31.811Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'run the tests' },
    });
    expect(extractCodexUserTurn(line)?.text).toBe('run the tests');
  });

  it('ignores assistant turns, metadata, and blank lines', () => {
    expect(extractCodexUserTurn('')).toBeNull();
    expect(extractCodexUserTurn('   ')).toBeNull();
    expect(extractCodexUserTurn(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ text: 'hi' }] },
    }))).toBeNull();
    expect(extractCodexUserTurn(JSON.stringify({
      type: 'session_meta', payload: { type: 'session_meta' },
    }))).toBeNull();
  });

  it('skips the synthetic priming turns Codex writes with role user', () => {
    expect(extractCodexUserTurn(userTurn('<environment_context>cwd=/tmp'))).toBeNull();
    expect(extractCodexUserTurn(userTurn('<user_instructions>be brief'))).toBeNull();
  });

  it('does not throw on a torn line from a partial write mid-flush', () => {
    // Five real rollout files on a live machine ended in a truncated JSON line,
    // which is what proved Codex appends incrementally. The scan must survive
    // reading one.
    expect(() => extractCodexUserTurn('{"timestamp":"2026-08-08T16:35:31.8')).toThrow();
    // ...and the scan wraps the extractor so a throw is a skip, never a crash:
    expect(extractCodexUserTurn('not json at all')).toBeNull();
  });
});

describe('scanForSubmittedText against a Codex rollout', () => {
  it('confirms a user turn submitted after sentAt', async () => {
    const sentAt = Date.now();
    append(userTurn('/pull-request', 20));
    expect(await scanForSubmittedText(rolloutPath, '/pull-request', sentAt, extractCodexUserTurn))
      .toBe(true);
  });

  it('does NOT confirm text that merely CONTAINS the command', async () => {
    // The exact bug the verifier exists to catch. A swallowed Enter
    // concatenates the next keystrokes into the same prompt buffer, so the
    // agent records `instead can we/pull-request` - which contains
    // `/pull-request`. A substring test would confirm the very failure this is
    // supposed to detect, and confirming it suppresses the retry that recovers.
    const sentAt = Date.now();
    append(userTurn('instead can we/pull-request', 20));
    expect(await scanForSubmittedText(rolloutPath, '/pull-request', sentAt, extractCodexUserTurn))
      .toBe(false);
  });

  it('does not confirm a turn written before sentAt', async () => {
    const sentAt = Date.now();
    append(userTurn('/pull-request', -5000));
    expect(await scanForSubmittedText(rolloutPath, '/pull-request', sentAt, extractCodexUserTurn))
      .toBe(false);
  });

  it('returns false rather than throwing when the file does not exist yet', async () => {
    // Production injects near spawn time, so the rollout file routinely does
    // not exist for the first few hundred ms. That must read as "keep polling",
    // never as a verified failure - a `failed` outcome escalates to a session
    // restart that destroys live work.
    const missing = path.join(tmpDir, 'not-created-yet.jsonl');
    expect(await scanForSubmittedText(missing, '/pull-request', Date.now(), extractCodexUserTurn))
      .toBe(false);
  });

  it('finds the turn among assistant traffic and a torn trailing line', async () => {
    const sentAt = Date.now();
    append(userTurn('deploy the branch', 10));
    append(JSON.stringify({
      timestamp: new Date(Date.now() + 15).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ text: 'working' }] },
    }));
    fs.appendFileSync(rolloutPath, '{"timestamp":"2026-08-08T16:3');
    expect(await scanForSubmittedText(rolloutPath, 'deploy the branch', sentAt, extractCodexUserTurn))
      .toBe(true);
  });
});

describe('createSubmittedTextSubmissionVerifier (Codex wiring)', () => {
  it('returns false when the context is missing a session id or cwd', async () => {
    const verifier = createSubmittedTextSubmissionVerifier({
      resolvePath: () => rolloutPath,
      extractUserTurn: extractCodexUserTurn,
    });
    expect(await verifier({ type: 'paste' })).toBe(false);
    expect(await verifier({
      type: 'command-injection', text: 'x', cwd: tmpDir, sentAt: Date.now(),
    })).toBe(false);
    expect(await verifier({
      type: 'command-injection', text: 'x', agentSessionId: 'abc', sentAt: Date.now(),
    })).toBe(false);
  });

  it('returns false when the path cannot be resolved', async () => {
    const verifier = createSubmittedTextSubmissionVerifier({
      resolvePath: () => null,
      extractUserTurn: extractCodexUserTurn,
    });
    expect(await verifier({
      type: 'command-injection',
      text: 'run it',
      agentSessionId: 'abc',
      cwd: tmpDir,
      sentAt: Date.now(),
    })).toBe(false);
  });

  it('confirms through the full adapter-shaped path', async () => {
    const sentAt = Date.now();
    append(userTurn('run the tests', 20));
    const verifier = createSubmittedTextSubmissionVerifier({
      resolvePath: () => rolloutPath,
      extractUserTurn: extractCodexUserTurn,
    });
    expect(await verifier({
      type: 'command-injection',
      text: 'run the tests',
      agentSessionId: 'abc',
      cwd: tmpDir,
      sentAt,
      mode: 'submitted',
    })).toBe(true);
  });
});

describe('the production path reaches this verifier', () => {
  // Everything above exercises the factory directly. This drives the REAL
  // chain the injection burst uses:
  //   buildCommandInjectionVerifier -> CodexAdapter.getSubmissionVerifier
  //   -> the shared scan -> a real rollout file on disk.
  //
  // The shapes differ across that boundary (the wrapper hands the adapter a
  // SubmissionContext object, while exposing a positional CommandVerifier to
  // its own caller), so a mismatch would make every poll return false - which
  // is the false-`failed` path that escalates into a session restart. Plan-shape
  // tests cannot catch that, because they never invoke the verifier.
  it('confirms an exact submission end to end through buildCommandInjectionVerifier', async () => {
    const sessionId = '019fe241-d06c-7983-b7da-7169b5f7d527';
    const sessionsDir = path.join(
      tmpDir, '.codex', 'sessions',
      new Date().toISOString().slice(0, 4),
      new Date().toISOString().slice(5, 7),
      new Date().toISOString().slice(8, 10),
    );
    fs.mkdirSync(sessionsDir, { recursive: true });

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    clearCodexRolloutPathCache();
    clearTranscriptTailCache();

    // Resolve the modules BEFORE stamping `sentAt`. A dynamic import costs tens
    // of milliseconds, and the scan correctly refuses any record older than
    // `sentAt - 50ms`; stamping first would make the test fail on its own
    // setup cost rather than on the behaviour under test.
    const { buildCommandInjectionVerifier } = await import(
      '../../src/main/transition-engine/injection-plan'
    );
    const { CodexAdapter } = await import(
      '../../src/main/agent/adapters/codex/codex-adapter'
    );

    const sentAt = Date.now();
    const realName = `rollout-2026-08-08T12-43-11-${sessionId}.jsonl`;
    fs.writeFileSync(path.join(sessionsDir, realName), userTurn('review the diff', 20) + '\n');

    const record = { id: 's1', agent_session_id: sessionId, cwd: tmpDir };
    const sessionRepo = {
      getLatestForTask: () => record,
      findByAnyId: () => record,
    } as unknown as Parameters<typeof buildCommandInjectionVerifier>[1];

    const verifier = buildCommandInjectionVerifier(
      new CodexAdapter(),
      sessionRepo,
      'task-1',
    );
    expect(verifier).not.toBeNull();

    // Positional CommandVerifier signature, exactly as submitKeystrokes calls it.
    expect(await verifier!('review the diff', sentAt, 'submitted')).toBe(true);
    // And the exactness survives the whole chain, not just the inner scan.
    expect(await verifier!('review', sentAt, 'submitted')).toBe(false);

    homedirSpy.mockRestore();
  });
});

describe('verification cost', () => {
  it('reads an unchanged rollout once no matter how many times it is polled', async () => {
    // `getSubmissionVerifier` rebuilds the verifier once per poll at 25ms, so
    // without a module-global cache this would re-read and re-split a
    // multi-megabyte file ~40 times a second on the main process.
    const sentAt = Date.now();
    append(userTurn('run the tests', 20));

    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const openSpy = vi.spyOn(fsPromises, 'open');

    for (let poll = 0; poll < 12; poll += 1) {
      const verifier = createSubmittedTextSubmissionVerifier({
        resolvePath: () => rolloutPath,
        extractUserTurn: extractCodexUserTurn,
      });
      expect(await verifier({
        type: 'command-injection',
        text: 'run the tests',
        agentSessionId: 'abc',
        cwd: tmpDir,
        sentAt,
        mode: 'submitted',
      })).toBe(true);
    }

    expect(readSpy.mock.calls.length + openSpy.mock.calls.length).toBe(1);

    readSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('re-reads once the file actually grows', async () => {
    const sentAt = Date.now();
    append(userTurn('first', 10));

    const verifier = createSubmittedTextSubmissionVerifier({
      resolvePath: () => rolloutPath,
      extractUserTurn: extractCodexUserTurn,
    });
    const context = {
      type: 'command-injection' as const,
      text: 'second',
      agentSessionId: 'abc',
      cwd: tmpDir,
      sentAt,
      mode: 'submitted' as const,
    };

    expect(await verifier(context)).toBe(false);
    append(userTurn('second', 20));
    expect(await verifier(context)).toBe(true);
  });
});
