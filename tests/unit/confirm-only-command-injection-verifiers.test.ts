/**
 * Tests the record parsing behind three CONFIRM-ONLY `command-injection`
 * verifiers: Kimi, Aider, and OpenCode.
 *
 * Confirm-only means the verifier may confirm a delivery and may drive
 * retry-on-Enter, both pure upside, but is barred from authorizing the restart
 * that escalation performs. These three land there for two different reasons -
 * Kimi and Aider are UNMEASURED (neither could be driven live on the
 * development machine), while OpenCode is measured but has a known wrong answer
 * for remote sessions. Both reasons and the bar itself are asserted in
 * `agent-submission-verifier-shape.test.ts`; this file covers the parsing each
 * one does, and the guards standing in for what could not be measured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractKimiUserTurn } from '../../src/main/agent/adapters/kimi/command-injection-verifier';
import {
  extractLastAiderUserPrompt,
  createAiderCommandInjectionVerifier,
} from '../../src/main/agent/adapters/aider/command-injection-verifier';
import { findOpenCodeSubmittedText } from '../../src/main/agent/adapters/opencode/command-injection-verifier';
import { scanForSubmittedText } from '../../src/main/agent/shared/submitted-text-verifier';
import { clearTranscriptTailCache } from '../../src/main/agent/shared/transcript-tail-cache';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-confirm-only-'));
  clearTranscriptTailCache();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('Kimi wire.jsonl', () => {
  /** Real shape: timestamp is unix SECONDS as a float. */
  function turnBegin(text: string, timestampSeconds: number): string {
    return JSON.stringify({
      timestamp: timestampSeconds,
      message: { type: 'TurnBegin', payload: { user_input: text } },
    });
  }

  it('converts the unix-SECONDS timestamp to milliseconds', () => {
    // The trap: Kimi records seconds, the shared scan compares against an
    // epoch-ms `sentAt`. Passing it through unscaled puts every record ~56
    // years in the past, so the watermark rejects them all and the verifier can
    // never confirm anything.
    const record = extractKimiUserTurn(turnBegin('run it', 1777232808.515));
    expect(record?.timestampMs).toBe(1777232809000 - 485);
    expect(record?.text).toBe('run it');
  });

  it('accepts SteerInput, which is how input during a live turn is recorded', () => {
    // That is exactly the `immediate` auto_command delivery mode.
    const line = JSON.stringify({
      timestamp: 1777232808.5,
      message: { type: 'SteerInput', payload: { user_input: 'stop and refactor' } },
    });
    expect(extractKimiUserTurn(line)?.text).toBe('stop and refactor');
  });

  it('joins array-form user_input', () => {
    const line = JSON.stringify({
      timestamp: 1777232808.5,
      message: { type: 'TurnBegin', payload: { user_input: [{ text: 'run ' }, { text: 'it' }] } },
    });
    expect(extractKimiUserTurn(line)?.text).toBe('run it');
  });

  it('ignores metadata, status, and tool records', () => {
    expect(extractKimiUserTurn('{"type":"metadata","protocol_version":"1.9"}')).toBeNull();
    expect(extractKimiUserTurn(JSON.stringify({
      timestamp: 1777232808.5,
      message: { type: 'StatusUpdate', payload: { context_usage: 0.12 } },
    }))).toBeNull();
  });

  it('confirms an exact submission and rejects a containing one', async () => {
    const filePath = path.join(tmpDir, 'wire.jsonl');
    const sentAt = Date.now();
    fs.writeFileSync(filePath, [
      '{"type":"metadata","protocol_version":"1.9"}',
      turnBegin('/pull-request', (sentAt + 20) / 1000),
    ].join('\n') + '\n');

    expect(await scanForSubmittedText(filePath, '/pull-request', sentAt, extractKimiUserTurn))
      .toBe(true);

    const containing = path.join(tmpDir, 'wire2.jsonl');
    fs.writeFileSync(containing, turnBegin('instead can we/pull-request', (sentAt + 20) / 1000) + '\n');
    expect(await scanForSubmittedText(containing, '/pull-request', sentAt, extractKimiUserTurn))
      .toBe(false);
  });
});

