/**
 * Unit tests for ensureWorktreeTrust() — pre-populates Claude Code's
 * trust entry in ~/.claude.json so agents skip the trust prompt.
 *
 * Uses real temp files (same pattern as hook-manager.test.ts).
 * Mocks os.homedir() to point at a temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.claude.json to a temp dir
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

import { ensureWorktreeTrust } from '../../src/main/agent/trust-manager';

function claudeJsonPath(): string {
  return path.join(tmpHome, '.claude.json');
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf-8'));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureWorktreeTrust', () => {
  it('creates ~/.claude.json with trust entry when file does not exist', () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.projects).toBeDefined();

    const projects = data.projects as Record<string, Record<string, unknown>>;
    // path.resolve + toForwardSlash may transform the path — find the entry
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });

  it('creates trust entry when file exists but has no projects key', () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ someOtherKey: 42 }));

    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.someOtherKey).toBe(42); // preserved
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });

  it('skips write if worktree is already trusted (idempotent)', () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    // First call — creates entry
    ensureWorktreeTrust(wtPath);
    const stat1 = fs.statSync(claudeJsonPath()).mtimeMs;

    // Tiny delay to ensure mtime would differ on write
    const data = readClaudeJson();

    // Second call — should skip
    ensureWorktreeTrust(wtPath);
    const data2 = readClaudeJson();

    // Content should be identical
    expect(data2).toEqual(data);
  });

  it('copies enabledMcpjsonServers from parent project entry', () => {
    // The worktree path encodes the parent as everything before /.kangentic/worktrees/
    const parentPath = path.resolve('/projects/myrepo');
    const parentKey = parentPath.replace(/\\/g, '/');
    const wtPath = path.join(parentPath, '.kangentic', 'worktrees', 'fix-bug-abcd1234');

    // Pre-populate parent entry with MCP servers
    const existing = {
      projects: {
        [parentKey]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['server-a', 'server-b'],
          allowedTools: ['Read'],
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;

    // Find the worktree entry (not the parent)
    const wtEntries = Object.entries(projects).filter(
      ([key]) => key.includes('.kangentic/worktrees/'),
    );
    expect(wtEntries).toHaveLength(1);
    const [, wtEntry] = wtEntries[0];
    expect(wtEntry.enabledMcpjsonServers).toEqual(['server-a', 'server-b']);
    expect(wtEntry.hasTrustDialogAccepted).toBe(true);
  });

  it('uses empty array when parent has no MCP servers', () => {
    const parentPath = path.resolve('/projects/myrepo');
    const parentKey = parentPath.replace(/\\/g, '/');
    const wtPath = path.join(parentPath, '.kangentic', 'worktrees', 'fix-bug-abcd1234');

    // Parent exists but has no enabledMcpjsonServers
    const existing = {
      projects: {
        [parentKey]: {
          hasTrustDialogAccepted: true,
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const wtEntries = Object.entries(projects).filter(
      ([key]) => key.includes('.kangentic/worktrees/'),
    );
    expect(wtEntries).toHaveLength(1);
    expect(wtEntries[0][1].enabledMcpjsonServers).toEqual([]);
  });

  it('preserves existing worktree entry fields while setting hasTrustDialogAccepted', () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    const resolvedKey = path.resolve(wtPath).replace(/\\/g, '/');

    // Pre-populate with a partial worktree entry (missing hasTrustDialogAccepted)
    const existing = {
      projects: {
        [resolvedKey]: {
          allowedTools: ['Bash', 'Read'],
          customField: 'keep-me',
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = projects[resolvedKey];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.customField).toBe('keep-me');
    // allowedTools from spread defaults gets overridden by existing entry's spread
    expect(entry.allowedTools).toEqual(['Bash', 'Read']);
  });

  it('handles malformed JSON (treats as empty)', () => {
    fs.writeFileSync(claudeJsonPath(), '{ this is not valid JSON !!!');

    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    ensureWorktreeTrust(wtPath);

    // Should not throw, and should create a valid file
    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });
});
