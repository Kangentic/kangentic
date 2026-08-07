/**
 * Unit tests for src/main/pty/prompt-draft-ledger.ts.
 *
 * The ledger answers "has the user typed something into this prompt and not
 * sent it?" without reading the screen, by folding the bytes that pass through
 * `SessionManager.write`. It exists so an injected auto_command never
 * concatenates onto a half-written message.
 *
 * Its accuracy bar is deliberately modest (see the module comment), so these
 * tests pin the behaviors that actually matter: user text accumulates, submit
 * and clear empty it regardless of who sent them, injected text never counts
 * as a draft, and cursor keys do not corrupt it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptDraftLedger } from '../../src/main/pty/prompt-draft-ledger';

const SESSION = 'sess-1';

describe('PromptDraftLedger', () => {
  let ledger: PromptDraftLedger;

  beforeEach(() => {
    ledger = new PromptDraftLedger();
  });

  it('reports no draft for a session that has never been written to', () => {
    expect(ledger.get(SESSION)).toBeNull();
  });

  it('accumulates user-typed text', () => {
    ledger.record(SESSION, 'instead', 'user');
    ledger.record(SESSION, ' can we', 'user');

    expect(ledger.get(SESSION)).toBe('instead can we');
  });

  it('does not count injected text as a user draft', () => {
    // An auto_command passing through the prompt is ours, not something the
    // user was in the middle of writing.
    ledger.record(SESSION, '/code-review', 'system');

    expect(ledger.get(SESSION)).toBeNull();
  });

  it('clears on submit, whoever sent the Enter', () => {
    ledger.record(SESSION, 'draft text', 'user');
    ledger.record(SESSION, '\r', 'system');

    expect(ledger.get(SESSION)).toBeNull();
  });

  it('clears on Ctrl+C, whoever sent it', () => {
    // Our own leading clear empties the prompt, so the ledger must agree - or
    // the next injection would report a draft it had already discarded.
    ledger.record(SESSION, 'draft text', 'user');
    ledger.record(SESSION, '\x03', 'system');

    expect(ledger.get(SESSION)).toBeNull();
  });

  it('handles backspace', () => {
    ledger.record(SESSION, 'abcd', 'user');
    ledger.record(SESSION, '\x7f\x7f', 'user');

    expect(ledger.get(SESSION)).toBe('ab');
  });

  it('ignores arrow keys and other CSI input', () => {
    // Cursor movement adds no text; counting its bytes as characters would
    // corrupt the draft and misreport what was discarded.
    ledger.record(SESSION, 'hi', 'user');
    ledger.record(SESSION, '\x1b[A\x1b[B\x1b[C\x1b[D', 'user');

    expect(ledger.get(SESSION)).toBe('hi');
  });

  it('ignores a bare Escape and SS3 sequences', () => {
    ledger.record(SESSION, 'hi', 'user');
    ledger.record(SESSION, '\x1b', 'user');
    ledger.record(SESSION, '\x1bOP', 'user');

    expect(ledger.get(SESSION)).toBe('hi');
  });

  it('ignores control chords that are commands, not content', () => {
    ledger.record(SESSION, 'hi', 'user');
    ledger.record(SESSION, '\x01\x05\x0c', 'user'); // Ctrl+A, Ctrl+E, Ctrl+L

    expect(ledger.get(SESSION)).toBe('hi');
  });

  it('processes a mixed chunk in order', () => {
    ledger.record(SESSION, 'first\rsecond', 'user');

    // The Enter submitted "first"; only what followed remains.
    expect(ledger.get(SESSION)).toBe('second');
  });

  it('keeps sessions independent', () => {
    ledger.record(SESSION, 'one', 'user');
    ledger.record('sess-2', 'two', 'user');

    expect(ledger.get(SESSION)).toBe('one');
    expect(ledger.get('sess-2')).toBe('two');
  });

  it('forgets a session on clear', () => {
    ledger.record(SESSION, 'draft', 'user');
    ledger.clear(SESSION);

    expect(ledger.get(SESSION)).toBeNull();
  });

  it('caps a very long draft instead of holding it all', () => {
    ledger.record(SESSION, 'x'.repeat(10_000), 'user');

    const draft = ledger.get(SESSION);
    expect(draft).not.toBeNull();
    expect(draft!.length).toBeLessThanOrEqual(4096);
  });
});
