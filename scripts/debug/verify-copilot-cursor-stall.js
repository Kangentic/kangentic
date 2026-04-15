#!/usr/bin/env node
/**
 * End-to-end empirical verification for the Copilot + Cursor "stuck at
 * loading agent" fix.
 *
 * Spawns each agent through node-pty with the EXACT command shape the
 * adapters produce, feeds every PTY chunk into the CopilotStreamParser /
 * CursorStreamParser, and reports:
 *
 *   - first_output_ms: time until any chunk satisfies the adapter's
 *                      `detectFirstOutput` (matches PtyBufferManager.onFlush)
 *   - first_usage_ms: time until the stream parser returns a usage entry
 *                      with a non-empty model.displayName
 *                      (matches ContextBar.tsx:62 gate)
 *   - model: the captured model display name
 *
 * The parsers are bundled on the fly via esbuild so this script is
 * independent of the Electron main bundle (which doesn't re-export parsers).
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');

const worktreeRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(worktreeRoot, 'debug-traces', 'post-fix');
fs.mkdirSync(outDir, { recursive: true });

// Bundle both parsers + their ADT dependencies as CJS.
// The worktree typically shares the main repo's node_modules for binaries
// via forwarded path resolution. We look in both locations.
const esbuildCandidates = [
  path.join(worktreeRoot, 'node_modules', '.bin', 'esbuild.cmd'),
  path.join(worktreeRoot, '..', '..', '..', 'node_modules', '.bin', 'esbuild.cmd'),
  'C:/Users/tyler/Documents/GitHub/kangentic/node_modules/.bin/esbuild.cmd',
];
const esbuildCli = esbuildCandidates.find((candidate) => fs.existsSync(candidate));
if (!esbuildCli) {
  console.error('could not locate esbuild.cmd. Tried:', esbuildCandidates);
  process.exit(2);
}
console.log(`[verify] using esbuild: ${esbuildCli}`);
const parsersBundle = path.join(outDir, 'parsers-bundle.cjs');
const parsersEntry = path.join(outDir, 'parsers-entry.ts');
fs.writeFileSync(
  parsersEntry,
  [
    "export { CopilotStreamParser } from '../../src/main/agent/adapters/copilot/stream-parser';",
    "export { CursorStreamParser } from '../../src/main/agent/adapters/cursor/stream-parser';",
    "export { CursorAdapter } from '../../src/main/agent/adapters/cursor/cursor-adapter';",
    "export { CopilotAdapter } from '../../src/main/agent/adapters/copilot/copilot-adapter';",
  ].join('\n'),
);

const esbuildResult = spawnSync(
  esbuildCli,
  [
    parsersEntry,
    '--bundle',
    `--outfile=${parsersBundle}`,
    '--platform=node',
    '--format=cjs',
    '--log-level=info',
    '--external:which',
  ],
  { cwd: worktreeRoot, encoding: 'utf-8', shell: true },
);
if (esbuildResult.status !== 0) {
  console.error('esbuild bundle failed. stdout:', esbuildResult.stdout);
  console.error('esbuild stderr:', esbuildResult.stderr);
  console.error('esbuild error:', esbuildResult.error);
  process.exit(2);
}

const bundle = require(parsersBundle);

function resolveBinary(name) {
  const result = spawnSync('where.exe', [name], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\n')[0].trim() || null;
}

async function runCase({ label, binary, argv, adapterName, timeoutMs }) {
  const logPath = path.join(outDir, `${label}-ptyout.log`);
  const eventsPath = path.join(outDir, `${label}-events.json`);
  fs.writeFileSync(logPath, '');
  const events = {
    label,
    binary,
    argv,
    firstOutputMs: null,
    firstUsageMs: null,
    model: null,
    exited: false,
  };

  if (!binary) {
    events.error = 'binary not found on PATH';
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));
    console.log(`\n=== ${label}: SKIP (binary not found) ===`);
    return events;
  }

  const AdapterClass = adapterName === 'copilot' ? bundle.CopilotAdapter : bundle.CursorAdapter;
  const adapter = new AdapterClass();
  const parser = adapter.runtime.streamOutput.createParser();
  const detectFirstOutput = adapter.detectFirstOutput.bind(adapter);

  const start = Date.now();
  const proc = pty.spawn(binary, argv, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: worktreeRoot,
    env: process.env,
  });

  await new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { proc.write('\x03'); } catch {}
      setTimeout(() => {
        try { proc.write('/exit\r'); } catch {}
        setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 1500);
      }, 500);
    };

    proc.onData((chunk) => {
      fs.appendFileSync(logPath, chunk);
      if (events.firstOutputMs == null && detectFirstOutput(chunk)) {
        events.firstOutputMs = Date.now() - start;
      }
      if (events.firstUsageMs == null) {
        const result = parser.parseTelemetry(chunk);
        if (result?.usage?.model?.displayName) {
          events.firstUsageMs = Date.now() - start;
          events.model = result.usage.model.displayName;
          setTimeout(shutdown, 200);
        }
      }
    });
    proc.onExit(({ exitCode }) => {
      events.exited = true;
      events.exitCode = exitCode;
      events.totalMs = Date.now() - start;
      resolve();
    });
    setTimeout(() => { if (!events.exited) shutdown(); }, timeoutMs);
  });

  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  console.log(`\n=== ${label} ===`);
  console.log(`binary: ${binary}`);
  console.log(`argv:   ${argv.join(' ')}`);
  console.log(`firstOutputMs: ${events.firstOutputMs}`);
  console.log(`firstUsageMs:  ${events.firstUsageMs}`);
  console.log(`model:         ${events.model}`);
  console.log(`exited:        ${events.exited} (code=${events.exitCode ?? '?'}) totalMs=${events.totalMs ?? '?'}`);
  return events;
}

async function main() {
  const copilotConfigDir = path.join(outDir, 'copilot-config');
  fs.mkdirSync(copilotConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(copilotConfigDir, 'config.json'),
    JSON.stringify({ banner: 'never' }, null, 2),
  );

  const results = [];
  results.push(await runCase({
    label: 'copilot-interactive',
    binary: resolveBinary('copilot'),
    argv: ['--config-dir', copilotConfigDir, '-i', 'say HELLO', '--allow-all-tools'],
    adapterName: 'copilot',
    timeoutMs: 45000,
  }));

  results.push(await runCase({
    label: 'cursor-bypass',
    binary: resolveBinary('agent'),
    argv: ['-p', 'say hi', '--output-format', 'stream-json'],
    adapterName: 'cursor',
    timeoutMs: 30000,
  }));

  const summary = results.map((r) => ({
    label: r.label,
    passed: r.firstUsageMs != null && r.model != null,
    firstOutputMs: r.firstOutputMs,
    firstUsageMs: r.firstUsageMs,
    model: r.model,
  }));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  const failed = summary.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${summary.length} cases did not extract a model.`);
    process.exit(1);
  }
  console.log('\nPASS: all cases extracted a model display name.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
