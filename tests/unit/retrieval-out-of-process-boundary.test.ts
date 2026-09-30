import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Enforces .claude/rules/retrieval-out-of-process.md: the retrieval index is
 * read and written only by the `kangentic-retrieval` utility process.
 *
 * The worker runs where `electron`'s main-only modules do not exist (`app`,
 * `ipcMain`, `BrowserWindow`), so a module in its graph that reaches for them
 * at load time kills the worker on every fork, and one that reaches for them
 * later fails the call that needed it. Analytics and Sentry are main-only for
 * the same reason. So the worker's bundle, built the way scripts/build.js
 * builds it, must hold none of them.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKER_ENTRY = 'src/main/retrieval/worker/retrieval-worker.ts';
const WORKER_OUTPUT = '.vite/build/retrieval-worker.js';
const CLIENT_FILE = 'src/main/retrieval/retrieval-client.ts';

function readEsbuildExternals(): string[] {
  const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
  const match = buildSource.match(/external:\s*\[([^\]]*)\]/);
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

async function bundleInputs(entry: string): Promise<esbuild.Metafile['inputs']> {
  const result = await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: readEsbuildExternals(),
    conditions: ['require'],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''),
      MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      __KANGENTIC_DEV__: 'true',
    },
    entryPoints: [path.join(REPO_ROOT, entry)],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return result.metafile.inputs;
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(fullPath));
    else if (entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

describe('retrieval out-of-process boundary', () => {
  it('builds the retrieval worker as its own entry in both build.js and dev.js', () => {
    for (const scriptName of ['build.js', 'dev.js']) {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', scriptName), 'utf-8');
      expect(source, `scripts/${scriptName} must build ${WORKER_ENTRY} as its own entry`).toContain(WORKER_ENTRY);
      expect(source, `scripts/${scriptName} must output ${WORKER_OUTPUT}`).toContain(WORKER_OUTPUT);
    }
  });

  it('keeps electron, analytics, Sentry and the IPC layer out of the worker bundle', async () => {
    const inputs = await bundleInputs(WORKER_ENTRY);
    const offenders: string[] = [];
    for (const [input, info] of Object.entries(inputs)) {
      const normalized = input.replace(/\\/g, '/');
      if (/src\/main\/(analytics|ipc|pop-out)\//.test(normalized)) offenders.push(`${normalized} (main-only module)`);
      if (/node_modules\/(@sentry|@aptabase)\//.test(normalized)) offenders.push(`${normalized} (main-only package)`);
      for (const imported of info.imports) {
        if (imported.path === 'electron') offenders.push(`${normalized} imports electron`);
      }
    }
    expect(
      offenders,
      `The retrieval worker's graph reaches main-only code. Trace each from ${WORKER_ENTRY} and move `
        + `the main-only part behind the client, or pass what it needs in the call:\n${offenders.join('\n')}`,
    ).toEqual([]);
    // Not vacuous: the worker does bundle the retrieval store.
    expect(Object.keys(inputs).some((input) => input.replace(/\\/g, '/').endsWith('src/main/retrieval/retrieval-store.ts'))).toBe(true);
  }, 30_000);

  it('constructs RetrievalClient only in retrieval-client.ts', () => {
    const offenders: string[] = [];
    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, 'src/main'))) {
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (relativePath === CLIENT_FILE) continue;
      fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line, index) => {
        if (/\bnew RetrievalClient\s*\(/.test(line)) offenders.push(`${relativePath}:${index + 1}`);
      });
    }
    expect(offenders, `Use the shared retrievalClient from ${CLIENT_FILE}. Offenders:\n${offenders.join('\n')}`).toEqual([]);
  });
});
