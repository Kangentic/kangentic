import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A convention scan over `src/main` for the agent-account wiring (task #1057):
 *  - the PTY env is built through `buildSessionEnv` only, so the account's env always reaches it;
 *  - a file that builds an agent command also resolves the account for it;
 *  - every account resolution is skipped for a WSL CLI target (`cliTarget ? null :`), which keeps
 *    its single login because an account folder cannot link into a distro's home;
 *  - a background session is stopped through `stopBackgroundSessionOnAccount`, so the stop runs
 *    with the session's account env.
 * Each detector is also driven over known-bad text, so a regex that stops matching fails here.
 */
const SRC = path.resolve(__dirname, '../../src/main');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function relative(file: string): string {
  return path.relative(SRC, file).replace(/\\/g, '/');
}

const BUILD_ENV_CALL = /\.buildEnv\s*(?:\?\.)?\s*\(/;
const BUILD_COMMAND_CALL = /\.buildCommand\s*\(/;
const RESOLVE_CALL = /\bresolveSpawnAccount\s*\(/g;
const GUARDED_RESOLVE = /cliTarget\s*\?\s*null\s*:\s*await\s+resolveSpawnAccount\s*\(/g;
const STOP_BACKGROUND_CALL = /\.stopBackgroundSession\s*\(/;

/** The resolution call sites that are not behind the WSL guard. */
function unguardedResolveCount(source: string): number {
  const code = stripComments(source);
  const total = (code.match(RESOLVE_CALL) ?? []).length;
  const guarded = (code.match(GUARDED_RESOLVE) ?? []).length;
  return total - guarded;
}

const files = listSourceFiles(SRC).map((file) => ({ file: relative(file), code: stripComments(fs.readFileSync(file, 'utf8')) }));

describe('the detectors fire on known-bad text', () => {
  it('buildEnv call forms', () => {
    expect(BUILD_ENV_CALL.test('const env = adapter.buildEnv?.(options);')).toBe(true);
    expect(BUILD_ENV_CALL.test('const env = adapter.buildEnv(options);')).toBe(true);
    expect(BUILD_ENV_CALL.test('const env = buildSessionEnv(adapter, options);')).toBe(false);
  });

  it('comments are not code', () => {
    expect(BUILD_ENV_CALL.test(stripComments('// adapter.buildEnv?.(options)\n/* adapter.buildEnv(x) */'))).toBe(false);
  });

  it('an unguarded resolution is counted, a guarded one is not', () => {
    expect(unguardedResolveCount('account: await resolveSpawnAccount(agent),')).toBe(1);
    expect(unguardedResolveCount('account: cliTarget ? null : await resolveSpawnAccount(agent),')).toBe(0);
    expect(unguardedResolveCount('account: cliTarget ? null : await resolveSpawnAccount(\n a,\n),\nconst x = await resolveSpawnAccount(b);')).toBe(1);
  });

  it('a direct background stop and a buildCommand call are matched', () => {
    expect(STOP_BACKGROUND_CALL.test('await adapter.stopBackgroundSession(options)')).toBe(true);
    expect(BUILD_COMMAND_CALL.test('const command = adapter.buildCommand(options);')).toBe(true);
  });
});

describe('agent-account spawn wiring', () => {
  it('only account-env.ts builds the adapter env', () => {
    const offenders = files.filter(({ file, code }) => file !== 'accounts/account-env.ts' && BUILD_ENV_CALL.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
    expect(files.some(({ file, code }) => file === 'accounts/account-env.ts' && BUILD_ENV_CALL.test(code))).toBe(true);
  });

  it('every file that builds a command resolves the account', () => {
    const builders = files.filter(({ code }) => BUILD_COMMAND_CALL.test(code));
    expect(builders.map(({ file }) => file).sort()).toEqual([
      'ipc/handlers/transient-sessions.ts',
      'transition-engine/session-startup/prepare-spawn.ts',
      'transition-engine/transition-engine.ts',
      'workflows/workflow-agent.ts',
    ]);
    const missing = builders.filter(({ code }) => !/\bresolveSpawnAccount\s*\(/.test(code));
    expect(missing.map(({ file }) => file)).toEqual([]);
  });

  it('every resolution call is behind the cliTarget guard', () => {
    const resolvers = files.filter(({ file, code }) => file !== 'accounts/account-service.ts' && /\bresolveSpawnAccount\s*\(/.test(code));
    expect(resolvers.length).toBeGreaterThanOrEqual(4);
    const unguarded = resolvers.filter(({ code }) => unguardedResolveCount(code) !== 0).map(({ file }) => file);
    expect(unguarded).toEqual([]);
  });

  it('no file stops a background session on the adapter directly', () => {
    const offenders = files
      .filter(({ file, code }) => !file.startsWith('agent/adapters/') && file !== 'accounts/account-background-stop.ts' && STOP_BACKGROUND_CALL.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the three background-stop callers go through stopBackgroundSessionOnAccount', () => {
    for (const name of ['ipc/helpers/command-terminal-background-session.ts', 'transition-engine/resume-id-reconcile.ts', 'ipc/helpers/task-cleanup.ts']) {
      const entry = files.find(({ file }) => file === name);
      expect(entry, name).toBeDefined();
      expect(entry?.code, name).toMatch(/stopBackgroundSessionOnAccount\s*\(/);
    }
  });
});
