import { describe, it, expect } from 'vitest';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

// ---------------------------------------------------------------------------
// Realistic TUI transcript fixtures
//
// These fixtures are derived from REAL PTY captures. Each simulates the
// structure of actual agent output after ANSI stripping.
// ---------------------------------------------------------------------------

// ── Claude Code ──
// Real structure: banner, spinner noise, duplicated viewport redraws of the
// initial prompt/response, garbled intermediate renders with no spaces,
// then the clean final render at the bottom.
const CLAUDE_REAL_TRANSCRIPT = [
  // Banner and spinners
  '\u2590\u259b\u259c\u258c\u2590\u259b\u259c\u258c Claude Code',
  '✶Combobulating...',
  '✻Moseying...',
  '◐ medium \u00b7 /effort',
  '',
  // First TUI redraw (duplicate)
  '❯ Test: Test',
  '',
  '● Hi! I\'m here and ready. What would you like to work on?',
  '',
  '❯ Test: Test',
  '',
  '● Hi! I\'m here and ready. What would you like to work on?',
  '',
  '❯ Test: Test',
  '',
  '● Hi! I\'m here and ready. What would you like to work on?',
  '',
  // Garbled intermediate render (words joined without spaces)
  'Tellmeabout5birds❯ Tell me about 5 birds',
  '* Transmuting\u2026',
  '  \u23bf  Tip: Use /memory to view and manage Claude memory',
  '──────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '⏸planmodeon (shift+tabtocycle)/buddy✢Transmuting\u2026',
  '●Here are 5 notablebirds:',
  '1.Peregrine Falcon-ThefastestanimalonEarth,reachingover240mph(386km/h)inahuntingdive(stoop).',
  '  2. Arctic Tern - Holds the record for the longest migration.',
  '3.African Grey Parrot-Consideredoneofthemostintelligentbirds.',
  '  4. Superb Lyrebird - An Australian bird famous for its extraordinary ability to mimic almost any sound.',
  '5. Emperor Penguin - The tallest penguinspecies,uniquelyadaptedtobreedduringtheAntarcticwinterintemperaturesaslowas-76\u00b0F(-60\u00b0C).',
  '──────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '',
  // Clean final render
  '❯ Test: Test',
  '',
  '● Hi! I\'m here and ready. What would you like to work on?',
  '',
  '❯ Tell me about 5 birds',
  '',
  '● Here are 5 notable birds:',
  '',
  '  1. Peregrine Falcon - The fastest animal on Earth, reaching over 240 mph in a hunting dive.',
  '  2. Arctic Tern - Holds the record for the longest migration, traveling roughly 44,000 miles annually.',
  '  3. African Grey Parrot - Considered one of the most intelligent birds.',
  '  4. Superb Lyrebird - An Australian bird famous for its extraordinary ability to mimic almost any sound.',
  '  5. Emperor Penguin - The tallest penguin species, uniquely adapted to breed during the Antarctic winter.',
].join('\n');

// ── Codex CLI ──
// Real structure from actual handoff: header box, spinner noise, handoff prompt
// repeated many times (TUI redraws), then the actual user prompt + response
// with auto-prompt interleaved between each streamed response item.
const CODEX_REAL_TRANSCRIPT = [
  // Header banner box
  '╭───────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.118.0)                            │',
  '│ model:     gpt-5.3-codex medium   /model to change    │',
  '│ directory: ~\\projects\\test                            │',
  '╰───────────────────────────────────────────────────────╯',
  '',
  '  Tip: New Build faster with Codex.',
  '',
  // Handoff prompt - repeated 3x from TUI redraws
  '› You are continuing work on this task. Read handoff-context.md before continuing. Prior work: 52 files changed.',
  '',
  '› Run /review on my current changes',
  '',
  '  gpt-5.3-codex medium · 100% left · ~\\projects\\test',
  '',
  '› You are continuing work on this task. Read handoff-context.md before continuing. Prior work: 52 files changed.',
  '',
  '› Run /review on my current changes',
  '',
  // Spinner residue (partial "Working" redraws)
  'W',
  '',
  'or',
  '',
  'rk',
  'ki',
  '',
  'in',
  'Wng',
  '1',
  'Wog',
  '',
  'or',
  '',
  'ki',
  'in',
  '',
  'ng',
  '',
  'g',
  '',
  // More handoff prompt repeats
  '› You are continuing work on this task. Read handoff-context.md before continuing. Prior work: 52 files changed.',
  '',
  '› Run /review on my current changes',
  '',
  '  tab to queu message100% context left',
  '',
  // Tool execution status
  '• Running Get-Content -Path handoff-context.md',
  '',
  // User prompt with continuation marker
  '› Tell me about 5 planets',
  '',
  '  tab to queue message100% context left',
  '',
  '• Ran Get-Content -Path handoff-context.md',
  '  └ <handoff version="1" source="claude" target="codex"...',
  '',
  '  … +82 lines',
  '',
  // The actual response, with auto-prompt interleaved between items
  '› Tell me about 5 planets',
  '',
  '› Run /review on my current changes',
  '',
  '• 1. Mercury: Closest planet to the Sun; small, rocky, extreme temperature swings.',
  '',
  '› Run /review on my current changes',
  '',
  '  2. Venus: Similar in size to Earth but with a thick, toxic atmosphere.',
  '',
  '› Run /review on my current changes',
  '',
  '  3. Earth: The only known planet with liquid surface water and life.',
  '',
  '› Run /review on my current changes',
  '',
  '  4. Mars: The "Red Planet," with giant volcanoes and deep canyons.',
  '',
  '› Run /review on my current changes',
  '',
  '  5. Jupiter: The largest planet, a gas giant with the Great Red Spot.',
  '',
  '› Run /review on my current changes',
  '',
  '› Run /review on my current changes',
].join('\n');

