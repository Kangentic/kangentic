/**
 * Removing a worktree's trust entry, for every adapter that writes one.
 *
 * Gemini, Qwen and Codex each pre-approve a worktree in their CLI's own trust
 * file when a task spawns, and each drops that entry when the worktree is
 * removed. Without the removal the file gains a dead entry per task, forever
 * (473 of them reached one machine's Codex config before it existed). The
 * contract is the same for all three, only the file differs, so the shared
 * scenarios are one table here:
 *
 *   - the entry Kangentic wrote goes away,
 *   - 25 create/remove cycles leave the file where it started,
 *   - another project's entry is untouched,
 *   - an entry the USER decided (TRUST_PARENT, DO_NOT_TRUST) is never removed,
 *   - nothing to remove (no file, no matching entry) is a quiet no-op.
 *
 * The ensure side, Qwen's lock and folderTrust gates, Codex's TOML handling and
 * each adapter's path matching stay in that adapter's own trust test file.
 *
 * Codex's user decision is `trust_level = "untrusted"`. It also keeps a table that
 * carries other keys (codex-trust-manager.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Redirect ~/.gemini, ~/.qwen and ~/.codex into a temp dir per test.
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { ensureGeminiWorktreeTrust, removeGeminiWorktreeTrust } from '../../src/main/agent/adapters/gemini';
import { ensureQwenWorktreeTrust, removeQwenWorktreeTrust } from '../../src/main/agent/adapters/qwen-code';
import { ensureCodexWorktreeTrust, removeCodexWorktreeTrust } from '../../src/main/agent/adapters/codex';

// Host-absolute so each adapter's path resolution matches on Windows and Linux.
const WORKTREE = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', '3');
const OTHER_PROJECT = path.resolve('/other/project');

interface TrustRemovalRow {
  adapter: string;
  /** Anything the CLI needs before its ensure writes (Qwen only writes with folderTrust on). */
  prepare(): void;
  ensure(worktree: string): Promise<void>;
  remove(worktree: string): Promise<void>;
  /** Entries in the trust file, 0 when there is no file. */
  entryCount(): number;
  seedOtherProject(): void;
  otherProjectSurvives(): boolean;
  /** Trust levels a user could have written for the worktree. */
  userDecisions: string[];
  seedUserDecision(worktree: string, decision: string): void;
  userDecisionSurvives(worktree: string, decision: string): boolean;
}

function jsonTrustRow(options: {
  adapter: string;
  directory: string;
  prepare(): void;
  ensure(worktree: string): Promise<void>;
  remove(worktree: string): Promise<void>;
}): TrustRemovalRow {
  const trustedFoldersPath = (): string => path.join(tmpHome, options.directory, 'trustedFolders.json');
  const read = (): Record<string, string> => (
    fs.existsSync(trustedFoldersPath()) ? JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) : {}
  );
  const write = (entries: Record<string, string>): void => {
    fs.mkdirSync(path.join(tmpHome, options.directory), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), JSON.stringify(entries));
  };
  return {
    adapter: options.adapter,
    prepare: options.prepare,
    ensure: options.ensure,
    remove: options.remove,
    entryCount: () => Object.keys(read()).length,
    seedOtherProject: () => write({ [OTHER_PROJECT]: 'TRUST_FOLDER' }),
    otherProjectSurvives: () => read()[OTHER_PROJECT] === 'TRUST_FOLDER',
    userDecisions: ['TRUST_PARENT', 'DO_NOT_TRUST'],
    seedUserDecision: (worktree, decision) => write({ [worktree]: decision }),
    userDecisionSurvives: (worktree, decision) => read()[worktree] === decision,
  };
}

function codexTrustRow(): TrustRemovalRow {
  const configPath = (): string => path.join(tmpHome, '.codex', 'config.toml');
  const read = (): string => (fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf-8') : '');
  return {
    adapter: 'codex',
    prepare: () => undefined,
    ensure: ensureCodexWorktreeTrust,
    remove: removeCodexWorktreeTrust,
    entryCount: () => (read().match(/\[projects\./g) ?? []).length,
    seedOtherProject: () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), `[projects.'${OTHER_PROJECT}']\ntrust_level = "trusted"\n`);
    },
    otherProjectSurvives: () => read().includes(`[projects.'${OTHER_PROJECT}']`),
    userDecisions: ['untrusted'],
    seedUserDecision: (worktree, decision) => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), `[projects.'${worktree}']\ntrust_level = "${decision}"\n`);
    },
    userDecisionSurvives: (worktree, decision) => read().includes(`[projects.'${worktree}']\ntrust_level = "${decision}"`),
  };
}

const rows: TrustRemovalRow[] = [
  jsonTrustRow({
    adapter: 'gemini',
    directory: '.gemini',
    prepare: () => undefined,
    ensure: ensureGeminiWorktreeTrust,
    remove: removeGeminiWorktreeTrust,
  }),
  jsonTrustRow({
    adapter: 'qwen',
    directory: '.qwen',
    prepare: () => {
      fs.mkdirSync(path.join(tmpHome, '.qwen'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, '.qwen', 'settings.json'),
        JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      );
    },
    ensure: ensureQwenWorktreeTrust,
    remove: removeQwenWorktreeTrust,
  }),
  codexTrustRow(),
];

// Each adapter resolves its home from an env override before os.homedir(), so a
// developer or runner that sets one would have its real file read and rewritten.
const HOME_OVERRIDES = ['CODEX_HOME', 'QWEN_HOME', 'GEMINI_CLI_HOME'] as const;
const savedOverrides = new Map<string, string | undefined>();

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-trust-removal-'));
  for (const name of HOME_OVERRIDES) {
    savedOverrides.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of HOME_OVERRIDES) {
    const saved = savedOverrides.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.each(rows)('$adapter removes the trust entry of a removed worktree', (row) => {
  it('drops the entry it wrote', async () => {
    row.prepare();
    await row.ensure(WORKTREE);
    expect(row.entryCount()).toBe(1);

    await row.remove(WORKTREE);
    expect(row.entryCount()).toBe(0);
  });

  it('does not grow the file across repeated create/remove cycles', async () => {
    row.prepare();
    for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
      const worktree = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', String(taskIndex));
      await row.ensure(worktree);
      await row.remove(worktree);
    }
    expect(row.entryCount()).toBe(0);
  });

  it('leaves other projects untouched', async () => {
    row.seedOtherProject();
    row.prepare();
    await row.ensure(WORKTREE);
    expect(row.entryCount()).toBe(2);

    await row.remove(WORKTREE);
    expect(row.otherProjectSurvives()).toBe(true);
    expect(row.entryCount()).toBe(1);
  });

  it('is a no-op when there is no file or no matching entry', async () => {
    await expect(row.remove(WORKTREE)).resolves.toBeUndefined();
    expect(row.entryCount()).toBe(0);

    row.seedOtherProject();
    await row.remove(WORKTREE);
    expect(row.otherProjectSurvives()).toBe(true);
    expect(row.entryCount()).toBe(1);
  });

  it.each(row.userDecisions)('never removes a user decision of %s', async (decision) => {
    // The user's, not ours: a later worktree at the same path must still honor it.
    row.seedUserDecision(WORKTREE, decision);
    await row.remove(WORKTREE);
    expect(row.userDecisionSurvives(WORKTREE, decision)).toBe(true);
  });
});
