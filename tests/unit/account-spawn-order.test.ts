import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A folder account's `.claude.json` takes its trust entries from the default home when the
 * account folder is refreshed, and the refresh runs inside `resolveSpawnAccount`. So at every
 * spawn site the adapter's `ensureTrust` (which writes the new cwd's trust into the default home)
 * must run first, or a session on a second account opens on a trust prompt no automated session
 * can answer. A line-order scan, like spawn-entry-point-parity's: it proves order, not control flow.
 */
const SRC = path.resolve(__dirname, '../../src/main');

function callSitesOf(source: string, pattern: RegExp): number[] {
  return [...source.matchAll(pattern)].map((match) => match.index ?? 0);
}

function filesCalling(directory: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesCalling(full, needle));
    else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes(needle)) found.push(full);
  }
  return found;
}

describe('account resolution runs after ensureTrust', () => {
  const callers = filesCalling(SRC, 'resolveSpawnAccount(')
    .filter((file) => !file.endsWith(path.join('accounts', 'account-service.ts')));

  it('finds the four spawn sites', () => {
    expect(callers.map((file) => path.basename(file)).sort()).toEqual(
      ['prepare-spawn.ts', 'transient-sessions.ts', 'transition-engine.ts', 'workflow-agent.ts'],
    );
  });

  it.each(callers.map((file) => [path.basename(file), file]))('%s writes trust before it resolves the account', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    const trustCalls = callSitesOf(source, /\.ensureTrust\(/g);
    const firstTrust = Math.min(...trustCalls);
    expect(trustCalls.length).toBeGreaterThan(0);
    if (path.basename(file) === 'transition-engine.ts') {
      // resolveLaunch is defined above the spawn methods; what matters is that every CALL of it
      // follows a trust write in the same method.
      for (const call of callSitesOf(source, /this\.resolveLaunch\(/g)) {
        expect(trustCalls.some((trust) => trust < call), `resolveLaunch at offset ${call}`).toBe(true);
      }
      return;
    }
    for (const call of callSitesOf(source, /resolveSpawnAccount\(/g)) {
      expect(call).toBeGreaterThan(firstTrust);
    }
  });
});