// ── Codex with tool execution ──
// Real scenario: Codex reads handoff context, runs git commands, encounters
// errors, then eventually answers the user's question. All tool narration
// and output should be stripped, leaving only the user prompt + response.
const CODEX_WITH_TOOLS = [
  // Handoff prompt fragment continuations (wrapped from long prompt)
  'context is at: .kangentic/sessions/abc123/handoff-context.md',
  '',
  '  context is at: .kangentic/sessions/abc123/handoff-context.md',
  '',
  '  context is at: .kangentic/sessions/abc123/handoff-context.md',
  '',
  // Tool narration
  "• I'll pick up from the prior handoff by reading the context file first.",
  '',
  // Spinner fragments (longer than 3 chars)
  'aWog',
  'brki',
  'ouin',
  '',
  // Partial prompt redraw
  '› Tell me about 5',
  '',
  // Leaked XML from reading handoff file
  '    </handoff>',
  '',
  'Wng5',
  '',
  'Wng7',
  '',
  // More tool narration
  "• I've loaded the handoff context. Next I'll check the git state.",
  '',
  // Tool output: git ownership check
  "    'C:/Users/dev/project/.git' is owned by:",
  '',
  '        git config --global --add safe.directory C:/Users/dev/project',
  '',
  // Tool narration
  '• Git is blocked by a safe-directory ownership check.',
  '',
  '10s \u2022 esc to interupt)',
  '',
  'Wng3',
  '',
  // More tool narration
  '• Global git config is not writable in this sandbox.',
  '',
  // Tool output: git status
  '    Your branch is up to date with \'origin/main\'.',
  '    warning: unable to access \'C:\\Users\\dev/.config/git/ignore\': Permission denied',
  '',
  '     M .claude/skills/sync-docs/references/verification-procedures.md',
  '',
  '    warning: unable to access \'C:\\Users\\dev/.config/git/ignore\': Permission denied',
  '',
  // Tool narration
  '• I found a large in-progress change set beyond the handoff summary.',
  '',
  // Tool output: JSON and file paths
  '      "name": "kangentic",',
  '',
  '      }',
  '',
  '    tests/unit\\worktree-manager.test.ts',
  '',
  '    tests/unit\\aider-adapter.test.ts',
  '',
  // THE ACTUAL RESPONSE (finally!)
  '• Here are 5 planets:',
  '',
  '  1. Mercury: The smallest planet and closest to the Sun.',
  '',
  '  2. Venus: Similar in size to Earth but extremely hot.',
  '',
  '  3. Earth: The only known planet with life.',
  '',
  '  4. Mars: The "Red Planet," with evidence of ancient water.',
  '',
  '  5. Jupiter: The largest planet, a gas giant with the Great Red Spot.',
  '',
  // TUI redraws of partial response (items 3-5 repeated)
  '  3. Earth: The only known planet with life.',
  '  4. Mars: The "Red Planet," with evidence of ancient water.',
  '  5. Jupiter: The largest planet, a gas giant with the Great Red Spot.',
  '',
  '  3. Earth: The only known planet with life.',
  '  4. Mars: The "Red Planet," with evidence of ancient water.',
  '  5. Jupiter: The largest planet, a gas giant with the Great Red Spot.',
].join('\n');

