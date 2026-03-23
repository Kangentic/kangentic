import { describe, it, expect } from 'vitest';
import { gitHubPRConnector } from '../../src/main/pty/github-pr-detector';
import { matchesPRCommand, detectPR } from '../../src/main/pty/pr-connectors';

describe('gitHubPRConnector.extract', () => {
  it('extracts PR URL from gh pr create bare output', () => {
    const scrollback = 'https://github.com/Kangentic/kangentic/pull/42\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/Kangentic/kangentic/pull/42', number: 42 });
  });

  it('extracts PR URL from gh pr create with status message prefix', () => {
    const scrollback = [
      'Creating pull request for feature-branch into main in Kangentic/kangentic',
      '',
      'https://github.com/Kangentic/kangentic/pull/99',
      '',
    ].join('\n');
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/Kangentic/kangentic/pull/99', number: 99 });
  });

  it('extracts PR URL from gh pr view TTY output with ANSI codes', () => {
    // Simulated muted color ANSI prefix/suffix around the line
    const scrollback = '\x1b[38;5;242mView this pull request on GitHub: https://github.com/owner/repo/pull/123\x1b[0m\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/123', number: 123 });
  });

  it('extracts PR URL from gh pr view non-TTY tab-separated output', () => {
    const scrollback = 'url:\thttps://github.com/owner/repo/pull/456\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/456', number: 456 });
  });

  it('extracts PR URL from gh pr view --json output', () => {
    const scrollback = '{"number":789,"url":"https://github.com/owner/repo/pull/789","state":"OPEN"}\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/789', number: 789 });
  });

  it('returns last match when multiple PR URLs appear in scrollback', () => {
    const scrollback = [
      'https://github.com/owner/repo/pull/10',
      'Some other output...',
      'https://github.com/owner/repo/pull/20',
    ].join('\n');
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/20', number: 20 });
  });

  it('does not match git push /pull/new/branch output', () => {
    const scrollback = [
      'remote:',
      'remote: Create a pull request for \'feature-branch\' on GitHub by visiting:',
      'remote:   https://github.com/owner/repo/pull/new/feature-branch',
      'remote:',
    ].join('\n');
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toBeNull();
  });

  it('does not match gh pr merge shorthand output', () => {
    const scrollback = 'Merged owner/repo#123 (fix: resolve login bug)\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toBeNull();
  });

  it('returns null for empty scrollback', () => {
    expect(gitHubPRConnector.extract('')).toBeNull();
  });

  it('returns null for scrollback with no PR URLs', () => {
    const scrollback = 'git status\nOn branch main\nnothing to commit, working tree clean\n';
    expect(gitHubPRConnector.extract(scrollback)).toBeNull();
  });

  it('handles heavy ANSI formatting around the URL', () => {
    const scrollback = [
      '\x1b[1m\x1b[32m✓\x1b[0m Created pull request',
      '\x1b[36m\x1b[4mhttps://github.com/org/project/pull/555\x1b[0m',
    ].join('\n');
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/org/project/pull/555', number: 555 });
  });

  it('strips OSC hyperlink sequences (Windows ConPTY)', () => {
    // OSC 8 hyperlink: ESC]8;;url BEL text ESC]8;; BEL
    const scrollback = '\x1b]8;;https://github.com/owner/repo/pull/321\x07https://github.com/owner/repo/pull/321\x1b]8;;\x07\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/321', number: 321 });
  });

  it('strips OSC sequences terminated by ESC backslash', () => {
    // Some terminals use ESC \ (ST) instead of BEL to end OSC
    const scrollback = '\x1b]8;;https://example.com\x1b\\https://github.com/owner/repo/pull/888\x1b]8;;\x1b\\\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/888', number: 888 });
  });

  it('only scans last 4KB of scrollback for performance', () => {
    // Old PR URL buried deep in scrollback (beyond 4KB window)
    const oldContent = 'https://github.com/owner/repo/pull/1\n' + 'x'.repeat(5000);
    const recentContent = '\nhttps://github.com/owner/repo/pull/999\n';
    const scrollback = oldContent + recentContent;
    const result = gitHubPRConnector.extract(scrollback);
    // Should find the recent one, not the old one (which is outside the 4KB window)
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/999', number: 999 });
  });

  it('handles URLs with org names containing hyphens and dots', () => {
    const scrollback = 'https://github.com/my-org.inc/my-repo.js/pull/7\n';
    const result = gitHubPRConnector.extract(scrollback);
    expect(result).toEqual({ url: 'https://github.com/my-org.inc/my-repo.js/pull/7', number: 7 });
  });
});

describe('gitHubPRConnector.matchesCommand', () => {
  it('matches gh pr create', () => {
    expect(gitHubPRConnector.matchesCommand('gh pr create --title "Fix bug" --body "desc"')).toBe(true);
  });

  it('matches gh pr view', () => {
    expect(gitHubPRConnector.matchesCommand('gh pr view 123')).toBe(true);
  });

  it('matches gh pr merge', () => {
    expect(gitHubPRConnector.matchesCommand('gh pr merge 123 --rebase --admin')).toBe(true);
  });

  it('does not match gh pr list', () => {
    expect(gitHubPRConnector.matchesCommand('gh pr list --state open')).toBe(false);
  });

  it('does not match git push', () => {
    expect(gitHubPRConnector.matchesCommand('git push origin HEAD:feature --force-with-lease')).toBe(false);
  });

  it('does not match unrelated commands', () => {
    expect(gitHubPRConnector.matchesCommand('npm run build')).toBe(false);
  });
});

describe('PR connector registry', () => {
  it('matchesPRCommand delegates to registered connectors', () => {
    expect(matchesPRCommand('gh pr create --title "test"')).toBe(true);
    expect(matchesPRCommand('npm run build')).toBe(false);
  });

  it('detectPR delegates to registered connectors', () => {
    const result = detectPR('https://github.com/owner/repo/pull/42\n');
    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/42', number: 42 });
  });

  it('detectPR returns null when no connector matches', () => {
    expect(detectPR('no PR URLs here')).toBeNull();
  });
});
