/**
 * External-scripts parity guard (see .claude/rules/external-scripts-parity.md).
 *
 * Some agent integration scripts (status-bridge.js, event-bridge.js, OpenCode's
 * kangentic-activity.mjs) run OUTSIDE the esbuild bundle as raw .js/.mjs injected
 * into the agent CLI, so they must be physically copied next to the bundle and
 * located at runtime by resolveBridgeScript / resolvePluginScript
 * (src/main/agent/shared/bridge-utils.ts), which return the first existing
 * candidate.
 *
 * This shipped as a bug: event-bridge.js source moved to a new directive format
 * while a stale `.vite/build/` copy still spoke the old format and silently
 * dropped every hook directive - because scripts/dev.js never copied the file
 * (only scripts/build.js did), so the stale dev copy permanently shadowed live
 * source. ExitPlanMode events went untagged and plan-exit auto-move broke.
 *
 * The copy list now lives once in scripts/copy-external-scripts.js. This test
 * (pure source analysis, no `.vite/build` needed - so it runs in CI) makes the
 * regression unmergeable by asserting:
 *   (a) every resolveBridgeScript/resolvePluginScript literal is registered, and
 *       resolver arguments are string literals (a non-literal would evade (a));
 *   (b) BOTH scripts/build.js and scripts/dev.js deploy via copyExternalScripts()
 *       - this is the invariant that catches the exact bug that happened;
 *   (c) each registered entry's source exists and destinations are unique;
 *   (d) each entry's destination matches the resolver's first-candidate layout.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXTERNAL_SCRIPTS } from '../../scripts/copy-external-scripts';

type ExternalScript = {
  kind: 'bridge' | 'plugin';
  name: string;
  adapter?: string;
  src: string;
  destDir: string;
  destFile: string;
};

const REPO_ROOT = path.resolve(__dirname, '../..');
const AGENT_DIR = path.join(REPO_ROOT, 'src/main/agent');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

const registered = EXTERNAL_SCRIPTS as ExternalScript[];
const registeredBridges = new Set(
  registered.filter((entry) => entry.kind === 'bridge').map((entry) => entry.name),
);
const registeredPlugins = new Set(
  registered.filter((entry) => entry.kind === 'plugin').map((entry) => `${entry.adapter}/${entry.name}`),
);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

type ResolverCall = { args: string; location: string };

// Collect every call to `fnName(...)` (args up to the first close paren),
// skipping the function's own definition line and comment lines. Nested parens
// in args would truncate, but the literal check below would then flag them as
// non-literal, which is the desired outcome.
function collectResolverCalls(fnName: string): ResolverCall[] {
  const callPattern = new RegExp(`\\b${fnName}\\s*\\(([^)]*)\\)`, 'g');
  const calls: ResolverCall[] = [];
  for (const filePath of collectSourceFiles(AGENT_DIR)) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (line.includes(`function ${fnName}`)) return; // the definition itself
      for (const match of line.matchAll(callPattern)) {
        calls.push({
          args: match[1].trim(),
          location: `${path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')}:${index + 1}`,
        });
      }
    });
  }
  return calls;
}

const BRIDGE_LITERAL = /^(['"])([^'"]+)\1$/;
const PLUGIN_LITERAL = /^(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3$/;

describe('external-scripts parity: resolver registration', () => {
  it('every resolveBridgeScript() call uses a string literal registered in EXTERNAL_SCRIPTS', () => {
    const nonLiteral: string[] = [];
    const unregistered: string[] = [];
    for (const call of collectResolverCalls('resolveBridgeScript')) {
      const literal = call.args.match(BRIDGE_LITERAL);
      if (!literal) {
        nonLiteral.push(`${call.location} -> resolveBridgeScript(${call.args})`);
        continue;
      }
      const name = literal[2];
      if (!registeredBridges.has(name)) {
        unregistered.push(`${call.location} -> '${name}'`);
      }
    }
    expect(
      nonLiteral,
      `resolveBridgeScript() must be called with a string literal so registration is statically `
        + `verifiable. Non-literal call(s):\n${nonLiteral.join('\n')}`,
    ).toEqual([]);
    expect(
      unregistered,
      `These resolveBridgeScript() names have no EXTERNAL_SCRIPTS entry, so dev/prod copy will `
        + `silently skip them. Add an entry in scripts/copy-external-scripts.js:\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  it('every resolvePluginScript() call uses string literals registered in EXTERNAL_SCRIPTS', () => {
    const nonLiteral: string[] = [];
    const unregistered: string[] = [];
    for (const call of collectResolverCalls('resolvePluginScript')) {
      const literal = call.args.match(PLUGIN_LITERAL);
      if (!literal) {
        nonLiteral.push(`${call.location} -> resolvePluginScript(${call.args})`);
        continue;
      }
      const key = `${literal[2]}/${literal[4]}`;
      if (!registeredPlugins.has(key)) {
        unregistered.push(`${call.location} -> '${key}'`);
      }
    }
    expect(
      nonLiteral,
      `resolvePluginScript() must be called with string literals so registration is statically `
        + `verifiable. Non-literal call(s):\n${nonLiteral.join('\n')}`,
    ).toEqual([]);
    expect(
      unregistered,
      `These resolvePluginScript() (adapter, name) pairs have no EXTERNAL_SCRIPTS entry, so `
        + `dev/prod copy will silently skip them. Add an entry in `
        + `scripts/copy-external-scripts.js:\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });
});

describe('external-scripts parity: deploy scripts', () => {
  // The exact regression guard: a deploy script that does not copy ships stale
  // (build.js) or never-refreshed (dev.js) external scripts. Do not delete
  // either assertion to silence a refactor - that reintroduces the original bug.
  it.each(['scripts/build.js', 'scripts/dev.js'])('%s deploys external scripts via copyExternalScripts()', (script) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, script), 'utf-8');
    expect(
      /require\(\s*['"]\.\/copy-external-scripts['"]\s*\)/.test(source),
      `${script} must require('./copy-external-scripts') (single source of truth for the copy list).`,
    ).toBe(true);
    expect(
      /copyExternalScripts\s*\(/.test(source),
      `${script} must call copyExternalScripts(projectDir). Without it, dev/prod runs stale `
        + `external scripts - the original dev-mode bridge bug.`,
    ).toBe(true);
  });
});

describe('external-scripts parity: packaged app', () => {
  // A hook runs `node <bridge>` with the system Node, which cannot read a file
  // inside app.asar. resolveBridgeScript rewrites the path to app.asar.unpacked,
  // so a script missing from asarUnpack is a path that does not exist in a
  // release build. The CLI treats a hook that fails to start as a non-blocking
  // error, so the feature the script carries (for browser-policy-bridge, the
  // Agent Browser deny) is off for every packaged install with no sign of it,
  // while dev and CI, which run from source, stay green.
  it('every registered external script is unpacked from the asar by electron-builder.yml', () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf-8');
    const section = config.match(/\nasarUnpack:\n([\s\S]*?)\nextraResources:/)?.[1] ?? '';
    const unpackEntries = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ''));
    expect(unpackEntries.length, 'could not read the asarUnpack list').toBeGreaterThan(0);

    const unpacked = (deployedPath: string): boolean => unpackEntries.some((entry) => (
      entry === deployedPath
      || (entry.endsWith('/**') && deployedPath.startsWith(entry.slice(0, -'**'.length)))
    ));
    const missing = registered
      .map((entry) => path.posix.join('.vite/build', entry.destDir, entry.destFile))
      .filter((deployedPath) => !unpacked(deployedPath));
    expect(
      missing,
      `These external scripts are copied into .vite/build but not listed in asarUnpack in `
        + `electron-builder.yml, so a packaged app's hook points at a file that does not exist:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

describe('external-scripts parity: registry integrity', () => {
  it('every registered entry has an existing source file', () => {
    const missing = registered
      .filter((entry) => !fs.existsSync(path.join(REPO_ROOT, entry.src)))
      .map((entry) => `${entry.name} -> ${entry.src}`);
    expect(missing, `EXTERNAL_SCRIPTS entries with a missing source file:\n${missing.join('\n')}`).toEqual([]);
  });

  it('destinations are unique (no entry clobbers another)', () => {
    const destinations = registered.map((entry) => path.posix.join(entry.destDir, entry.destFile));
    const duplicates = destinations.filter((dest, index) => destinations.indexOf(dest) !== index);
    expect(duplicates, `Duplicate EXTERNAL_SCRIPTS destinations:\n${duplicates.join('\n')}`).toEqual([]);
  });

  it('each entry destination matches the resolver first-candidate layout', () => {
    const mismatches: string[] = [];
    for (const entry of registered) {
      if (entry.kind === 'bridge') {
        // resolveBridgeScript: path.join(__dirname, `${name}.js`)
        if (entry.destDir !== '' || entry.destFile !== `${entry.name}.js`) {
          mismatches.push(`bridge '${entry.name}' must deploy to <build>/${entry.name}.js`);
        }
      } else {
        // resolvePluginScript: path.join(__dirname, 'plugins', adapter, `${name}.mjs`)
        if (entry.destDir !== `plugins/${entry.adapter}` || entry.destFile !== `${entry.name}.mjs`) {
          mismatches.push(`plugin '${entry.adapter}/${entry.name}' must deploy to <build>/plugins/${entry.adapter}/${entry.name}.mjs`);
        }
      }
    }
    expect(mismatches, `Destination layout diverges from the resolver candidate path:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
