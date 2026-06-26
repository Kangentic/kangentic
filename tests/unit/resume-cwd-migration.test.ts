/**
 * Unit tests for migrateResumeCwdIfRenamed()
 * (src/main/transition-engine/resume-cwd-migration.ts).
 *
 * When a task's branch is renamed, its worktree directory is recreated at a new
 * path and the re-spawned agent runs with the new cwd. cwd-keyed agents key their
 * conversation history to the cwd (Claude:
 * ~/.claude/projects/<slug(cwd)>/<id>.jsonl), so `--resume <id>` from the new cwd
 * finds nothing. This helper migrates the history to the new cwd's slug before the
 * resume command is built, reusing the adapter's onProjectRelocated hook.
 *
 * Real temp files with os.homedir() mocked to a temp directory (same pattern as
 * claude-project-relocation.test.ts). Generic fixture paths only, derived from the
 * OS temp dir so every write stays inside the sandbox on all platforms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateResumeCwdIfRenamed } from '../../src/main/transition-engine/resume-cwd-migration';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const AGENT_SESSION_ID = '5d522da8-2db0-401e-ac33-c8b9e08ad281';

let tmpProjectsParent: string;
let projectPath: string;
let oldWorktree: string;
let newWorktree: string;

function projectsRoot(): string {
  return path.join(tmpHome, '.claude', 'projects');
}

function transcriptDir(cwd: string): string {
  return path.join(projectsRoot(), claudeProjectSlug(path.resolve(cwd)));
}

function seedTranscript(cwd: string, content: string): void {
  const dir = transcriptDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${AGENT_SESSION_ID}.jsonl`), content, 'utf-8');
}

/** Minimal AgentAdapter with just the two methods the helper calls. */
function spyAdapter(overrides: {
  locate?: string | null;
  onRelocated?: () => Promise<void>;
}): { adapter: AgentAdapter; locateSpy: ReturnType<typeof vi.fn>; relocateSpy: ReturnType<typeof vi.fn> } {
  const locateSpy = vi.fn().mockResolvedValue(overrides.locate ?? null);
  const relocateSpy = vi.fn(overrides.onRelocated ?? (async () => {}));
  const adapter = {
    locateSessionHistoryFile: locateSpy,
    onProjectRelocated: relocateSpy,
  } as unknown as AgentAdapter;
  return { adapter, locateSpy, relocateSpy };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-migrate-home-'));
  tmpProjectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-migrate-proj-'));
  projectPath = path.join(tmpProjectsParent, 'my-app');
  oldWorktree = path.join(projectPath, '.kangentic', 'worktrees', 'code-review-750-6eb72164');
  newWorktree = path.join(projectPath, '.kangentic', 'worktrees', 'fix-blog-post-date-6eb72164');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsParent, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migrateResumeCwdIfRenamed - real Claude adapter', () => {
  it('migrates the transcript to the new worktree slug so resume becomes reachable', async () => {
    const adapter = new ClaudeAdapter();
    seedTranscript(oldWorktree, '{"type":"user"}\n{"type":"assistant"}\n');

    // Red: not reachable from the renamed worktree before migration.
    expect(await adapter.locateSessionHistoryFile(AGENT_SESSION_ID, newWorktree)).toBeNull();

    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: oldWorktree,
      newCwd: newWorktree,
      projectPath,
    });

    // Green: history moved under slug(newWorktree) and is now reachable.
    const reachable = await adapter.locateSessionHistoryFile(AGENT_SESSION_ID, newWorktree);
    expect(reachable).not.toBeNull();
    expect(fs.readFileSync(reachable!, 'utf-8')).toContain('assistant');
    expect(fs.existsSync(transcriptDir(oldWorktree))).toBe(false);
  });
});

