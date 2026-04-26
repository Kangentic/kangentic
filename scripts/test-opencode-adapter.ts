/**
 * Empirical validation harness for the OpenCode adapter.
 *
 * Run with: npx tsx scripts/test-opencode-adapter.ts
 *
 * What it does:
 *   1. Builds canonical commands for each spawn shape (fresh, resume,
 *      every permission mode) and prints them so a human can eyeball
 *      against the documented OpenCode TUI flag table.
 *   2. Probes the local environment for an installed `opencode` binary
 *      via the same detector the running app uses. If found, prints
 *      version + path so the user can verify the detector matches
 *      what `which opencode` (or `where opencode`) reports.
 *   3. Lists candidate session-storage roots and reports which ones
 *      actually exist on disk, so the user can confirm the parser is
 *      looking in the right place once they've run OpenCode at least
 *      once.
 *
 * This is a smoke test, not an autograder - all output is printed for
 * a human to inspect. Exit code is 0 unless a hard error occurs (e.g.
 * adapter throws while building a command).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAdapter } from '../src/main/agent/adapters/opencode';
import type { SpawnCommandOptions } from '../src/main/agent/agent-adapter';
import type { PermissionMode } from '../src/shared/types';

const SAMPLE_PROMPT = 'Fix the TypeScript error in src/foo.ts';
const SAMPLE_SESSION_ID = 'ses_abc123def456ghi789';
const SAMPLE_CWD = process.platform === 'win32' ? 'C:\\Users\\dev\\demo' : '/home/dev/demo';

function divider(label: string): void {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
}

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  const detected = process.platform === 'win32' ? 'C:\\opencode\\opencode.cmd' : '/usr/local/bin/opencode';
  return {
    agentPath: detected,
    taskId: 'task-harness-001',
    cwd: SAMPLE_CWD,
    permissionMode: 'default',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    ...overrides,
  };
}

async function main(): Promise<void> {
  const adapter = new OpenCodeAdapter();

  divider('1. Adapter identity');
  console.log({
    name: adapter.name,
    displayName: adapter.displayName,
    sessionType: adapter.sessionType,
    supportsCallerSessionId: adapter.supportsCallerSessionId,
    defaultPermission: adapter.defaultPermission,
    permissions: adapter.permissions.map((p) => p.mode),
    activityKind: adapter.runtime.activity.kind,
    hasSessionIdCapture: Boolean(adapter.runtime.sessionId),
  });

  divider('2. Command shapes (compare against documented OpenCode TUI flags)');
  console.log('Documented flags: --continue/-c, --session/-s, --fork, --prompt, --model/-m, --agent\n');

  console.log('Fresh, no prompt:');
  console.log('  ' + adapter.buildCommand(makeOptions()));

  console.log('\nFresh, with prompt:');
  console.log('  ' + adapter.buildCommand(makeOptions({ prompt: SAMPLE_PROMPT })));

  const modes: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];
  for (const permissionMode of modes) {
    console.log(`\nFresh, permission=${permissionMode}:`);
    console.log('  ' + adapter.buildCommand(makeOptions({ permissionMode, prompt: SAMPLE_PROMPT })));
  }

  console.log('\nResume:');
  console.log('  ' + adapter.buildCommand(makeOptions({ resume: true, sessionId: SAMPLE_SESSION_ID })));

  console.log('\nResume with prompt (prompt should be DROPPED):');
  console.log('  ' + adapter.buildCommand(makeOptions({
    resume: true,
    sessionId: SAMPLE_SESSION_ID,
    prompt: 'this should not appear',
  })));

  console.log('\nPrompt with embedded double quotes:');
  console.log('  ' + adapter.buildCommand(makeOptions({
    prompt: 'fix the "broken" test',
  })));

  divider('3. Local CLI detection');
  try {
    const info = await adapter.detect(null);
    if (info.found) {
      console.log('OpenCode detected:');
      console.log(`  path:    ${info.path}`);
      console.log(`  version: ${info.version}`);
    } else {
      console.log('OpenCode NOT detected on this machine.');
      console.log('Install via:  npm i -g opencode-ai   (or curl|sh installer)');
      console.log('Then re-run this script to verify the detector resolves it.');
    }
  } catch (error) {
    console.log('Detection threw:', error);
  }

  divider('4. Session ID capture - PTY output regex');
  const fromOutput = adapter.runtime.sessionId?.fromOutput;
  if (!fromOutput) {
    console.log('No fromOutput defined.');
  } else {
    // Real OpenCode ID format (verified on v1.14.25): `ses_<26 alphanumeric>`.
    // UUID samples are kept for the defensive forward-compat path.
    const sesId = 'ses_2349b5c91ffeKd6qajuUTR4clq';
    const uuidId = '550e8400-e29b-41d4-a716-446655440000';
    const samples: Array<[string, string]> = [
      ['ses_* native label', `session id: ${sesId}\n`],
      ['ses_* JSON', `"session_id": "${sesId}"`],
      ['ses_* resume hint', `Resume: opencode --session '${sesId}'`],
      ['ses_* ANSI-decorated', `\x1b[36msession id:\x1b[0m \x1b[1m${sesId}\x1b[0m`],
      ['UUID label (compat)', `session id: ${uuidId}\n`],
      ['UUID JSON (compat)', `"sessionId":"${uuidId}"`],
      ['no match', 'just a regular banner with no session ID'],
    ];
    for (const [label, sample] of samples) {
      const captured = fromOutput(sample);
      const status = captured ? `captured ${captured}` : 'no match';
      console.log(`  ${label.padEnd(20)} -> ${status}`);
    }
  }

  divider('5. OpenCode SQLite database on this machine');
  console.log('Parser reads sessions from a SQLite DB - report path, presence, size, mtime.\n');
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME;
  const dataRoots = [
    xdgData ? path.join(xdgData, 'opencode') : null,
    path.join(home, '.local', 'share', 'opencode'),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const dataRoot of dataRoots) {
    const dbPath = path.join(dataRoot, 'opencode.db');
    if (!fs.existsSync(dbPath)) {
      console.log(`  [absent] ${dbPath}`);
      continue;
    }
    try {
      const stat = fs.statSync(dbPath);
      console.log(`  [EXISTS] ${dbPath}`);
      console.log(`             size:  ${stat.size} bytes`);
      console.log(`             mtime: ${new Date(stat.mtimeMs).toISOString()}`);
    } catch (error) {
      console.log(`  [error]  ${dbPath} - ${(error as Error).message}`);
    }
  }

  divider('Done');
  console.log('Review the printed command shapes against:');
  console.log('  https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/cli.mdx');
  console.log('Every fresh command should:');
  console.log('  - have the binary as the first token');
  console.log('  - emit the prompt via --prompt <text>, NOT as a positional');
  console.log('  - not include --dangerously-skip-permissions (TUI only honors that on `opencode run`)');
  console.log('Every resume command should:');
  console.log('  - emit --session <id>');
  console.log('  - drop the prompt');
}

main().catch((error) => {
  console.error('Harness failed:', error);
  process.exit(1);
});
