/**
 * Unit test for `kangentic_get_recent_crashes`'s global-config-dir merge
 * (Sentry DESKTOP-16 follow-on): `crash-capture.ts`'s `writeRecord` falls
 * back to the app's config directory when no project is open at crash time,
 * so this read tool must check BOTH locations or a crash recorded before any
 * project loaded becomes permanently invisible to it.
 *
 * Pattern mirrors tests/unit/mcp-diagnostics-tools-worktree-base.test.ts: a
 * minimal fake McpServer captures registerTool(name, config, handler) calls
 * so the handler runs directly, without the real MCP SDK transport. Real fs
 * writes go under os.tmpdir() per .claude/rules/cross-platform-parity.md.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  PROJECT_SELECTOR_DESCRIPTION: 'Optional project selector (test stub).',
}));

vi.mock('../../src/main/diagnostics/process-metrics', () => ({
  getProcessMetrics: vi.fn(),
}));

vi.mock('../../src/main/git/worktree-list', () => ({
  enumerateWorktrees: vi.fn(async () => []),
}));

const configDirHolder = vi.hoisted(() => ({ value: '' }));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    get configDir() { return configDirHolder.value; },
  },
}));

import { registerDiagnosticsTools } from '../../src/main/agent/mcp-http/diagnostics-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { CrashRecord } from '../../src/shared/types';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { items: CrashRecord[] };
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeFakeServer(): { registerTool: ReturnType<typeof vi.fn>; getHandler: (name: string) => ToolHandler } {
  const handlers: Record<string, ToolHandler> = {};
  const registerTool = vi.fn((name: string, _config: unknown, handler: ToolHandler) => {
    handlers[name] = handler;
  });
  return {
    registerTool,
    getHandler: (name: string) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
  };
}

function writeCrashRecord(directory: string, record: CrashRecord): void {
  fs.mkdirSync(directory, { recursive: true });
  const safeStamp = record.ts.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(directory, `${safeStamp}.json`), JSON.stringify(record), 'utf-8');
}

function crashRecord(ts: string): CrashRecord {
  return {
    ts,
    kind: 'render-process-gone',
    source: 'renderer',
    message: 'Render process gone: oom',
    stack: null,
    origin: null,
    context: null,
    versions: { kangentic: '0.41.0', electron: '41.1.1', node: '24.14.0', chrome: '146.0.7680.166' },
  };
}

describe('kangentic_get_recent_crashes: merges the per-project and global fallback directories', () => {
  let projectPath: string;

  beforeAll(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crashes-project-'));
    configDirHolder.value = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crashes-configdir-'));
  });

  afterAll(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.rmSync(configDirHolder.value, { recursive: true, force: true });
  });

  function makeResolver(): RequestResolver {
    return {
      resolveProject: vi.fn(() => ({
        context: { getProjectPath: () => projectPath },
        projectId: 'proj-1',
        projectName: 'test-project',
        isDefault: true,
      })),
    } as unknown as RequestResolver;
  }

  it('returns records from both directories, sorted newest first', async () => {
    writeCrashRecord(
      path.join(projectPath, '.kangentic', 'logs', 'crashes'),
      crashRecord('2026-09-16T10:00:00.000Z')
    );
    writeCrashRecord(
      path.join(configDirHolder.value, 'logs', 'crashes'),
      crashRecord('2026-09-16T12:00:00.000Z')
    );

    const server = makeFakeServer();
    registerDiagnosticsTools(server as never, makeResolver());
    const result = await server.getHandler('kangentic_get_recent_crashes')({});

    const records = result.structuredContent?.items ?? [];
    expect(records.map((record) => record.ts)).toEqual([
      '2026-09-16T12:00:00.000Z', // global fallback, newer
      '2026-09-16T10:00:00.000Z', // per-project, older
    ]);
  });

  it('still works when only the global fallback directory has a record (no project ever opened)', async () => {
    const emptyProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crashes-empty-project-'));
    const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-crashes-only-fallback-'));
    configDirHolder.value = isolatedConfigDir;
    writeCrashRecord(
      path.join(isolatedConfigDir, 'logs', 'crashes'),
      crashRecord('2026-09-16T08:00:00.000Z')
    );

    const server = makeFakeServer();
    const resolver = {
      resolveProject: vi.fn(() => ({
        context: { getProjectPath: () => emptyProjectPath },
        projectId: 'proj-2',
        projectName: 'empty-project',
        isDefault: true,
      })),
    } as unknown as RequestResolver;
    registerDiagnosticsTools(server as never, resolver);
    const result = await server.getHandler('kangentic_get_recent_crashes')({});

    const records = result.structuredContent?.items ?? [];
    expect(records).toHaveLength(1);
    expect(records[0].ts).toBe('2026-09-16T08:00:00.000Z');

    fs.rmSync(emptyProjectPath, { recursive: true, force: true });
    fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
  });
});
