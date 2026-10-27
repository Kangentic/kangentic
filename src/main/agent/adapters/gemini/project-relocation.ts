import * as fs from 'node:fs';
import * as path from 'node:path';
import { geminiHomeDir } from './gemini-home';
import { replacePathPrefix } from '../../../../shared/paths';
import {
  collectRelocationPairs,
  renameOrMergeDirectory,
  atomicWriteFileWithBackup,
  createSerialLock,
  type RelocationPathPair,
} from '../../shared/relocation-utils';

/**
 * Migrate Gemini CLI's per-project data when a Kangentic project is relocated.
 *
 * Gemini keys per-project data to the absolute path through an authoritative
 * registry, all OUTSIDE the project folder:
 *
 * 1. `~/.gemini/projects.json` -> `{ projects: { "<resolved, lowercased-on-win32
 *    path>": "<slug>" } }` maps each project path to a short directory slug.
 * 2. `~/.gemini/tmp/<slug>/` and `~/.gemini/history/<slug>/` hold chats and
 *    shell history; each carries a `.project_root` marker file naming the path.
 * 3. `~/.gemini/trustedFolders.json` maps absolute paths to trust levels, with
 *    keys observed in MIXED separator/case forms.
 *
 * Because the registry keys on the absolute path, ANY move or rename (not just
 * a basename change) orphans the project: Gemini then claims a fresh empty slug.
 * The migration rewrites the registry key and the `.project_root` markers and
 * trust keys. When the basename changes and the new-basename slug directories
 * are free, it additionally renames the slug directories so Kangentic's own
 * basename-keyed chat locator keeps finding them; when that target slug is taken,
 * it keeps the old slug (Gemini still resolves via the registry, but Kangentic's
 * basename locator cannot find the old chats - a pre-existing Gemini
 * basename-collision limitation, not introduced here).
 *
 * Best-effort and non-destructive under a serial lock; the JSON files are backed
 * up and written atomically, every step independently guarded.
 */
const withGeminiGlobalConfigLock = createSerialLock();

export async function migrateGeminiProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  return withGeminiGlobalConfigLock(() => migrateGeminiProjectDataSync(oldProjectPath, newProjectPath));
}

const geminiDir = (): string => geminiHomeDir();
const projectsJsonPath = (): string => path.join(geminiDir(), 'projects.json');
const trustedFoldersPath = (): string => path.join(geminiDir(), 'trustedFolders.json');
const SLUG_ROOTS = ['tmp', 'history'] as const;

function migrateGeminiProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const registry = readProjectsRegistry();
  const pairs = collectRelocationPairs(oldResolved, newResolved, Object.keys(registry));

  // Accumulate registry key rewrites (oldKey -> { newKey, newSlug }) so the file
  // is rebuilt once at the end, preserving entry order.
  const keyRewrites = new Map<string, { newKey: string; newSlug: string }>();

  for (const pair of pairs) {
    try {
      migratePair(pair, registry, keyRewrites);
    } catch (err) {
      console.warn(`[GEMINI_RELOCATE] Failed to migrate ${pair.oldAbsolute}:`, err);
    }
  }

  if (keyRewrites.size > 0) rewriteProjectsRegistry(registry, keyRewrites);
  rewriteTrustedFolders(oldResolved, newResolved);
}

function migratePair(
  pair: RelocationPathPair,
  registry: Record<string, string>,
  keyRewrites: Map<string, { newKey: string; newSlug: string }>,
): void {
  const oldKey = findRegistryKey(registry, pair.oldAbsolute);
  const oldSlug = (oldKey && registry[oldKey]) || path.basename(pair.oldAbsolute).toLowerCase();
  const newSlug = path.basename(pair.newAbsolute).toLowerCase();

  let slugDir = oldSlug;
  if (newSlug !== oldSlug && slugTargetsFree(newSlug)) {
    for (const root of SLUG_ROOTS) {
      renameOrMergeDirectory(path.join(geminiDir(), root, oldSlug), path.join(geminiDir(), root, newSlug));
    }
    slugDir = newSlug;
  }

  for (const root of SLUG_ROOTS) {
    rewriteProjectRootMarker(path.join(geminiDir(), root, slugDir, '.project_root'), pair.oldAbsolute, pair.newAbsolute);
  }

  if (oldKey) {
    keyRewrites.set(oldKey, { newKey: mirrorPathStyle(oldKey, pair.newAbsolute), newSlug: slugDir });
  }
}

