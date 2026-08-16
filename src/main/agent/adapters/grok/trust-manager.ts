import fs from 'node:fs';
import path from 'node:path';
import { createSerialLock, atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import { grokHomeDir } from './session-paths';

/**
 * Grok Build folder-trust pre-approval.
 *
 * Grok gates project-level hooks AND project-level `[mcp_servers]` behind
 * its unified folder-trust store, `~/.grok/trusted_folders.toml`:
 *
 *   [folders.'C:\Users\dev\proj']
 *   trusted = true
 *   decided_at = 1786162868
 *
 * Untrusted folders do not prompt at spawn - project hooks and MCP are
 * SILENTLY SKIPPED (fail-open, verified: a config-less fresh dir launches
 * straight into the TUI). So without trust, a Kangentic-spawned session
 * simply loses hook-based activity (the `hooksAndPty` PTY fallback covers
 * it) and MCP tools.
 *
 * The load-bearing difference from Codex: grok trust CASCADES to
 * subdirectories (documented in 10-hooks.md, and verified live - a
 * Kangentic worktree under a trusted project root reports
 * `projectTrusted: true` with only the root in the store). That shapes the
 * policy here:
 *
 * - A worktree under an already-decided ancestor needs NOTHING (the
 *   common steady state: one root entry covers every future worktree).
 * - A worktree under an UNDECIDED project root gets its own entry
 *   (scoped exactly like Codex's per-worktree approval: the trust
 *   boundary is Kangentic itself - the user opened this project and the
 *   directory being approved is a worktree Kangentic created from it).
 *   `onWorktreeRemoved` drops that entry so the store tracks live
 *   worktrees (Codex's 473-dead-entries lesson).
 * - The PROJECT ROOT itself is never auto-trusted: an undecided root
 *   spawn runs untrusted (hooks silently off, PTY fallback carries
 *   activity), and the user's own first interactive grok session there
 *   decides it once, cascading to everything after. Kangentic never
 *   answers a trust question the user has not.
 * - An explicit ancestor `trusted = false` is always respected.
 */
const withTrustStoreLock = createSerialLock();

export async function ensureWorktreeTrust(workingDirectory: string): Promise<void> {
  return withTrustStoreLock(() => ensureWorktreeTrustSync(workingDirectory));
}

export async function removeWorktreeTrust(worktreePath: string): Promise<void> {
  return withTrustStoreLock(() => removeWorktreeTrustSync(worktreePath));
}

function trustStorePath(): string {
  return path.join(grokHomeDir(), 'trusted_folders.toml');
}

/** Recover the owning project root from the `/.kangentic/worktrees/` marker. */
function projectRootForWorktree(resolvedPath: string): string | null {
  const marker = `${path.sep}.kangentic${path.sep}worktrees${path.sep}`;
  const markerIndex = resolvedPath.indexOf(marker);
  return markerIndex === -1 ? null : resolvedPath.substring(0, markerIndex);
}

/**
 * Normalize for comparison: resolve, forward slashes, no trailing slash,
 * casefold on win32. Exported for `project-relocation.ts`, which compares
 * the same trust-store header paths (the Codex `config-toml.ts` precedent).
 */
export function normalizeForCompare(rawPath: string): string {
  let normalized = path.resolve(rawPath).replace(/\\/g, '/');
  normalized = normalized.replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

interface TrustEntry {
  folderPath: string;
  trusted: boolean | null;
}

/** Parse `[folders.'<path>']` headers and their `trusted` values. */
function parseTrustEntries(lines: string[]): TrustEntry[] {
  const entries: TrustEntry[] = [];
  let current: TrustEntry | null = null;
  for (const line of lines) {
    const header = parseHeaderLine(line);
    if (header) {
      current = { folderPath: header, trusted: null };
      entries.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (current) {
      const trustedMatch = line.match(/^\s*trusted\s*=\s*(true|false)\s*$/);
      if (trustedMatch) current.trusted = trustedMatch[1] === 'true';
    }
  }
  return entries;
}

/** Extract the quoted folder path from a `[folders.'...']` or `[folders."..."]` header line. */
function parseHeaderLine(line: string): string | null {
  const match = line.match(/^\s*\[folders\.(?:'([^']+)'|"([^"]+)")\]\s*$/);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** The decision covering `target`, honoring cascade (nearest decided ancestor wins). */
function decisionFor(entries: TrustEntry[], target: string): boolean | null {
  const normalizedTarget = normalizeForCompare(target);
  let bestPathLength = -1;
  let bestDecision: boolean | null = null;
  for (const entry of entries) {
    if (entry.trusted === null) continue;
    const normalizedEntry = normalizeForCompare(entry.folderPath);
    const covers = normalizedTarget === normalizedEntry
      || normalizedTarget.startsWith(`${normalizedEntry}/`);
    if (covers && normalizedEntry.length > bestPathLength) {
      bestPathLength = normalizedEntry.length;
      bestDecision = entry.trusted;
    }
  }
  return bestDecision;
}

function ensureWorktreeTrustSync(workingDirectory: string): void {
  const resolvedPath = path.resolve(workingDirectory);
  const projectRoot = projectRootForWorktree(resolvedPath);
  // Only a Kangentic worktree is ever pre-approved; a project root spawn
  // runs with whatever the user decided (or undecided = untrusted).
  if (!projectRoot) return;

  const storePath = trustStorePath();
  let content: string;
  try {
    content = fs.readFileSync(storePath, 'utf-8');
  } catch {
    content = '';
  }
  const entries = parseTrustEntries(content.split('\n'));

  // Cascade already answers for this path (a decided ancestor, or a prior
  // entry for the worktree itself, in either direction) - never overrule.
  if (decisionFor(entries, resolvedPath) !== null) return;

  // Single-quoted TOML literal keys cannot represent a path containing a
  // single quote; reserializing the user's file to switch quote styles is
  // not worth the risk (Codex precedent).
  if (resolvedPath.includes("'")) return;

  const decidedAt = Math.floor(Date.now() / 1000);
  const table = `[folders.'${resolvedPath}']\ntrusted = true\ndecided_at = ${decidedAt}\n`;
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';

  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.appendFileSync(storePath, `${separator}\n${table}`, 'utf-8');
  } catch (error) {
    // Best-effort: a failure only means project hooks/MCP stay silently
    // gated for this session. Never block the spawn.
    console.error('[grok] Failed to pre-approve folder trust', error);
  }
}

function removeWorktreeTrustSync(worktreePath: string): void {
  const storePath = trustStorePath();
  const target = normalizeForCompare(worktreePath);

  let content: string;
  try {
    content = fs.readFileSync(storePath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  let removed = false;
  let index = 0;

  while (index < lines.length) {
    const headerPath = parseHeaderLine(lines[index]);
    if (!headerPath || normalizeForCompare(headerPath) !== target) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^\s*\[/.test(lines[cursor])) {
      body.push(lines[cursor]);
      cursor += 1;
    }

    // Only a table Kangentic could have written is removed: `trusted` and
    // `decided_at` are also what grok's own prompt records, but anything
    // BEYOND those keys is unmistakably not ours and survives.
    const meaningful = body.filter((line) => line.trim().length > 0);
    const removable = meaningful.length > 0 && meaningful.every(
      (line) => /^\s*(trusted|decided_at)\s*=/.test(line),
    );
    if (!removable) {
      kept.push(lines[index], ...body);
    } else {
      removed = true;
      // Drop the blank separator line `ensureWorktreeTrustSync` wrote ahead
      // of the table. Scoped to the single preceding line.
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    }
    index = cursor;
  }

  if (!removed) return;

  // Full-file rewrite of a store the user owns - backup + temp + rename so
  // an interrupted write can never truncate every project's trust.
  atomicWriteFileWithBackup(storePath, kept.join('\n'), { logTag: '[GROK_TRUST]' });
}
