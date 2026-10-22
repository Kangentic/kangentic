import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentOutputTracker, AGENT_READY_CEILING_MS } from '../../src/main/pty/lifecycle/agent-output-tracker';

/**
 * Byte shapes taken from real Command Terminal boots (Claude Code 2.1.308 in a
 * /preview, raw rings read with kangentic_devtools_terminal_forensics), trimmed
 * and with the paths replaced. What each shell's typed clear prelude became:
 *
 *   Windows PowerShell 5.1, pwsh 7.6, cmd  ->  line erases plus `\x1b[3J`, no `\x1b[2J`
 *   Git Bash, WSL (ncurses `clear`)         ->  `\x1b[H\x1b[2J\x1b[3J`
 *
 * ConPTY opens every stream with its own `\x1b[2J`, with nothing printable
 * ahead of it, and the shell's startup frame carries the cursor-hide escape
 * Claude's first-output detector matches. Neither may count as the agent.
 */
const lineErases = (count: number) => '\x1b[K\r\n'.repeat(count);

const CONPTY_INIT = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' + '\r\n'.repeat(4)
  + '\x1b[H\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE\x07\x1b[?25h';
const POWERSHELL_PROMPT = '\x1b[?25l' + lineErases(4) + '\x1b[K\x1b[H\x1b[?25hPS C:\\Users\\dev\\project> ';
const POWERSHELL_ECHO = '\x1b[?25l\x1b[93mC\x1b[?25h\x1b[m\x1b[93m\x08Clear-Host\x1b[37m; & '
  + '\x1b[36m"C:\\Users\\dev\\.local\\bin\\claude.EXE" \x1b[90m--model \x1b[37mhaiku';
const CLEAR_HOST = '\x1b[?25l\x1b[m\x1b[H\x1b[?25h\x1b[?25l' + lineErases(4) + '\x1b[K\x1b[H\x1b[?25h\x1b[?25l\x1b[3J'
  + lineErases(4) + '\x1b[K\x1b[H\x1b[?25h';
const CLAUDE_SETUP = '\x1b]0;claude\x07\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[<u\x1b[>5u\x1b[>4;2m'
  + '\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[>4m\x1b]0;\u2733 Claude Code\x07';
const CLAUDE_FRAME = '\x1b[?1049h\x1b[2J\x1b[?2026h\x1b[?2026l\x1b[K\x1b[38;2;215;119;87m\r\n \u2590\x1b[m   \x1b[1mClaude Code\x1b[22m';

function feed(tracker: AgentOutputTracker, chunks: string[]): boolean[] {
  return chunks.map((chunk) => tracker.consume('s1', chunk));
}

