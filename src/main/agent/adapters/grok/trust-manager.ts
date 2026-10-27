import fs from 'node:fs';
import path from 'node:path';
import { createSerialLock, atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import { cliPathForTarget, type CliPlace } from '../../shared/cli-target';
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
 *
 * A Grok installed in a WSL distro (`place`) keeps its store in the distro's
 * Grok home, keyed by the folder as the distro sees it (`/mnt/c/...`), and
 * compared as Linux compares paths: case included, nothing resolved.
 */
const withTrustStoreLock = createSerialLock();

export async function ensureWorktreeTrust(workingDirectory: string, place: CliPlace | null = null): Promise<void> {
  return withTrustStoreLock(() => ensureWorktreeTrustSync(workingDirectory, place));
}

/** The key Grok records a folder under: its resolved path, the distro's view of it for a Grok in a WSL distro. */
function trustKeyOf(folderPath: string, place: CliPlace | null): string {
  const resolvedPath = path.resolve(folderPath);
  return place ? cliPathForTarget(resolvedPath, place) : resolvedPath;
}

/**
 * Trust the Knowledge Graph's answer home, so an answer run's project-scoped
 * MCP server (the search tool) starts there.
 *
 * The same boundary as a worktree: a folder Kangentic created and owns, with
 * no user content in it. ONE entry for the one stable folder every answer run
 * starts in. `--trust` was the other way to start the server, and it records
 * the run's folder permanently: a trust entry per question.
 */
export async function ensureAnswerHomeTrust(answerHome: string, place: CliPlace | null = null): Promise<void> {
  return withTrustStoreLock(() => ensureFolderTrustSync(trustKeyOf(answerHome, place), place));
}

export async function removeWorktreeTrust(worktreePath: string, place: CliPlace | null = null): Promise<void> {
  return withTrustStoreLock(() => removeWorktreeTrustSync(worktreePath, place));
}

function trustStorePath(place: CliPlace | null): string {
  return path.join(grokHomeDir(place), 'trusted_folders.toml');
}

/**
 * Whether Grok trusts `workingDirectory`: the nearest decision covering it says
 * trusted. Undecided reads as untrusted, as Grok runs it. Grok records the
 * folder it runs in, which the OS reports with links resolved, so a decision
 * on the folder's real path wins over one on the path it was opened by (a
 * project opened as `/tmp/app` that Grok trusted as `/private/tmp/app`). Read
 * only; Kangentic never writes a decision for a folder that is not its own.
 */
export function isFolderTrusted(workingDirectory: string, place: CliPlace | null = null): boolean {
  let content: string;
  try {
    content = fs.readFileSync(trustStorePath(place), 'utf-8');
  } catch {
    return false;
  }
  const entries = parseTrustEntries(content.split('\n'));
  // A distro's Grok recorded the path it ran in, the distro's view of ours.
  if (place) return decisionFor(entries, trustKeyOf(workingDirectory, place), place) === true;
  let realPath: string | null = null;
  try {
    realPath = fs.realpathSync.native(workingDirectory);
  } catch {
    // A folder that is gone has no real path; its own path decides.
  }
  const realDecision = realPath ? decisionFor(entries, realPath) : null;
  return (realDecision ?? decisionFor(entries, path.resolve(workingDirectory))) === true;
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
 * A key in a WSL distro's store (`place`) is a Linux path as Grok wrote it:
 * only a trailing slash is dropped.
 */
export function normalizeForCompare(rawPath: string, place: CliPlace | null = null): string {
  if (place) return rawPath.replace(/\/+$/, '');
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
function decisionFor(entries: TrustEntry[], target: string, place: CliPlace | null = null): boolean | null {
  const normalizedTarget = normalizeForCompare(target, place);
  let bestPathLength = -1;
  let bestDecision: boolean | null = null;
  for (const entry of entries) {
    if (entry.trusted === null) continue;
    const normalizedEntry = normalizeForCompare(entry.folderPath, place);
    const covers = normalizedTarget === normalizedEntry
      || normalizedTarget.startsWith(`${normalizedEntry}/`);
    if (covers && normalizedEntry.length > bestPathLength) {
      bestPathLength = normalizedEntry.length;
      bestDecision = entry.trusted;
    }
  }
  return bestDecision;
}

function ensureWorktreeTrustSync(workingDirectory: string, place: CliPlace | null): void {
  const resolvedPath = path.resolve(workingDirectory);
  const projectRoot = projectRootForWorktree(resolvedPath);
  // Only a Kangentic worktree is ever pre-approved; a project root spawn
  // runs with whatever the user decided (or undecided = untrusted).
  if (!projectRoot) return;
  ensureFolderTrustSync(trustKeyOf(resolvedPath, place), place);
}

/** Record trust for exactly `resolvedPath` (a key in the store `place` names), unless a decision already covers it. */
function ensureFolderTrustSync(resolvedPath: string, place: CliPlace | null): void {
  const storePath = trustStorePath(place);
  let content: string;
  try {
    content = fs.readFileSync(storePath, 'utf-8');
  } catch {
    content = '';
  }
  const entries = parseTrustEntries(content.split('\n'));

  // Cascade already answers for this path (a decided ancestor, or a prior
  // entry for the worktree itself, in either direction) - never overrule.
  if (decisionFor(entries, resolvedPath, place) !== null) return;

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

function removeWorktreeTrustSync(worktreePath: string, place: CliPlace | null): void {
  const storePath = trustStorePath(place);
  const target = normalizeForCompare(place ? trustKeyOf(worktreePath, place) : worktreePath, place);

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
    if (!headerPath || normalizeForCompare(headerPath, place) !== target) {
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
