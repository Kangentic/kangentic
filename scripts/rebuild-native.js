// Rebuild only better-sqlite3 against Electron's Node headers.
// node-pty ships NAPI prebuilts and must NOT be rebuilt (winpty's
// GetCommitHash.bat breaks on Windows).
//
// @electron/rebuild v4 is ESM-only, so we use dynamic import().
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const electronVersion = require(path.join(projectDir, 'node_modules', 'electron', 'package.json')).version;

import('@electron/rebuild').then(({ rebuild }) => {
  return rebuild({
    buildPath: projectDir,
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3'],
  });
}).then(() => {
  console.log('[rebuild] better-sqlite3 rebuilt for Electron', electronVersion);
}).catch((err) => {
  console.error('[rebuild] Failed:', err);
  process.exit(1);
});
