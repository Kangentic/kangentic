import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/vite-prebundle.js, the short-lived child a worktree preview runs so its dev server
 * starts on a warm Vite cache, and the part of scripts/dev.js that runs it.
 *
 * The script's exit contract is checked by running it. dev.js cannot be required into a test
 * (it writes a PID file and starts a watcher at module load), so its side is a static scan of
 * comment-stripped source, the way dev-restart-channel.test.ts reads it. Every marker index is
 * checked against -1 before two are compared, because indexOf returns -1 for a missing marker
 * and -1 is less than everything.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const PREBUNDLE_PATH = path.join(REPO_ROOT, 'scripts', 'vite-prebundle.js');

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Comment-only lines removed, so prose that names a call cannot satisfy a scan. */
function withoutComments(source: string): string {
  return source.split('\n').filter((line) => !isCommentLine(line)).join('\n');
}

const DEV_JS_CODE = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf-8'));
const PREBUNDLE_CODE = withoutComments(fs.readFileSync(PREBUNDLE_PATH, 'utf-8'));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireMatch(pattern: RegExp, source: string, description: string): RegExpExecArray {
  const match = pattern.exec(source);
  if (!match) throw new Error(`expected to find ${description}`);
  return match;
}

/** The `{ ... }` block that opens at `openBraceIndex`, braces included. */
function blockFrom(source: string, openBraceIndex: number, description: string): string {
  let braceDepth = 0;
  for (let sourceIndex = openBraceIndex; sourceIndex < source.length; sourceIndex += 1) {
    const character = source[sourceIndex];
    if (character === '{') braceDepth += 1;
    else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(openBraceIndex, sourceIndex + 1);
    }
  }
  throw new Error(`unbalanced braces in ${description}`);
}

function extractFunctionBody(source: string, functionName: string): string {
  const declarationMatches = [...source.matchAll(new RegExp(`function\\s+${functionName}\\s*\\(`, 'g'))];
  expect(declarationMatches.length, `expected exactly one 'function ${functionName}(' in scripts/dev.js`).toBe(1);
  const openBraceIndex = source.indexOf('{', declarationMatches[0].index);
  return blockFrom(source, openBraceIndex, `function ${functionName}`);
}

/** The body of the `.on('<eventName>', (<parameter>) => { ... })` handler inside `source`. */
function eventHandler(source: string, eventName: string): { parameter: string; body: string } {
  const registration = requireMatch(
    new RegExp(`\\.on\\('${eventName}',\\s*\\((\\w+)\\)\\s*=>\\s*\\{`),
    source,
    `a .on('${eventName}', (...) => { handler`,
  );
  const openBraceIndex = registration.index + registration[0].length - 1;
  return { parameter: registration[1], body: blockFrom(source, openBraceIndex, `the '${eventName}' handler`) };
}

/** start()'s body. The last statement proves a stray brace in a string did not end it early. */
function startBody(): string {
  const body = extractFunctionBody(DEV_JS_CODE, 'start');
  expect(body).toContain('spawnElectron(electronArgs, spawnEnv);');
  return body;
}

