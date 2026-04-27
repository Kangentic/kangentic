/**
 * Unit tests for cleanQwenTranscript.
 *
 * Qwen Code is a soft fork of gemini-cli, so the cleanup pipeline mirrors
 * Gemini's: filter TUI noise, keep only the last `✦` response block plus
 * the `>` prompt that precedes it. These tests lock in the Qwen-specific
 * additions on top of that pipeline (idle indicator, Session ID footer,
 * resume hint, auth-wizard chrome) and the multi-redraw last-block
 * extraction behaviour.
 */
import { describe, it, expect } from 'vitest';
import { cleanQwenTranscript } from '../../src/main/agent/adapters/qwen-code/transcript-cleanup';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

describe('cleanQwenTranscript', () => {
  it('keeps the prompt and final response across a typical Qwen turn', () => {
    const raw = [
      '╭───────────────────────────────╮',
      '│ Welcome to Qwen Code          │',
      '╰───────────────────────────────╯',
      '',
      '> what is 2+2?',
      '',
      '✦ The answer is 4.',
      '',
      "I'm ready.",
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('what is 2+2?');
    expect(cleaned).toContain('The answer is 4.');
    expect(cleaned).not.toContain("I'm ready");
  });

  it('strips box-drawing-only lines (top, bottom, side-only borders)', () => {
    const raw = [
      '╭──────────────────────╮',
      '│                      │',
      '╰──────────────────────╯',
      '> hello',
      '✦ Hi there.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('╭');
    expect(cleaned).not.toContain('╯');
    expect(cleaned).not.toContain('│');
    expect(cleaned).toContain('Hi there.');
  });

  it('strips the Session ID and resume-hint shutdown lines', () => {
    const raw = [
      '> summarize the project',
      '✦ The project is a desktop Kanban for AI agents.',
      '',
      'Session ID: 73013240-b192-422f-99a3-7cf37eac045a',
      "qwen --resume '73013240-b192-422f-99a3-7cf37eac045a'",
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Session ID:');
    expect(cleaned).not.toContain('--resume');
    expect(cleaned).toContain('desktop Kanban');
  });

  it('also accepts the upstream `gemini --resume` literal that some Qwen forks emit', () => {
    const raw = [
      '> ping',
      '✦ pong',
      "gemini --resume '73013240-b192-422f-99a3-7cf37eac045a'",
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('--resume');
    expect(cleaned).toContain('pong');
  });

  it('strips the Select-Auth-Method wizard menu items', () => {
    const raw = [
      'Select Auth Method',
      '(Use arrow keys to navigate)',
      'Sign in with Google',
      'Use Gemini API Key',
      'Vertex AI',
      'Login with Qwen',
      'OpenAI Compatible',
      '> resume task',
      '✦ Continuing where we left off.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Select Auth Method');
    expect(cleaned).not.toContain('Sign in with Google');
    expect(cleaned).not.toContain('Use Gemini API Key');
    expect(cleaned).not.toContain('Vertex AI');
    expect(cleaned).not.toContain('Login with Qwen');
    expect(cleaned).not.toContain('OpenAI Compatible');
    expect(cleaned).toContain('Continuing where we left off.');
  });

  it('strips the Gemini-inherited spinner, status bar, and tips chrome', () => {
    const raw = [
      'Tips for getting started:',
      '1. Create QWEN.md to customize behaviour.',
      '2. /help for command list',
      '⠋ Thinking...',
      'YOLO Ctrl+Y',
      'Auto (Qwen 3 Coder)',
      'no sandbox',
      'branch: main',
      '> generate a haiku',
      '✦ Silent code awaits / blinking cursor on the screen / fingers find the keys',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Tips for getting started');
    expect(cleaned).not.toContain('Thinking');
    expect(cleaned).not.toContain('YOLO');
    expect(cleaned).not.toContain('Auto (Qwen');
    expect(cleaned).not.toContain('no sandbox');
    expect(cleaned).not.toContain('branch:');
    expect(cleaned).toContain('Silent code awaits');
  });

  it('returns only the last response block when Qwen redraws the viewport per token', () => {
    // Qwen (like Gemini) re-emits the entire response with each token, so
    // the raw transcript contains many partial copies. The last ✦ block
    // is the most complete one and the only one we want to keep.
    const raw = [
      '> explain prompt caching',
      '✦ Prompt',
      '✦ Prompt caching',
      '✦ Prompt caching is',
      '✦ Prompt caching is a feature that reduces cost.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('Prompt caching is a feature that reduces cost.');
    // Count the ✦-prefixed lines: only the final complete redraw should remain.
    // Counting "✦ Prompt" is stricter than counting "Prompt caching" because
    // the substring "Prompt caching" appears in the final line regardless of
    // whether earlier partial redraws leaked - the ✦ prefix does not.
    const redrawMarkers = (cleaned ?? '').match(/✦\s+Prompt/g) ?? [];
    expect(redrawMarkers.length).toBe(1);
    // Belt-and-suspenders: the stale partial "✦ Prompt caching is" must be gone.
    expect(cleaned).not.toContain('✦ Prompt caching is\n');
  });

  it('returns null for empty input', () => {
    expect(cleanQwenTranscript('')).toBeNull();
    expect(cleanQwenTranscript('   ')).toBeNull();
  });

  it('returns null when only TUI noise remains', () => {
    const raw = [
      '╭──────────────╮',
      '│              │',
      '╰──────────────╯',
      "I'm ready.",
      'Session ID: 73013240-b192-422f-99a3-7cf37eac045a',
      "qwen --resume '73013240-b192-422f-99a3-7cf37eac045a'",
    ].join('\n');

    expect(cleanQwenTranscript(raw)).toBeNull();
  });

  it('strips the inline "? for shortcuts" suffix that gets concatenated to response lines', () => {
    const raw = [
      '> quick check',
      '✦ All good.? for shortcuts',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('All good.');
    expect(cleaned).not.toContain('? for shortcuts');
  });

  it('strips the U+2019 curly-apostrophe variant of the idle indicator', () => {
    // Real PTY output may emit a curly right-single-quote for "I’m"
    // depending on locale or terminal autocorrect.
    const raw = [
      '> ping',
      '✦ pong',
      'I’m ready.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('ready');
    expect(cleaned).toContain('pong');
  });

  it('falls through to finalizeTranscript when no ✦ response marker is present', () => {
    // When the transcript contains content but no ✦ line, lastResponseStart
    // stays -1 and cleanQwenTranscript returns finalizeTranscript(text).
    // This branch is exercised by sessions that exited before the agent
    // produced any response (e.g. an immediate auth failure or a pure
    // command invocation with no model output).
    const raw = [
      '> run the tests',
      'some non-response output without the response marker',
      'Session ID: 73013240-b192-422f-99a3-7cf37eac045a',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    // The function must not return null - the prompt and non-noise content
    // should survive finalizeTranscript even without a ✦ block.
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('run the tests');
    expect(cleaned).toContain('non-response output');
    // Session ID noise still stripped by filterNoiseLines before finalize.
    expect(cleaned).not.toContain('Session ID:');
  });

  it('returns only the response block when a ✦ response exists but no > prompt precedes it', () => {
    // When lastResponseStart is found but the backward scan for a `>` prompt
    // finds nothing (promptStart === -1), the function returns just the last
    // ✦ block via finalizeTranscript. This happens when the session starts
    // mid-conversation and the prompt scroll-backed off the PTY buffer.
    const raw = [
      '✦ The answer is 42.',
      '✦ The answer is 42. More detail follows.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    // Only the final (most complete) response block is returned.
    expect(cleaned).toContain('More detail follows.');
    // No duplicate of the earlier incomplete line.
    const responseOccurrences = (cleaned ?? '').match(/The answer is 42\./g) ?? [];
    expect(responseOccurrences.length).toBe(1);
  });

  it('strips the Auto (Gemini …) variant of the status-bar pattern', () => {
    // The QWEN_NOISE_PATTERNS regex /Auto\s*\((?:Gemini|Qwen)\s*\d/ covers both
    // `Auto (Qwen 3 Coder)` and `Auto (Gemini 2.5 Flash)`. The Gemini variant
    // appears in Qwen fork builds that still emit the upstream status bar text.
    const raw = [
      'Auto (Gemini 2.5 Flash)',
      'no sandbox',
      '> list the files',
      '✦ Here are the files in the project.',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Auto (Gemini');
    expect(cleaned).not.toContain('no sandbox');
    expect(cleaned).toContain('Here are the files');
  });

  it('strips noise wrapped inside `│ ... │` box borders (idle and wizard)', () => {
    // Qwen renders interactive surfaces inside box-drawing borders, so
    // noise lines may arrive as `│ I’m ready.       │`
    // rather than as bare lines. The pre-strip step extracts inner text
    // before the noise filter runs.
    const raw = [
      '╭──────────────╮',
      '│ Select Auth Method            │',
      '│ Sign in with Google           │',
      '│ Login with Qwen               │',
      '╰──────────────╯',
      '│ I’m ready.                  │',
      '> resume task',
      '│ ✦ Continuing where we left off. │',
    ].join('\n');

    const cleaned = cleanQwenTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Select Auth Method');
    expect(cleaned).not.toContain('Sign in with Google');
    expect(cleaned).not.toContain('Login with Qwen');
    expect(cleaned).not.toContain('ready');
    expect(cleaned).not.toContain('│');
    expect(cleaned).toContain('Continuing where we left off.');
  });
});

describe('cleanTranscriptForHandoff with qwen', () => {
  it('routes to the Qwen cleaner', () => {
    const raw = [
      '> hello',
      '✦ Hi there.',
      "I'm ready.",
    ].join('\n');

    const direct = cleanQwenTranscript(raw);
    const dispatched = cleanTranscriptForHandoff(raw, 'qwen');
    expect(dispatched).toBe(direct);
    expect(dispatched).toContain('Hi there.');
  });

  it('returns null for empty input', () => {
    expect(cleanTranscriptForHandoff('', 'qwen')).toBeNull();
    expect(cleanTranscriptForHandoff('   ', 'qwen')).toBeNull();
  });
});