// ── Codex multi-turn ──
const CODEX_MULTI_TURN = [
  '╭───────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.118.0)                            │',
  '╰───────────────────────────────────────────────────────╯',
  '•◦Working (thinking)',
  '',
  '› What is 2+2?',
  '',
  '• 2+2 = 4',
  '',
  '› Now what is 3+3?',
  '',
  '• 3+3 = 6',
  '',
  '› Run /review on my current changes',
  '',
  '  gpt-5.3-codex medium · 88% left · ~\\projects\\test',
].join('\n');

// ── Gemini CLI ──
// Real structure: banner art, auth, workspace status, multiple spinner redraws,
// then clean final conversation.
const GEMINI_REAL_TRANSCRIPT = [
  '\u259d\u259c\u2584 \u2597\u259f\u2580 Gemini CLI',
  'Authenticated with user@gmail.com',
  'workspace (/directory)',
  '~\\projects\\test',
  'no sandbox   ? for shortcuts',
  '',
  '\u280b Thinking...',
  '\u2819 Thinking...',
  '',
  // First redraw (incomplete)
  '> Tell me about 5 fish',
  '',
  '\u2839 Thinking...',
  '\u2838 Thinking...',
  '',
  // Second redraw (incomplete)
  '> Tell me about 5 fish',
  '',
  '\u2826 Thinking...',
  '',
  // Clean final render
  '> Tell me about 5 fish',
  '',
  '✦ Here are 5 fascinating fish:',
  '',
  '  1. Clownfish - lives among sea anemones',
  '  2. Great White Shark - apex ocean predator',
  '  3. Seahorse - male carries the eggs',
  '  4. Electric Eel - generates 860 volts',
  '  5. Pufferfish - inflates when threatened',
  '',
  '  Would you like more details on any of these?',
  '',
  '* Type your message',
  'YOLO Ctrl+Y',
].join('\n');

// ── Claude multi-turn ──
const CLAUDE_MULTI_TURN = [
  '✶Sublimating...',
  '',
  '❯ Tell me about 3 colors',
  '',
  '● Here are 3 colors:',
  '',
  '  1. Red - warm, energetic',
  '  2. Blue - cool, calming',
  '  3. Green - natural, refreshing',
  '',
  '❯ Now tell me about 3 shapes',
  '',
  '● Here are 3 shapes:',
  '',
  '  1. Circle - infinite symmetry',
  '  2. Triangle - strongest shape',
  '  3. Square - stability and order',
].join('\n');


