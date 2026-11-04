/**
 * Kimi Code CLI transcript cleanup for PTY output.
 *
 * The TUI's welcome box (`apps/kimi-code/src/tui/components/chrome/welcome.ts`,
 * Kimi Code CLI 2.4.1, read 2026-11-03) draws, inside a `╭─╮ │ ╰─╯` border:
 *
 *     "Welcome to Kimi Code!"
 *     "Send /help for help information."   (or "Run /login or /provider to get started.")
 *     "Directory: <workDir>"
 *     "Session:   <id>"
 *     "Model:     <alias>"                 (or "not set, run /login or /provider")
 *     "Version:   <version>"
 *     "MCP:       <summary>"
 *
 * and a resumable session's exit prints "To resume this session: kimi -r <id>"
 * (`run-shell.ts`). Built from the source; the TUI has not been captured.
 *
 * Strategy: strip the welcome box's lines and the resume hint, defer to the
 * shared border filter for the box-drawing characters, and let
 * `finalizeTranscript()` collapse blank runs. The conversation itself is kept
 * whole for handoff context.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const KIMI_NOISE_PATTERNS: RegExp[] = [
  // Welcome box
  /^Welcome to Kimi Code!?$/i,
  /^Send \/help for help information\.?$/i,
  /^Run \/login or \/provider to get started\.?$/i,
  /^Directory:\s/,
  /^Session:\s*\S*$/,
  /^Model:\s/,
  /^Version:\s+\d+\.\d+\.\d+\S*$/,
  /^MCP:\s/,
  // The startup notice of a session that has no message yet.
  /^No session yet\b/i,
  // Exit hint, shown when the session has content. The CLI prints both lines
  // with a leading space.
  /^\s*To resume this session:\s+kimi\s+-r\s+\S+$/i,
  /^\s*Bye!$/,
];

export function cleanKimiTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');
  const filtered = filterNoiseLines(lines, KIMI_NOISE_PATTERNS);
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  return finalizeTranscript(text);
}
