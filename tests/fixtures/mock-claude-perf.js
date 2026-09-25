#!/usr/bin/env node
/**
 * Perf-rig mock agent for scripts/drag-perf-rig.mjs.
 *
 * Answers `--version` and `--help` like mock-claude.js so detection and capability
 * discovery succeed, then enters the alt screen, hides the cursor (Kangentic's
 * first-output latch), and writes `status.json` plus appends `events.jsonl` in the
 * session directory (derived from `--settings`, the only reliable source) at
 * MOCK_PERF_PUSH_HZ. Those files go through the REAL status-file pipeline, so the
 * renderer receives genuine `session:usage` and `session:activity` pushes at a
 * known rate while a drag is measured. Lives for MOCK_PERF_LIFETIME_MS (default
 * 10 minutes) and exits on Ctrl+C or Ctrl+D.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('mock-claude 0.0.0-perf');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: claude [options] [prompt]');
  console.log('');
  console.log('Options:');
  console.log('  --version            Print version and exit');
  console.log('  --help               Show this help');
  console.log('  --print              Non-interactive mode');
  console.log('  --session-id <uuid>  Create a new session with this id');
  console.log('  --resume <uuid>      Resume an existing session');
  console.log('  --model <name>       Override the model for this session');
  console.log('  --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)');
  console.log('  --permission-mode <mode>  Permission mode');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let settingsPath = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--session-id' && index + 1 < args.length) { sessionId = args[index + 1]; index++; }
  else if (args[index] === '--resume' && index + 1 < args.length) { sessionId = args[index + 1]; resumed = true; index++; }
  else if (args[index] === '--settings' && index + 1 < args.length) { settingsPath = args[index + 1]; index++; }
}
if (sessionId) console.log((resumed ? 'MOCK_CLAUDE_RESUMED:' : 'MOCK_CLAUDE_SESSION:') + sessionId);
if (settingsPath) console.log('MOCK_CLAUDE_SETTINGS:' + settingsPath);

const pushHz = parseFloat(process.env.MOCK_PERF_PUSH_HZ || '3');
const lifetimeMs = parseInt(process.env.MOCK_PERF_LIFETIME_MS || '600000', 10);
const sessionDir = settingsPath ? path.dirname(settingsPath) : null;

function paint() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  let out = '\x1b[2J\x1b[H';
  out += '\x1b[1m Claude Code (perf mock) \x1b[0m ' + cols + 'x' + rows + '\n';
  out += ' session ' + (sessionId || 'none') + '\n';
  out += ' writing status/events at ' + pushHz + ' Hz\n';
  for (let line = 3; line < rows - 2; line++) out += ' > tool call ' + line + '\n';
  out += ' ❯ ';
  process.stdout.write(out);
}

process.stdout.write('\x1b[?1049h\x1b[?25l');
paint();
process.stdout.on('resize', paint);

let tick = 0;
let timer = null;
if (sessionDir && pushHz > 0) {
  const statusPath = path.join(sessionDir, 'status.json');
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const tools = ['Read', 'Grep', 'Edit', 'Bash', 'Glob'];
  timer = setInterval(() => {
    tick += 1;
    const inputTokens = 4000 + tick * 37;
    const cacheRead = 60000 + tick * 120;
    const usedTokens = inputTokens + cacheRead + 800;
    const status = {
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      context_window: {
        used_percentage: Math.min(95, (usedTokens / 200000) * 100),
        context_window_size: 200000,
        current_usage: {
          input_tokens: inputTokens,
          output_tokens: 800 + tick,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: cacheRead,
        },
      },
      cost: { total_cost_usd: tick * 0.0007, total_duration_ms: tick * (1000 / pushHz) },
    };
    try { fs.writeFileSync(statusPath, JSON.stringify(status)); } catch { /* the session dir may be gone */ }
    const tool = tools[tick % tools.length];
    const event = tick % 2 === 1
      ? { ts: Date.now(), type: 'tool_start', tool, detail: 'src/renderer/file-' + tick + '.ts' }
      : { ts: Date.now(), type: 'tool_end', tool };
    try { fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n'); } catch { /* the session dir may be gone */ }
  }, Math.max(20, Math.round(1000 / pushHz)));
}

function shutdown(code) {
  if (timer) clearInterval(timer);
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.exit(code);
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  if (text.includes('\x03') || text.includes('\x04')) shutdown(0);
});
process.stdin.on('end', () => shutdown(0));
setTimeout(() => shutdown(0), lifetimeMs);
