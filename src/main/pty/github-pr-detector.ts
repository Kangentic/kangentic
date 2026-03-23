/**
 * GitHub PR connector - detects PR URLs from gh CLI terminal output.
 *
 * Captures from:
 * - `gh pr create` stdout: bare URL on a line
 * - `gh pr view` TTY mode: "View this pull request on GitHub: <url>"
 * - `gh pr view` non-TTY: "url:\t<url>"
 * - `gh pr view --json` output containing URL in JSON value
 *
 * Does NOT match:
 * - `git push` output: /pull/new/branch-name (no numeric ID)
 * - `gh pr merge` output: owner/repo#123 (no full URL)
 */

import type { PRConnector, DetectedPR } from './pr-connectors';

/**
 * Strip all common terminal escape sequences:
 * - CSI sequences: ESC [ ... letter  (colors, cursor, etc.)
 * - OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \  (hyperlinks, title)
 * - Two-byte sequences: ESC + single char  (e.g. ESC M reverse index)
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;
const GITHUB_PR_URL_PATTERN = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g;

/** Maximum bytes to scan from the end of scrollback for performance. */
const SCAN_WINDOW = 4096;

export const gitHubPRConnector: PRConnector = {
  name: 'GitHub',

  matchesCommand(commandDetail: string): boolean {
    return /^gh\s+pr\s+(create|view|merge)/.test(commandDetail);
  },

  extract(scrollback: string): DetectedPR | null {
    if (!scrollback) return null;

    // Only scan the tail of the scrollback for performance
    const tail = scrollback.length > SCAN_WINDOW
      ? scrollback.slice(-SCAN_WINDOW)
      : scrollback;

    // Strip ANSI escape sequences so color codes don't break matching
    const clean = tail.replace(ANSI_ESCAPE_PATTERN, '');

    // Find all matches and return the last one (most recent)
    let lastMatch: DetectedPR | null = null;
    let match: RegExpExecArray | null;

    GITHUB_PR_URL_PATTERN.lastIndex = 0;
    while ((match = GITHUB_PR_URL_PATTERN.exec(clean)) !== null) {
      lastMatch = {
        url: match[0],
        number: parseInt(match[1], 10),
      };
    }

    return lastMatch;
  },
};
