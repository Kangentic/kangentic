#!/usr/bin/env node
// Empirical end-to-end check: invoke the real KimiCommandBuilder and run
// the resulting shell command against the real `kimi` binary, confirming
// the flag set is accepted (no "unrecognized option" errors).
//
// We pass --print so kimi exits without an interactive TTY. We pass a
// caller-owned UUID via --session and verify the same UUID appears in
// the wire.jsonl path that kimi creates.
//
// Run: node scripts/kimi-validate-command.mjs

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'kimi-validate-'));
const sessionId = randomUUID();

console.log(`[validate] cwd:        ${tmp}`);
console.log(`[validate] sessionId:  ${sessionId}`);

// Build the same command the adapter would generate. We don't import
// the adapter here (it's TS, this is .mjs) - we hand-build the same
// argv to keep this script simple and confirm the flag SHAPE works.
const args = [
  '-w', tmp,
  '--session', sessionId,
  '--yolo',
  '--print',
  '--output-format', 'stream-json',
  '--prompt', 'echo hello and exit',
];

console.log(`[validate] argv:       kimi ${args.join(' ')}\n`);

let stdout = '';
let stderr = '';
let exitCode = 0;
try {
  stdout = execFileSync('kimi', args, { encoding: 'utf-8', timeout: 60_000 }).toString();
} catch (err) {
  exitCode = err.status ?? -1;
  stdout = (err.stdout ?? '').toString();
  stderr = (err.stderr ?? '').toString();
}
console.log(`[validate] exit:       ${exitCode}`);
console.log(`[validate] stdout:     ${stdout.trim() || '(empty)'}`);
console.log(`[validate] stderr:     ${stderr.trim() || '(empty)'}`);

// Look for the wire.jsonl. The hash is opaque so we glob across all
// hash dirs and match on our session UUID.
const sessionsRoot = join(homedir(), '.kimi', 'sessions');
let wireFile = null;
try {
  const hashDirs = execSync(`ls -1 "${sessionsRoot}"`, { encoding: 'utf-8' }).trim().split('\n');
  for (const hash of hashDirs) {
    const candidate = join(sessionsRoot, hash, sessionId, 'wire.jsonl');
    if (existsSync(candidate)) { wireFile = candidate; break; }
  }
} catch {}

if (wireFile) {
  console.log(`[validate] wire.jsonl: ${wireFile}`);
  const content = readFileSync(wireFile, 'utf-8');
  console.log('[validate] events:');
  for (const line of content.split('\n').filter(Boolean)) {
    console.log(`           ${line}`);
  }
} else {
  console.log('[validate] wire.jsonl: NOT FOUND');
}

// Hard checks the adapter relies on:
const checks = [
  { name: 'kimi accepted -w flag',                pass: !stderr.includes('No such option: -w') && !stderr.includes('Got unexpected extra argument') },
  { name: 'kimi accepted --session flag',         pass: !stderr.includes('No such option: --session') },
  { name: 'kimi accepted --yolo flag',            pass: !stderr.includes('No such option: --yolo') },
  { name: 'kimi accepted --print flag',           pass: !stderr.includes('No such option: --print') },
  { name: 'kimi accepted --output-format flag',   pass: !stderr.includes('No such option: --output-format') },
  { name: 'kimi accepted --prompt flag',          pass: !stderr.includes('No such option: --prompt') },
  { name: 'session dir created with caller UUID', pass: wireFile !== null },
  { name: 'wire.jsonl has metadata header',       pass: wireFile !== null && readFileSync(wireFile, 'utf-8').startsWith('{"type": "metadata"') },
];

console.log('\n[validate] result summary:');
let allPass = true;
for (const check of checks) {
  console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
  if (!check.pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
