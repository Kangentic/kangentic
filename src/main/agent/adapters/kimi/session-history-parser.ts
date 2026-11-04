import fs from 'node:fs';
import { cliPathForTarget, placeFromStored, type CliPlace } from '../../shared/cli-target';
import type { SessionHistoryParseResult, StoredCliTarget } from '../../../../shared/types';
import { parseWireJsonl } from './wire-parser';
import { kimiMainWirePath } from './kimi-home';
import { findKimiSessionDir, kimiSessionsForWorkDir } from './session-index';
import { kimiModelByAlias } from './config-toml';

/**
 * Locator and parser for Kimi Code CLI's session history,
 * `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`
 * (`en/configuration/data-locations.md`, Kimi Code CLI 2.4.1, read
 * 2026-11-03).
 *
 * A session is found by its id through `session_index.jsonl`, which names
 * each session's folder outright, so no folder name is computed. A new
 * session exists only once its first message is sent ("No session yet - one
 * will be created on your first message", the TUI's startup notice), and
 * Kangentic types that message in after the TUI is ready, so the locator and
 * the id capture wait longer than the 1.x CLI needed.
 *
 * Built from the docs and source, not yet checked against a real run.
 */
export class KimiSessionHistoryParser {
  /**
   * The main agent's `wire.jsonl` for a known session id, polled for up to
   * about 10 s while the CLI writes its first record.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
    cliTarget?: StoredCliTarget | null;
  }): Promise<string | null> {
    const place = placeFromStored(options.cliTarget);
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const found = locateKimiWireFile(options.agentSessionId, place);
      if (found) return found;
      await sleep(500);
    }
    return null;
  }

  /**
   * The id of the session this spawn started, read from the index: the newest
   * session for this working directory (as the CLI saw it) whose folder was
   * made after the spawn. Polled once a second for about 90 s, since the session folder
   * appears only when the typed first prompt is sent.
   *
   * The caller drops a match that could be another session's
   * (`SessionIdManager.folderMatchConflict`), and the output anchors
   * (`Session: <id>` on a resume, `kimi -r <id>` at exit) cover what that leaves
   * with no id. The CLI records `process.cwd()`, which has symlinks resolved, so
   * both spellings of a cwd reached through a link are compared.
   */
  static async captureSessionIdFromFilesystem(options: {
    spawnedAt: Date;
    cwd: string;
    cliTarget?: StoredCliTarget | null;
    maxAttempts?: number;
  }): Promise<string | null> {
    const place = placeFromStored(options.cliTarget);
    const floorMs = options.spawnedAt.getTime() - 5_000;
    const cliWorkDirs = place ? [cliPathForTarget(options.cwd, place)] : hostWorkDirSpellings(options.cwd);
    const maxAttempts = options.maxAttempts ?? 90;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const found = newestSessionSince(cliWorkDirs, floorMs, place);
      if (found) return found;
      await sleep(1000);
    }
    return null;
  }

  static parse(content: string, mode: 'full' | 'append'): SessionHistoryParseResult {
    return KimiSessionHistoryParser.parseWith(content, mode);
  }

  /** One session's parser: it remembers each open call's tool across chunks. */
  static createParse(): (content: string, mode: 'full' | 'append') => SessionHistoryParseResult {
    const openToolNames = new Map<string, string>();
    return (content, mode) => KimiSessionHistoryParser.parseWith(content, mode, openToolNames);
  }

  private static parseWith(
    content: string,
    mode: 'full' | 'append',
    openToolNames?: Map<string, string>,
  ): SessionHistoryParseResult {
    return parseWireJsonl(content, mode, {
      contextWindowForAlias: (alias) => kimiModelByAlias(alias)?.maxContextSize ?? null,
      displayNameForAlias: (alias) => kimiModelByAlias(alias)?.displayName ?? null,
      openToolNames,
    });
  }
}

/** The main agent's wire file for a session id, when it exists. */
export function locateKimiWireFile(agentSessionId: string, place: CliPlace | null = null): string | null {
  const sessionDir = findKimiSessionDir(agentSessionId, place);
  if (!sessionDir) return null;
  const wirePath = kimiMainWirePath(sessionDir);
  try {
    return fs.existsSync(wirePath) ? wirePath : null;
  } catch {
    return null;
  }
}

/** A cwd as the host spells it, and with its symlinks resolved when that differs. */
function hostWorkDirSpellings(cwd: string): string[] {
  try {
    return [cwd, fs.realpathSync.native(cwd)];
  } catch {
    return [cwd];
  }
}

function newestSessionSince(cliWorkDirs: readonly string[], floorMs: number, place: CliPlace | null): string | null {
  const candidates = kimiSessionsForWorkDir(cliWorkDirs, place);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    let createdAtMs: number;
    try {
      const stat = fs.statSync(candidate.sessionDir);
      createdAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    } catch {
      // The folder is not there yet, or was removed: not this spawn's.
      continue;
    }
    if (createdAtMs >= floorMs) return candidate.sessionId;
    // Candidates run oldest first, so every one before this is older still. A
    // folder with many sessions costs one stat per poll, not one per session.
    return null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
