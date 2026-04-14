#!/usr/bin/env npx tsx
/**
 * Validate Copilot CLI telemetry capture via OTel file exporter.
 *
 * StatusLine is TTY-gated (STATUS_LINE=false when not in a PTY), so we
 * use the COPILOT_OTEL_FILE_EXPORTER_PATH env var to capture structured
 * telemetry data that includes model, tokens, and cost information.
 *
 * This validates:
 * 1. OTel telemetry flows and captures session data
 * 2. The hook event payload schema (what fields are in hook stdin)
 * 3. The actual data available for our status parser to consume
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeSessionConfig } from '../src/main/agent/adapters/copilot/hook-manager';

const COPILOT_PATH = process.env.COPILOT_PATH || path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe',
);

async function main(): Promise<void> {
  console.log('=== Copilot Telemetry & Hook Payload Validation ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tel-'));
  const sessionDir = path.join(tempDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const statusPath = path.join(sessionDir, 'status.json');
  const otelPath = path.join(sessionDir, 'otel.jsonl');
  const configDir = path.join(sessionDir, 'copilot-config');
  const hookStdinCapturePath = path.join(sessionDir, 'hook-stdin.jsonl');

  // Create a config that captures hook stdin payloads (the actual data
  // Copilot sends to hooks) alongside our normal event-bridge hooks
  const captureScript = path.join(tempDir, 'capture-hook-stdin.js');
  fs.writeFileSync(captureScript, `#!/usr/bin/env node
const fs = require('node:fs');
const capturePath = ${JSON.stringify(hookStdinCapturePath)};
const eventType = process.argv[2] || 'unknown';
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const line = JSON.stringify({ eventType, stdin: data.trim(), ts: Date.now() });
  fs.appendFileSync(capturePath, line + '\\n');
});
`);

  // Write session config with hooks
  writeSessionConfig(configDir, eventsPath, statusPath);

  // Add our capture hooks alongside the event-bridge hooks
  const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
  const captureScriptForward = captureScript.replace(/\\/g, '/');
  for (const eventName of Object.keys(config.hooks || {})) {
    // Append a capture hook to each event's array
    config.hooks[eventName].push({
      command: `node "${captureScriptForward}" ${eventName}`,
      timeout: 10,
    });
  }
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  console.log('Config written with capture hooks for each event type.');
  console.log(`OTel output: ${otelPath}`);
  console.log(`Hook stdin capture: ${hookStdinCapturePath}\n`);

  // Spawn with OTel enabled and a prompt that triggers tool use
  console.log('Spawning Copilot with OTel telemetry enabled...');
  const child = spawn(COPILOT_PATH, [
    '--config-dir', configDir,
    '--allow-all-tools',
    '-p', 'Read the file package.json and tell me the version number. Use the read tool.',
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 45000,
    env: {
      ...process.env,
      COPILOT_OTEL_FILE_EXPORTER_PATH: otelPath,
      COPILOT_OTEL_ENABLED: 'true',
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code: number | null) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
    setTimeout(() => { try { child.kill(); } catch {} resolve(1); }, 40000);
  });

  console.log(`\nExit code: ${exitCode}`);
  console.log(`Stdout: ${stdout.trim().slice(0, 300)}`);
  if (stderr.trim()) {
    console.log(`Stderr: ${stderr.trim().slice(0, 300)}`);
  }

  // --- Analyze events.jsonl ---
  console.log('\n--- Events (event-bridge JSONL) ---');
  if (fs.existsSync(eventsPath)) {
    const eventsRaw = fs.readFileSync(eventsPath, 'utf-8');
    const events = eventsRaw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    console.log(`${events.length} events captured:`);
    for (const event of events) {
      console.log(`  ${JSON.stringify(event)}`);
    }
  } else {
    console.log('  (not created)');
  }

  // --- Analyze hook stdin captures ---
  console.log('\n--- Hook Stdin Payloads ---');
  if (fs.existsSync(hookStdinCapturePath)) {
    const captureRaw = fs.readFileSync(hookStdinCapturePath, 'utf-8');
    const captures = captureRaw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    console.log(`${captures.length} hook invocations captured:`);
    for (const capture of captures) {
      console.log(`\n  Event: ${capture.eventType}`);
      if (capture.stdin) {
        try {
          const parsed = JSON.parse(capture.stdin);
          console.log(`  Stdin JSON keys: ${Object.keys(parsed).join(', ')}`);
          console.log(`  Full payload: ${JSON.stringify(parsed, null, 2).slice(0, 500)}`);
        } catch {
          console.log(`  Stdin (raw): ${capture.stdin.slice(0, 300)}`);
        }
      } else {
        console.log('  (no stdin data)');
      }
    }
  } else {
    console.log('  (not created - hooks may not have fired)');
  }

  // --- Analyze OTel data ---
  console.log('\n--- OTel Telemetry ---');
  if (fs.existsSync(otelPath)) {
    const otelRaw = fs.readFileSync(otelPath, 'utf-8');
    const otelLines = otelRaw.split('\n').filter(Boolean);
    console.log(`${otelLines.length} OTel records captured.`);

    // Look for token usage and model info
    for (const line of otelLines.slice(0, 5)) {
      try {
        const record = JSON.parse(line);
        const name = record.name || record.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name || '(unnamed)';
        console.log(`  Record: ${JSON.stringify(record).slice(0, 200)}`);
      } catch {
        console.log(`  Raw: ${line.slice(0, 200)}`);
      }
    }
    if (otelLines.length > 5) {
      console.log(`  ... and ${otelLines.length - 5} more records`);
    }
  } else {
    console.log('  (not created)');
  }

  // --- Status.json (TTY-gated, expected to be absent) ---
  console.log('\n--- StatusLine ---');
  if (fs.existsSync(statusPath)) {
    const statusRaw = fs.readFileSync(statusPath, 'utf-8');
    console.log(`PRESENT! (${statusRaw.length} bytes)`);
    console.log(statusRaw.slice(0, 500));
  } else {
    console.log('Not created (expected - STATUS_LINE=false without PTY).');
    console.log('StatusLine is TTY-gated and will fire in Kangentic\'s node-pty sessions.');
  }

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
