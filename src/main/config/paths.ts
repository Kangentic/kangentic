import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { markDataDirFailure, type DataDirKind, type DataDirOrigin } from './data-dir-failure';

function getDataDirFromArgs(): string | null {
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument.startsWith('--data-dir=')) {
      return argument.slice('--data-dir='.length);
    }
    if (argument === '--data-dir' && index + 1 < process.argv.length) {
      const nextArgument = process.argv[index + 1];
      if (!nextArgument.startsWith('-')) {
        return nextArgument;
      }
    }
  }
  return null;
}

/** A resolved directory and what decided it, read together so the two cannot disagree. */
interface ResolvedDir {
  dir: string;
  origin: DataDirOrigin;
}

function resolvePlatformConfigDir(): ResolvedDir {
  const platform = process.platform;
  let base: string;
  let origin: DataDirOrigin = 'home';
  if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    if (process.env.APPDATA) origin = 'appdata';
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    if (process.env.XDG_CONFIG_HOME) origin = 'appdata';
  }
  return { dir: path.join(base, 'kangentic'), origin };
}

/**
 * The persistent, machine-global config dir (platform default), ignoring any
 * KANGENTIC_DATA_DIR / --data-dir override. The model cache resolves from this so
 * its immutable, shared weights survive per-instance data dirs (the ephemeral
 * preview, a relocated data dir) instead of re-downloading.
 */
export function getPlatformConfigDir(): string {
  return resolvePlatformConfigDir().dir;
}

function resolveConfigDir(): ResolvedDir {
  // Priority: env var > CLI flag > platform default
  if (process.env.KANGENTIC_DATA_DIR) {
    return { dir: process.env.KANGENTIC_DATA_DIR, origin: 'env' };
  }

  const dataDirFromArgs = getDataDirFromArgs();
  if (dataDirFromArgs) {
    return { dir: dataDirFromArgs, origin: 'flag' };
  }

  return resolvePlatformConfigDir();
}

const resolvedConfigDir = resolveConfigDir();
const resolvedPlatformConfigDir = resolvePlatformConfigDir();

export const PATHS = {
  configDir: resolvedConfigDir.dir,
  configDirOrigin: resolvedConfigDir.origin,
  // The model cache holds immutable, machine-global weights (hundreds of MB), so
  // it resolves from the persistent platform config dir, NOT the per-instance
  // data dir (KANGENTIC_DATA_DIR / --data-dir). The ephemeral preview and a
  // relocated data dir share one cache instead of re-downloading ~730 MB.
  modelCacheDir: path.join(resolvedPlatformConfigDir.dir, 'models'),
  modelCacheDirOrigin: resolvedPlatformConfigDir.origin,
  get globalDb() { return path.join(this.configDir, 'index.db'); },
  get configFile() { return path.join(this.configDir, 'config.json'); },
  get projectsDir() { return path.join(this.configDir, 'projects'); },
  /** The folder standing in for a remote project on this computer (#913): its config, logs and session files. */
  remoteProjectShell(projectId: string) { return path.join(this.configDir, 'remote-projects', projectId); },
  /**
   * This computer's mirror of a remote host's home, where readers look. A remote session's transcript is
   * copied into it as the agent writes it (`remote-session-relay.ts`); nothing else is, and it holds no
   * proof that anything is absent on the host.
   */
  remoteHomeMirror(hostId: string) { return path.join(this.configDir, 'remote-homes', hostId); },
  /** Local archive of announcements this client has seen, and their read-state.
   *  A sidecar rather than a config.json key: it holds full markdown bodies,
   *  and read-state must survive an announcement leaving the active feed (see
   *  src/main/announcements-archive.ts). */
  get announcementsArchiveFile() { return path.join(this.configDir, 'announcements-archive.json'); },
  projectDb(projectId: string) { return path.join(this.projectsDir, `${projectId}.db`); },
  /** Downloaded voice-dictation models, one subdirectory per model id (global cache). */
  get modelsDir() { return this.modelCacheDir; },
  modelDir(modelId: string) { return path.join(this.modelCacheDir, modelId); },
  /** Root for the conversation-memory embedding model (transformers.js
   *  localModelPath); the model id nests below this. Shares the persistent
   *  model cache so it survives per-instance data-dir isolation. */
  get embeddingModelsDir() { return path.join(this.modelCacheDir, 'embeddings'); },
};

// Create one directory, recording which it was on the error before it goes on.
function ensureDir(directory: string, kind: DataDirKind, origin: DataDirOrigin): void {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    markDataDirFailure(error, { path: directory, kind, origin });
    throw error;
  }
}

// These mkdirSync calls deliberately throw, and each caller already has its own
// reason to see the failure: ConfigManager.load() wraps its call and degrades to
// defaults (write-failure-notice.ts); getGlobalDb()/getProjectDb() (db/database.ts)
// let it propagate, and the startup dialog reads the mark ensureDir leaves to say
// it is the data folder and not the database. Each call names its own origin
// because the models directory ignores KANGENTIC_DATA_DIR and --data-dir, so it
// can fail while the other two are healthy.
export function ensureDirs(): void {
  ensureDir(PATHS.configDir, 'config', PATHS.configDirOrigin);
  ensureDir(PATHS.projectsDir, 'projects', PATHS.configDirOrigin);
  ensureDir(PATHS.modelsDir, 'models', PATHS.modelCacheDirOrigin);
}
