import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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

/**
 * The persistent, machine-global config dir (platform default), ignoring any
 * KANGENTIC_DATA_DIR / --data-dir override. The model cache resolves from this so
 * its immutable, shared weights survive per-instance data dirs (the ephemeral
 * preview, a relocated data dir) instead of re-downloading.
 */
export function getPlatformConfigDir(): string {
  const platform = process.platform;
  let base: string;
  if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return path.join(base, 'kangentic');
}

function getConfigDir(): string {
  // Priority: env var > CLI flag > platform default
  if (process.env.KANGENTIC_DATA_DIR) {
    return process.env.KANGENTIC_DATA_DIR;
  }

  const dataDirFromArgs = getDataDirFromArgs();
  if (dataDirFromArgs) {
    return dataDirFromArgs;
  }

  return getPlatformConfigDir();
}

export const PATHS = {
  configDir: getConfigDir(),
  // The model cache holds immutable, machine-global weights (hundreds of MB), so
  // it resolves from the persistent platform config dir, NOT the per-instance
  // data dir (KANGENTIC_DATA_DIR / --data-dir). The ephemeral preview and a
  // relocated data dir share one cache instead of re-downloading ~730 MB.
  modelCacheDir: path.join(getPlatformConfigDir(), 'models'),
  get globalDb() { return path.join(this.configDir, 'index.db'); },
  get configFile() { return path.join(this.configDir, 'config.json'); },
  get projectsDir() { return path.join(this.configDir, 'projects'); },
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

export function ensureDirs(): void {
  fs.mkdirSync(PATHS.configDir, { recursive: true });
  fs.mkdirSync(PATHS.projectsDir, { recursive: true });
  fs.mkdirSync(PATHS.modelsDir, { recursive: true });
}
