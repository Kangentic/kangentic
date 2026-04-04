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
