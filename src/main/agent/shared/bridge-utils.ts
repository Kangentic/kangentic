import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a bridge script path using the standard 3-candidate pattern:
 * 1. Production build (next to main bundle)
 * 2. Dev build (.vite/build/ -> project root)
 * 3. Fallback from CWD
 */
export function resolveBridgeScript(name: string): string {
  const candidates = [
    path.join(__dirname, `${name}.js`),
    path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', `${name}.js`),
    path.resolve(process.cwd(), 'src', 'main', 'agent', `${name}.js`),
  ];
  const resolved = candidates.find(p => fs.existsSync(p)) || candidates[0];
  // Bridge scripts run in an external node process (Claude Code hooks), which
  // cannot read files inside an asar archive. In production builds the scripts
  // are unpacked via asarUnpack, so rewrite the path to the unpacked location.
  if (resolved.includes('app.asar')) {
    return resolved.replace('app.asar', 'app.asar.unpacked');
  }
  return resolved;
}

/**
 * Resolve an adapter-owned plugin script path using the same 3-candidate
 * pattern as `resolveBridgeScript`. Plugin files live alongside their
 * adapter under `adapters/<adapterName>/plugin/<name>.mjs` in source,
 * and get copied into `.vite/build/plugins/<adapterName>/` by the build
 * step so production resolution mirrors source layout.
 *
 * Used by adapters whose target CLI loads ESM plugins from a project
 * directory (e.g. OpenCode's `.opencode/plugins/`). Kangentic copies
 * the resolved file into the project at spawn time.
 */
export function resolvePluginScript(adapterName: string, name: string): string {
  const candidates = [
    path.join(__dirname, 'plugins', adapterName, `${name}.mjs`),
    path.resolve(
      __dirname,
      '..',
      '..',
      'src',
      'main',
      'agent',
      'adapters',
      adapterName,
      'plugin',
      `${name}.mjs`,
    ),
    path.resolve(
      process.cwd(),
      'src',
      'main',
      'agent',
      'adapters',
      adapterName,
      'plugin',
      `${name}.mjs`,
    ),
  ];
  const resolved = candidates.find(p => fs.existsSync(p)) || candidates[0];
  if (resolved.includes('app.asar')) {
    return resolved.replace('app.asar', 'app.asar.unpacked');
  }
  return resolved;
}
