/**
 * Every session kill in main announces what happened next
 * (see .claude/rules/session-replica-contract.md).
 *
 * The renderer's SESSION_EXIT handler ignores an intentional exit, because it
 * cannot tell a suspend from a hard end without racing the suspended status
 * push. So a bare `sessionManager.kill()` fixes main and the DB while the
 * renderer's replica stays at 'running': the card keeps its spinner and the
 * bottom panel its tab. Measured live on 2026-08-17 (4 agents counted, 3 tabs
 * kept, DB said exited) and again as the cleanup_worktree transition action
 * on 2026-09-16. Every kill must therefore be followed by the push that says
 * what happened: a `remove()` / `removeByTaskId()` (session-removed), a
 * `suspend()` (suspended status), `announceSessionEnded()` (the resolved
 * status for a row the caller keeps), a cleanup helper that removes, or an
 * inline 'session-changed' / 'session-removed' emit.
 *
 * This is a line-order scan, like spawn-entry-point-parity.test.ts: for each
 * kill call site under src/main it looks for a follow-up within the next
 * WINDOW_LINES of the same file. A site with a reason not to follow up is
 * allowlisted here BY ITS OWN LINE, with that reason, so a new bare kill
 * cannot ship without a deliberate decision. Control flow is not proven
 * (that is what the behavior tests for each site are for); what this makes
 * unmergeable is a kill with nothing after it at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_DIR = path.join(REPO_ROOT, 'src/main');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const WINDOW_LINES = 40;

/** A kill of ONE session or one task's sessions. `killAll` is the quit path. */
const KILL_CALL = /\b(?:sessionManager|this)\.(?:kill|killByTaskId)\(/;

/** What counts as telling the renderer what happened after a kill. */
const FOLLOW_UP = /\.(?:remove|removeByTaskId|suspend|announceSessionEnded)\(|cleanupTaskResources\(|cleanupTaskSession\(|emit\('session-(?:changed|removed)'/;

interface AllowlistedKill {
  file: string;
  /** A substring of the kill line itself, so the entry cannot cover a neighbour. */
  lineIncludes: string;
  reason: string;
}

const ALLOWLIST: AllowlistedKill[] = [
  {
    file: 'src/main/ipc/handlers/sessions.ts',
    lineIncludes: 'context.sessionManager.kill(id)',
    reason: 'SESSION_KILL is renderer-initiated: the store\'s killSession marks the row exited itself before the invoke resolves',
  },
  {
    file: 'src/main/pty/session-manager.ts',
    lineIncludes: 'for (const session of this.registry.listByTaskId(taskId)) this.kill(session.id);',
    reason: 'killByTaskId is a fan-out helper; every caller of it is classified by this scan',
  },
  {
    file: 'src/main/ipc/handlers/project-relocate.ts',
    lineIncludes: 'context.sessionManager.kill(session.id);',
    reason: 'transient Command Terminal kills during a relocate; the relocate reopens the project, whose cold-path syncSessions re-lists every row',
  },
];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

interface KillSite {
  relativePath: string;
  line: number;
  text: string;
  followedUp: boolean;
}

function collectKillSites(): KillSite[] {
  const sites: KillSite[] = [];
  for (const filePath of collectSourceFiles(MAIN_DIR)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line) || !KILL_CALL.test(line)) return;
      const window = lines.slice(index + 1, index + 1 + WINDOW_LINES).filter((candidate) => !isCommentLine(candidate));
      sites.push({
        relativePath,
        line: index + 1,
        text: line.trim(),
        followedUp: window.some((candidate) => FOLLOW_UP.test(candidate)),
      });
    });
  }
  return sites;
}

function allowlistEntryFor(site: KillSite): AllowlistedKill | undefined {
  return ALLOWLIST.find((entry) => entry.file === site.relativePath && site.text.includes(entry.lineIncludes));
}

describe('every session kill in main announces what happened next', () => {
  const sites = collectKillSites();

  it('finds the kill sites it exists to classify (the scan is not vacuous)', () => {
    // task-cleanup, transition-engine, mcp-project-context, transient-sessions,
    // task-move, sessions (x2), projects, project-relocate, and the three
    // inside session-manager itself.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it('every kill site is followed by a removal, suspend, announcement, or cleanup helper, or is allowlisted with a reason', () => {
    const bare = sites
      .filter((site) => !site.followedUp && !allowlistEntryFor(site))
      .map((site) => `${site.relativePath}:${site.line}  ${site.text}`);
    expect(
      bare,
      'A kill with nothing after it leaves the renderer at "running" for a session main knows is '
      + 'finished. Follow it with remove() / suspend() / announceSessionEnded(), or allowlist the '
      + 'line here with the reason the renderer converges anyway.',
    ).toEqual([]);
  });

  it('every allowlist entry still matches a real kill site (no stale exemptions)', () => {
    const stale = ALLOWLIST.filter((entry) => !sites.some((site) => allowlistEntryFor(site) === entry));
    expect(stale.map((entry) => `${entry.file}: ${entry.lineIncludes}`)).toEqual([]);
  });

  it('the announcement the cleanup_worktree action relies on exists and emits a status', () => {
    const source = fs.readFileSync(path.join(MAIN_DIR, 'pty/session-manager.ts'), 'utf-8');
    const start = source.indexOf('announceSessionEnded(sessionId: string): void {');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, start + 800)).toContain("this.emit('session-changed', sessionId, toSession(session))");
  });
});
