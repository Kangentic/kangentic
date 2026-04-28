/**
 * Unit tests for Droid transcript cleanup.
 *
 * Verifies that Droid TUI noise (status bar, streaming spinner, version
 * indicators, input placeholder) is stripped, and that the last `⛬`
 * response is extracted alongside its preceding user prompt for handoff
 * context.
 *
 * Fixtures are synthesized from real PTY captures collected via
 * `scripts/capture-droid-pty.js` against Droid 0.109.3.
 */
import { describe, it, expect } from 'vitest';
import { cleanDroidTranscript } from '../../src/main/agent/adapters/droid/transcript-cleanup';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

describe('cleanDroidTranscript', () => {
  it('strips streaming spinner status line', () => {
    const raw = [
      'Say hello and nothing else',
      '',
      '⛬  Hello!',
      '',
      ' ⣂ Streaming...  (Press ESC to stop)',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toContain('Streaming...');
    expect(result).not.toContain('Press ESC to stop');
    expect(result).toContain('Say hello and nothing else');
    expect(result).toContain('⛬  Hello!');
  });

  it('strips standalone braille spinner glyphs', () => {
    const raw = [
      'Tell me about birds',
      '⠁',
      '⠂',
      '⡀',
      '⛬  Birds are fascinating creatures.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toMatch(/^⠁$/m);
    expect(result).not.toMatch(/^⠂$/m);
    expect(result).not.toMatch(/^⡀$/m);
    expect(result).toContain('Birds are fascinating');
  });

  it('strips the autonomy status line', () => {
    const raw = [
      'Test prompt',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      '',
      ' >',
      '',
      '⛬  Test response.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toContain('all actions require approval');
    expect(result).not.toContain('[BYOK]');
    expect(result).not.toContain('[custom]');
    expect(result).toContain('Test prompt');
    expect(result).toContain('Test response');
  });

  it('strips empty input box prompt lines', () => {
    const raw = [
      'My prompt',
      ' >',
      '>',
      '⛬  My answer.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toMatch(/^\s*>\s*$/m);
    expect(result).toContain('My prompt');
    expect(result).toContain('My answer');
  });

  it('strips the input placeholder hint', () => {
    const raw = [
      ' > Type "Review this code for security issues"',
      'Real prompt text',
      '⛬  Real response.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toContain('Type "Review this code');
    expect(result).toContain('Real prompt text');
  });

  it('strips version-update notices', () => {
    const raw = [
      ' ↓ Downloading update',
      ' ⟳ Verifying update..',
      ' ✓ v0.109.3 ready (restart to apply)',
      'My prompt',
      '⛬  My response.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toContain('Downloading update');
    expect(result).not.toContain('Verifying update');
    expect(result).not.toContain('v0.109.3 ready');
    expect(result).toContain('My prompt');
    expect(result).toContain('My response');
  });

  it('strips the IDE phase indicator', () => {
    const raw = [
      'Some prompt',
      'IDE ◌',
      'IDE ●',
      '⛬  Some response.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toMatch(/^IDE\s/m);
    expect(result).toContain('Some prompt');
    expect(result).toContain('Some response');
  });

  it('strips the elapsed-time timer in the status bar', () => {
    const raw = [
      'Question',
      ' [⏱ 1s]✓ v0.109.3 ready',
      ' [⏱ 12s]✓ v0.109.3 ready',
      '⛬  Answer.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toMatch(/\[⏱\s+\d+s\]/);
    expect(result).toContain('Question');
    expect(result).toContain('Answer.');
  });

  it('extracts only the last response from streaming redraws', () => {
    // Each Ink frame emits a fresh ⛬ block with progressively more content.
    // After noise filtering, blank lines remain between frames where the
    // status block used to be. We want the final, complete response only.
    const raw = [
      'My question',
      '',
      '⛬  Hel',
      '',
      '⛬  Hello',
      '',
      '⛬  Hello world',
      '',
      '⛬  Hello world! Final answer.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).toContain('Hello world! Final answer.');
    expect(result).toContain('My question');
    // Earlier partial frames should not be present.
    const frameCount = (result?.match(/⛬/g) ?? []).length;
    expect(frameCount).toBe(1);
  });

  it('walks past intermediate ⛬ frames to find the user prompt', () => {
    // The user prompt is the first content line ABOVE the response area.
    // Earlier ⛬ frames between the prompt and last response are subsumed
    // into the final-frame response.
    const raw = [
      'How does recursion work?',
      '',
      '⛬  Recur',
      '',
      '⛬  Recursion is when',
      '',
      '⛬  Recursion is when a function calls itself.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).toContain('How does recursion work?');
    expect(result).toContain('Recursion is when a function calls itself.');
  });

  it('does not mistake response continuation lines for the user prompt', () => {
    // Regression: when the response spans multiple lines AND multiple frames,
    // walking back from the LAST ⛬ would land on continuation lines of an
    // earlier frame. Anchoring on the FIRST ⛬ avoids this.
    const raw = [
      'What is recursion?',
      '',
      '⛬  Recursion is when',
      'a function calls itself.',
      '',
      '⛬  Recursion is when',
      'a function calls itself.',
      'It needs a base case.',
      '',
      '⛬  Recursion is when',
      'a function calls itself.',
      'It needs a base case to terminate.',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toBeNull();
    // The actual user prompt must be preserved.
    expect(result).toContain('What is recursion?');
    // Continuation lines from earlier frames must not be promoted to prompts.
    expect(result?.split('\n')[0]).toBe('What is recursion?');
    // The complete final-frame response must be present.
    expect(result).toContain('It needs a base case to terminate.');
    // Only the final frame survives, not the partial earlier frames.
    const frameCount = (result?.match(/⛬/g) ?? []).length;
    expect(frameCount).toBe(1);
  });

  it('preserves multi-line response continuation', () => {
    const raw = [
      'Tell me a joke',
      '⛬  Why did the chicken cross the road?',
      '',
      '  To get to the other side!',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).toContain('Why did the chicken');
    expect(result).toContain('To get to the other side!');
    expect(result).not.toContain('all actions require approval');
  });

  it('returns null for empty input', () => {
    expect(cleanDroidTranscript('')).toBeNull();
    expect(cleanDroidTranscript('   ')).toBeNull();
  });

  it('returns null when only noise remains', () => {
    const raw = [
      ' ⣂ Streaming...  (Press ESC to stop)',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      ' >',
      ' ✓ v0.109.3 ready (restart to apply)',
      ' [⏱ 3s]✓ v0.109.3 ready',
      'IDE ◌',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).toBeNull();
  });

  it('handles a realistic full-frame transcript', () => {
    // Synthesized from a real `capture-droid-pty.js` run against Droid 0.109.3.
    // Multiple frames concatenated, each containing the response area on top
    // and the status block at the bottom.
    const raw = [
      // Initial frames before any response (only spinners + status)
      ' ⠁ Streaming...  (Press ESC to stop)',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      '',
      ' >',
      '',
      ' ✓ v0.109.3 ready (restart to apply)',
      '',
      // User prompt is emitted in conversation area before response begins
      'Say hello and nothing else',
      '',
      ' ⣀ Streaming...  (Press ESC to stop)',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      '',
      ' >',
      '',
      ' [⏱ 2s]✓ v0.109.3 ready (restart to apply)',
      '',
      // Mid-stream frame: partial response
      '⛬  Hel',
      '',
      ' ⣄ Streaming...  (Press ESC to stop)',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      '',
      ' >',
      '',
      ' [⏱ 3s]✓ v0.109.3 ready (restart to apply)',
      '',
      // Final frame with complete response
      '⛬  Hello!',
      '',
      ' ⣂ Streaming...  (Press ESC to stop)',
      '',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK] [custom]',
      '',
      ' >',
      '',
      ' [⏱ 3s]✓ v0.109.3 ready (restart to apply)IDE ◌',
    ].join('\n');

    const result = cleanDroidTranscript(raw);
    expect(result).not.toBeNull();
    expect(result).toContain('Say hello and nothing else');
    expect(result).toContain('Hello!');

    // No noise should leak through.
    expect(result).not.toContain('Streaming');
    expect(result).not.toContain('all actions require approval');
    expect(result).not.toContain('Press ESC to stop');
    expect(result).not.toContain('v0.109.3');
    expect(result).not.toMatch(/^IDE\s/m);
    expect(result).not.toMatch(/\[⏱/);

    // Only the final ⛬ frame should remain.
    const responseFrames = (result?.match(/⛬/g) ?? []).length;
    expect(responseFrames).toBe(1);
  });
});

describe('cleanTranscriptForHandoff with droid', () => {
  it('dispatches to droid cleanup', () => {
    const raw = [
      ' ⣂ Streaming...  (Press ESC to stop)',
      'Greet me',
      '⛬  Hello there.',
      ' Auto (Off) - all actions require approvalSonnet 4.5 [BYOK]',
    ].join('\n');

    const result = cleanTranscriptForHandoff(raw, 'droid');
    expect(result).not.toContain('Streaming...');
    expect(result).not.toContain('all actions require approval');
    expect(result).toContain('Greet me');
    expect(result).toContain('Hello there.');
  });

  it('returns null for empty input', () => {
    expect(cleanTranscriptForHandoff('', 'droid')).toBeNull();
    expect(cleanTranscriptForHandoff('   ', 'droid')).toBeNull();
  });
});
