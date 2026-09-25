import fs from 'node:fs';
import path from 'node:path';
import { safeWriteJson } from '../safe-write';

// Per-task browser URL overrides. Stored as a flat JSON map
// `{ [taskId]: url }` at `<projectPath>/.kangentic/browser-urls.json`. The
// project default lives in `<projectPath>/.kangentic/config.json` under
// `browser.defaultUrl` and is managed via the existing ConfigManager paths;
// this store is only for the per-task overrides.

const FILE_NAME = 'browser-urls.json';

function resolveFilePath(projectPath: string): string {
  return path.join(projectPath, '.kangentic', FILE_NAME);
}

function readMap(projectPath: string): Record<string, string> {
  const filePath = resolveFilePath(projectPath);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) out[key] = value;
      }
      return out;
    }
  } catch {
    // Corrupt file -> treat as empty.
  }
  return {};
}

function writeMap(projectPath: string, map: Record<string, string>): void {
  // Degrades rather than throws: an unwritable project directory must not
  // reject the set/clear/prune call the renderer is waiting on. Atomicity
  // (tmp + rename) and the shared write-failure-notice latch both come from
  // safeWriteJson now; this used to hand-roll the same tmp + rename.
  safeWriteJson(resolveFilePath(projectPath), map, 'browser_url');
}

export class BrowserUrlStore {
  read(projectPath: string): Record<string, string> {
    return readMap(projectPath);
  }

  get(projectPath: string, taskId: string): string | null {
    const map = readMap(projectPath);
    return map[taskId] ?? null;
  }

  set(projectPath: string, taskId: string, url: string): void {
    const map = readMap(projectPath);
    map[taskId] = url;
    writeMap(projectPath, map);
  }

  clear(projectPath: string, taskId: string): void {
    const map = readMap(projectPath);
    if (!(taskId in map)) return;
    delete map[taskId];
    writeMap(projectPath, map);
  }

  prune(projectPath: string, activeTaskIds: ReadonlySet<string>): void {
    const map = readMap(projectPath);
    let mutated = false;
    for (const key of Object.keys(map)) {
      if (!activeTaskIds.has(key)) {
        delete map[key];
        mutated = true;
      }
    }
    if (mutated) writeMap(projectPath, map);
  }
}

export const browserUrlStore = new BrowserUrlStore();
