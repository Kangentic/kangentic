/**
 * Runs each `command-injection` extractor over a REAL captured history file
 * committed under `tests/fixtures/`, and asserts it recovers the user's text
 * EXACTLY.
 *
 * WHY THIS IS SEPARATE FROM THE OTHER VERIFIER TESTS
 * The per-adapter tests hand-author their input, which pins our BELIEF about a
 * record shape rather than the shape itself. The measurement harness does not
 * close that gap either: `scripts/measure-injection-flush.mjs` hunts a unique
 * nonce as a SUBSTRING, deliberately so it stays honest when the app's own
 * resolver is broken. A CLI that wrapped or decorated the stored text would
 * satisfy the harness and still never satisfy the verifier, whose contract is
 * whole-record trim-equality. Cursor is the live proof that this happens: it
 * stores `<user_query>\n<task>...</task>\n</user_query>`, not the raw prompt.
 *
 * So this file answers the one question neither of the others does: given a
 * real file this agent wrote, does the extractor hand back a string that
 * trim-equals what the user typed? That is the property escalation rests on,
 * and it is checked here for every adapter with a real capture in the repo.
 *
 * Adding a fixture for Copilot or OpenCode would extend this to them; the
 * absence of one is exactly why those two stay confirm-only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractCodexUserTurn } from '../../src/main/agent/adapters/codex/command-injection-verifier';
import { extractQwenUserTurn } from '../../src/main/agent/adapters/qwen-code/command-injection-verifier';
import { extractKimiUserTurn } from '../../src/main/agent/adapters/kimi/command-injection-verifier';
import { extractLastAiderUserPrompt } from '../../src/main/agent/adapters/aider/command-injection-verifier';
import type { UserTurnRecord } from '../../src/main/agent/shared/submitted-text-verifier';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function readFixtureLines(...relativePath: string[]): string[] {
  return fs.readFileSync(path.join(FIXTURES, ...relativePath), 'utf8').split('\n');
}

/** Every user turn the extractor finds, in file order. */
function collectUserTurns(
  lines: string[],
  extract: (line: string) => UserTurnRecord | null,
): UserTurnRecord[] {
  const turns: UserTurnRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = extract(line);
    if (record) turns.push(record);
  }
  return turns;
}

describe('Codex, against a real rollout capture', () => {
  it('recovers the submitted text verbatim from the response_item shape', () => {
    const turns = collectUserTurns(
      readFixtureLines('codex-real-rollout.jsonl'),
      extractCodexUserTurn,
    );

    // The record is returned UNWRAPPED. If Codex ever started decorating the
    // stored text the way Cursor does, this is where it would surface, and the
    // verifier's trim-equality would silently stop matching in production.
    const texts = turns.map((turn) => turn.text);
    expect(texts).toContain('List the files in this directory.');
  });

  it('skips the synthetic context-priming turns Codex writes as user records', () => {
    const turns = collectUserTurns(
      readFixtureLines('codex-real-rollout.jsonl'),
      extractCodexUserTurn,
    );

    // `<environment_context>` is a real `role: user` record in this capture.
    // Counting it as a user turn is not merely noise: the backwards scan stops
    // at the first record older than `sentAt`, so a synthetic turn written
    // AFTER ours could end the scan before reaching the real one.
    for (const turn of turns) {
      expect(turn.text.startsWith('<environment_context>')).toBe(false);
      expect(turn.text.startsWith('<user_instructions>')).toBe(false);
    }
  });

  it('reads a parseable timestamp off every user turn', () => {
    const turns = collectUserTurns(
      readFixtureLines('codex-real-rollout.jsonl'),
      extractCodexUserTurn,
    );

    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      // A null timestamp makes the scan accept the record on text alone, which
      // drops the `sentAt` watermark and lets a stale repeat confirm.
      expect(turn.timestampMs).not.toBeNull();
      expect(new Date(turn.timestampMs as number).getUTCFullYear()).toBeGreaterThan(2000);
    }
  });

  it('reads the alternate event_msg generation too', () => {
    const lines = readFixtureLines('codex-rollout-event-msg.jsonl');
    const turns = collectUserTurns(lines, extractCodexUserTurn);

    // This capture is sanitized down to '...' as its message text, so the
    // assertion is about WHICH records are user turns, not what they say. The
    // file has two `user_message` events and one `agent_message`.
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.text === '...')).toBe(true);
  });
});

describe('Qwen, against a real chats capture', () => {
  it('recovers the submitted text verbatim, and only from user records', () => {
    const turns = collectUserTurns(
      readFixtureLines('qwen-real-session.jsonl'),
      extractQwenUserTurn,
    );

    expect(turns.map((turn) => turn.text)).toEqual(['say ok']);
  });

  it('accepts a record with no provenance field, as older builds write', () => {
    // The guard skips `provenance` values that are present and not 'real_user'.
    // This capture omits the field entirely; treating that as a skip would make
    // the verifier blind on any CLI version predating it.
    const turns = collectUserTurns(
      readFixtureLines('qwen-real-session.jsonl'),
      extractQwenUserTurn,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].timestampMs).not.toBeNull();
  });
});

describe('Kimi, against a real wire capture', () => {
  it('recovers the submitted text and scales unix SECONDS to milliseconds', () => {
    const turns = collectUserTurns(
      readFixtureLines('kimi', 'wire-real.jsonl'),
      extractKimiUserTurn,
    );

    expect(turns.map((turn) => turn.text)).toEqual(['hello', 'hello']);

    // Kimi is the only adapter whose timestamps are unix seconds. Unscaled,
    // every record reads as ~1970 and lands far below the `sentAt` watermark,
    // so the scan bails at the first record and nothing ever confirms.
    for (const turn of turns) {
      const year = new Date(turn.timestampMs as number).getUTCFullYear();
      expect(year).toBeGreaterThan(2020);
    }
  });
});

describe('Aider, against a real chat history capture', () => {
  it('sees nothing in a FINISHED conversation, however many user blocks it holds', () => {
    // Aider keeps ONE file per project directory, appended forever, with no
    // per-entry timestamp, so matching anywhere in the file would confirm an
    // auto_command from a previous session that was never submitted this time.
    // This capture holds three `####` blocks and ends on an assistant reply -
    // the state the file is in when nothing has just been submitted.
    expect(extractLastAiderUserPrompt(readFixtureLines('aider-chat-history.md'))).toBeNull();
  });

  it('recovers our submission, and only ours, once aider appends it', () => {
    // The production sequence: we press Enter, aider appends the prompt block,
    // and the reply has not been written yet - so within the verify window the
    // file ENDS on our block. Appended onto the real capture rather than a
    // synthetic file, so the walk has to skip past genuine aider output.
    const lines = [
      ...readFixtureLines('aider-chat-history.md'),
      '#### /pull-request  ',
      '',
    ];

    expect(extractLastAiderUserPrompt(lines)).toBe('/pull-request');
  });

  it('joins a multi-line prompt into the one block aider wrote', () => {
    // Aider prefixes EVERY line of a multi-line prompt with `####`. Reading only
    // the last of them would compare a fragment against the full submitted text
    // and never trim-equal it.
    const lines = [
      ...readFixtureLines('aider-chat-history.md'),
      '#### review the diff  ',
      '#### then open a PR  ',
      '',
    ];

    expect(extractLastAiderUserPrompt(lines)).toBe('review the diff\nthen open a PR');
  });
});
