/**
 * The dev-build caller attribution on every simple-git client
 * (`openSimpleGit` -> `withCallerAttribution`, src/main/git/simple-git-client.ts).
 *
 * The wrapper is a Proxy over the whole client and exists only when
 * `__KANGENTIC_DEV__` is true, which vitest pins to false (vitest.config.mts), so
 * `simple-git-client.test.ts` never reaches it. Yet every git call the team's
 * dogfooded `npm start` makes goes through it, chained calls
 * (`git.cwd(dir).raw(...)`) included. A chain that handed back the raw client
 * would silently drop attribution for the rest of the chain, and a proxy that
 * broke a method would break git in dev only.
 *
 * So this builds the real source with the flag true (the way
 * `pty-host-boundary.test.ts` builds the host in dev) and runs the bundle.
 * simple-git is bundled in, so the bundle needs nothing resolved around it.
 *
 * Tier: Unit. Runs real git in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import type { SimpleGit } from 'simple-git';

const REPO_ROOT = path.resolve(__dirname, '../..');

interface DevBundle {
  openSimpleGit: (directory: string) => SimpleGit;
  storedSpawnCaller: () => string | undefined;
}

let scratch: string;
let repository: string;
let bundle: DevBundle;

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-git-attribution-')));
  repository = path.join(scratch, 'repo');
  fs.mkdirSync(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });

  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { openSimpleGit } from './src/main/git/simple-git-client';",
        "export { storedSpawnCaller } from './src/main/diagnostics/spawn-caller';",
      ].join('\n'),
      resolveDir: REPO_ROOT,
      sourcefile: 'dev-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    define: { __KANGENTIC_DEV__: 'true' },
    write: false,
    logLevel: 'silent',
  });
  const bundlePath = path.join(scratch, 'dev-bundle.cjs');
  fs.writeFileSync(bundlePath, result.outputFiles[0].text);
  bundle = createRequire(bundlePath)(bundlePath) as DevBundle;
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('openSimpleGit in a dev build', () => {
  it('still runs git through the wrapper: methods return what they returned unwrapped', async () => {
    const client = bundle.openSimpleGit(repository);

    const toplevel = (await client.revparse(['--show-toplevel'])).trim();
    expect(fs.realpathSync(toplevel)).toBe(repository);
    expect((await client.raw(['rev-parse', '--git-dir'])).trim()).toBe('.git');
  });

  it('hands the wrapper back from a method that returns the client, not the raw client underneath', () => {
    const client = bundle.openSimpleGit(repository);
    // `outputHandler` returns `this`; through the wrapper that must still be the wrapper.
    expect(client.outputHandler(() => undefined)).toBe(client);
  });

  it('records a caller for the spawn, across the scheduler\'s awaits, and clears it afterwards', async () => {
    const callersSeenAtSpawn: Array<string | undefined> = [];
    const client = bundle.openSimpleGit(repository);
    // simple-git runs the output handler when it starts the process, behind its own await.
    client.outputHandler(() => {
      callersSeenAtSpawn.push(bundle.storedSpawnCaller());
    });

    await client.revparse(['--show-toplevel']);

    expect(callersSeenAtSpawn).toHaveLength(1);
    expect(typeof callersSeenAtSpawn[0]).toBe('string');
    expect(callersSeenAtSpawn[0]).not.toBe('');
    // The storage was scoped to the call: nothing leaks to the code after it.
    expect(bundle.storedSpawnCaller()).toBeUndefined();
  });

  it('keeps attributing a call made on what a chained method returned', async () => {
    const callersSeenAtSpawn: Array<string | undefined> = [];
    const client = bundle.openSimpleGit(repository);

    // `outputHandler(...)` returns the client; the `.revparse` after it must still be traced.
    await client
      .outputHandler(() => {
        callersSeenAtSpawn.push(bundle.storedSpawnCaller());
      })
      .revparse(['--show-toplevel']);

    expect(callersSeenAtSpawn).toHaveLength(1);
    expect(typeof callersSeenAtSpawn[0]).toBe('string');
  });
});
