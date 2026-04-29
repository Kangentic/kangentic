#!/usr/bin/env node
// Empirical end-to-end check: build the `--mcp-config <JSON>` argument
// via the real KimiCommandBuilder, then run the resulting command
// through real powershell.exe -Command and confirm Kimi accepts the
// JSON without parser errors.
//
// Why a separate validator from kimi-validate-command.mjs:
//   That script invokes kimi via execFileSync with an argv array, which
//   bypasses any shell parser. The MCP path's risk is specifically that
//   PowerShell's parser rejects the single-quote-substituted JSON we
//   emit (command-builder.ts:148-157). We have to actually go through
//   powershell.exe -Command "<string>" to exercise that parser.
//
// Skip on non-Windows: the substitution only fires for non-Unix shells,
// and powershell.exe is not present on macOS/Linux dev hosts.
//
// Run: npm run validate:kimi-mcp

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build as esbuild } from 'esbuild';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BUILDER_TS = join(REPO_ROOT, 'src', 'main', 'agent', 'adapters', 'kimi', 'command-builder.ts');

if (process.platform !== 'win32') {
  console.log('SKIP: kimi-validate-mcp is Windows-only (powershell.exe not available). Run `npm run test:unit -- kimi-adapter` for cross-platform coverage.');
  process.exit(0);
}

let kimiPath;
try {
  kimiPath = execFileSync('where', ['kimi'], { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
} catch {
  console.error('FAIL: `kimi` not found on PATH. Install kimi v1.37.0+ before running this validator.');
  process.exit(1);
}
console.log(`[validate] kimi:       ${kimiPath}`);

// Compile the TS adapter to a temp ESM file so we can dynamic-import it.
// Bundle with all deps inlined (paths.ts etc.) and external Node builtins.
const tempWorkDir = mkdtempSync(join(tmpdir(), 'kimi-validate-mcp-'));

// Belt-and-suspenders: also clean up if we throw before reaching the
// finally block (e.g. on a SIGINT during esbuild). The finally block is
// the primary cleanup path; this just covers crash-out cases.
const cleanupTempDir = () => {
  try { rmSync(tempWorkDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanupTempDir);

let exitStatus = 0;
try {
  const compiled = join(tempWorkDir, 'command-builder.mjs');
  try {
    await esbuild({
      entryPoints: [BUILDER_TS],
      outfile: compiled,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      logLevel: 'error',
    });
  } catch (err) {
    console.error('FAIL: esbuild could not compile command-builder.ts');
    console.error(err);
    exitStatus = 1;
    process.exit(exitStatus);
  }

  const { KimiCommandBuilder } = await import(pathToFileURL(compiled).href);
  const builder = new KimiCommandBuilder();

  const sessionId = randomUUID();
  const cwd = tempWorkDir;
  const commandString = builder.buildKimiCommand({
    kimiPath,
    cwd,
    sessionId,
    shell: 'powershell',
    permissionMode: 'bypassPermissions',
    nonInteractive: true,
    mcpServerEnabled: true,
    mcpServerUrl: 'http://127.0.0.1:54321',
    mcpServerToken: 'validation-token',
    prompt: 'reply OK and exit',
  });

  console.log(`[validate] cwd:        ${cwd}`);
  console.log(`[validate] sessionId:  ${sessionId}`);
  console.log(`[validate] command:    ${commandString}\n`);

  // Run through real PowerShell. -Command parses commandString the same
  // way the dogfooded app's PTY does when adaptCommandForShell prepends
  // `& `. We prepend `& ` here ourselves so PS treats kimiPath as an
  // executable invocation, mirroring paths.ts:115.
  const psCommand = '& ' + commandString;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const stdout = (result.stdout ?? '').toString();
  const stderr = (result.stderr ?? '').toString();
  const exitCode = result.status ?? -1;

  console.log(`[validate] exit:       ${exitCode}`);
  if (stdout.trim()) {
    console.log(`[validate] stdout (first 40 lines):`);
    for (const line of stdout.split(/\r?\n/).slice(0, 40)) console.log(`           ${line}`);
  }
  if (stderr.trim()) {
    console.log(`[validate] stderr (first 40 lines):`);
    for (const line of stderr.split(/\r?\n/).slice(0, 40)) console.log(`           ${line}`);
  }

  // Classify the result.
  //
  // Kimi will fail to actually connect to the MCP server (port 54321 is
  // not bound) but that failure happens AFTER the JSON is parsed, so
  // we still get a clean signal for the question we care about: did
  // PowerShell + Kimi parse the substituted JSON?
  //
  // The MCP-parser regexes are pinned to the exact wording Kimi v1.37.0
  // emits ("Invalid value for --mcp-config" + Python json's "Expecting
  // property name enclosed in double quotes"). Tightening them after
  // empirical discovery prevents misattributing unrelated cwd/path
  // errors that happen to mention "config" or "json" near "invalid".
  const combined = stderr + '\n' + stdout;

  const psParserError = /ParserError|parser error|unexpected token/i.test(combined);
  const jsonParserError =
    /Invalid (value|JSON|input) for --mcp-config/i.test(combined) ||
    /Expecting property name enclosed in double quotes/i.test(combined);
  const sawMetadataFrame = /"type":\s*"metadata"/.test(stdout);
  const sawMcpConnectAttempt = /(mcp|kangentic).{0,80}(connect|server|http:\/\/127\.0\.0\.1:54321)/i.test(combined);
  const sawConnectionRefused = /(connection refused|econnrefused)/i.test(combined);

  console.log('\n[validate] signals:');
  console.log(`  ${psParserError        ? 'YES' : 'no '}  PowerShell parser error`);
  console.log(`  ${jsonParserError      ? 'YES' : 'no '}  Kimi JSON/MCP parse error`);
  console.log(`  ${sawMetadataFrame     ? 'YES' : 'no '}  Kimi emitted stream-json metadata frame`);
  console.log(`  ${sawMcpConnectAttempt ? 'YES' : 'no '}  Kimi attempted MCP server connection`);
  console.log(`  ${sawConnectionRefused ? 'YES' : 'no '}  Connection refused (expected: port not bound)`);

  let verdict;
  if (psParserError) {
    verdict = 'FAIL: PowerShell rejected the command string before kimi started. The quoteArg/JSON substitution is broken.';
    exitStatus = 1;
  } else if (jsonParserError) {
    verdict = 'FAIL: Kimi rejected the substituted JSON. The double-to-single quote substitution at command-builder.ts ~L155 is incompatible with Kimi\'s strict JSON parser. Switch the non-Unix branch to --mcp-config-file <path>: write JSON.stringify(mcpConfig) to a temp file (e.g. os.tmpdir()/kangentic-mcp-<uuid>.json) and emit `--mcp-config-file <quoted-path>` instead of inline JSON. Clean the file up on session exit.';
    exitStatus = 1;
  } else if (sawMcpConnectAttempt || sawConnectionRefused || sawMetadataFrame) {
    verdict = 'PASS: PowerShell + Kimi accepted the substituted JSON and proceeded to MCP connection.';
    exitStatus = 0;
  } else {
    verdict = `FAIL: Inconclusive. Kimi exited ${exitCode} with no MCP-connection or parser signals; review stderr above.`;
    exitStatus = 2;
  }

  console.log(`\n${verdict}`);
} finally {
  cleanupTempDir();
}

process.exit(exitStatus);
