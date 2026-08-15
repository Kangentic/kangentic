/**
 * Unit tests for ensureCodexWorktreeTrust() -- pre-approves Codex's
 * per-directory trust in ~/.codex/config.toml.
 *
 * Why this has to exist at all, measured against codex-cli 0.141.0:
 * trust is keyed on the GIT REPO ROOT and is NOT inherited by nested
 * repositories, and every Kangentic task gets its own git worktree (which
 * is its own repo root). So accepting the prompt records only that one
 * worktree and the next task prompts again - there is no answer the user
 * can give once that carries forward. The per-invocation `-c` override
 * does not work either; trust is resolved before overrides apply.
 *
 * Mirrors tests/unit/gemini-trust-manager.test.ts, against Codex's TOML
 * shape rather than a JSON map.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.codex/* to a temp dir per test
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import {
  ensureCodexWorktreeTrust,
  removeCodexWorktreeTrust,
  readCodexTrustLevel,
} from '../../src/main/agent/adapters/codex';

function configPath(): string {
  return path.join(tmpHome, '.codex', 'config.toml');
}

function writeConfig(contents: string): void {
  fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
  fs.writeFileSync(configPath(), contents);
}

function readConfig(): string {
  return fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf-8') : '';
}

function trustOf(targetPath: string): string | null {
  return readCodexTrustLevel(readConfig().split('\n'), targetPath);
}

// Host-absolute so the resolver's absolutization matches the stored key on
// both Windows and Linux CI.
const PROJECT = path.resolve('/repo');
const WORKTREE = path.join(PROJECT, '.kangentic', 'worktrees', '7');

// codexHomeDir() reads $CODEX_HOME BEFORE falling back to os.homedir(), so
// mocking homedir alone does not sandbox a developer or runner that has the
// variable set - their real config.toml would be read and rewritten. Clear it
// for every test and restore it afterwards.
const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureCodexWorktreeTrust', () => {
  it('records trust_level = "trusted" for a new worktree', async () => {
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBe('trusted');
  });

  it('creates config.toml when the user has none', async () => {
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(fs.existsSync(configPath())).toBe(true);
  });

  it('preserves existing content, comments, and unrelated projects', async () => {
    writeConfig([
      '# my settings',
      'model = "gpt-5.5"',
      '',
      "[projects.'/other/project']",
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    await ensureCodexWorktreeTrust(WORKTREE);

    const written = readConfig();
    expect(written).toContain('# my settings');
    expect(written).toContain('model = "gpt-5.5"');
    expect(trustOf('/other/project')).toBe('trusted');
    expect(trustOf(WORKTREE)).toBe('trusted');
  });

  it('never overrides an explicit user decision', async () => {
    for (const level of ['untrusted', 'trusted']) {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
      writeConfig(`[projects.'${WORKTREE}']\ntrust_level = "${level}"\n`);
      await ensureCodexWorktreeTrust(WORKTREE);
      expect(trustOf(WORKTREE)).toBe(level);
      // And never writes a second table for the same path, which would
      // make config.toml unparsable for Codex itself.
      expect(readConfig().match(/\[projects\./g)).toHaveLength(1);
    }
  });

  it('respects a project-level deny for worktrees under it', async () => {
    writeConfig(`[projects.'${PROJECT}']\ntrust_level = "untrusted"\n`);
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBeNull();
  });

  it('still approves when the project root is trusted', async () => {
    writeConfig(`[projects.'${PROJECT}']\ntrust_level = "trusted"\n`);
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBe('trusted');
  });

  it('matches an existing entry stored in another path spelling', async () => {
    // Codex writes these interchangeably: single/double quotes, forward or
    // back slashes, and a \\?\ long-path prefix. A missed match would append
    // a duplicate table for the same directory.
    const forwardSlashed = WORKTREE.replace(/\\/g, '/');
    writeConfig(`[projects."${forwardSlashed}"]\ntrust_level = "untrusted"\n`);
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(readConfig().match(/\[projects\./g)).toHaveLength(1);
    expect(trustOf(WORKTREE)).toBe('untrusted');
  });

  it('is idempotent across repeated spawns', async () => {
    await ensureCodexWorktreeTrust(WORKTREE);
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(readConfig().match(/\[projects\./g)).toHaveLength(1);
  });

  it('appends cleanly to a file with no trailing newline', async () => {
    writeConfig('model = "gpt-5.5"');
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(readConfig()).not.toContain('model = "gpt-5.5"[projects');
    expect(trustOf(WORKTREE)).toBe('trusted');
  });

  it('approves a spawn directly in the project root', async () => {
    await ensureCodexWorktreeTrust(PROJECT);
    expect(trustOf(PROJECT)).toBe('trusted');
  });

  it('writes nothing for a path containing a single quote, rather than emitting an unparsable table', async () => {
    // trust-manager.ts's single-quoted TOML literal cannot represent an
    // embedded single quote (TOML 1.0 section 3.2 - no escaping inside a
    // literal string), and reserializing the user's file as a double-quoted
    // header just to fix this one path is not worth the risk. So the guard
    // skips the write entirely rather than emitting a header Codex itself
    // cannot parse. The failure mode being guarded against is worse than a
    // re-prompt: an unparsable config.toml, not merely a missed trust entry.
    // Mirrors the sibling emitHeaderValue guard already pinned as "Gap 1" in
    // codex-project-relocation.test.ts.
    const apostropheWorktree = path.join(PROJECT, '.kangentic', 'worktrees', "owner's-task");

    await expect(ensureCodexWorktreeTrust(apostropheWorktree)).resolves.toBeUndefined();

    expect(fs.existsSync(configPath())).toBe(false);
  });
});

describe('removeCodexWorktreeTrust', () => {
  // Trust is keyed per directory and cannot be inherited, so Kangentic writes
  // one entry per task worktree. Without removal on cleanup the file grows by
  // one dead table per task, forever - one machine had accumulated 473.
  it('drops the entry for a removed worktree', async () => {
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBe('trusted');

    await removeCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBeNull();
    expect(readConfig()).not.toContain('worktrees');
  });

  it('does not grow the file across repeated create/remove cycles', async () => {
    for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
      const worktree = path.join(PROJECT, '.kangentic', 'worktrees', String(taskIndex));
      await ensureCodexWorktreeTrust(worktree);
      await removeCodexWorktreeTrust(worktree);
    }
    expect(readConfig().match(/\[projects\./g) ?? []).toHaveLength(0);
    // And no blank-line drift accumulates from the repeated splices.
    expect(readConfig()).not.toMatch(/\n{3}/);
  });

  it('leaves other projects untouched', async () => {
    await ensureCodexWorktreeTrust(PROJECT);
    await ensureCodexWorktreeTrust(WORKTREE);
    await removeCodexWorktreeTrust(WORKTREE);
    expect(trustOf(PROJECT)).toBe('trusted');
    expect(trustOf(WORKTREE)).toBeNull();
  });

  it('preserves a table that carries more than trust_level', async () => {
    // Anything else in there came from the user or a future Codex.
    writeConfig(`[projects.'${WORKTREE}']\ntrust_level = "trusted"\nsome_future_key = 42\n`);
    await removeCodexWorktreeTrust(WORKTREE);
    expect(readConfig()).toContain('some_future_key = 42');
    expect(trustOf(WORKTREE)).toBe('trusted');
  });

  it('is a no-op when there is no config or no matching entry', async () => {
    await expect(removeCodexWorktreeTrust(WORKTREE)).resolves.toBeUndefined();
    writeConfig('model = "gpt-5.5"\n');
    await removeCodexWorktreeTrust(WORKTREE);
    expect(readConfig()).toContain('model = "gpt-5.5"');
  });
});

describe('CODEX_HOME', () => {
  // Kangentic must write trust to the same file Codex reads. Writing to
  // ~/.codex while Codex reads $CODEX_HOME leaves the user prompted on every
  // task with no indication why. It is also what keeps a test run from
  // appending to the developer's real config.
  const originalCodexHome = process.env.CODEX_HOME;
  let altHome: string;

  beforeEach(() => {
    altHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(altHome, { recursive: true, force: true });
  });

  it('writes into $CODEX_HOME when it is set', async () => {
    process.env.CODEX_HOME = altHome;
    await ensureCodexWorktreeTrust(WORKTREE);

    const relocated = path.join(altHome, 'config.toml');
    expect(fs.existsSync(relocated)).toBe(true);
    expect(readCodexTrustLevel(fs.readFileSync(relocated, 'utf-8').split('\n'), WORKTREE))
      .toBe('trusted');
    // ...and leaves the default location untouched.
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', async () => {
    process.env.CODEX_HOME = '   ';
    await ensureCodexWorktreeTrust(WORKTREE);
    expect(trustOf(WORKTREE)).toBe('trusted');
  });
});

describe('readCodexTrustLevel', () => {
  it('does not attribute a trust_level from a following table', async () => {
    const lines = [
      `[projects.'${PROJECT}']`,
      '',
      `[projects.'${WORKTREE}']`,
      'trust_level = "trusted"',
    ];
    expect(readCodexTrustLevel(lines, PROJECT)).toBeNull();
    expect(readCodexTrustLevel(lines, WORKTREE)).toBe('trusted');
  });

  it('stops scanning at a non-projects table header', async () => {
    const lines = [
      `[projects.'${PROJECT}']`,
      '',
      '[mcp_servers.kangentic]',
      'trust_level = "trusted"',
    ];
    expect(readCodexTrustLevel(lines, PROJECT)).toBeNull();
  });

  it('returns null for a path with no table', () => {
    expect(readCodexTrustLevel([], PROJECT)).toBeNull();
  });
});
