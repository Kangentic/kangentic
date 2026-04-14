import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COPILOT_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe',
);

async function testFormat(label: string, config: Record<string, unknown>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-fmt2-'));
  const configDir = path.join(tempDir, 'copilot-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(config.hooks, null, 2).slice(0, 400));

  const child = spawn(COPILOT_PATH, [
    '--config-dir', configDir, '--plan', '--allow-all-tools',
    '-p', 'Say hello',
  ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });

  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  let stdout = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code: number | null) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  const hasConfigError = stderr.includes('Failed to load config') || stderr.includes('invalid_type');
  if (hasConfigError) {
    console.log(`FAIL (exit ${exitCode}): ${stderr.slice(0, 400)}`);
  } else if (exitCode === 0) {
    console.log(`PASS (exit 0): ${stdout.trim().slice(0, 200)}`);
  } else {
    console.log(`EXIT ${exitCode}: ${stderr.slice(0, 400)}`);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // Array of {command, timeout} per event key
  await testFormat('array-of-objects-per-event', {
    banner: 'never',
    hooks: {
      preToolUse: [{ command: 'echo pre-tool', timeout: 5 }],
      postToolUse: [{ command: 'echo post-tool', timeout: 5 }],
    },
  });

  // Array of strings per event key
  await testFormat('array-of-strings-per-event', {
    banner: 'never',
    hooks: {
      preToolUse: ['echo pre-tool'],
    },
  });

  // Empty arrays
  await testFormat('empty-arrays-per-event', {
    banner: 'never',
    hooks: {
      preToolUse: [],
    },
  });

  // Empty object
  await testFormat('empty-object', {
    banner: 'never',
    hooks: {},
  });
}

main().catch(console.error);
