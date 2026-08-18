#!/usr/bin/env node
/**
 * Mock Antigravity CLI (agy) for E2E tests.
 *
 * agy command shapes (see src/main/agent/adapters/antigravity/command-builder.ts):
 *   agy --version                                        -> detector probe
 *   agy [--mode <m>] --conversation <id> [-i <prompt>]   -> resume
 *   agy [--mode <m>] [-i|-p] <prompt>                    -> new session
 *
 * Markers for test assertions:
 *   MOCK_AGY_SESSION:<id>   -> new session
 *   MOCK_AGY_RESUMED:<id>   -> resumed session via --conversation
 *   MOCK_AGY_PROMPT:<text>  -> prompt text delivered via -i / -p
 *
 * Mirrors the real CLI's exit behavior (verified against agy 1.1.13): the
 * conversation id is NOT printed at boot. The first Ctrl+C prints
 * "press ctrl+c again to exit"; the second prints the shutdown summary
 * (`agy --conversation=<uuid>`) and exits. That summary line is what the
 * adapter's `fromOutput` scraper captures at suspend, so the E2E resume flow
 * genuinely exercises the exit-time capture path.
 *
 * Also paints the idle footer ("? for shortcuts") so detectIdle can fire.
 */

const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('0.0.0-test');
  process.exit(0);
}

let conversationId = null;
let resumed = false;
let prompt = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--conversation' && args[i + 1]) {
    conversationId = args[i + 1];
    resumed = true;
    i++;
    continue;
  }
  if (a === '-i' || a === '-p' || a === '--print' || a === '--prompt-interactive') {
    if (args[i + 1]) { prompt = args[i + 1]; i++; }
    continue;
  }
  if (a === '--mode' || a === '--model' || a === '--effort' || a === '--output-format') {
    if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    continue;
  }
}

if (!conversationId) conversationId = randomUUID();

if (resumed) {
  console.log('MOCK_AGY_RESUMED:' + conversationId);
} else {
  console.log('MOCK_AGY_SESSION:' + conversationId);
}

if (prompt) {
  console.log('MOCK_AGY_PROMPT:' + prompt);
}

// Idle footer, as the real TUI paints between turns.
console.log('? for shortcuts');

const timeout = setTimeout(() => { process.exit(0); }, 30000);

let interruptCount = 0;
function exitWithSummary() {
  clearTimeout(timeout);
  // The real CLI prints this on graceful exit; the adapter's fromOutput
  // regex captures the conversation id from it during suspend.
  console.log('Resume with -c (or command below):');
  console.log('agy --conversation=' + conversationId);
  process.exit(0);
}

process.on('SIGTERM', exitWithSummary);
process.on('SIGINT', () => {
  interruptCount += 1;
  if (interruptCount === 1) console.log('press ctrl+c again to exit');
  else exitWithSummary();
});

// Raw mode, like the real agy TUI (and every other interactive fixture here).
//
// This is load-bearing on POSIX, not cosmetic. Kangentic writes the whole exit
// sequence back-to-back in one tick (`writeExitSequence`), and agy's is TWO
// Ctrl+C. In canonical mode the tty turns each \x03 into SIGINT instead of
// delivering it as data - and POSIX standard signals are NOT queued, so two
// raised in immediate succession coalesce into a single delivery. The mock then
// counted one interrupt, printed "press ctrl+c again to exit", and never
// reached exitWithSummary, so the `agy --conversation=<uuid>` line the adapter's
// fromOutput scraper needs was never printed and the resume spawned fresh.
//
// That failed only on Linux CI (intermittently, depending on whether the handler
// ran between the two signals) and always passed on Windows, where ConPTY
// delivers \x03 as data. Raw mode disables ISIG, so both bytes arrive on the
// data path on every platform and the count is deterministic.
if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true); } catch { /* not a tty: fall back to the SIGINT path */ }
}
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Double Ctrl+C exits (both may arrive in one chunk).
  const interrupts = (data.match(/\x03/g) || []).length;
  if (interrupts === 0) return;
  interruptCount += interrupts;
  if (interruptCount >= 2) exitWithSummary();
  else console.log('press ctrl+c again to exit');
});
