/**
 * How Kangentic asks Claude Code to exit (claude-adapter.ts).
 *
 * Measured with scripts/probe-claude-exit-paths.js (task #854): `\x03` +
 * `/exit\r` sent to a turn still thinking put the prompt back with `/exit`
 * appended and submitted it as a second turn, and sent to an open permission
 * prompt it approved the tool. On Windows the console close is Claude's
 * graceful exit in every state, and so is the hangup on Linux
 * (scripts/probe-claude-exit-paths-linux.py), so a kill, a suspend and a quit
 * close it and type nothing. The typed sequence is left for a console that
 * cannot be closed (a Windows shell that died on its own) and for macOS, which
 * is not measured, and it starts with Esc and a pause so it never reads as an
 * interrupt that restores the prompt.
 */
import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

describe('ClaudeAdapter exit behavior', () => {
  const adapter = new ClaudeAdapter();

  it('treats the close as the graceful exit where it was measured: Windows and Linux, not macOS', () => {
    expect(adapter.consoleCloseIsGraceful('win32')).toBe(true);
    expect(adapter.consoleCloseIsGraceful('linux')).toBe(true);
    expect(adapter.consoleCloseIsGraceful('darwin')).toBe(false);
  });

  it('types Esc, a pause, Ctrl+C and /exit, never Ctrl+C first', () => {
    const steps = adapter.getExitSequence();
    expect(steps).toEqual(['\x1b', { delayMs: 400 }, '\x03', '/exit\r']);
    // Esc and the keys after it must not share a burst: the TUI would read
    // them as one escape-prefixed key and the text would never arrive.
    expect(typeof steps[1]).toBe('object');
  });
});
