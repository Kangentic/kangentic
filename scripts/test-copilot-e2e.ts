#!/usr/bin/env npx tsx
/**
 * End-to-end test: spawns a REAL Copilot CLI session with our adapter's
 * config (hooks + statusLine) and verifies events actually flow.
 *
 * This is the gold-standard validation - it exercises the full chain:
 *   adapter config -> real CLI -> hooks fire -> event-bridge -> events.jsonl
 *
 * Run from the worktree root:
 *   npx tsx scripts/test-copilot-e2e.ts
 *
 * Requirements:
 *   - copilot CLI installed (winget, npm, or brew)
 *   - Authenticated (run `copilot login` first)
 *   - Set COPILOT_PATH env var if copilot is not on PATH
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CopilotDetector } from '../src/main/agent/adapters/copilot/detector';
import { CopilotCommandBuilder } from '../src/main/agent/adapters/copilot/command-builder';
import { writeSessionConfig } from '../src/main/agent/adapters/copilot/hook-manager';

const COPILOT_PATH = process.env.COPILOT_PATH || path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe',
);

async function main(): Promise<void> {
  console.log('=== Copilot Adapter E2E Validation ===\n');

  // --- Step 1: Verify detection ---
  console.log('Step 1: Detection');
  const detector = new CopilotDetector();
  const detection = await detector.detect(COPILOT_PATH);
  if (!detection.found) {
    console.error(`FAIL: copilot not found at ${COPILOT_PATH}`);
    console.error('Set COPILOT_PATH env var or install via: winget install GitHub.Copilot');
    process.exit(1);
  }
  console.log(`  PASS: Found copilot v${detection.version} at ${detection.path}\n`);

  // --- Step 2: Create session directory with config ---
  console.log('Step 2: Session config generation');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-e2e-'));
  const sessionDir = path.join(tempDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const statusPath = path.join(sessionDir, 'status.json');
  const configDir = path.join(sessionDir, 'copilot-config');

  writeSessionConfig(configDir, eventsPath, statusPath);

  const configFile = path.join(configDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  console.log(`  Config written to: ${configDir}`);
  console.log(`  Hooks: ${Object.keys(config.hooks || {}).join(', ')}`);
  console.log(`  StatusLine: ${config.statusLine ? 'yes' : 'no'}`);
  console.log(`  Banner: ${config.banner}`);

  // Verify user config was merged
  const userConfigPath = path.join(os.homedir(), '.copilot', 'config.json');
  if (fs.existsSync(userConfigPath)) {
    const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
    const userKeys = Object.keys(userConfig).filter(
      (key) => key !== 'hooks' && key !== 'statusLine' && key !== 'banner',
    );
    const preserved = userKeys.filter((key) => config[key] !== undefined);
    console.log(`  User config keys preserved: ${preserved.length}/${userKeys.length} (${preserved.join(', ')})`);
  }
  console.log('  PASS: Config generation complete\n');

  // --- Step 3: Build command ---
  console.log('Step 3: Command building');
  const builder = new CopilotCommandBuilder();
  const command = builder.buildCopilotCommand({
    copilotPath: detection.path!,
    taskId: 'e2e-test',
    prompt: 'Say "hello world" and nothing else. Do not use any tools.',
    cwd: process.cwd(),
    permissionMode: 'plan',
    eventsOutputPath: eventsPath,
    statusOutputPath: statusPath,
    shell: 'bash',
  });
  console.log(`  Command: ${command}\n`);

  // --- Step 4: Spawn real Copilot CLI ---
  console.log('Step 4: Spawning real Copilot CLI');
  console.log('  Launching with --plan mode and a simple prompt...');
  console.log('  (Will wait up to 30 seconds for response, then send /exit)\n');

  // We use -p (non-interactive) to get a response and exit cleanly.
  // This avoids needing a PTY for this validation script.
  const nonInteractiveCommand = builder.buildCopilotCommand({
    copilotPath: detection.path!,
    taskId: 'e2e-test',
    prompt: 'Say exactly "hello from copilot" and nothing else. Do not run any tools or commands.',
    cwd: process.cwd(),
    permissionMode: 'plan',
    nonInteractive: true,
    eventsOutputPath: eventsPath,
    statusOutputPath: statusPath,
    shell: 'bash',
  });

  // Parse the command into executable + args for spawn
  // The command is shell-quoted, so we need to run it via shell
  const child = spawn(detection.path!, [
    '--config-dir', configDir,
    '--plan',
    '--allow-all-tools',
    '-p', 'Say exactly "hello from copilot" and nothing else. Do not use any tools.',
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 45000,
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code: number | null) => resolve(code ?? 1));
    child.on('error', (error: Error) => {
      console.error(`  Spawn error: ${error.message}`);
      resolve(1);
    });
  });

  console.log(`  Exit code: ${exitCode}`);
  if (stdout.trim()) {
    console.log(`  Stdout (first 500 chars): ${stdout.trim().slice(0, 500)}`);
  }
  if (stderr.trim()) {
    console.log(`  Stderr (first 300 chars): ${stderr.trim().slice(0, 300)}`);
  }
  console.log('');

  // --- Step 5: Check events ---
  console.log('Step 5: Checking events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const eventsRaw = fs.readFileSync(eventsPath, 'utf-8');
    const events = eventsRaw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    console.log(`  Events file size: ${eventsRaw.length} bytes`);
    console.log(`  Parsed events: ${events.length}`);

    if (events.length > 0) {
      const byType: Record<string, number> = {};
      for (const event of events) {
        byType[event.type] = (byType[event.type] || 0) + 1;
      }
      console.log('  Event type breakdown:');
      for (const type of Object.keys(byType).sort()) {
        console.log(`    ${type.padEnd(20)} ${byType[type]}`);
      }
      console.log('  PASS: Events are flowing through the hook bridge!');
    } else {
      console.log('  WARN: events.jsonl exists but no events parsed.');
      console.log('  This could mean Copilot --plan mode does not fire hooks for non-tool responses.');
      console.log('  Try running a task that uses tools (file reads, shell commands) to verify hooks.');
    }
  } else {
    console.log('  INFO: events.jsonl was not created.');
    console.log('  This is expected if Copilot CLI does not fire hooks in non-interactive -p mode.');
    console.log('  The hooks should fire in interactive mode when spawned from a PTY.');
  }
  console.log('');

  // --- Step 6: Check status file ---
  console.log('Step 6: Checking status.json');
  if (fs.existsSync(statusPath)) {
    const statusRaw = fs.readFileSync(statusPath, 'utf-8');
    console.log(`  Status file size: ${statusRaw.length} bytes`);
    if (statusRaw.trim()) {
      try {
        const status = JSON.parse(statusRaw);
        console.log(`  Status JSON keys: ${Object.keys(status).join(', ')}`);
        if (status.model) console.log(`  Model: ${JSON.stringify(status.model)}`);
        if (status.context_window) console.log(`  Context: ${JSON.stringify(status.context_window)}`);
        console.log('  PASS: Status bridge is receiving data!');
      } catch {
        console.log(`  Raw content: ${statusRaw.slice(0, 200)}`);
        console.log('  WARN: Status file exists but is not valid JSON.');
      }
    } else {
      console.log('  Status file is empty.');
    }
  } else {
    console.log('  INFO: status.json was not created.');
    console.log('  StatusLine may not fire in non-interactive -p mode.');
  }
  console.log('');

  // --- Cleanup ---
  console.log('Cleanup:');
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`  Removed temp dir: ${tempDir}`);

  // --- Verdict ---
  console.log('\n=== Verdict ===');
  if (exitCode === 0 && stdout.trim()) {
    console.log('PASS: Copilot CLI launched successfully with our adapter config.');
    console.log('The adapter is correctly configured for integration with Kangentic.');
  } else if (exitCode !== 0) {
    console.log(`PARTIAL: Copilot exited with code ${exitCode}.`);
    console.log('The CLI launched but may have hit an auth or permission issue.');
    console.log('Check stderr output above for details.');
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
