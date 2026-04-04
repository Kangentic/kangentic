/**
 * Unit tests for ensureWorktreeTrust() -- pre-populates Claude Code's
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

import { ensureWorktreeTrust, ensureMcpServerTrust } from '../../src/main/agent/adapters/claude';

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
  it('creates ~/.claude.json with trust entry when file does not exist', async () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.projects).toBeDefined();

    const projects = data.projects as Record<string, Record<string, unknown>>;
    // path.resolve + toForwardSlash may transform the path -- find the entry
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });

  it('creates trust entry when file exists but has no projects key', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ someOtherKey: 42 }));

    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.someOtherKey).toBe(42); // preserved
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });

  it('skips write if worktree is already trusted (idempotent)', async () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    // First call -- creates entry
    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();

    // Second call -- should skip
    await ensureWorktreeTrust(wtPath);
    const data2 = readClaudeJson();

    // Content should be identical
    expect(data2).toEqual(data);
  });

  it('copies enabledMcpjsonServers from parent project entry', async () => {
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

    await ensureWorktreeTrust(wtPath);

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

  it('uses empty array when parent has no MCP servers', async () => {
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

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const wtEntries = Object.entries(projects).filter(
      ([key]) => key.includes('.kangentic/worktrees/'),
    );
    expect(wtEntries).toHaveLength(1);
    expect(wtEntries[0][1].enabledMcpjsonServers).toEqual([]);
  });

  it('preserves existing worktree entry fields while setting hasTrustDialogAccepted', async () => {
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

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = projects[resolvedKey];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.customField).toBe('keep-me');
    // allowedTools from spread defaults gets overridden by existing entry's spread
    expect(entry.allowedTools).toEqual(['Bash', 'Read']);
  });

  it('handles malformed JSON (treats as empty)', async () => {
    fs.writeFileSync(claudeJsonPath(), '{ this is not valid JSON !!!');

    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    await ensureWorktreeTrust(wtPath);

    // Should not throw, and should create a valid file
    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });
});

describe('ensureMcpServerTrust', () => {
  it('adds kangentic to enabledMcpjsonServers when file does not exist', async () => {
    const projectPath = '/projects/myrepo';
    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].enabledMcpjsonServers).toContain('kangentic');
  });

  it('adds kangentic to existing enabledMcpjsonServers without duplicating', async () => {
    const projectPath = '/projects/myrepo';
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');

    // Pre-populate with existing MCP servers
    const existing = {
      projects: {
        [resolvedKey]: {
          enabledMcpjsonServers: ['server-a', 'server-b'],
          hasTrustDialogAccepted: true,
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = projects[resolvedKey];
    const servers = entry.enabledMcpjsonServers as string[];
    expect(servers).toContain('kangentic');
    expect(servers).toContain('server-a');
    expect(servers).toContain('server-b');
    expect(servers.filter((server) => server === 'kangentic')).toHaveLength(1);
  });

  it('is idempotent -- skips write if kangentic already present', async () => {
    const projectPath = '/projects/myrepo';
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');

    const existing = {
      projects: {
        [resolvedKey]: {
          enabledMcpjsonServers: ['kangentic'],
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    // Record mtime before second call
    const statBefore = fs.statSync(claudeJsonPath()).mtimeMs;

    await ensureMcpServerTrust(projectPath);

    // Content should be unchanged
    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const servers = projects[resolvedKey].enabledMcpjsonServers as string[];
    expect(servers).toEqual(['kangentic']);
  });

  it('creates project entry when none exists', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ projects: {} }));

    const projectPath = '/projects/brand-new';
    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');
    expect(projects[resolvedKey].enabledMcpjsonServers).toContain('kangentic');
  });
});

// ---------------------------------------------------------------------------
// Concurrent access (serialization via withClaudeJsonLock)
// ---------------------------------------------------------------------------

describe('Concurrent trust writes', () => {
  it('5 concurrent ensureWorktreeTrust calls - all entries present', async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );

    await Promise.all(paths.map(worktreePath => ensureWorktreeTrust(worktreePath)));

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);

    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.hasTrustDialogAccepted).toBe(true);
    }
  });

  it('5 concurrent ensureMcpServerTrust calls - all kangentic entries present', async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      `/projects/repo-${index}`,
    );

    await Promise.all(paths.map(projectPath => ensureMcpServerTrust(projectPath)));

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);

    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect((entry.enabledMcpjsonServers as string[])).toContain('kangentic');
    }
  });

  it('mixed concurrent trust + MCP calls - no entries lost', async () => {
    const trustPaths = Array.from({ length: 3 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );
    const mcpPaths = Array.from({ length: 3 }, (_, index) =>
      `/projects/mcp-repo-${index}`,
    );

    await Promise.all([
      ...trustPaths.map(worktreePath => ensureWorktreeTrust(worktreePath)),
      ...mcpPaths.map(projectPath => ensureMcpServerTrust(projectPath)),
    ]);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.entries(projects);

    // Should have all 6 entries (3 trust + 3 MCP)
    expect(entries).toHaveLength(6);

    // Verify trust entries
    const trustEntries = entries.filter(([key]) => key.includes('.kangentic/worktrees/'));
    expect(trustEntries).toHaveLength(3);
    for (const [, entry] of trustEntries) {
      expect(entry.hasTrustDialogAccepted).toBe(true);
    }

    // Verify MCP entries
    const mcpEntries = entries.filter(([key]) => key.includes('mcp-repo'));
    expect(mcpEntries).toHaveLength(3);
    for (const [, entry] of mcpEntries) {
      expect((entry.enabledMcpjsonServers as string[])).toContain('kangentic');
    }
  });

  it('already-trusted path returns early without write (idempotent)', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';

    await ensureWorktreeTrust(worktreePath);
    const dataBefore = readClaudeJson();

    // Second call should be a no-op
    await ensureWorktreeTrust(worktreePath);
    const dataAfter = readClaudeJson();

    expect(dataAfter).toEqual(dataBefore);
  });
});