describe('Aider .aider.chat.history.md', () => {
  function writeHistory(contents: string, mtimeMs: number): string {
    const filePath = path.join(tmpDir, '.aider.chat.history.md');
    fs.writeFileSync(filePath, contents);
    const seconds = mtimeMs / 1000;
    fs.utimesSync(filePath, seconds, seconds);
    return filePath;
  }

  it('reads the final user block, stripping aider trailing double-spaces', () => {
    const lines = [
      '#### Add a hello world function  ',
      '',
      'Here it is.',
      '',
      '#### Now add unit tests  ',
      '',
    ];
    expect(extractLastAiderUserPrompt(lines)).toBe('Now add unit tests');
  });

  it('joins a multi-line prompt, which aider prefixes on every line', () => {
    expect(extractLastAiderUserPrompt(['#### first line  ', '#### second line  ']))
      .toBe('first line\nsecond line');
  });

  it('returns null when the file ends on assistant output', () => {
    expect(extractLastAiderUserPrompt(['#### do it  ', '', 'Done.'])).toBeNull();
  });

  it('does NOT confirm a stale identical prompt from an earlier session', async () => {
    // The hazard unique to aider: no per-entry timestamps, and ONE file per
    // project appended to forever. An auto_command that ever ran here before
    // would otherwise confirm instantly from a months-old entry with nothing
    // having been submitted at all.
    const sentAt = Date.now();
    writeHistory([
      '# aider chat started at 2026-01-01 09:00:00',
      '',
      '#### /review  ',
      '',
      'Reviewed.',
      '',
    ].join('\n'), sentAt - 60_000);

    const verifier = createAiderCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection', text: '/review', cwd: tmpDir, sentAt, mode: 'submitted',
    })).toBe(false);
  });

  it('does not confirm when an older entry matches but the newest does not', async () => {
    const sentAt = Date.now();
    writeHistory([
      '#### /review  ',
      '',
      'Reviewed.',
      '',
      '#### something else entirely  ',
      '',
    ].join('\n'), sentAt + 10);

    const verifier = createAiderCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection', text: '/review', cwd: tmpDir, sentAt, mode: 'submitted',
    })).toBe(false);
  });

  it('confirms when the newest block is our text and the file was just written', async () => {
    const sentAt = Date.now();
    writeHistory([
      '#### an older prompt  ',
      '',
      'Answered.',
      '',
      '#### /review  ',
      '',
    ].join('\n'), sentAt + 10);

    const verifier = createAiderCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection', text: '/review', cwd: tmpDir, sentAt, mode: 'submitted',
    })).toBe(true);
  });

  it('treats a missing history file as "keep polling", not a failure', async () => {
    const verifier = createAiderCommandInjectionVerifier();
    expect(await verifier({
      type: 'command-injection', text: '/review', cwd: tmpDir, sentAt: Date.now(), mode: 'submitted',
    })).toBe(false);
  });
});

describe('OpenCode SQLite rows', () => {
  const messageRow = (id: string, role: string, timeCreated: number) => ({
    id,
    time_created: timeCreated,
    data: JSON.stringify({ role }),
  });
  const textPart = (messageId: string, text: string) => ({
    message_id: messageId,
    data: JSON.stringify({ type: 'text', text }),
  });

  it('confirms a user message whose text parts concatenate to the exact text', () => {
    const sentAt = Date.now();
    expect(findOpenCodeSubmittedText(
      [messageRow('m1', 'user', sentAt + 20)],
      [textPart('m1', '/pull-'), textPart('m1', 'request')],
      '/pull-request',
      sentAt,
    )).toBe(true);
  });

  it('does NOT confirm text that merely contains the command', () => {
    const sentAt = Date.now();
    expect(findOpenCodeSubmittedText(
      [messageRow('m1', 'user', sentAt + 20)],
      [textPart('m1', 'instead can we/pull-request')],
      '/pull-request',
      sentAt,
    )).toBe(false);
  });

  it('ignores assistant messages with identical text', () => {
    const sentAt = Date.now();
    expect(findOpenCodeSubmittedText(
      [messageRow('m1', 'assistant', sentAt + 20)],
      [textPart('m1', '/pull-request')],
      '/pull-request',
      sentAt,
    )).toBe(false);
  });

  it('ignores a message written before sentAt', () => {
    const sentAt = Date.now();
    expect(findOpenCodeSubmittedText(
      [messageRow('m1', 'user', sentAt - 5000)],
      [textPart('m1', '/pull-request')],
      '/pull-request',
      sentAt,
    )).toBe(false);
  });

  it('ignores non-text parts such as reasoning and tool blocks', () => {
    const sentAt = Date.now();
    const reasoning = { message_id: 'm1', data: JSON.stringify({ type: 'reasoning', text: '/pull-request' }) };
    expect(findOpenCodeSubmittedText(
      [messageRow('m1', 'user', sentAt + 20)],
      [reasoning],
      '/pull-request',
      sentAt,
    )).toBe(false);
  });

  it('returns false for an empty result set, which is the remote-session case', () => {
    // A remote OpenCode session has NO local row. That must read as "not seen
    // yet" so the burst ends `unconfirmed`, never as a verified failure - there
    // is nothing local to have failed.
    expect(findOpenCodeSubmittedText([], [], '/pull-request', Date.now())).toBe(false);
  });
});
