#!/usr/bin/env npx tsx
/**
 * Test harness that validates the Copilot adapter against the real CLI.
 *
 * Run from the worktree root:
 *   npx tsx scripts/test-copilot-adapter.ts
 *
 * Tests:
 *   1. Detection: finds copilot binary and parses version
 *   2. Hook config: writes a session config with hooks and statusLine
 *   3. Command building: generates correct CLI commands for all permission modes
 *   4. Config merge: preserves user's ~/.copilot/config.json settings
 *   5. Cleanup: removeSessionConfig cleans up properly
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopilotDetector } from '../src/main/agent/adapters/copilot/detector';
import { CopilotCommandBuilder } from '../src/main/agent/adapters/copilot/command-builder';
import { writeSessionConfig, removeSessionConfig, buildHooks } from '../src/main/agent/adapters/copilot/hook-manager';
import { CopilotStatusParser } from '../src/main/agent/adapters/copilot/status-parser';
import type { PermissionMode } from '../src/shared/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

// ---------- Test 1: Detection ----------
async function testDetection(): Promise<void> {
  console.log('\n--- Test 1: Detection ---');
  const detector = new CopilotDetector();
  const result = await detector.detect();

  assert(result.found === true, 'copilot binary found on system');
  assert(result.path !== null, `binary path resolved: ${result.path}`);
  assert(result.version !== null, `version parsed: ${result.version}`);

  if (result.version) {
    // Version should be semver-like (e.g. 1.0.24), not contain "GitHub Copilot CLI"
    assert(!result.version.includes('GitHub'), 'version prefix stripped');
    assert(!result.version.endsWith('.'), 'trailing period stripped');
    assert(/^\d+\.\d+\.\d+/.test(result.version), `version is semver: ${result.version}`);
  }
}

// ---------- Test 2: Hook config ----------
function testHookConfig(): void {
  console.log('\n--- Test 2: Hook Config ---');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
  const configDir = path.join(tempDir, 'copilot-config');
  const eventsPath = path.join(tempDir, 'events.jsonl');
  const statusPath = path.join(tempDir, 'status.json');

  try {
    writeSessionConfig(configDir, eventsPath, statusPath);

    const configFile = path.join(configDir, 'config.json');
    assert(fs.existsSync(configFile), 'config.json created');

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    assert(config.hooks !== undefined, 'hooks key present');
    assert(config.hooks.preToolUse !== undefined, 'preToolUse hook defined');
    assert(config.hooks.postToolUse !== undefined, 'postToolUse hook defined');
    assert(config.hooks.agentStop !== undefined, 'agentStop hook defined');
    assert(config.hooks.preCompact !== undefined, 'preCompact hook defined');

    // Verify hooks are arrays (empirically verified against Copilot CLI v1.0.24)
    assert(Array.isArray(config.hooks.preToolUse), 'preToolUse is an array');
    assert(config.hooks.preToolUse.length === 1, 'preToolUse has one entry');

    // Verify hooks reference event-bridge
    const preToolCommand = config.hooks.preToolUse[0].command;
    assert(preToolCommand.includes('event-bridge'), 'preToolUse references event-bridge');
    assert(preToolCommand.includes('tool_start'), 'preToolUse maps to tool_start');
    assert(preToolCommand.includes('tool:toolName'), 'preToolUse extracts toolName (camelCase)');

    // Verify statusLine
    assert(config.statusLine !== undefined, 'statusLine present');
    assert(config.statusLine.type === 'command', 'statusLine type is command');
    assert(config.statusLine.command.includes('status-bridge'), 'statusLine references status-bridge');

    // Verify banner suppression
    assert(config.banner === 'never', 'banner set to never');

    // Verify user config merge (if ~/.copilot/config.json exists)
    const userConfigPath = path.join(os.homedir(), '.copilot', 'config.json');
    if (fs.existsSync(userConfigPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
        // Check that user settings like model, theme, etc. are preserved
        for (const key of Object.keys(userConfig)) {
          if (key === 'hooks' || key === 'statusLine' || key === 'banner') continue;
          assert(config[key] !== undefined, `user config key preserved: ${key}`);
        }
      } catch {
        console.log('  (skipped user config merge test - could not parse ~/.copilot/config.json)');
      }
    } else {
      console.log('  (skipped user config merge test - ~/.copilot/config.json not found)');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------- Test 3: Command building ----------
function testCommandBuilding(): void {
  console.log('\n--- Test 3: Command Building ---');
  const builder = new CopilotCommandBuilder();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cmd-'));

  try {
    // Test new session with prompt
    const newCommand = builder.buildCopilotCommand({
      copilotPath: '/usr/bin/copilot',
      taskId: 'task-1',
      prompt: 'Fix the login bug',
      cwd: '/home/user/project',
      permissionMode: 'acceptEdits',
      eventsOutputPath: path.join(tempDir, 'events.jsonl'),
      statusOutputPath: path.join(tempDir, 'status.json'),
      shell: 'bash',
    });
    assert(newCommand.includes('/usr/bin/copilot'), 'new: binary path present');
    assert(newCommand.includes('--allow-all-tools'), 'new: acceptEdits maps to --allow-all-tools');
    assert(newCommand.includes('--config-dir'), 'new: --config-dir present');
    assert(newCommand.includes('-i'), 'new: -i flag for interactive prompt');
    assert(newCommand.includes('Fix the login bug'), 'new: prompt text present');

    // Test resume
    const resumeCommand = builder.buildCopilotCommand({
      copilotPath: '/usr/bin/copilot',
      taskId: 'task-2',
      cwd: '/home/user/project',
      permissionMode: 'default',
      sessionId: 'abc-123-def',
      resume: true,
      shell: 'bash',
    });
    assert(resumeCommand.includes('--resume'), 'resume: --resume flag present');
    assert(resumeCommand.includes('abc-123-def'), 'resume: session ID present');
    assert(!resumeCommand.includes('-i'), 'resume: no -i flag (no prompt on resume)');

    // Test new session with caller UUID
    const callerUuidCommand = builder.buildCopilotCommand({
      copilotPath: '/usr/bin/copilot',
      taskId: 'task-3',
      prompt: 'Build feature X',
      cwd: '/home/user/project',
      permissionMode: 'acceptEdits',
      sessionId: 'new-uuid-456',
      shell: 'bash',
    });
    assert(callerUuidCommand.includes('--resume'), 'caller-uuid: --resume flag for new UUID');
    assert(callerUuidCommand.includes('new-uuid-456'), 'caller-uuid: UUID present');

    // Test all permission modes
    const permissionModes: Array<{ mode: PermissionMode; expectedFlag: string }> = [
      { mode: 'plan', expectedFlag: '--plan' },
      { mode: 'dontAsk', expectedFlag: '--no-ask-user' },
      { mode: 'default', expectedFlag: '' },
      { mode: 'acceptEdits', expectedFlag: '--allow-all-tools' },
      { mode: 'auto', expectedFlag: '--allow-all-tools' },
      { mode: 'bypassPermissions', expectedFlag: '--yolo' },
    ];
    for (const { mode, expectedFlag } of permissionModes) {
      const command = builder.buildCopilotCommand({
        copilotPath: 'copilot',
        taskId: `task-perm-${mode}`,
        cwd: '/tmp',
        permissionMode: mode,
        shell: 'bash',
      });
      if (expectedFlag) {
        assert(command.includes(expectedFlag), `permission ${mode}: includes ${expectedFlag}`);
      } else {
        assert(!command.includes('--plan') && !command.includes('--yolo') && !command.includes('--allow-all'),
          `permission ${mode}: no permission flags`);
      }
    }

    // Test non-interactive mode
    const nonInteractiveCommand = builder.buildCopilotCommand({
      copilotPath: 'copilot',
      taskId: 'task-ni',
      prompt: 'Check syntax',
      cwd: '/tmp',
      permissionMode: 'acceptEdits',
      nonInteractive: true,
      shell: 'bash',
    });
    assert(nonInteractiveCommand.includes('-p'), 'non-interactive: -p flag present');
    assert(nonInteractiveCommand.includes('Check syntax'), 'non-interactive: prompt present');
    assert(!nonInteractiveCommand.includes('-i'), 'non-interactive: no -i flag');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------- Test 4: Status parser ----------
function testStatusParser(): void {
  console.log('\n--- Test 4: Status Parser ---');

  // parseStatus returns null until format is verified
  const result = CopilotStatusParser.parseStatus('{"model": {"id": "gpt-5"}}');
  assert(result === null, 'parseStatus returns null (unverified format)');

  // parseEvent handles generic event-bridge JSONL
  const event = CopilotStatusParser.parseEvent('{"ts": 1234567890, "type": "tool_start", "tool": "read"}');
  assert(event !== null, 'parseEvent parses valid JSONL');
  assert(event?.type === 'tool_start', 'parseEvent extracts type');
  assert(event?.tool === 'read', 'parseEvent extracts tool');

  // parseEvent handles malformed input
  const badEvent = CopilotStatusParser.parseEvent('not json');
  assert(badEvent === null, 'parseEvent returns null for invalid JSON');
}

// ---------- Test 5: Cleanup ----------
function testCleanup(): void {
  console.log('\n--- Test 5: Cleanup ---');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cleanup-'));
  const configDir = path.join(tempDir, 'copilot-config');
  const eventsPath = path.join(tempDir, 'events.jsonl');

  try {
    writeSessionConfig(configDir, eventsPath);
    assert(fs.existsSync(path.join(configDir, 'config.json')), 'config exists before cleanup');

    removeSessionConfig(configDir);
    assert(!fs.existsSync(path.join(configDir, 'config.json')), 'config.json removed');
    assert(!fs.existsSync(configDir), 'config directory removed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------- Run all ----------
async function main(): Promise<void> {
  console.log('=== Copilot Adapter Test Harness ===');

  await testDetection();
  testHookConfig();
  testCommandBuilding();
  testStatusParser();
  testCleanup();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
