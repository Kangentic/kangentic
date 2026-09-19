/**
 * Unit test for `kangentic_tail_logs`'s global-config-dir merge:
 * `log-mirror.ts`'s `resolveLogDirectory` falls back to the app's config
 * directory when no project is open at log-write time, so a mobile-bridge
 * trace captured before any project loaded was durably on disk but
 * unreachable through the one tool built to read it. This test pins the
 * merge, the ascending timestamp sort, the level/limit filters applied to
 * the merged set, and the empty-result text naming both candidate paths.
 *
 * Pattern mirrors tests/unit/mcp-get-recent-crashes-fallback.test.ts: a
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
import type { LogEntry } from '../../src/shared/types';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { items: LogEntry[] };
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

function writeLogFile(directory: string, date: string, entries: LogEntry[]): void {
  fs.mkdirSync(directory, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(path.join(directory, `${date}.log`), `${lines.join('\n')}\n`, 'utf-8');
}

function logEntry(ts: string, level: LogEntry['level'], source: LogEntry['source'], args: string[]): LogEntry {
  return { ts, level, source, args };
}

const DATE = '2026-09-16';

describe('kangentic_tail_logs: merges the per-project and global config-dir fallback log files', () => {
  let projectPath: string;

  beforeAll(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-project-'));
    configDirHolder.value = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-configdir-'));
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

  it('merges entries from both files for the same date, sorted ascending with the fallback entry interleaved', async () => {
    writeLogFile(path.join(projectPath, '.kangentic', 'logs'), DATE, [
      logEntry('2026-09-16T10:00:00.000Z', 'info', 'main', ['project-10']),
      logEntry('2026-09-16T12:00:00.000Z', 'info', 'main', ['project-12']),
    ]);
    writeLogFile(path.join(configDirHolder.value, 'logs'), DATE, [
      logEntry('2026-09-16T11:00:00.000Z', 'info', 'main', ['fallback-11']),
    ]);

    const server = makeFakeServer();
    registerDiagnosticsTools(server as never, makeResolver());
    const result = await server.getHandler('kangentic_tail_logs')({ date: DATE });

    const items = result.structuredContent?.items ?? [];
    expect(items.map((entry) => entry.ts)).toEqual([
      '2026-09-16T10:00:00.000Z',
      '2026-09-16T11:00:00.000Z',
      '2026-09-16T12:00:00.000Z',
    ]);
    expect(items.map((entry) => entry.args[0])).toEqual(['project-10', 'fallback-11', 'project-12']);
  });

  it('still returns entries when only the global fallback log file exists (no project log ever written)', async () => {
    const emptyProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-empty-project-'));
    const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-only-fallback-'));
    configDirHolder.value = isolatedConfigDir;
    writeLogFile(path.join(isolatedConfigDir, 'logs'), DATE, [
      logEntry('2026-09-16T08:00:00.000Z', 'info', 'main', ['fallback-08']),
      logEntry('2026-09-16T09:00:00.000Z', 'info', 'main', ['fallback-09']),
    ]);

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
    const result = await server.getHandler('kangentic_tail_logs')({ date: DATE });

    const items = result.structuredContent?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.map((entry) => entry.ts)).toEqual([
      '2026-09-16T08:00:00.000Z',
      '2026-09-16T09:00:00.000Z',
    ]);

    fs.rmSync(emptyProjectPath, { recursive: true, force: true });
    fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
  });

  it('applies the level filter and the limit tail across the merged set', async () => {
    const freshProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-filter-project-'));
    const freshConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-filter-configdir-'));
    configDirHolder.value = freshConfigDir;
    const resolver = {
      resolveProject: vi.fn(() => ({
        context: { getProjectPath: () => freshProjectPath },
        projectId: 'proj-3',
        projectName: 'filter-project',
        isDefault: true,
      })),
    } as unknown as RequestResolver;

    // level filter: a warn in the project file, an info in the fallback
    // file. The filter must run over the merged set, not just the project
    // file, so the info entry (sourced from the OTHER file) is correctly
    // excluded.
    writeLogFile(path.join(freshProjectPath, '.kangentic', 'logs'), DATE, [
      logEntry('2026-09-16T08:00:00.000Z', 'warn', 'main', ['proj-warn']),
    ]);
    writeLogFile(path.join(freshConfigDir, 'logs'), DATE, [
      logEntry('2026-09-16T09:00:00.000Z', 'info', 'main', ['fallback-info']),
    ]);

    const server = makeFakeServer();
    registerDiagnosticsTools(server as never, resolver);
    const levelResult = await server.getHandler('kangentic_tail_logs')({ date: DATE, level: 'warn' });
    const levelItems = levelResult.structuredContent?.items ?? [];
    expect(levelItems).toHaveLength(1);
    expect(levelItems[0].level).toBe('warn');
    expect(levelItems[0].args).toEqual(['proj-warn']);

    // limit: 3 entries across the two files, newest one in the fallback
    // file, so tailing to the 2 newest only comes out right when the
    // fallback entry is merged in before the tail is taken.
    const limitDate = '2026-09-17';
    writeLogFile(path.join(freshProjectPath, '.kangentic', 'logs'), limitDate, [
      logEntry('2026-09-17T10:00:00.000Z', 'info', 'main', ['proj-10']),
      logEntry('2026-09-17T12:00:00.000Z', 'info', 'main', ['proj-12']),
    ]);
    writeLogFile(path.join(freshConfigDir, 'logs'), limitDate, [
      logEntry('2026-09-17T13:00:00.000Z', 'info', 'main', ['fallback-13']),
    ]);

    const limitResult = await server.getHandler('kangentic_tail_logs')({ date: limitDate, limit: 2 });
    const limitItems = limitResult.structuredContent?.items ?? [];
    expect(limitItems.map((entry) => entry.ts)).toEqual([
      '2026-09-17T12:00:00.000Z',
      '2026-09-17T13:00:00.000Z',
    ]);

    fs.rmSync(freshProjectPath, { recursive: true, force: true });
    fs.rmSync(freshConfigDir, { recursive: true, force: true });
  });

  it('names both candidate log paths in the empty-result text when neither file exists', async () => {
    const freshProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-empty-project-both-'));
    const freshConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-logs-empty-configdir-both-'));
    configDirHolder.value = freshConfigDir;
    const resolver = {
      resolveProject: vi.fn(() => ({
        context: { getProjectPath: () => freshProjectPath },
        projectId: 'proj-4',
        projectName: 'no-logs-project',
        isDefault: true,
      })),
    } as unknown as RequestResolver;

    const server = makeFakeServer();
    registerDiagnosticsTools(server as never, resolver);
    const result = await server.getHandler('kangentic_tail_logs')({ date: DATE });

    const expectedProjectLogPath = path.join(freshProjectPath, '.kangentic', 'logs', `${DATE}.log`);
    const expectedFallbackLogPath = path.join(freshConfigDir, 'logs', `${DATE}.log`);
    expect(result.content[0].text).toContain(expectedProjectLogPath);
    expect(result.content[0].text).toContain(expectedFallbackLogPath);
    expect(result.structuredContent?.items).toEqual([]);

    fs.rmSync(freshProjectPath, { recursive: true, force: true });
    fs.rmSync(freshConfigDir, { recursive: true, force: true });
  });
});
