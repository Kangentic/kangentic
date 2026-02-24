#!/usr/bin/env node
/**
 * Activity Bridge for Claude Code hooks → Kangentic
 *
 * Claude Code invokes this script via hooks (UserPromptSubmit / Stop).
 * Writes { state, timestamp } to the file path given as argv[2].
 *
 * Usage:
 *   node activity-bridge.js <outputPath> <state>
 *
 * - state defaults to 'thinking' if not provided
 * - Reads stdin to completion (hooks pipe event JSON via stdin)
 *   before writing and exiting — same pattern as status-bridge.js
 */
const fs = require('fs');
const outputPath = process.argv[2];
const state = process.argv[3] || 'thinking';

// Drain stdin fully before writing — Claude Code pipes event JSON via stdin
// and expects the process to consume it. Exiting before stdin ends causes
// EPIPE which may make the hook fail.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (outputPath) {
    try { fs.writeFileSync(outputPath, JSON.stringify({ state, timestamp: new Date().toISOString() })); } catch {}
  }
  // Process exits naturally when stdin closes — no process.exit() needed
});
