/**
 * Static backstop for .claude/rules/pty-teardown-grace.md.
 *
 * A session PTY is force-killed only through SessionManager.kill() /
 * suspend() / killAll() or the DeferredKillRegistry, so a young agent always
 * gets its exit sequence and the grace before the kill lands (Claude Code's
 * fullscreen boot canary counts a pid killed inside its boot window as a
 * strike). Every ~/.claude.json writer in the Claude adapter goes through
 * withClaudeJsonLock, which takes the CLI's own lock file. Both are things a
 * new call site would silently opt out of, so this scan fails the build on one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_ROOT = path.resolve(__dirname, '../../src/main');
const CLAUDE_ADAPTER_ROOT = path.join(MAIN_ROOT, 'agent', 'adapters', 'claude');

/**
 * Files allowed to kill a PTY directly, and why. Every entry must still exist,
 * so a rename cannot leave a dead allowance behind.
 */
const DIRECT_KILL_ALLOWLIST: Record<string, string> = {
  'pty/lifecycle/pty-kill.ts': 'safeKillPty itself',
  'pty/lifecycle/deferred-kill.ts': 'the registry that owns the deferred force-kill',
  'pty/session-manager.ts': 'kill(): the mature path and the killPty dependency',
  'pty/shutdown/session-suspend.ts': 'gracefulPtyShutdown: exit sequence, grace, then kill',
  'pty/shutdown/session-shutdown.ts': 'killAllSessions: the synchronous quit path',
  'pty/lifecycle/session-spawn-flow.ts': 'the respawn sibling drain, which only ever finds an already-nulled pty',
  'agent/adapters/claude/model-picker-probe.ts': 'the probe PTY: classic renderer, /exit, then the fallback kill',
  'agent/adapters/antigravity/print-runner.ts': 'a print-mode run of a different agent, no boot canary',
};

function walkTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function relativeToMain(filePath: string): string {
  return path.relative(MAIN_ROOT, filePath).split(path.sep).join('/');
}

describe('pty-teardown-grace: every session PTY kill goes through the teardown modules', () => {
  const files = walkTypeScriptFiles(MAIN_ROOT);

  it('every allowlisted file still exists', () => {
    for (const relativePath of Object.keys(DIRECT_KILL_ALLOWLIST)) {
      expect(fs.existsSync(path.join(MAIN_ROOT, relativePath)), `${relativePath} is allowlisted but gone`).toBe(true);
    }
  });

  it('no file outside the allowlist calls safeKillPty()', () => {
    const offenders = files
      .filter((filePath) => !(relativeToMain(filePath) in DIRECT_KILL_ALLOWLIST))
      .filter((filePath) => /\bsafeKillPty\(/u.test(fs.readFileSync(filePath, 'utf-8')))
      .map(relativeToMain);
    expect(
      offenders,
      'a direct safeKillPty() skips the exit sequence and the grace a young agent needs; route the teardown through SessionManager.kill() (see .claude/rules/pty-teardown-grace.md)',
    ).toEqual([]);
  });

  it('no file outside the allowlist that imports node-pty calls .kill()', () => {
    const offenders = files
      .filter((filePath) => !(relativeToMain(filePath) in DIRECT_KILL_ALLOWLIST))
      .filter((filePath) => {
        const source = fs.readFileSync(filePath, 'utf-8');
        return source.includes("'node-pty'") && /\.kill\(\)/u.test(source);
      })
      .map(relativeToMain);
    expect(
      offenders,
      'a bare pty.kill() gives the agent ~100 ms; route the teardown through SessionManager.kill() or the DeferredKillRegistry (see .claude/rules/pty-teardown-grace.md)',
    ).toEqual([]);
  });
});

describe('pty-teardown-grace: every ~/.claude.json writer takes Claude\'s lock', () => {
  it('a Claude adapter file that writes ~/.claude.json goes through withClaudeJsonLock', () => {
    const offenders = walkTypeScriptFiles(CLAUDE_ADAPTER_ROOT)
      .filter((filePath) => {
        const source = fs.readFileSync(filePath, 'utf-8');
        const writesClaudeJson = source.includes("'.claude.json'")
          && (source.includes('writeFileSync(') || source.includes('atomicWriteFileWithBackup('));
        return writesClaudeJson && !source.includes('withClaudeJsonLock(');
      })
      .map(relativeToMain);
    expect(
      offenders,
      'a ~/.claude.json read-modify-write outside withClaudeJsonLock can straddle the CLI\'s locked withdrawal of its boot canary and resurrect the record',
    ).toEqual([]);
  });

  it('the lock module takes the CLI\'s own lock directory, not just the in-process chain', () => {
    const source = fs.readFileSync(path.join(CLAUDE_ADAPTER_ROOT, 'claude-json-lock.ts'), 'utf-8');
    expect(source).toContain("`${claudeJsonPath()}.lock`");
    expect(source).toContain('fs.mkdirSync(lockPath)');
  });
});
