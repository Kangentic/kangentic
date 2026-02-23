#!/usr/bin/env node
/**
 * Status Line Bridge for Claude Code → Kangentic
 *
 * Claude Code invokes this script as its status line command,
 * piping JSON session data via stdin on each state change.
 *
 * - Writes the full JSON payload to the file path given as argv[2]
 * - Outputs empty string to stdout (Kangentic renders usage in its own UI)
 */
const fs = require('fs');
const outputPath = process.argv[2];

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (outputPath) {
    try { fs.writeFileSync(outputPath, input); } catch { /* ignore write errors */ }
  }
  // Output empty string — Kangentic shows usage data in its own UI,
  // so we don't need Claude Code's TUI to display a status line.
  process.stdout.write('');
});