describe('AgentOutputTracker', () => {
  it('fires on the agent frame under Windows PowerShell, never on the shell before it', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [CONPTY_INIT, POWERSHELL_PROMPT, POWERSHELL_ECHO, CLEAR_HOST, CLAUDE_SETUP, CLAUDE_FRAME]))
      .toEqual([false, false, false, false, false, true]);
  });

  it('finds the handoff and the agent text inside one coalesced chunk', () => {
    const tracker = new AgentOutputTracker();
    expect(tracker.consume('s1', CONPTY_INIT + POWERSHELL_PROMPT + POWERSHELL_ECHO + CLEAR_HOST + CLAUDE_SETUP + CLAUDE_FRAME)).toBe(true);
  });

  it('does not fire on a chunk that ends at the handoff, only on the agent text after it', () => {
    const tracker = new AgentOutputTracker();
    expect(tracker.consume('s1', CONPTY_INIT + POWERSHELL_PROMPT + POWERSHELL_ECHO + CLEAR_HOST + CLAUDE_SETUP)).toBe(false);
    expect(tracker.consume('s1', CLAUDE_FRAME)).toBe(true);
  });

  it('skips a window title after the handoff and fires on an inline agent line (cmd)', () => {
    const cmdBanner = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HMicrosoft Windows [Version 10.0.0]'
      + '\x1b]0;C:\\WINDOWS\\system32\\cmd.EXE\x07\x1b[?25h\x1b[?25l\r\n\x1b[4;1HC:\\Users\\dev\\project>\x1b[?25h'
      + 'cls & "C:\\Users\\dev\\.local\\bin\\agent.EXE" --model haiku\r\n';
    const cls = '\x1b[?25l\x1b[H' + lineErases(4) + '\x1b[K\x1b[9;1H\x1b]0;C:\\WINDOWS\\system32\\cmd.EXE - cls  \x07'
      + '\x1b[?25h\x1b[?25l\x1b[3J\x1b[H\x1b]0;C:\\WINDOWS\\system32\\cmd.EXE - "C:\\Users\\dev\\.local\\bin\\agent.EXE" --model haiku\x07\x1b[?25h';
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [cmdBanner, cls, 'AGENT READY\r\n'])).toEqual([false, false, true]);
  });

  it('takes the ncurses clear as the handoff (Git Bash, WSL, POSIX)', () => {
    const bashPrompt = '\x1b[?2004h\x1b[32m\r\ndev@host \x1b[33m~/project\x1b[m\r\n$ '
      + "clear; '/home/dev/.local/bin/claude' --model haiku\x1b[?2004l\r\n";
    const clear = '\x1b[H\x1b[2J\x1b[3J';
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [CONPTY_INIT, bashPrompt, clear, CLAUDE_SETUP, CLAUDE_FRAME]))
      .toEqual([false, false, false, false, true]);
  });

  it('takes an erase-display alone as the handoff, as a clear with no E3 in its terminfo sends', () => {
    const zshPrompt = 'dev@host project % clear; /usr/local/bin/aider --model sonnet\r\n';
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [zshPrompt, '\x1b[H\x1b[2J', 'Aider v0.86.0\r\n'])).toEqual([false, false, true]);
  });

  it('never takes ConPTY startup clear for the handoff, so the prompt cannot fire it', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [CONPTY_INIT, POWERSHELL_PROMPT, POWERSHELL_ECHO, 'more shell text\r\n']))
      .toEqual([false, false, false, false]);
  });

  it('ignores an erase-scrollback with nothing printable before it', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, ['\x1b[?25l\x1b[3J\x1b[H', POWERSHELL_PROMPT])).toEqual([false, false]);
  });

  it('shows the shell error when the agent command could not start', () => {
    const tracker = new AgentOutputTracker();
    const notFound = "\x1b[91m& : The term 'claude' is not recognized as the name of a cmdlet\x1b[m\r\n";
    expect(feed(tracker, [CONPTY_INIT, POWERSHELL_PROMPT, POWERSHELL_ECHO, CLEAR_HOST, notFound]))
      .toEqual([false, false, false, false, true]);
  });

  it('finds an erase-scrollback split across two chunks', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [POWERSHELL_PROMPT + '\x1b[?25l\x1b[3', 'J\x1b[H', 'AGENT READY'])).toEqual([false, false, true]);
  });

  it('reads neither half of a window title split across chunks as agent text', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [
      POWERSHELL_PROMPT + CLEAR_HOST + '\x1b]0;C:\\WINDOWS\\system32\\cmd.EXE - "C:\\Users\\de',
      'v\\.local\\bin\\agent.EXE" --model haiku\x07\x1b[?25h',
      'AGENT READY',
    ])).toEqual([false, false, true]);
  });

  it('reads no parameters of a CSI split across chunks as agent text', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [POWERSHELL_PROMPT + CLEAR_HOST + '\x1b[38;2;', '215;119;87m', 'AGENT READY']))
      .toEqual([false, false, true]);
  });

  it('reads a charset designation and blank line erases as nothing', () => {
    const tracker = new AgentOutputTracker();
    expect(feed(tracker, [POWERSHELL_PROMPT + CLEAR_HOST, '\x1b(B\x1b[m' + lineErases(3) + '   \r\n', 'AGENT READY']))
      .toEqual([false, false, true]);
  });

  it('fires once per session, tracks sessions apart, and fires again after removeSession', () => {
    const tracker = new AgentOutputTracker();
    expect(tracker.consume('s1', POWERSHELL_PROMPT + CLEAR_HOST + 'AGENT READY')).toBe(true);
    expect(tracker.consume('s1', 'more agent text')).toBe(false);
    expect(tracker.consume('s2', 'AGENT READY')).toBe(false);
    tracker.removeSession('s1');
    expect(tracker.consume('s1', POWERSHELL_PROMPT + CLEAR_HOST + 'AGENT READY')).toBe(true);
    tracker.clear();
    expect(tracker.consume('s1', POWERSHELL_PROMPT + CLEAR_HOST + 'AGENT READY')).toBe(true);
  });

  describe('a partial escape longer than the carry cap', () => {
    // 250 repeats of a 21 character path is over 5000 characters, past
    // MAX_CARRY_LENGTH (4096, not exported). It is the shape of cmd's title
    // carrying a long agent command line.
    const oversizeTitleStart = '\x1b]0;' + 'C:\\Users\\dev\\project\\'.repeat(250);

    it('reads neither half of an oversize window title split across chunks as agent text', () => {
      expect(oversizeTitleStart.length).toBeGreaterThan(4096);
      const tracker = new AgentOutputTracker();
      // The handoff has already landed. The title's payload is dropped from the
      // carry but its introducer is kept, so the tail that ends it in the next
      // chunk still reads as part of a string and not as text. Dropping the
      // whole partial would lift the overlay on the shell at 'tail text'.
      expect(feed(tracker, [
        POWERSHELL_PROMPT + CLEAR_HOST,
        oversizeTitleStart,
        'tail text\x07',
        'AGENT READY',
      ])).toEqual([false, false, false, true]);
    });

    it('keeps a trailing ESC of an oversize partial, so a string terminator split across chunks still ends the title', () => {
      const tracker = new AgentOutputTracker();
      // The title is cut right after the ESC of its ST terminator (`\x1b\`).
      // With that ESC dropped from the carry, the lone backslash that follows
      // is read as more of the title's payload and swallows the agent's text.
      expect(feed(tracker, [
        POWERSHELL_PROMPT + CLEAR_HOST,
        oversizeTitleStart + '\x1b',
        '\\',
        'AGENT READY',
      ])).toEqual([false, false, false, true]);
    });
  });

  describe('the cursor-home plus erase-below clear (TERM=screen)', () => {
    // A recorded miss, pinned on purpose. SPAWN_HANDOFF_CLEAR (in
    // pty-buffer-manager.ts) matches only erase-display (ED2) and
    // erase-scrollback (ED3). The decision there is to NOT match `\x1b[H\x1b[J`,
    // because a prompt redraw sends the same two sequences, so matching them
    // would take the prompt for the handoff before the typed command ran. The
    // cost is that a shell sending only this clear never shows a handoff, and
    // its launch overlay lifts on the alt screen, the SessionStart hook or
    // AGENT_READY_CEILING_MS instead. If this test goes red, someone widened
    // the pattern: revisit that decision, do not just update the expectation.
    it('is not taken as the handoff, so the text after it does not fire', () => {
      const tracker = new AgentOutputTracker();
      expect(feed(tracker, [POWERSHELL_PROMPT, '\x1b[H\x1b[J', 'AGENT READY', 'more agent text']))
        .toEqual([false, false, false, false]);
    });

    it('does fire when the same stream clears with erase-scrollback, so the miss is only the clear form', () => {
      const tracker = new AgentOutputTracker();
      expect(feed(tracker, [POWERSHELL_PROMPT, '\x1b[H\x1b[3J', 'AGENT READY']))
        .toEqual([false, false, true]);
    });
  });

  describe('the AGENT_READY_CEILING_MS bound', () => {
    // Date is faked along with the timers, which is what the tracker reads.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('never fires for a session whose first chunk is older than the ceiling, even on a full handoff after it', () => {
      vi.useFakeTimers();
      const tracker = new AgentOutputTracker();
      expect(tracker.consume('s1', POWERSHELL_PROMPT)).toBe(false);

      vi.advanceTimersByTime(AGENT_READY_CEILING_MS + 1);
      // Past the ceiling the overlay has lifted whatever the stream shows, so
      // the clear and the agent text that follow must not fire the latch.
      expect(tracker.consume('s1', CLEAR_HOST)).toBe(false);
      expect(tracker.consume('s1', 'AGENT READY')).toBe(false);
      expect(tracker.consume('s1', 'more agent text')).toBe(false);
    });

    it('measures the window from each session\'s own first chunk, and removeSession starts it over', () => {
      vi.useFakeTimers();
      const tracker = new AgentOutputTracker();
      expect(tracker.consume('s1', POWERSHELL_PROMPT)).toBe(false);

      vi.advanceTimersByTime(AGENT_READY_CEILING_MS + 1);
      // s1 is past its ceiling. s2 first spoke just now, so it is inside its own.
      expect(tracker.consume('s1', CLEAR_HOST + 'AGENT READY')).toBe(false);
      expect(tracker.consume('s2', POWERSHELL_PROMPT + CLEAR_HOST + 'AGENT READY')).toBe(true);

      // A dropped session forgets that it ran out, as it forgets that it fired.
      tracker.removeSession('s1');
      expect(tracker.consume('s1', POWERSHELL_PROMPT + CLEAR_HOST + 'AGENT READY')).toBe(true);
    });

    it('still fires for a session inside the window', () => {
      vi.useFakeTimers();
      const tracker = new AgentOutputTracker();
      expect(tracker.consume('s1', POWERSHELL_PROMPT)).toBe(false);

      vi.advanceTimersByTime(AGENT_READY_CEILING_MS - 1);
      expect(tracker.consume('s1', CLEAR_HOST)).toBe(false);
      expect(tracker.consume('s1', 'AGENT READY')).toBe(true);
    });
  });
});
