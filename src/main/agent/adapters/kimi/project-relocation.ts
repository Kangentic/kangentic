import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { kimiWorkDirHash } from './work-dir-hash';
import { replacePathPrefix } from '../../../../shared/paths';
import {
  collectRelocationPairs,
  renameOrMergeDirectory,
  atomicWriteFileWithBackup,
  createSerialLock,
  type RelocationPathPair,
} from '../../shared/relocation-utils';

/**
 * Migrate Kimi CLI's per-project session data when a Kangentic project is
 * relocated.
 *
 * Kimi keys sessions to the absolute work-dir path, OUTSIDE the project folder:
 *   `~/.kimi/sessions/<md5(work_dir)>/<uuid>/...`
 * where the directory name is the md5 hex of the literal absolute work-dir
 * string (or `<kaos>_<md5>` for non-local kaos). Verified empirically (md5 of
 * the native path matched the real directory) and against kimi-cli's
 * `metadata.py`. `~/.kimi/kimi.json` holds `work_dirs: [{ path, kaos,
 * last_session_id }]` matched by literal string equality. Resume routes through
 * md5(cwd), so a move fully breaks it.
 *
 * The migration renames the md5 session directories (and any `<kaos>_<md5>`
 * variants) and rewrites the `work_dirs[].path` literals. The md5 is computed
 * over the resolved NATIVE-separator path: Kangentic spawns Kimi with a
 * forward-slashed `-w`, but Kimi normalizes it back to native before hashing, so
 * the on-disk hash matches the native form.
 *
 * Best-effort and non-destructive under a serial lock; kimi.json is backed up
 * and written atomically, directories renamed or merged (never deleted).
 */
const withKimiConfigLock = createSerialLock();

export async function migrateKimiProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  return withKimiConfigLock(() => migrateKimiProjectDataSync(oldProjectPath, newProjectPath));
}

interface WorkDirEntry {
  path: string;
  [key: string]: unknown;
}

const kimiJsonPath = (): string => path.join(os.homedir(), '.kimi', 'kimi.json');
const sessionsRoot = (): string => path.join(os.homedir(), '.kimi', 'sessions');

function migrateKimiProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const config = readKimiConfig();
  const workDirs = config.workDirs;

  const pairs = collectRelocationPairs(oldResolved, newResolved, workDirs.map((entry) => entry.path));
  for (const pair of pairs) {
    try {
      migrateSessionDirs(pair, workDirs);
    } catch (err) {
      console.warn(`[KIMI_RELOCATE] Failed to migrate sessions for ${pair.oldAbsolute}:`, err);
    }
  }

  rewriteKimiJson(config.raw, workDirs, oldResolved, newResolved);
}

function migrateSessionDirs(pair: RelocationPathPair, workDirs: WorkDirEntry[]): void {
  // Candidate literals whose md5 may name an on-disk session dir: our resolved
  // path plus any stored work_dirs literal that equals it under platform path
  // semantics (covers a differently-cased literal Kimi recorded).
  const literals = new Set<string>([pair.oldAbsolute]);
  for (const entry of workDirs) {
    if (path.relative(entry.path, pair.oldAbsolute) === '') literals.add(entry.path);
  }

  const newHash = kimiWorkDirHash(pair.newAbsolute);
  const root = sessionsRoot();

  let existingDirs: string[] = [];
  try {
    existingDirs = fs.readdirSync(root);
  } catch {
    // No sessions directory yet.
  }

  for (const literal of literals) {
    const oldHash = kimiWorkDirHash(literal);
    renameOrMergeDirectory(path.join(root, oldHash), path.join(root, newHash));

    // `<kaos>_<oldHash>` variants for non-local kaos.
    const variantPattern = new RegExp(`^(.+_)${oldHash}$`);
    for (const dirName of existingDirs) {
      const variantMatch = variantPattern.exec(dirName);
      if (!variantMatch) continue;
      renameOrMergeDirectory(path.join(root, dirName), path.join(root, `${variantMatch[1]}${newHash}`));
    }
  }
}

function readKimiConfig(): { raw: Record<string, unknown>; workDirs: WorkDirEntry[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(kimiJsonPath(), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const workDirsRaw = raw.work_dirs;
      const workDirs: WorkDirEntry[] = Array.isArray(workDirsRaw)
        ? workDirsRaw.filter(
            (entry): entry is WorkDirEntry =>
              entry !== null && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string',
          )
        : [];
      return { raw, workDirs };
    }
  } catch {
    // Missing or unparsable kimi.json: still migrate session dirs by resolved path.
  }
  return { raw: {}, workDirs: [] };
}

function rewriteKimiJson(
  raw: Record<string, unknown>,
  workDirs: WorkDirEntry[],
  oldResolved: string,
  newResolved: string,
): void {
  if (!Array.isArray(raw.work_dirs)) return; // Nothing parseable to rewrite.

  let changed = false;
  for (const entry of workDirs) {
    const rewritten = replacePathPrefix(entry.path, oldResolved, newResolved);
    if (rewritten && rewritten !== entry.path) {
      entry.path = rewritten;
      changed = true;
    }
  }
  if (!changed) return;

  atomicWriteFileWithBackup(kimiJsonPath(), JSON.stringify(raw, null, 2), { logTag: '[KIMI_RELOCATE]' });
}
