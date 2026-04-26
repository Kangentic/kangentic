#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Quick inspection helper: dump the first few lines of the most recent
// Droid session JSONL file from `~/.factory/sessions/`. Used to learn
// the JSONL schema for a future session-history-parser.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sessionsDir = path.join(os.homedir(), '.factory', 'sessions');
const cwdDirs = fs.readdirSync(sessionsDir)
  .map((name) => ({ name, mtime: fs.statSync(path.join(sessionsDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (cwdDirs.length === 0) {
  console.log('no session dirs');
  process.exit(0);
}

for (const cwdDir of cwdDirs.slice(0, 4)) {
  const dir = path.join(sessionsDir, cwdDir.name);
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) continue;
  const file = path.join(dir, files[0].f);
  console.log('=== ' + file + ' ===');
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  console.log('total lines:', lines.length);
  for (const line of lines.slice(0, 3)) {
    try {
      const obj = JSON.parse(line);
      console.log(JSON.stringify(obj, null, 2).slice(0, 800));
    } catch {
      console.log('NON-JSON:', line.slice(0, 200));
    }
    console.log('---');
  }
  console.log('');
  break;
}