/** True when neither `tmp/<slug>` nor `history/<slug>` already exists. */
function slugTargetsFree(slug: string): boolean {
  return SLUG_ROOTS.every((root) => !fs.existsSync(path.join(geminiDir(), root, slug)));
}

function readProjectsRegistry(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const projects = (parsed as Record<string, unknown>).projects;
      if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
          if (typeof value === 'string') result[key] = value;
        }
        return result;
      }
    }
  } catch {
    // Missing or unparsable: no registry to migrate.
  }
  return {};
}

/** Find the registry key that resolves to the given absolute path, or null. */
function findRegistryKey(registry: Record<string, string>, absolute: string): string | null {
  for (const key of Object.keys(registry)) {
    if (path.relative(key, absolute) === '') return key;
  }
  return null;
}

function rewriteProjectRootMarker(markerPath: string, oldAbsolute: string, newAbsolute: string): void {
  let content: string;
  try {
    content = fs.readFileSync(markerPath, 'utf-8');
  } catch {
    return; // No marker for this slug.
  }
  const trailingNewline = content.endsWith('\n') ? '\n' : '';
  const rewritten = replacePathPrefix(content.trim(), path.resolve(oldAbsolute), path.resolve(newAbsolute));
  if (!rewritten) return;
  atomicWriteFileWithBackup(markerPath, mirrorPathStyle(content.trim(), rewritten) + trailingNewline, {
    backup: false,
    logTag: '[GEMINI_RELOCATE]',
  });
}

function rewriteProjectsRegistry(
  registry: Record<string, string>,
  keyRewrites: Map<string, { newKey: string; newSlug: string }>,
): void {
  const rebuilt: Record<string, string> = {};
  for (const [key, value] of Object.entries(registry)) {
    const rewrite = keyRewrites.get(key);
    if (!rewrite) {
      if (!(key in rebuilt)) rebuilt[key] = value;
      continue;
    }
    if (rewrite.newKey in registry || rewrite.newKey in rebuilt) continue; // Destination already present.
    rebuilt[rewrite.newKey] = rewrite.newSlug;
  }
  atomicWriteFileWithBackup(projectsJsonPath(), JSON.stringify({ projects: rebuilt }, null, 2), {
    logTag: '[GEMINI_RELOCATE]',
  });
}

function rewriteTrustedFolders(oldResolved: string, newResolved: string): void {
  let entries: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    entries = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const rewrites = new Map<string, string>();
  for (const key of Object.keys(entries)) {
    const rewritten = replacePathPrefix(key, oldResolved, newResolved);
    if (rewritten) rewrites.set(key, mirrorPathStyle(key, rewritten));
  }
  if (rewrites.size === 0) return;

  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const target = rewrites.get(key);
    if (!target) {
      if (!(key in rebuilt)) rebuilt[key] = value;
      continue;
    }
    if (target in entries || target in rebuilt) continue;
    rebuilt[target] = value;
  }
  atomicWriteFileWithBackup(trustedFoldersPath(), JSON.stringify(rebuilt, null, 2), { logTag: '[GEMINI_RELOCATE]' });
}

/**
 * Re-emit `targetPath` in the separator and case style of `template`. Gemini
 * stores keys in mixed forms (backslash native, forward-slash lowercased), so
 * the rewritten key must match the original convention for the CLI's
 * normalize-and-compare lookup to keep matching. Case mirroring is gated to
 * win32 (POSIX paths are case-sensitive, so an all-lowercase template there is
 * a coincidence we must not impose on the new path).
 */
function mirrorPathStyle(template: string, targetPath: string): string {
  const usesForwardSlashOnly = template.includes('/') && !template.includes('\\');
  let result = usesForwardSlashOnly ? targetPath.replace(/\\/g, '/') : targetPath;
  if (process.platform === 'win32' && template === template.toLowerCase()) {
    result = result.toLowerCase();
  }
  return result;
}
