/**
 * Test different hook config formats against real Copilot CLI to find the right schema.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COPILOT_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe',
);

async function testFormat(label: string, config: Record<string, unknown>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-fmt-'));
  const configDir = path.join(tempDir, 'copilot-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  console.log(`\n--- Format: ${label} ---`);
  console.log(`Config: ${JSON.stringify(config, null, 2).slice(0, 400)}`);

  const child = spawn(COPILOT_PATH, [
    '--config-dir', configDir,
    '--plan',
    '--allow-all-tools',
    '-p', 'Say hello',
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20000,
  });

  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  let stdout = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code: number | null) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  const hasConfigError = stderr.includes('Failed to load config') || stderr.includes('invalid_type');
  console.log(`Exit: ${exitCode}, Config error: ${hasConfigError}`);
  if (hasConfigError) {
    console.log(`Stderr: ${stderr.slice(0, 500)}`);
  } else if (exitCode === 0) {
    console.log(`PASS! Stdout: ${stdout.trim().slice(0, 200)}`);
  } else {
    console.log(`Stderr: ${stderr.slice(0, 500)}`);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // Format 1: Object keyed by event name (what Context7 showed)
  await testFormat('object-keyed', {
    banner: 'never',
    hooks: {
      preToolUse: { command: 'echo pre-tool', timeout: 5 },
      postToolUse: { command: 'echo post-tool', timeout: 5 },
    },
  });

  // Format 2: Array of {event, command, timeout} (like Codex)
  await testFormat('array-with-event', {
    banner: 'never',
    hooks: [
      { event: 'preToolUse', command: 'echo pre-tool', timeout: 5 },
      { event: 'postToolUse', command: 'echo post-tool', timeout: 5 },
    ],
  });

  // Format 3: Array of objects with type field
  await testFormat('array-with-type', {
    banner: 'never',
    hooks: [
      { type: 'preToolUse', command: 'echo pre-tool', timeout: 5 },
      { type: 'postToolUse', command: 'echo post-tool', timeout: 5 },
    ],
  });

  // Format 4: Empty hooks (baseline - should work)
  await testFormat('empty-hooks', {
    banner: 'never',
    hooks: [],
  });

  // Format 5: No hooks key at all
  await testFormat('no-hooks', {
    banner: 'never',
  });

  // Format 6: .github/hooks style - array of objects with matcher
  await testFormat('github-hooks-style', {
    banner: 'never',
    hooks: [
      {
        event: 'preToolUse',
        command: 'echo pre-tool',
        timeout: 5,
        matcher: '',
      },
    ],
  });
}

main().catch(console.error);
