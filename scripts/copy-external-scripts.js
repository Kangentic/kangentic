const fs = require('fs');
const path = require('path');

// Single source of truth for "external scripts": raw .js/.mjs files that run
// OUTSIDE the esbuild bundle (agent CLI hooks / plugins) and therefore must be
// physically copied next to the bundle in `.vite/build/`. Both scripts/build.js
// (production) and scripts/dev.js (npm start / npm run dev) deploy these by
// calling copyExternalScripts(); see .claude/rules/external-scripts-parity.md.
//
// `name` is the resolver join key: it must match the literal passed to
// resolveBridgeScript('<name>') / resolvePluginScript('<adapter>', '<name>')
// in src/main/agent/shared/bridge-utils.ts. `destDir`/`destFile` are RELATIVE
// to `.vite/build` (no absolute paths) and mirror the resolver's first
// candidate layout: bridges -> <build>/<name>.js, plugins ->
// <build>/plugins/<adapter>/<name>.mjs.
const EXTERNAL_SCRIPTS = [
  {
    kind: 'bridge',
    name: 'status-bridge',
    src: 'src/main/agent/status-bridge.js',
    destDir: '',
    destFile: 'status-bridge.js',
  },
  {
    kind: 'bridge',
    name: 'event-bridge',
    src: 'src/main/agent/event-bridge.js',
    destDir: '',
    destFile: 'event-bridge.js',
  },
  {
    kind: 'bridge',
    name: 'plan-approval-bridge',
    src: 'src/main/agent/plan-approval-bridge.js',
    destDir: '',
    destFile: 'plan-approval-bridge.js',
  },
  {
    kind: 'bridge',
    name: 'background-shell-hint-bridge',
    src: 'src/main/agent/background-shell-hint-bridge.js',
    destDir: '',
    destFile: 'background-shell-hint-bridge.js',
  },
  {
    kind: 'plugin',
    adapter: 'opencode',
    name: 'kangentic-activity',
    src: 'src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs',
    destDir: 'plugins/opencode',
    destFile: 'kangentic-activity.mjs',
  },
];

// Copy every registered external script into `<projectDir>/.vite/build/`,
// creating destination subdirectories as needed. Idempotent: overwrites any
// existing copy so dev never runs a stale bridge.
function copyExternalScripts(projectDir) {
  const buildDir = path.join(projectDir, '.vite', 'build');
  for (const script of EXTERNAL_SCRIPTS) {
    const destFolder = path.join(buildDir, script.destDir);
    fs.mkdirSync(destFolder, { recursive: true });
    fs.copyFileSync(
      path.join(projectDir, script.src),
      path.join(destFolder, script.destFile),
    );
  }
}

module.exports = { EXTERNAL_SCRIPTS, copyExternalScripts };
