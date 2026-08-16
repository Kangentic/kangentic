import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Single source of truth for Grok Build's on-disk layout.
 *
 * Empirically verified against grok 1.0.0 (3cd0d0cbce) on Windows:
 *
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<session-uuid>/
 *     updates.jsonl       - authoritative append-only ACP session/update log
 *     chat_history.jsonl  - raw model messages (system/user/assistant/
 *                           reasoning/tool_result records)
 *     summary.json        - session metadata (id, cwd, timestamps, model,
 *                           generated_title, reasoning_effort, git info)
 *
 * The directory key is the URL-encoded working directory exactly as
 * `encodeURIComponent` produces it (observed on disk:
 * `C%3A%5CUsers%5C...`), and `GROK_HOME` overrides `~/.grok` (documented in
 * the shipped user guide, 17-sessions.md / 21-terminal-support.md).
 *
 * Because GrokAdapter declares `supportsCallerSessionId = true` (Kangentic
 * generates the UUID and passes `-s <uuid>` at spawn), every path here is a
 * deterministic construction - no filesystem scanning or capture race.
 */

/** Grok's config/data root: `$GROK_HOME` when set, else `~/.grok`. Read per-call so tests can redirect it. */
export function grokHomeDir(): string {
  const override = process.env.GROK_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.grok');
}

/**
 * The per-cwd sessions directory key. Grok URL-encodes the raw absolute
 * cwd string (backslashes intact on Windows) with `encodeURIComponent`
 * semantics - verified byte-for-byte against a real session directory.
 */
export function cwdToSessionsDirName(cwd: string): string {
  return encodeURIComponent(cwd);
}

/** Absolute path to one session's directory. */
export function grokSessionDir(cwd: string, agentSessionId: string): string {
  return path.join(grokHomeDir(), 'sessions', cwdToSessionsDirName(cwd), agentSessionId);
}

export function grokUpdatesJsonlPath(cwd: string, agentSessionId: string): string {
  return path.join(grokSessionDir(cwd, agentSessionId), 'updates.jsonl');
}

export function grokChatHistoryPath(cwd: string, agentSessionId: string): string {
  return path.join(grokSessionDir(cwd, agentSessionId), 'chat_history.jsonl');
}

/**
 * Locate the session's `updates.jsonl` by polling the deterministic path for
 * existence. The budget mirrors Claude's (~60s): the caller-owned-session-id
 * flow attaches the SessionHistoryReader at spawn, before the CLI has booted
 * and written its first update, so the file legitimately does not exist for
 * the first seconds. `locate` MUST confirm existence before returning -
 * SessionHistoryReader treats ENOENT on the initial read as "file
 * disappeared" and detaches.
 */
export async function locateGrokUpdatesFile(options: {
  agentSessionId: string;
  cwd: string;
  maxAttempts?: number;
}): Promise<string | null> {
  const expected = grokUpdatesJsonlPath(options.cwd, options.agentSessionId);
  const maxAttempts = options.maxAttempts ?? 120; // ~60s at 500ms cadence
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fs.existsSync(expected)) return expected;
    // Encoding-mismatch safety net: the session UUID is caller-generated
    // and globally unique, so once the CLI has had a few seconds to write
    // ANYTHING, a one-level scan of the sessions root finds our session
    // even if the cwd key was encoded differently than we computed (e.g. a
    // drive-letter casing difference on Windows). Checked every 10th
    // attempt to keep the common path cheap.
    if (attempt >= 10 && attempt % 10 === 0) {
      const scanned = findSessionDirAcrossCwds(options.agentSessionId);
      if (scanned) return scanned;
    }
    await sleep(500);
  }
  return findSessionDirAcrossCwds(options.agentSessionId);
}

/**
 * Scan `~/.grok/sessions/<any-cwd-key>/<sessionId>/updates.jsonl` for a
 * caller-owned session UUID. One readdir of the sessions root plus one
 * existsSync per cwd key - cheap, and unambiguous because the UUID is ours.
 */
function findSessionDirAcrossCwds(agentSessionId: string): string | null {
  const sessionsRoot = path.join(grokHomeDir(), 'sessions');
  let cwdKeys: string[];
  try {
    cwdKeys = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const cwdKey of cwdKeys) {
    const candidate = path.join(sessionsRoot, cwdKey, agentSessionId, 'updates.jsonl');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable entry (a file, a permissions issue) - skip.
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
