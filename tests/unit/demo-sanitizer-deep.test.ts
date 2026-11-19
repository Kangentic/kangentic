/**
 * sanitizeDeep (scripts/lib/demo-sanitizer.js) is the walk both transcript writers run before
 * the leak check: capture-agent-scrollback.js --transcript-out at record time, and
 * scripts/backfill-demo-transcripts.mjs for a recording already on disk. A transcript carries the
 * identity in tool inputs, tool results, and file paths the agent quotes, at any depth, so the
 * walk has to reach every string. The rewrite itself is buildSanitizer's and is driven by the
 * recording machine's own home and user name, so it is stood in for here by a fake that rewrites
 * one marker; what this pins is the walk.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

interface DistroIdentity {
  user: string;
  host: string;
  home: string;
  homeUnc: string;
  linuxCwd: string;
}

const require = createRequire(import.meta.url);
const { sanitizeDeep, stripAccountLinks, buildSanitizer } = require('../../scripts/lib/demo-sanitizer.js') as {
  sanitizeDeep: (value: unknown, sanitizer: { apply: (text: string) => string }) => unknown;
  stripAccountLinks: (text: string) => string;
  buildSanitizer: (options: { project: string; cwd: string; wsl?: DistroIdentity | null; demoPath?: string | null }) => { apply: (text: string) => string; assertClean: (text: string, label: string) => void };
};

describe('a capture in a WSL distro', () => {
  // A distro whose user and host are not the recording machine's, so what rewrites them is the
  // distro identity and not the Windows one.
  const identity: DistroIdentity = {
    user: 'someone',
    host: 'somebox',
    home: '/home/someone',
    homeUnc: '\\\\wsl.localhost\\Distro\\home\\someone',
    linuxCwd: '/home/someone/redis',
  };
  const sanitizer = buildSanitizer({ project: 'redis', cwd: '\\\\wsl.localhost\\Distro\\home\\someone\\redis', wsl: identity, demoPath: '/home/dev/redis' });

  it('turns the clone into the host folder and the distro into the sample host', () => {
    expect(sanitizer.apply('cd /home/someone/redis/.kangentic/worktrees/one; git log')).toBe('cd /home/dev/redis/.kangentic/worktrees/one; git log');
    expect(sanitizer.apply('someone@somebox:~/redis$ ls /home/someone/.claude')).toBe('dev@build-box:~/redis$ ls /home/dev/.claude');
    // A path the terminal wrapped mid-word is one path again.
    expect(sanitizer.apply('/home/some\x1b[1Cone/redis/src')).toBe('/home/dev/redis/src');
    expect(() => sanitizer.assertClean(sanitizer.apply('/home/someone/redis on somebox'), 'frame')).not.toThrow();
  });

  it('needs the host folder it stands for', () => {
    expect(() => buildSanitizer({ project: 'redis', cwd: '\\\\wsl.localhost\\Distro\\home\\someone\\redis', wsl: identity })).toThrow(/POSIX folder/);
  });

  it('refuses what says the recording was made in a distro on Windows', () => {
    expect(() => sanitizer.assertClean('PATH=/usr/bin:/mnt/c/Windows/system32', 'stream')).toThrow(/Windows drive mounted/);
    expect(() => sanitizer.assertClean('Linux 5.15.167.4-microsoft-standard-WSL2', 'stream')).toThrow(/Windows Subsystem for Linux/);
    expect(() => sanitizer.assertClean('running under WSL', 'stream')).toThrow(/Windows Subsystem for Linux/);
  });

  it('refuses an email address with the pattern the fixture scan uses, and keeps the host address', () => {
    expect(() => sanitizer.assertClean('Author: Some One <someone@mail.example.org>', 'changes')).toThrow(/an email address/);
    expect(() => sanitizer.assertClean('ssh dev@build-box', 'stream')).not.toThrow();
    expect(() => sanitizer.assertClean('Author: Dev <dev@example.com>', 'changes')).not.toThrow();
  });
});

describe('notices about the recording machine\'s install', () => {
  const sanitizer = buildSanitizer({ project: 'contoso-web', cwd: process.cwd() });

  it('refuses each one, also when a repaint split its words with cursor moves', () => {
    expect(() => sanitizer.assertClean('  Fable 5.2 is here for your longest tasks. Switch with /model.', 'stream')).toThrow(/model launch announcement/);
    expect(() => sanitizer.assertClean('✻install\x1b[1Cgh\x1b[1Cfor PR status', 'stream')).toThrow(/install the GitHub CLI/);
    expect(() => sanitizer.assertClean('Updated: 26 features, 422 fixes', 'stream')).toThrow(/update notice/);
    expect(() => sanitizer.assertClean('Update installed · Restart to update', 'stream')).toThrow(/update notice/);
  });

  it('leaves an ordinary session alone', () => {
    expect(() => sanitizer.assertClean('● Bash(gh pr view 42)\n  ⎿  Update the README', 'stream')).not.toThrow();
  });
});

describe('stripAccountLinks', () => {
  // Claude's footer as a recording carries it: "/rc" linked to the account's own session.
  const linked = (terminator: string): string => `\x1b]8;id=u-abc%123;https://claude.ai/code/session_01AbCdEf?from=cli${terminator}/rc\x1b]8;;${terminator}`;

  it('drops the session link\'s target and keeps the text in the same cells', () => {
    expect(stripAccountLinks(linked('\x1b\\'))).toBe('\x1b]8;;\x1b\\/rc\x1b]8;;\x1b\\');
    expect(stripAccountLinks(linked('\x07'))).toBe('\x1b]8;;\x07/rc\x1b]8;;\x07');
  });

  it('leaves every other link alone', () => {
    const docs = '\x1b]8;;https://docs.example.com/page\x1b\\docs\x1b]8;;\x1b\\';
    expect(stripAccountLinks(docs)).toBe(docs);
  });

  it('runs inside the capture\'s rewrite, and the leak check refuses a link that survived it', () => {
    const sanitizer = buildSanitizer({ project: 'contoso-web', cwd: process.cwd() });
    expect(sanitizer.apply(linked('\x1b\\'))).not.toContain('claude.ai/code/session_');
    expect(() => sanitizer.assertClean(linked('\x1b\\'), 'footer')).toThrow(/claude\.ai session/);
  });
});

const rewriter = { apply: (text: string) => text.replaceAll('MARKER', 'dev') };

describe('sanitizeDeep', () => {
  it('rewrites every string at any depth, keys included, and leaves other values alone', () => {
    const input = {
      kind: 'assistant',
      ts: 1234,
      done: true,
      nothing: null,
      blocks: [
        { type: 'text', text: 'read C:\\Users\\MARKER\\work\\contoso-web' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/Users/MARKER/work/x.ts', 'MARKER-key': ['MARKER', 7] } },
      ],
    };

    const output = sanitizeDeep(input, rewriter) as typeof input & { blocks: Array<{ input?: Record<string, unknown> }> };

    expect(output).toEqual({
      kind: 'assistant',
      ts: 1234,
      done: true,
      nothing: null,
      blocks: [
        { type: 'text', text: 'read C:\\Users\\dev\\work\\contoso-web' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/Users/dev/work/x.ts', 'dev-key': ['dev', 7] } },
      ],
    });
  });

  it('returns a copy rather than rewriting the input in place', () => {
    const input = { text: 'MARKER', nested: { text: 'MARKER' } };

    const output = sanitizeDeep(input, rewriter) as typeof input;

    expect(input.text).toBe('MARKER');
    expect(input.nested.text).toBe('MARKER');
    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(input.nested);
  });

  it('passes a bare string, array, or primitive through the same rewrite', () => {
    expect(sanitizeDeep('MARKER', rewriter)).toBe('dev');
    expect(sanitizeDeep(['MARKER', 1], rewriter)).toEqual(['dev', 1]);
    expect(sanitizeDeep(42, rewriter)).toBe(42);
    expect(sanitizeDeep(undefined, rewriter)).toBeUndefined();
  });
});