describe('migrateResumeCwdIfRenamed - guards', () => {
  it('SKIPS migration when oldCwd is the shared project root (not a dedicated worktree)', async () => {
    // The enable-worktree flow resumes a session whose oldCwd is the project root.
    // Relocating that would move the whole shared transcript dir; the guard prevents it.
    const { adapter, relocateSpy } = spyAdapter({ locate: null });
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: projectPath,
      newCwd: newWorktree,
      projectPath,
    });
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('no-ops when the history is already reachable from the new cwd (id-keyed agents)', async () => {
    // id-keyed agents (Codex/OpenCode) locate the file regardless of cwd.
    const { adapter, relocateSpy } = spyAdapter({ locate: '/somewhere/session.jsonl' });
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: oldWorktree,
      newCwd: newWorktree,
      projectPath,
    });
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('early-returns when the cwd did not change (the #255 E2E resume specs path)', async () => {
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: newWorktree,
      newCwd: newWorktree,
      projectPath,
    });
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when not resuming', async () => {
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: false,
      oldCwd: oldWorktree,
      newCwd: newWorktree,
      projectPath,
    });
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when there is no resumeFromCwd', async () => {
    const { adapter, relocateSpy } = spyAdapter({ locate: null });
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: null,
      newCwd: newWorktree,
      projectPath,
    });
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when projectPath is null (guard: path.resolve(projectPath) is outside try/catch)', async () => {
    // Without the !projectPath guard, path.resolve(null) would throw TypeError
    // at the isDedicatedWorktree check, which sits OUTSIDE the try/catch. That
    // error would escape into the spawn path and break the task-move. This test
    // pins that the function returns silently when projectPath is absent.
    //
    // Red: remove `!projectPath ||` from the guard in resume-cwd-migration.ts
    //      -> path.resolve(null) throws TypeError, test fails with propagated error.
    // Green: guard present -> early return, no adapter calls, resolves undefined.
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    await expect(
      migrateResumeCwdIfRenamed({
        adapter,
        agentSessionId: AGENT_SESSION_ID,
        canResume: true,
        oldCwd: oldWorktree,
        newCwd: newWorktree,
        projectPath: null,
      }),
    ).resolves.toBeUndefined();
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('is fault-tolerant: a failing onProjectRelocated does not throw into the spawn', async () => {
    const { adapter, relocateSpy } = spyAdapter({
      locate: null,
      onRelocated: async () => { throw new Error('migration exploded'); },
    });
    await expect(
      migrateResumeCwdIfRenamed({
        adapter,
        agentSessionId: AGENT_SESSION_ID,
        canResume: true,
        oldCwd: oldWorktree,
        newCwd: newWorktree,
        projectPath,
      }),
    ).resolves.toBeUndefined();
    expect(relocateSpy).toHaveBeenCalledTimes(1);
  });

  it('is fault-tolerant: a throwing locateSessionHistoryFile does not escape into the spawn', async () => {
    // The documented contract is "on any failure, return silently". A future
    // adapter whose locator throws (not returns null) must not crash the spawn,
    // and a failed reachability check must not trigger a blind relocation.
    const locateSpy = vi.fn().mockRejectedValue(new Error('locate exploded'));
    const relocateSpy = vi.fn(async () => {});
    const adapter = {
      locateSessionHistoryFile: locateSpy,
      onProjectRelocated: relocateSpy,
    } as unknown as AgentAdapter;
    await expect(
      migrateResumeCwdIfRenamed({
        adapter,
        agentSessionId: AGENT_SESSION_ID,
        canResume: true,
        oldCwd: oldWorktree,
        newCwd: newWorktree,
        projectPath,
      }),
    ).resolves.toBeUndefined();
    expect(locateSpy).toHaveBeenCalledTimes(1);
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('SKIPS migration when oldCwd is exactly the worktrees root', async () => {
    // relative(worktreesRoot, worktreesRoot) === '' -> not a dedicated worktree.
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    const worktreesRoot = path.join(projectPath, '.kangentic', 'worktrees');
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: worktreesRoot,
      newCwd: newWorktree,
      projectPath,
    });
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('SKIPS migration when oldCwd is a sibling-prefix of the worktrees root', async () => {
    // `.kangentic/worktrees-evil/x` shares a string prefix but is not under the
    // worktrees root; path.relative yields a `..`-leading result.
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    const siblingPrefix = path.join(projectPath, '.kangentic', 'worktrees-evil', 'x');
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: siblingPrefix,
      newCwd: newWorktree,
      projectPath,
    });
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });

  it('SKIPS migration when oldCwd is a sub-directory inside a worktree (not the worktree root)', async () => {
    // A nested cwd's slug differs from the worktree root's, so migrating it would
    // orphan the real transcript. The single-segment guard rejects it.
    const { adapter, locateSpy, relocateSpy } = spyAdapter({ locate: null });
    const nestedSubdir = path.join(oldWorktree, 'src', 'main');
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId: AGENT_SESSION_ID,
      canResume: true,
      oldCwd: nestedSubdir,
      newCwd: newWorktree,
      projectPath,
    });
    expect(locateSpy).not.toHaveBeenCalled();
    expect(relocateSpy).not.toHaveBeenCalled();
  });
});