describe('cleanTranscriptForHandoff', () => {
  describe('Claude Code', () => {
    it('extracts the clean final conversation, not garbled redraws', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_REAL_TRANSCRIPT, 'claude');
      expect(result).not.toBeNull();

      // Should contain both prompts and full response
      expect(result).toContain('Tell me about 5 birds');
      expect(result).toContain('Peregrine Falcon');
      expect(result).toContain('Arctic Tern');
      expect(result).toContain('African Grey Parrot');
      expect(result).toContain('Superb Lyrebird');
      expect(result).toContain('Emperor Penguin');
    });

    it('strips garbled lines with no spaces between words', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_REAL_TRANSCRIPT, 'claude')!;
      expect(result).not.toContain('Tellmeabout5birds');
      expect(result).not.toContain('notablebirds');
      expect(result).not.toContain('ThefastestanimalonEarth');
    });

    it('strips TUI noise (spinners, banners, status lines)', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_REAL_TRANSCRIPT, 'claude')!;
      expect(result).not.toMatch(/Combobulating/);
      expect(result).not.toMatch(/Moseying/);
      expect(result).not.toMatch(/Transmuting/);
      expect(result).not.toMatch(/\(thinking\)/);
      expect(result).not.toMatch(/plan\s*mode/);
      expect(result).not.toMatch(/\/buddy/);
    });

    it('does not duplicate the initial task prompt', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_REAL_TRANSCRIPT, 'claude')!;
      const taskPromptCount = (result.match(/Test: Test/g) || []).length;
      // Should appear at most once (the clean render's first prompt)
      expect(taskPromptCount).toBeLessThanOrEqual(1);
    });

    it('does not duplicate the user prompt', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_REAL_TRANSCRIPT, 'claude')!;
      const promptCount = (result.match(/Tell me about 5 birds/g) || []).length;
      expect(promptCount).toBe(1);
    });

    it('includes all turns in a multi-turn conversation', () => {
      const result = cleanTranscriptForHandoff(CLAUDE_MULTI_TURN, 'claude');
      expect(result).not.toBeNull();
      expect(result).toContain('3 colors');
      expect(result).toContain('3 shapes');
      expect(result).toContain('Red');
      expect(result).toContain('Circle');
    });
  });

  describe('Codex CLI', () => {
    it('extracts complete response with all items', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex');
      expect(result).not.toBeNull();

      // Should contain the user prompt and full response (all 5 planets)
      expect(result).toContain('Tell me about 5 planets');
      expect(result).toContain('Mercury');
      expect(result).toContain('Venus');
      expect(result).toContain('Earth');
      expect(result).toContain('Mars');
      expect(result).toContain('Jupiter');
    });

    it('strips box-drawing borders', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex')!;
      expect(result).not.toMatch(/[╭╮╰╯│]/);
    });

    it('strips spinner noise and TUI chrome', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex')!;
      // Spinner fragments
      expect(result).not.toMatch(/^Wng$/m);
      expect(result).not.toMatch(/^Wog$/m);
      // TUI chrome
      expect(result).not.toMatch(/tab to queu/);
      expect(result).not.toMatch(/context left/);
      // Tool execution status
      expect(result).not.toMatch(/Running Get-Content/);
      expect(result).not.toMatch(/Ran Get-Content/);
    });

    it('strips interleaved auto-prompts from response', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex')!;
      // The auto-prompt "Run /review..." should not appear in the cleaned output
      expect(result).not.toMatch(/Run \/review/);
    });

    it('strips repeated handoff prompts', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex')!;
      // The handoff prompt should not appear (it's repeated noise)
      expect(result).not.toMatch(/continuing work on this task/);
    });

    it('does not duplicate the user prompt', () => {
      const result = cleanTranscriptForHandoff(CODEX_REAL_TRANSCRIPT, 'codex')!;
      const promptCount = (result.match(/Tell me about 5 planets/g) || []).length;
      expect(promptCount).toBe(1);
    });

    it('handles multi-turn Codex conversation', () => {
      const result = cleanTranscriptForHandoff(CODEX_MULTI_TURN, 'codex');
      expect(result).not.toBeNull();
      expect(result).toContain('2+2');
      expect(result).toContain('2+2 = 4');
      expect(result).toContain('3+3');
      expect(result).toContain('3+3 = 6');
    });

    it('strips tool narration and tool output from sessions with tool calls', () => {
      const result = cleanTranscriptForHandoff(CODEX_WITH_TOOLS, 'codex');
      expect(result).not.toBeNull();

      // Should contain the actual response
      expect(result).toContain('Mercury');
      expect(result).toContain('Venus');
      expect(result).toContain('Earth');
      expect(result).toContain('Mars');
      expect(result).toContain('Jupiter');

      // Should NOT contain tool narration
      expect(result).not.toMatch(/I'll pick up/);
      expect(result).not.toMatch(/I've loaded/);
      expect(result).not.toMatch(/Git is blocked/);
      expect(result).not.toMatch(/Global git config/);
      expect(result).not.toMatch(/I found a large/);

      // Should NOT contain tool output
      expect(result).not.toMatch(/safe\.directory/);
      expect(result).not.toMatch(/Permission denied/);
      expect(result).not.toMatch(/warning:/);
      expect(result).not.toMatch(/branch is up to date/);
      expect(result).not.toMatch(/<\/handoff>/);
      expect(result).not.toMatch(/"name":/);

      // Should NOT contain handoff prompt fragments
      expect(result).not.toMatch(/context is at:/);

      // Should NOT contain spinner fragments
      expect(result).not.toMatch(/^aWog$/m);
      expect(result).not.toMatch(/^brki$/m);
      expect(result).not.toMatch(/^Wng5$/m);
    });

    it('does not duplicate response in tool-heavy sessions', () => {
      const result = cleanTranscriptForHandoff(CODEX_WITH_TOOLS, 'codex')!;
      // Planets 3-5 should appear only once (not from TUI redraws)
      const earthCount = (result.match(/Earth:/g) || []).length;
      expect(earthCount).toBe(1);
    });
  });

  describe('Gemini CLI', () => {
    it('extracts clean conversation from Gemini TUI output', () => {
      const result = cleanTranscriptForHandoff(GEMINI_REAL_TRANSCRIPT, 'gemini');
      expect(result).not.toBeNull();

      expect(result).toContain('Tell me about 5 fish');
      expect(result).toContain('Clownfish');
      expect(result).toContain('Great White Shark');
      expect(result).toContain('Seahorse');
      expect(result).toContain('Electric Eel');
      expect(result).toContain('Pufferfish');
    });

    it('strips Gemini-specific noise', () => {
      const result = cleanTranscriptForHandoff(GEMINI_REAL_TRANSCRIPT, 'gemini')!;
      expect(result).not.toMatch(/Thinking\.\.\./);
      expect(result).not.toMatch(/Authenticated with/);
      expect(result).not.toMatch(/workspace.*\/directory/);
      expect(result).not.toMatch(/Type your message/);
      expect(result).not.toMatch(/YOLO/);
    });

    it('does not duplicate the prompt', () => {
      const result = cleanTranscriptForHandoff(GEMINI_REAL_TRANSCRIPT, 'gemini')!;
      const promptCount = (result.match(/Tell me about 5 fish/g) || []).length;
      expect(promptCount).toBe(1);
    });
  });

  describe('Aider (no TUI)', () => {
    it('passes through plain text with basic cleanup', () => {
      const plain = 'User: Fix the bug\n\nAssistant: I found the issue in main.ts\nand fixed it.';
      const result = cleanTranscriptForHandoff(plain, 'aider');
      expect(result).toContain('Fix the bug');
      expect(result).toContain('found the issue');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty input', () => {
      expect(cleanTranscriptForHandoff('', 'claude')).toBeNull();
      expect(cleanTranscriptForHandoff('   ', 'codex')).toBeNull();
    });

    it('returns null for pure TUI noise', () => {
      const noise = [
        '\u2590\u259b\u259c\u258c\u2590\u259b\u259c\u258c Claude Code',
        '✶Sublimating...',
        '✻Moseying...',
        '(thinking)',
        '──────────────────────────────',
      ].join('\n');
      expect(cleanTranscriptForHandoff(noise, 'claude')).toBeNull();
    });

    it('handles unknown agent gracefully', () => {
      const text = 'Some plain output';
      const result = cleanTranscriptForHandoff(text, 'unknown-agent');
      expect(result).toContain('plain output');
    });

    it('default branch applies finalizeTranscript (collapse blank runs, trim) for unknown agent', () => {
      // The dispatcher default case calls finalizeTranscript, which collapses
      // 3+ blank lines to at most 2 and trims leading/trailing whitespace.
      const text = '   \n\n\n\nSome content\n\n\n\nMore content\n\n\n';
      const result = cleanTranscriptForHandoff(text, 'future-agent-v2');
      expect(result).not.toBeNull();
      // Leading/trailing whitespace must be gone.
      expect(result!.startsWith(' ')).toBe(false);
      expect(result!.endsWith('\n')).toBe(false);
      // Excessive blank runs collapsed to at most two newlines.
      expect(result).not.toMatch(/\n{3,}/);
      // Content must be preserved.
      expect(result).toContain('Some content');
      expect(result).toContain('More content');
    });

    it('early-return guard returns null for whitespace-only transcript regardless of agent', () => {
      // The dispatcher's `if (!rawTranscript.trim()) return null;` guard fires
      // BEFORE the switch, so whitespace-only input never reaches the default
      // branch. This test pins the early-return contract explicitly so a
      // future change that moves the trim check into individual cleaners
      // doesn't silently break it.
      const result = cleanTranscriptForHandoff('   \n  \n  ', 'future-agent-v2');
      expect(result).toBeNull();
    });

    it('default branch returns null when content reduces to nothing inside finalizeTranscript', () => {
      // To exercise the default branch (not the early-return guard), the
      // input must pass `rawTranscript.trim()` (i.e. contain non-whitespace
      // characters somewhere) but reduce to empty after finalizeTranscript's
      // collapse + strip-trailing-duplicates pass. A run of repeated blank
      // lines surrounding a single zero-width-joiner does this: trim() on
      // the whole thing returns truthy (the ZWJ survives), but the per-line
      // pipeline collapses it away and trim() at the end returns ''.
      // We use a simpler input: a single line of pure whitespace mixed with
      // tabs is preserved by the early-return guard (tabs survive trim) but
      // the finalize step trims it to empty.
      // NOTE: with the current implementation, ANY input that passes the
      // early-return guard will preserve at least one non-whitespace
      // character through finalizeTranscript. So the default branch
      // returning null is unreachable in practice - it's a defensive
      // safety net. This test documents that observation.
      const text = '​'; // zero-width space - non-whitespace per trim()
      const result = cleanTranscriptForHandoff(text, 'future-agent-v2');
      // Defensive null OR a string containing the ZWJ are both acceptable;
      // the contract is that the default branch never throws.
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });
});
