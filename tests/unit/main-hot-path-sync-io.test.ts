import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { hasOptOutMarker } from './helpers/opt-out-marker';

/**
 * Main's hot file paths do their I/O asynchronously, so a slow disk, a virus
 * scanner or a network drive waits off the main thread (Electron's
 * performance guidance: no blocking I/O on main). These are the modules that
 * read or write on every agent change, poll tick, transcript flush or read:
 * the status, events and session-history readers and the watcher under them,
 * the Claude spawn's ~/.claude.json pass, the bounded tail read MCP tools
 * use, and the transcript paths main relays.
 *
 * A synchronous call stays only where the moment needs it, marked on its line
 * or in the comment block above with `// sync-read-ok: <reason>` or
 * `// sync-write-ok: <reason>` (the exit flush must dispatch before the exit
 * is handled; an attach truncate must land before the agent's first write).
 */

const HOT_PATH_MODULES = [
  'src/main/pty/readers/status-file-reader.ts',
  'src/main/pty/readers/session-history-reader.ts',
  'src/main/pty/readers/file-watcher.ts',
  'src/main/pty/buffer/transcript-writer.ts',
  'src/main/agent/adapters/claude/trust-manager.ts',
  'src/main/agent/commands/bounded-tail-read.ts',
  'src/main/agent/message-trail-tracker.ts',
  'src/main/ipc/handlers/transcripts.ts',
  'src/main/mobile-bridge/handlers/read-stream.ts',
];

const SYNC_CALL = /\bfs\.(readFileSync|readSync|statSync|existsSync|writeFileSync|openSync|appendFileSync|mkdirSync|unlinkSync)\(/;

function offenders(relativePath: string): string[] {
  const lines = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8').split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    const match = SYNC_CALL.exec(line);
    if (!match) return;
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
    if (hasOptOutMarker(lines, index, 'sync-read-ok') || hasOptOutMarker(lines, index, 'sync-write-ok')) return;
    found.push(`${relativePath}:${index + 1} fs.${match[1]}`);
  });
  return found;
}

describe('main hot paths do no synchronous file I/O', () => {
  it('has no unmarked synchronous fs call in a hot-path module', () => {
    const all = HOT_PATH_MODULES.flatMap(offenders);
    expect(all, 'Use fs.promises here, or mark the line `// sync-read-ok: <reason>` naming why the moment needs it.').toEqual([]);
  });

  it('still finds the marked exceptions (the scan is not vacuous)', () => {
    // The status reader's exit flush and attach truncates are the known marked
    // sites; a detector that stops matching would find none of them.
    const lines = fs.readFileSync(path.join(process.cwd(), 'src/main/pty/readers/status-file-reader.ts'), 'utf-8').split('\n');
    const marked = lines.filter((line, index) => SYNC_CALL.test(line)
      && (hasOptOutMarker(lines, index, 'sync-read-ok') || hasOptOutMarker(lines, index, 'sync-write-ok')));
    expect(marked.length).toBeGreaterThanOrEqual(3);
    // And every listed module exists, so a rename cannot empty the scan.
    for (const relativePath of HOT_PATH_MODULES) {
      expect(fs.existsSync(path.join(process.cwd(), relativePath)), relativePath).toBe(true);
    }
  });
});