describe('scripts/vite-prebundle.js exit contract', () => {
  let scratchDir: string;

  beforeAll(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-prebundle-'));
  });

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * The argument check runs before import('vite'), so these exits come back in well under a second.
   * The scratch directory is the cwd, so a check that stopped rejecting an empty project directory
   * would bundle into it and not into the checkout the test runs from.
   */
  function runPrebundle(args: string[]) {
    return spawnSync(process.execPath, [PREBUNDLE_PATH, ...args], {
      cwd: scratchDir,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30_000,
    });
  }

  it('exits 1 and names the usage when given no arguments', () => {
    const result = runPrebundle([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: vite-prebundle.js <projectDir> <port>');
  });

  it('exits 1 and names the usage when the port is missing', () => {
    // A real directory, so a check that stopped looking at the port would carry on into Vite.
    const result = runPrebundle([scratchDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: vite-prebundle.js <projectDir> <port>');
  });

  it('exits 1 and names the usage when the project directory is empty', () => {
    const result = runPrebundle(['', '5173']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: vite-prebundle.js <projectDir> <port>');
  });

  it('maps a resolved pre-bundle to exit 0 and a rejected one to exit 1', () => {
    const settled = requireMatch(
      /main\(\)\.then\(\s*\(\)\s*=>\s*process\.exit\(0\),\s*\(\w+\)\s*=>\s*\{/,
      PREBUNDLE_CODE,
      'main().then(() => process.exit(0), (error) => { ... })',
    );
    const rejection = blockFrom(PREBUNDLE_CODE, settled.index + settled[0].length - 1, 'the rejection handler');

    expect(rejection).toContain('process.exit(1);');
    expect(rejection).not.toContain('process.exit(0)');
  });

  it('drops only the optimizeDeps deprecation notice from the logger it hands to Vite', () => {
    expect(PREBUNDLE_CODE).toContain("const DEPRECATION_NOTICE = 'manually calling optimizeDeps is deprecated';");
    // Without the custom logger the filter below would never see a message.
    expect(PREBUNDLE_CODE).toMatch(/customLogger:\s*logger\b/);

    const override = requireMatch(/logger\.warn = \((\w+), (\w+)\) => \{/, PREBUNDLE_CODE, 'the logger.warn override');
    const [, messageName, optionsName] = override;
    const body = blockFrom(PREBUNDLE_CODE, override.index + override[0].length - 1, 'the logger.warn override');
    const guard = `if (typeof ${messageName} === 'string' && ${messageName}.includes(DEPRECATION_NOTICE)) return;`;

    // The only early return is the notice match, and everything else reaches Vite's own warn.
    expect(body.match(/\breturn\b/g) ?? []).toHaveLength(1);
    expect(body).toContain(guard);
    expect(body.indexOf(`warn(${messageName}, ${optionsName});`)).toBeGreaterThan(body.indexOf(guard));
  });
});

describe('scripts/dev.js runs the pre-bundle child', () => {
  it('passes the script the project directory, then the port, in the order it reads them', () => {
    // Both sides are pinned: a swap in either one leaves the other still looking right.
    expect(extractFunctionBody(DEV_JS_CODE, 'runDependencyPrebundle'))
      .toMatch(/\[path\.join\(__dirname, 'vite-prebundle\.js'\),\s*projectDir,\s*String\(port\),?\s*\]/);
    expect(PREBUNDLE_CODE).toMatch(/const \[projectDir, portText\] = process\.argv\.slice\(2\);/);
  });

  it('resolves the close code, or 1 when the child has none, and 1 when it could not start', () => {
    const body = extractFunctionBody(DEV_JS_CODE, 'runDependencyPrebundle');
    const closed = eventHandler(body, 'close');
    const failed = eventHandler(body, 'error');

    expect(closed.body).toContain(`resolve(${closed.parameter} ?? 1);`);
    expect(failed.body).toContain('resolve(1);');
  });

  it('only warns when the child fails, then still creates the server', () => {
    const body = startBody();
    const awaited = requireMatch(/const (\w+) = await runDependencyPrebundle\(\);/, body, 'the awaited pre-bundle exit code');
    const afterAwait = body.slice(awaited.index + awaited[0].length);
    const serverCreationAt = afterAwait.indexOf('createServer(await worktreeViteConfig(projectDir, port))');
    expect(serverCreationAt, 'the worktree server is created after the pre-bundle').toBeGreaterThan(-1);
    const fallback = afterAwait.slice(0, serverCreationAt);

    expect(fallback).toMatch(new RegExp(`if \\(${escapeRegExp(awaited[1])} !== 0\\) \\{\\s*console\\.warn\\(`));
    // Nothing between the await and the server may stop the boot: the server bundles in-process instead.
    expect(fallback).not.toMatch(/\bthrow\b|\breturn\b|process\.exit\(|\bcleanup\(/);
  });
});

describe('scripts/dev.js starts the esbuild builds ahead of Vite', () => {
  it('starts them before the pre-bundle and both servers, and awaits them once the server is listening', () => {
    const body = startBody();
    const started = requireMatch(
      /const (\w+) = buildMainBundles\(\);\s*\1\.catch\(\(\) => \{\}\);/,
      body,
      'buildMainBundles() with its promise marked handled right away',
    );
    const startedAt = started.index;
    const timerStartedAt = body.indexOf("console.time('[dev] esbuild')");
    const prebundleAt = body.indexOf('await runDependencyPrebundle()');
    const serverCreationAt = [...body.matchAll(/createServer\(/g)].map((match) => match.index ?? -1);
    const listeningAt = body.indexOf('await viteServer.listen()');
    const awaitedAt = body.indexOf(`await ${started[1]};`);
    const timerEndedAt = body.indexOf("console.timeEnd('[dev] esbuild')");

    expect(timerStartedAt, 'the esbuild timer starts').toBeGreaterThan(-1);
    expect(prebundleAt, 'the pre-bundle is awaited').toBeGreaterThan(-1);
    expect(serverCreationAt.length, 'a server is created').toBeGreaterThan(0);
    expect(serverCreationAt.every((index) => index > -1)).toBe(true);
    expect(listeningAt, 'the server starts listening').toBeGreaterThan(-1);
    expect(awaitedAt, 'the builds are awaited').toBeGreaterThan(-1);
    expect(timerEndedAt, 'the esbuild timer ends').toBeGreaterThan(-1);

    expect(timerStartedAt).toBeLessThan(startedAt);
    expect(startedAt).toBeLessThan(prebundleAt);
    expect(startedAt).toBeLessThan(Math.min(...serverCreationAt));
    expect(Math.max(...serverCreationAt)).toBeLessThan(listeningAt);
    expect(listeningAt).toBeLessThan(awaitedAt);
    expect(awaitedAt).toBeLessThan(timerEndedAt);
  });

  it('does not build inline in start(), where a build would run after Vite instead of beside it', () => {
    expect(startBody()).not.toContain('esbuild.build(');
  });

  it('builds the main bundle, preload, embed worker and line-count worker in buildMainBundles', () => {
    // The pty host, dictation worker and retrieval worker entries are pinned by their boundary tests.
    const body = extractFunctionBody(DEV_JS_CODE, 'buildMainBundles');
    const entries: Array<[string, string]> = [
      ['src/main/index.ts', '.vite/build/index.js'],
      ['src/preload/preload.ts', '.vite/build/preload.js'],
      ['src/main/retrieval/embedder/embed-worker.ts', '.vite/build/embed-worker.js'],
      ['src/main/git/line-count/line-count-worker.ts', '.vite/build/line-count-worker.js'],
    ];

    for (const [entryPoint, outputFile] of entries) {
      expect(body, `buildMainBundles must build ${entryPoint} to ${outputFile}`).toMatch(new RegExp(
        `entryPoints:\\s*\\[path\\.join\\(projectDir, '${escapeRegExp(entryPoint)}'\\)\\],\\s*`
          + `outfile:\\s*path\\.join\\(projectDir, '${escapeRegExp(outputFile)}'\\)`,
      ));
    }
  });
});
