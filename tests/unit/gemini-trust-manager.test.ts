/**
 * Unit tests for ensureGeminiWorktreeTrust() -- pre-populates Gemini CLI's
 * entry in ~/.gemini/trustedFolders.json.
 *
 * This is load-bearing for MCP, not just prompt-skipping: measured against
 * gemini 0.54.4, an untrusted folder reports "MCP servers are configured but
 * disabled because this folder is untrusted" and suppresses user-level
 * servers too, so the mcpServers.kangentic entry the command builder writes
 * would be inert.
 *
 * Mirrors tests/unit/qwen-trust-manager.test.ts for the shared schema, with
 * two deliberate divergences covered below: no folderTrust.enabled gate, and
 * an ancestor check so one key per worktree does not accumulate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.gemini/* to a temp dir per test
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

import {
  ensureGeminiWorktreeTrust,
  removeGeminiWorktreeTrust,
  GeminiAdapter,
} from '../../src/main/agent/adapters/gemini';

function trustedFoldersPath(): string {
  return path.join(tmpHome, '.gemini', 'trustedFolders.json');
}

function readTrustedFolders(): Record<string, string> {
  return JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8'));
}

function writeTrustedFolders(contents: Record<string, string>): void {
  fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
  fs.writeFileSync(trustedFoldersPath(), JSON.stringify(contents));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureGeminiWorktreeTrust', () => {
  it('creates trustedFolders.json with TRUST_FOLDER for a new path', async () => {
    await ensureGeminiWorktreeTrust('/repo/.kangentic/worktrees/1');
    expect(Object.values(readTrustedFolders())).toEqual(['TRUST_FOLDER']);
  });

  it('writes without a security.folderTrust.enabled flag', async () => {
    // Divergence from Qwen: Gemini 0.54.4 enforces folder trust even when
    // that setting is absent, so gating on it would make MCP wiring inert.
    await ensureGeminiWorktreeTrust('/repo/worktree');
    expect(fs.existsSync(trustedFoldersPath())).toBe(true);
  });

  it('preserves unrelated existing entries', async () => {
    writeTrustedFolders({ '/other/project': 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust('/repo/worktree');
    expect(readTrustedFolders()['/other/project']).toBe('TRUST_FOLDER');
  });

  it('never overrides an explicit user decision', async () => {
    for (const level of ['DO_NOT_TRUST', 'TRUST_PARENT']) {
      writeTrustedFolders({ '/repo/worktree': level });
      await ensureGeminiWorktreeTrust('/repo/worktree');
      expect(readTrustedFolders()['/repo/worktree']).toBe(level);
    }
  });

  // Ancestor cases use host-absolute paths: the resolver absolutizes its
  // argument, so a bare POSIX literal would become "C:/repo" on Windows and
  // stop matching a stored "/repo" key, passing on Linux CI only.
  const REPO = path.resolve('/repo');

  it('writes nothing when an ancestor is already trusted', async () => {
    // Kangentic creates a worktree per task; without this the user's home
    // config would gain one key per task forever.
    writeTrustedFolders({ [REPO]: 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust(path.join(REPO, '.kangentic', 'worktrees', '42'));
    expect(Object.keys(readTrustedFolders())).toEqual([REPO]);
  });

  it('matches an ancestor stored with different separators', async () => {
    // Gemini stores keys in mixed styles: native backslashes from one code
    // path, forward slashes from another. Separator style must never decide
    // whether the ancestor matches, on any platform.
    writeTrustedFolders({ [REPO.replace(/\\/g, '/')]: 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust(path.join(REPO, 'worktrees', '7'));
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);
  });

  it('folds case only where the filesystem does', async () => {
    // Windows paths are case-insensitive, POSIX paths are not: /repo and
    // /REPO are the same directory on Windows and two different ones on
    // Linux, so an unconditional fold would skip the write for a worktree
    // that is genuinely untrusted - leaving Gemini's MCP servers disabled,
    // which is the whole reason this module exists. Same win32 gate as
    // codex/config-toml.ts's normalizeForCompare.
    writeTrustedFolders({ [REPO.toUpperCase()]: 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust(path.join(REPO, 'worktrees', '7'));
    expect(Object.keys(readTrustedFolders()))
      .toHaveLength(process.platform === 'win32' ? 1 : 2);
  });

  it('does not treat a sibling with a shared prefix as an ancestor', async () => {
    writeTrustedFolders({ [REPO]: 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust(path.join(`${REPO}-backup`, 'worktree'));
    expect(Object.keys(readTrustedFolders())).toHaveLength(2);
  });

  it('respects a project-level deny for worktrees under it', async () => {
    // A DO_NOT_TRUST parent is the user's explicit decision. Kangentic must
    // not route around it by trusting a worktree it created underneath.
    // Mirrors the Codex sibling's "respects a project-level deny" case.
    writeTrustedFolders({ [REPO]: 'DO_NOT_TRUST' });
    await ensureGeminiWorktreeTrust(path.join(REPO, 'worktree'));
    expect(Object.keys(readTrustedFolders())).toEqual([REPO]);
  });

  it('still trusts a sibling of a denied directory', async () => {
    // The deny covers only its own subtree, not a path that merely shares a
    // prefix - the same boundary rule the trusted-ancestor check uses.
    writeTrustedFolders({ [REPO]: 'DO_NOT_TRUST' });
    await ensureGeminiWorktreeTrust(path.join(`${REPO}-other`, 'worktree'));
    expect(Object.keys(readTrustedFolders())).toHaveLength(2);
  });

  it('is idempotent across repeated spawns', async () => {
    await ensureGeminiWorktreeTrust('/repo/worktree');
    await ensureGeminiWorktreeTrust('/repo/worktree');
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);
  });

  it('recovers from a corrupt trustedFolders.json', async () => {
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), 'not json at all');
    await ensureGeminiWorktreeTrust('/repo/worktree');
    expect(Object.values(readTrustedFolders())).toEqual(['TRUST_FOLDER']);
  });
});

describe('GeminiAdapter.ensureTrust', () => {
  // GeminiAdapter.ensureTrust used to be documented as a no-op ("Gemini CLI
  // does not have a trust/directory-approval system"). This diff makes it a
  // real delegate to ensureGeminiWorktreeTrust, above. The describe block
  // above tests that function directly; this proves the ADAPTER method is
  // actually wired to it - CodexAdapter got the equivalent assertion in
  // codex-adapter.test.ts's "records directory trust..." test, and nothing
  // else in the suite calls GeminiAdapter.ensureTrust at all.
  //
  // Reuses this file's top-level os.homedir() mock and tmpHome sandbox
  // (beforeEach/afterEach above) rather than adding a new one: Gemini's
  // trust-manager has no CODEX_HOME-style env override, so writing this test
  // anywhere without that mock would pollute the developer's real
  // ~/.gemini/trustedFolders.json.
  it('delegates to ensureGeminiWorktreeTrust so a spawn does not stop on the trust prompt', async () => {
    const adapter = new GeminiAdapter();
    const worktree = path.join(tmpHome, 'project', '.kangentic', 'worktrees', '1');

    await expect(adapter.ensureTrust(worktree)).resolves.toBeUndefined();

    const resolvedWorktree = path.resolve(worktree).replace(/\\/g, '/');
    expect(Object.keys(readTrustedFolders())).toEqual([resolvedWorktree]);
    expect(readTrustedFolders()[resolvedWorktree]).toBe('TRUST_FOLDER');
  });
});

describe('removeGeminiWorktreeTrust', () => {
  // When no ancestor is already trusted, ensureTrust writes one key per task
  // worktree. Without removal on cleanup the file grows by a dead entry per
  // task forever - the same accumulation that reached 473 entries in Codex's
  // config.toml before its equivalent cleanup existed.
  const WORKTREE = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', '3');

  it('drops the entry for a removed worktree', async () => {
    await ensureGeminiWorktreeTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);

    await removeGeminiWorktreeTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('does not grow the file across repeated create/remove cycles', async () => {
    for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
      const worktree = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', String(taskIndex));
      await ensureGeminiWorktreeTrust(worktree);
      await removeGeminiWorktreeTrust(worktree);
    }
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('leaves other projects untouched', async () => {
    writeTrustedFolders({ '/other/project': 'TRUST_FOLDER' });
    await ensureGeminiWorktreeTrust(WORKTREE);
    await removeGeminiWorktreeTrust(WORKTREE);
    expect(readTrustedFolders()['/other/project']).toBe('TRUST_FOLDER');
  });

  it('never removes a user decision', async () => {
    // TRUST_PARENT / DO_NOT_TRUST are the user's, not ours: a later worktree
    // at the same path must still honor them.
    for (const level of ['TRUST_PARENT', 'DO_NOT_TRUST']) {
      writeTrustedFolders({ [WORKTREE]: level });
      await removeGeminiWorktreeTrust(WORKTREE);
      expect(readTrustedFolders()[WORKTREE]).toBe(level);
    }
  });

  it('is a no-op when there is no file or no matching entry', async () => {
    await expect(removeGeminiWorktreeTrust(WORKTREE)).resolves.toBeUndefined();
    writeTrustedFolders({ '/other/project': 'TRUST_FOLDER' });
    await removeGeminiWorktreeTrust(WORKTREE);
    expect(readTrustedFolders()['/other/project']).toBe('TRUST_FOLDER');
  });

  it('is wired to the adapter via onWorktreeRemoved', async () => {
    const adapter = new GeminiAdapter();
    await ensureGeminiWorktreeTrust(WORKTREE);
    await adapter.onWorktreeRemoved(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });
});
