/**
 * Tests for Qwen's `command-injection` submission verifier.
 *
 * Qwen earned a verifier by MEASUREMENT (`scripts/measure-injection-flush.mjs`,
 * 2026-08-08), scoped to `chats/<sessionId>.jsonl` - the file the verifier
 * actually reads: 443ms / 519ms on a short turn, 696ms / 479ms on turns of
 * 13.5s and 14.1s. Flat against turn length is what proves the write happens on
 * SUBMIT rather than at turn-end.
 *
 * The scoping mattered: an unscoped scan reported 124-201ms because the text
 * reaches `~/.qwen/tmp/<hash>/logs.json` first. Measuring the wrong file would
 * have credited the verifier with a latency ~3.5x better than the truth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractQwenUserTurn,
  resolveQwenSessionPath,
  createQwenCommandInjectionVerifier,
} from '../../src/main/agent/adapters/qwen-code/command-injection-verifier';
import { scanForSubmittedText } from '../../src/main/agent/shared/submitted-text-verifier';
import { clearTranscriptTailCache } from '../../src/main/agent/shared/transcript-tail-cache';

let tmpDir: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-qwen-verifier-'));
  jsonlPath = path.join(tmpDir, 'session.jsonl');
  clearTranscriptTailCache();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** The exact shape captured from a live Qwen chats JSONL. */
function userTurn(text: string, offsetMs = 0, provenance: string | null = 'real_user'): string {
  const record: Record<string, unknown> = {
    uuid: 'fcbc59c1-7bf3-42d5-a21e-33e084286f10',
    parentUuid: null,
    sessionId: 'cf6d72d5-6d5a-42dd-a00e-2aeca30ad7b5',
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
    type: 'user',
    cwd: path.join('mock', 'workspace'),
    version: '0.21.7',
    message: { role: 'user', parts: [{ text }] },
  };
  if (provenance !== null) record.provenance = provenance;
  return JSON.stringify(record);
}

describe('resolveQwenSessionPath', () => {
  it('builds the chats path directly from the session id', () => {
    const resolved = resolveQwenSessionPath('cf6d72d5-6d5a-42dd-a00e-2aeca30ad7b5', tmpDir);
    // Qwen names the file exactly `<sessionId>.jsonl` because the adapter
    // passes `--session-id`, so there is no scan and nothing to memoise.
    expect(path.basename(resolved)).toBe('cf6d72d5-6d5a-42dd-a00e-2aeca30ad7b5.jsonl');
    expect(resolved).toContain(`chats${path.sep}`);
  });
});

describe('extractQwenUserTurn', () => {
  it('reads text and timestamp from a live-captured record', () => {
    const record = extractQwenUserTurn(userTurn('run the tests'));
    expect(record?.text).toBe('run the tests');
    expect(record?.timestampMs).toBeGreaterThan(0);
  });

  it('accepts an older record with no provenance field', () => {
    expect(extractQwenUserTurn(userTurn('run the tests', 0, null))?.text).toBe('run the tests');
  });

  it('skips a turn that is present but not real user input', () => {
    expect(extractQwenUserTurn(userTurn('replayed', 0, 'compression'))).toBeNull();
  });

  it('ignores system and assistant records', () => {
    expect(extractQwenUserTurn(JSON.stringify({
      type: 'system', subtype: 'attribution_snapshot', systemPayload: {},
    }))).toBeNull();
    expect(extractQwenUserTurn(JSON.stringify({
      type: 'assistant', message: { role: 'assistant', parts: [{ text: 'hi' }] },
    }))).toBeNull();
    expect(extractQwenUserTurn('')).toBeNull();
  });
});

describe('scanForSubmittedText against a Qwen chats JSONL', () => {
  it('confirms a user turn submitted after sentAt', async () => {
    const sentAt = Date.now();
    fs.appendFileSync(jsonlPath, userTurn('/pull-request', 20) + '\n');
    expect(await scanForSubmittedText(jsonlPath, '/pull-request', sentAt, extractQwenUserTurn))
      .toBe(true);
  });

  it('does NOT confirm text that merely CONTAINS the command', async () => {
    // The swallowed-Enter bug: `instead can we/pull-request` contains
    // `/pull-request`, so a substring test would confirm the exact failure the
    // verifier exists to detect, suppressing the retry that recovers it.
    const sentAt = Date.now();
    fs.appendFileSync(jsonlPath, userTurn('instead can we/pull-request', 20) + '\n');
    expect(await scanForSubmittedText(jsonlPath, '/pull-request', sentAt, extractQwenUserTurn))
      .toBe(false);
  });

  it('does not confirm a turn written before sentAt', async () => {
    const sentAt = Date.now();
    fs.appendFileSync(jsonlPath, userTurn('/pull-request', -5000) + '\n');
    expect(await scanForSubmittedText(jsonlPath, '/pull-request', sentAt, extractQwenUserTurn))
      .toBe(false);
  });

  it('treats a not-yet-created chats file as "keep polling", not a failure', async () => {
    // Qwen does not create the file until the first user turn lands, so the
    // missing-file case is normal. Reporting it as a failure would escalate to
    // a session restart that destroys live work.
    const verifier = createQwenCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection',
      text: 'run the tests',
      agentSessionId: 'cf6d72d5-6d5a-42dd-a00e-2aeca30ad7b5',
      cwd: tmpDir,
      sentAt: Date.now(),
      mode: 'submitted',
    })).toBe(false);
  });

  it('confirms a slash command, which Qwen does record as a user turn', async () => {
    // Measured: an unrecognized `/...` reached the chats JSONL in 306ms / 355ms.
    // This is the behavioural difference from Codex, which never records slash
    // input and therefore declines to verify it.
    const sentAt = Date.now();
    fs.appendFileSync(jsonlPath, userTurn('/kng-probe', 20) + '\n');
    expect(await scanForSubmittedText(jsonlPath, '/kng-probe', sentAt, extractQwenUserTurn))
      .toBe(true);
  });
});
