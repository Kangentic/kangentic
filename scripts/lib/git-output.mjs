/**
 * Run git in a directory and return its trimmed stdout, for the demo capture scripts that read a
 * repository (scripts/capture-demo-archived-runs.mjs, scripts/capture-demo-knowledge-graph.mjs).
 * Long paths stay on for every call, since an upstream sample's old tree can be deep and a reset or
 * checkout walks the whole of it on Windows.
 */
import { execFileSync } from 'node:child_process';

export function gitOutput(cwd, args) {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
