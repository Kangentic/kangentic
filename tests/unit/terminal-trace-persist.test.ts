/**
 * The persisted terminal trace (src/devtools/main/terminal-trace-persist.ts).
 *
 * The in-memory trace ring was the only record of a stuck-terminal incident,
 * and the restart that cleared the terminals erased it. These pin what the
 * file must keep for the next one: every entry as its own JSON line, the
 * process that recorded it, the detail, and the lines a previous run wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTerminalTracePersistListener,
  formatTerminalTraceLine,
  terminalTraceFilePath,
  TERMINAL_TRACE_FILE_NAME,
} from '../../src/devtools/main/terminal-trace-persist';
import { flushAllForTest, resetForTest, ROTATED_FILE_SUFFIX } from '../../src/main/diagnostics/async-file-queue';
import type { TerminalTraceEvent } from '../../src/main/pty/terminal-trace';

function traceEntry(overrides: Partial<TerminalTraceEvent>): TerminalTraceEvent {
  return {
    ts: Date.UTC(2026, 9, 14, 14, 25, 4, 120),
    source: 'main',
    process: 'main',
    sessionId: 'session-window',
    event: 'resize-applied',
    detail: { origin: 'desktop', cols: 210, rows: 48 },
    ...overrides,
  };
}

function readLines(filePath: string): Record<string, unknown>[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('terminal trace persistence', () => {
  let directory: string;

  beforeEach(() => {
    resetForTest();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-terminal-trace-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('places the file under the config dir logs folder', () => {
    expect(terminalTraceFilePath(directory)).toBe(path.join(directory, 'logs', TERMINAL_TRACE_FILE_NAME));
  });

  it('writes each entry as one JSON line with an ISO timestamp, the recording process and the detail', async () => {
    const filePath = terminalTraceFilePath(directory);
    const listener = createTerminalTracePersistListener(filePath);
    listener(traceEntry({}));
    listener(traceEntry({
      process: 'pty-host',
      event: 'pty-resize',
      detail: { fromCols: 306, toCols: 210, fromRows: 19, toRows: 48 },
    }));
    await flushAllForTest();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      ts: '2026-10-14T14:25:04.120Z',
      process: 'main',
      sessionId: 'session-window',
      event: 'resize-applied',
      detail: { origin: 'desktop', cols: 210, rows: 48 },
    });
    expect(lines[1].process).toBe('pty-host');
    expect(lines[1].detail).toEqual({ fromCols: 306, toCols: 210, fromRows: 19, toRows: 48 });
  });

  it('omits detail for an entry that has none', () => {
    const line = formatTerminalTraceLine(traceEntry({ event: 'focus-union-lost', detail: undefined }));
    expect(JSON.parse(line)).not.toHaveProperty('detail');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('appends to the lines a previous run left instead of truncating them', async () => {
    const filePath = terminalTraceFilePath(directory);
    createTerminalTracePersistListener(filePath)(traceEntry({ event: 'settle' }));
    await flushAllForTest();

    // A restart: a fresh queue and a fresh listener on the same file.
    resetForTest();
    createTerminalTracePersistListener(filePath)(traceEntry({ event: 'resize-applied' }));
    await flushAllForTest();

    expect(readLines(filePath).map((line) => line.event)).toEqual(['settle', 'resize-applied']);
  });

  it('rotates to the .1 copy at the size cap instead of growing without bound', async () => {
    const filePath = terminalTraceFilePath(directory);
    const lineLength = formatTerminalTraceLine(traceEntry({})).length;
    const listener = createTerminalTracePersistListener(filePath, lineLength * 2);
    for (let index = 0; index < 3; index += 1) {
      listener(traceEntry({}));
      await flushAllForTest();
    }

    expect(fs.existsSync(filePath + ROTATED_FILE_SUFFIX)).toBe(true);
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(lineLength * 2);
  });
});
