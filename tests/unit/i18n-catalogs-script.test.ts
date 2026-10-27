/**
 * scripts/i18n-catalogs.js, the Lingui catalog steps every build path shares
 * (scripts/build.js, scripts/build-demo.js, scripts/dev.js and the `i18n:*` npm
 * scripts). Three contracts here fail without ever failing a unit run of the
 * product code:
 *
 *  - The Node floor. Lingui 6 ships ESM only and needs Node 22.19 or newer, and
 *    release.yml asks setup-node for `22`, which resolves to whatever 22.x the
 *    runner image caches. The floor turns a too-old Node into a named failure
 *    instead of an ESM loader error.
 *  - The CLI's usage failure. A mistyped npm script must exit 1, not run nothing
 *    and pass.
 *  - The dev session's background compile NEVER rejects. scripts/dev.js awaits it
 *    only after the Vite server is up, and a rejection before that reaches its
 *    unhandledRejection handler and ends the boot. A Lingui CLI that cannot be
 *    found threw inside the Promise executor and rejected the promise, until the
 *    lookup moved inside a try/catch.
 *
 * The compile tests run against a stub `@lingui/cli` written into a temp project,
 * so no real catalog is compiled and nothing is written to .vite/build/locales.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface I18nCatalogsModule {
  assertNodeSupportsLingui(version?: string): void;
  compileCatalogsForMainInBackground(projectDir: string): Promise<boolean>;
}

const requireFromTest = createRequire(import.meta.url);
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/i18n-catalogs.js');
const { assertNodeSupportsLingui, compileCatalogsForMainInBackground } = requireFromTest(SCRIPT_PATH) as I18nCatalogsModule;

describe('assertNodeSupportsLingui', () => {
  it.each(['22.18.9', '22.0.0', '21.9.0', '20.19.0'])('refuses Node %s, below the 22.19.0 floor', (version) => {
    expect(() => assertNodeSupportsLingui(version)).toThrow(`Node ${version} is below 22.19.0`);
  });

  it.each(['22.19.0', '22.19.1', '22.20.1', '23.0.0', '24.1.0'])('accepts Node %s, at or above the floor', (version) => {
    expect(() => assertNodeSupportsLingui(version)).not.toThrow();
  });

  it('names the fix a workflow needs to make', () => {
    expect(() => assertNodeSupportsLingui('22.18.9')).toThrow(/node-version to 22\.19 or newer, or 24/);
  });
});

describe('node scripts/i18n-catalogs.js with an unknown command', () => {
  // Only commands that never reach the Lingui CLI run here, so no catalog is read or written.
  function runScript(commandArguments: string[]): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...commandArguments], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }

  it('exits 1 and prints the usage, naming the command it was given', () => {
    const { status, stderr } = runScript(['bogus']);
    expect(status).toBe(1);
    expect(stderr).toContain('Usage');
    expect(stderr).toContain('"bogus"');
  });

  it('exits 1 and prints the usage when no command is given', () => {
    const { status, stderr } = runScript([]);
    expect(status).toBe(1);
    expect(stderr).toContain('Usage');
  });
});

describe('compileCatalogsForMainInBackground', () => {
  let projectDir = '';

  // A stand-in for the real @lingui/cli: resolvable from the project (package.json with a `main`),
  // and its bin records the arguments it was spawned with, then exits with the code in exit-code.txt.
  const STUB_BIN_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'recorded-arguments.json'), JSON.stringify(process.argv.slice(2)));
process.exit(Number.parseInt(fs.readFileSync(path.join(__dirname, 'exit-code.txt'), 'utf8'), 10));
`;

  function installStubCli(options: { hasBin: boolean; exitCode?: number }): void {
    const cliDirectory = path.join(projectDir, 'node_modules', '@lingui', 'cli');
    fs.mkdirSync(cliDirectory, { recursive: true });
    const packageJson: Record<string, unknown> = { name: '@lingui/cli', version: '0.0.0', main: 'index.js' };
    if (options.hasBin) packageJson.bin = { lingui: 'cli.js' };
    fs.writeFileSync(path.join(cliDirectory, 'package.json'), JSON.stringify(packageJson));
    fs.writeFileSync(path.join(cliDirectory, 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(cliDirectory, 'cli.js'), STUB_BIN_SOURCE);
    fs.writeFileSync(path.join(cliDirectory, 'exit-code.txt'), String(options.exitCode ?? 0));
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-catalogs-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('resolves false, and never rejects, when the Lingui CLI cannot be resolved from the project', async ({ skip }) => {
    // require.resolve's `paths` still consults global folders ($HOME/.node_modules and the
    // like), so a machine that has the CLI there would find it. Nothing here would then
    // exercise the lookup failure, and the stub-package case below covers the same branch.
    let resolvableFromTemporaryDirectory = true;
    try {
      requireFromTest.resolve('@lingui/cli', { paths: [projectDir] });
    } catch {
      resolvableFromTemporaryDirectory = false;
    }
    if (resolvableFromTemporaryDirectory) skip();

    await expect(compileCatalogsForMainInBackground(projectDir)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find the Lingui CLI'), expect.any(String));
  });

  it('resolves false, and never rejects, when the CLI package names no lingui bin', async () => {
    // Deterministic on any machine: the project's own node_modules is searched before any
    // global folder, so the lookup finds this package and linguiCliPath throws on its bin.
    installStubCli({ hasBin: false });

    await expect(compileCatalogsForMainInBackground(projectDir)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find the Lingui CLI'), expect.stringContaining('names no lingui bin'));
  });

  it('resolves true after a compile that exits 0, spawning the non-strict compile in the project', async () => {
    installStubCli({ hasBin: true, exitCode: 0 });

    await expect(compileCatalogsForMainInBackground(projectDir)).resolves.toBe(true);
    // The dev session runs with messages not yet re-extracted, so it must not pass --strict.
    const recordedArguments = JSON.parse(fs.readFileSync(path.join(projectDir, 'recorded-arguments.json'), 'utf8')) as string[];
    expect(recordedArguments).toEqual(['compile', '--namespace', 'json']);
  });

  it('resolves false, warning with the exit code, after a compile that fails', async () => {
    installStubCli({ hasBin: true, exitCode: 3 });

    await expect(compileCatalogsForMainInBackground(projectDir)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lingui compile exited 3'));
  });
});
