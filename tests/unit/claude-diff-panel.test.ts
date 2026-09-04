/**
 * Unit tests for ensureDiffPanelClosed() - keeps Claude Code 2.1.260's fullscreen
 * diff panel closed at launch by writing `diffSidebarOpen: false` into the global
 * ~/.claude.json before each spawn (src/main/agent/adapters/claude/diff-panel.ts).
 *
 * Same temp-home pattern as trust-manager.test.ts: os.homedir() is mocked to a
 * fresh temp directory per test and the writer touches real files there.
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
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

// Lets a single test force the NEXT fs.readFileSync call to throw an
// arbitrary (non-ENOENT) error, e.g. EACCES, without a real chmod (which
// behaves differently on Windows vs CI's headless Linux). diff-panel.ts
// imports fs via `import * as fs from 'node:fs'`, a real ESM namespace
// object that `vi.spyOn` cannot redefine ("Module namespace is not
// configurable in ESM") - only a module-level vi.mock reaches it, mirroring
// the node:os mock above. Every other fs call passes through to the real
// implementation, so the rest of this file's tests are unaffected.
let forcedReadFileSyncError: NodeJS.ErrnoException | null = null;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (forcedReadFileSyncError) {
      const error = forcedReadFileSyncError;
      forcedReadFileSyncError = null;
      throw error;
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync,
    },
    readFileSync,
  };
});

import { ensureDiffPanelClosed, ClaudeAdapter } from '../../src/main/agent/adapters/claude';

function claudeJsonPath(): string {
  return path.join(tmpHome, '.claude.json');
}

function backupPath(): string {
  return `${claudeJsonPath()}.kangentic-backup`;
}

function tempPath(): string {
  return `${claudeJsonPath()}.kangentic-tmp`;
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf-8'));
}

// A slice of what a real ~/.claude.json carries: the auth block and the
// per-project map must survive the write byte-for-byte in value.
const REAL_SHAPE = {
  oauthAccount: { accountUuid: 'acct-1234', emailAddress: 'dev@example.com' },
  theme: 'dark',
  diffTool: 'auto',
  projects: {
    'C:/Users/dev/repo': { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['kangentic'] },
  },
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-panel-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // A test that asserts before ensureDiffPanelClosedSync reaches the read
  // (or throws for an unrelated reason) would otherwise leave a forced error
  // armed for the next test's unrelated readFileSync calls.
  forcedReadFileSyncError = null;
});

describe('ensureDiffPanelClosed', () => {
  it('writes diffSidebarOpen: false when the key is unset and preserves every other key', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(REAL_SHAPE, null, 2));

    await ensureDiffPanelClosed();

    const data = readClaudeJson();
    expect(data.diffSidebarOpen).toBe(false);
    expect(data.oauthAccount).toEqual(REAL_SHAPE.oauthAccount);
    expect(data.theme).toBe('dark');
    expect(data.diffTool).toBe('auto');
    expect(data.projects).toEqual(REAL_SHAPE.projects);
    // No backup copy: the write is one key on freshly parsed content, and a
    // megabyte copy per flip would litter the home directory.
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it('flips diffSidebarOpen: true (a session left the panel open) back to false', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ ...REAL_SHAPE, diffSidebarOpen: true }, null, 2));

    await ensureDiffPanelClosed();

    expect(readClaudeJson().diffSidebarOpen).toBe(false);
  });

  it('is idempotent: an already-false key produces no write, no backup, and no temp file', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ ...REAL_SHAPE, diffSidebarOpen: false }, null, 2));
    const contentBefore = fs.readFileSync(claudeJsonPath(), 'utf-8');
    const mtimeBefore = fs.statSync(claudeJsonPath()).mtimeMs;

    await ensureDiffPanelClosed();

    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(contentBefore);
    expect(fs.statSync(claudeJsonPath()).mtimeMs).toBe(mtimeBefore);
    expect(fs.existsSync(backupPath())).toBe(false);
    expect(fs.existsSync(tempPath())).toBe(false);
  });

  it('creates ~/.claude.json with only the key when the file is missing', async () => {
    expect(fs.existsSync(claudeJsonPath())).toBe(false);

    await ensureDiffPanelClosed();

    expect(readClaudeJson()).toEqual({ diffSidebarOpen: false });
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it('leaves an unparseable file untouched instead of replacing it', async () => {
    // A torn read (the CLI mid-write) must never become `{ diffSidebarOpen: false }`,
    // which would wipe the auth block.
    const torn = '{"oauthAccount": {"accountUuid": "acct-1234"}, "projects": {';
    fs.writeFileSync(claudeJsonPath(), torn);

    await expect(ensureDiffPanelClosed()).resolves.toBeUndefined();

    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(torn);
    expect(fs.existsSync(backupPath())).toBe(false);
    expect(fs.existsSync(tempPath())).toBe(false);
  });

  it('leaves the file untouched when readFileSync fails with a non-ENOENT error (e.g. EACCES)', async () => {
    // Collapsing this branch into "any read failure means the file is
    // missing" would make the writer treat an unreadable-but-present
    // ~/.claude.json as empty and blindly write { diffSidebarOpen: false }
    // over content it never actually saw - wiping the user's auth/MCP state.
    // A permission error is simulated (not a real chmod) because chmod does
    // not behave the same on Windows as it does on CI's headless Linux.
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(REAL_SHAPE, null, 2));
    const contentBefore = fs.readFileSync(claudeJsonPath(), 'utf-8');

    forcedReadFileSyncError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    }) as NodeJS.ErrnoException;

    await expect(ensureDiffPanelClosed()).resolves.toBeUndefined();

    // The forced error is consumed by the mock after one throw (see the
    // node:fs mock above); nothing left to reset here.
    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(contentBefore);
    expect(fs.existsSync(backupPath())).toBe(false);
    expect(fs.existsSync(tempPath())).toBe(false);
  });

  it('leaves a file whose top level is not an object untouched', async () => {
    fs.writeFileSync(claudeJsonPath(), '[]');

    await ensureDiffPanelClosed();

    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe('[]');
  });

  it('writes atomically with the 2-space indent the CLI uses and leaves no temp file', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(REAL_SHAPE, null, 2));

    await ensureDiffPanelClosed();

    const content = fs.readFileSync(claudeJsonPath(), 'utf-8');
    expect(content).toBe(JSON.stringify(JSON.parse(content), null, 2));
    expect(fs.existsSync(tempPath())).toBe(false);
  });

  it('serializes with the trust writers: concurrent calls all land and the file stays valid', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(REAL_SHAPE, null, 2));

    await Promise.all([ensureDiffPanelClosed(), ensureDiffPanelClosed(), ensureDiffPanelClosed()]);

    const data = readClaudeJson();
    expect(data.diffSidebarOpen).toBe(false);
    expect(data.oauthAccount).toEqual(REAL_SHAPE.oauthAccount);
  });
});

describe('ClaudeAdapter.ensureTrust', () => {
  it('closes the diff panel alongside the trust entries on every spawn', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ ...REAL_SHAPE, diffSidebarOpen: true }, null, 2));
    const workingDirectory = path.join(tmpHome, 'repo');

    await new ClaudeAdapter().ensureTrust(workingDirectory);

    const data = readClaudeJson();
    expect(data.diffSidebarOpen).toBe(false);
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = Object.entries(projects).find(([key]) => key.endsWith('/repo'))?.[1];
    expect(entry?.hasTrustDialogAccepted).toBe(true);
    expect(entry?.enabledMcpjsonServers).toContain('kangentic');
  });

  it('heals a torn ~/.claude.json via the trust writers and still closes the diff panel, because diff-panel runs LAST', async () => {
    // ensureDiffPanelClosedSync's own guard leaves a torn file untouched (see
    // the standalone test above) - that is correct in isolation, but
    // ensureTrust composes it with ensureWorktreeTrust/ensureMcpServerTrust,
    // which fall back to `data = {}` on the same parse failure and DO write,
    // healing the file into valid JSON. That only reaches diffSidebarOpen
    // because diff-panel is called LAST in ClaudeAdapter.ensureTrust: it
    // reads the now-healed file, not the original torn one. If the call
    // order were ever reversed (diff-panel first), diff-panel would see the
    // still-torn file, correctly leave it untouched, and then the trust
    // writers' fallback would overwrite it afterward without diffSidebarOpen
    // ever being set - silently dropping the feature for that spawn whenever
    // ~/.claude.json happens to be torn (e.g. the CLI mid-write elsewhere).
    const torn = '{"oauthAccount": {"accountUuid": "acct-1234"}, "projects": {';
    fs.writeFileSync(claudeJsonPath(), torn);
    const workingDirectory = path.join(tmpHome, 'repo');

    await new ClaudeAdapter().ensureTrust(workingDirectory);

    const data = readClaudeJson();
    expect(data.diffSidebarOpen).toBe(false);
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = Object.entries(projects).find(([key]) => key.endsWith('/repo'))?.[1];
    expect(entry?.hasTrustDialogAccepted).toBe(true);
    expect(entry?.enabledMcpjsonServers).toContain('kangentic');
  });
});
