/**
 * Does the answer call get prompt caching on its stable prefix?
 *
 * MANUAL ONLY, like `eval-ask.mjs`, and for the same reason: this spends real
 * agent calls. Three of them: a floor, then the two that answer the question.
 * It refuses to run where a CI variable is set.
 *
 *   node scripts/probe-cache.mjs
 *
 * WHY IT MATTERS. Ask's prompt is a large STABLE prefix (rules, glossary,
 * summary, and the whole task table - about 14k tokens, byte-identical across
 * questions for a given corpus) followed by a variable tail (the retrieved
 * excerpts and the question). Published pricing puts cache reads at $0.30/M
 * against $3/M for input, so if that prefix caches, every question after the
 * first pays a tenth for it and the recurring bill is already small. If it does
 * not, every question pays full price for an identical 14k of text, and that is
 * the largest remaining lever on this surface.
 *
 * We do not know which, and the point of this probe is to stop guessing.
 *
 * HOW. Two calls sharing an identical long prefix and differing only in their
 * final line. If the CLI caches a user message, the second call reports
 * `cache_read_input_tokens` at roughly the prefix size. If it reports zero and
 * pays `cache_creation_input_tokens` again, the prefix is not being reused.
 *
 * The first call is expected to be a cache WRITE either way, so only the second
 * call's numbers answer the question.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

/** Past this, a call counts as failed and its CLI is stopped. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * A stand-in for the stable prefix, sized to match the real one.
 *
 * Deliberately shaped like the task table rather than random filler: caching
 * keys on an exact prefix, and a degenerate string of repeated bytes is not a
 * fair test of how a real table of varied rows behaves.
 */
function buildPrefix(rows) {
  const lines = ['ref|task|ticket|cost_usd|duration|outcome'];
  for (let index = 1; index <= rows; index += 1) {
    lines.push(
      `T${index}|Task number ${index}: a representative title of about the length real ones run to`
      + `|#${1000 + index}|${(index * 1.37).toFixed(2)}|${index % 9}h ${index % 60}m|done`,
    );
  }
  return lines.join('\n');
}

function ask(prompt) {
  return new Promise((resolve) => {
    // `shell` is what finds the npm `claude.cmd` shim on Windows, and a shell
    // joins argv with spaces unquoted, so the empty tool list is written as a
    // quoted empty string. Bare, it vanished and left `--tools` with no value.
    // No session is saved, as on the product's answer path, so a probe leaves
    // nothing behind in the user's Claude history.
    const args = [
      '-p', '--model', 'haiku',
      '--tools', '""', '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format', 'json',
    ];
    // Prompt on STDIN, exactly as the product sends it - an argv prompt of this
    // size would not survive the command line and would not be the same test.
    const child = spawn('claude', args, { cwd: os.tmpdir(), shell: true });
    let out = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stopTree(child);
      settle({ error: `no reply within ${CALL_TIMEOUT_MS / 1000}s` });
    }, CALL_TIMEOUT_MS);
    child.on('error', (error) => settle({ error: error.message }));
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const usage = parsed.usage ?? {};
        settle({
          input: usage.input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          costUsd: parsed.total_cost_usd ?? null,
        });
      } catch {
        settle({ error: out.slice(0, 300) });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Stop the CLI, not just its shell. On Windows `shell: true` starts cmd.exe,
 *  and `child.kill()` ends cmd.exe while `claude` keeps running. */
function stopTree(child) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** Whether node was asked to run this file. Compared by real path, as
 *  `package-smoke.mjs` does: node resolves the entry through links, so a
 *  checkout under a link or junction never matched by URL. */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(url.fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

/** The same guard as `eval-ask.mjs`: a real agent call never runs unattended. */
function refuseIfAutomated() {
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER']
    .find((name) => process.env[name]);
  if (automated) {
    throw new Error(`Refusing to run: ${automated} is set. This probe spends real agent calls and is for on-demand use only.`);
  }
}

if (!isEntrypoint()) {
  throw new Error('Run this probe directly with node, never import it.');
}
refuseIfAutomated();

const prefix = buildPrefix(350);
const shared = `Here is a table of tasks.\n\n${prefix}\n\n`;

/*
 * A FLOOR first, and it is what makes the rest of this readable.
 *
 * The CLI carries its own system prompt and tool context on every call, and it
 * caches that for reasons of its own. Without measuring it, that number sits
 * inside every reading and invites exactly the two wrong conclusions this
 * script has already printed: once matching the system cache and calling our
 * prefix cached, once seeing a warm steady state and calling it uncached.
 *
 * Everything below is reported NET of this.
 */
const floor = await ask('Reply with exactly: OK');
console.log('floor (the CLI\'s own context, ours net of this):', floor);

const first = await ask(`${shared}Question: how many rows does the table have?`);
console.log('call 1:', first);

const second = await ask(`${shared}Question: what is the ticket of the first row?`);
console.log('call 2:', second);

/*
 * The verdict asks ONE question: of the prefix we sent, how much did the last
 * call READ rather than WRITE, net of the CLI's own context?
 *
 * Two earlier versions of this check were wrong in opposite directions, and
 * both wrongs came from not having the floor:
 *
 *   - `call2.cacheRead > prefixTokens / 2` printed CACHED on a run that proved
 *     the opposite. It was matching the CLI's own 7,344-token system cache.
 *   - Comparing call 2 against call 1 printed NOT CACHED on a warm run where
 *     BOTH calls read the prefix and wrote nothing. On a steady-state cache the
 *     difference between two calls is zero, which that test read as failure.
 *
 * Netting off the floor removes both traps: what remains is our prefix, and the
 * only thing that matters is whether it arrived as a read or as a write.
 */
const ourRead = second.cacheRead - floor.cacheRead;
const ourWrite = second.cacheWrite - floor.cacheWrite;

if (second.error || first.error || floor.error) {
  console.log('\nA call failed; nothing can be concluded.');
} else if (ourRead > ourWrite) {
  console.log(
    `\nCACHED. Net of the CLI's own context, call 2 READ ${ourRead} tokens of our prefix`
    + `\nand wrote ${ourWrite}. The stable prefix is reused across questions, so every`
    + '\nquestion after the first pays roughly a tenth for it.'
    + '\n\nThe token thread is closed: there is no large recurring saving left in'
    + '\nshrinking the table, because the table is already nearly free to resend.',
  );
} else {
  console.log(
    `\nNOT CACHED. Net of the floor, call 2 wrote ${ourWrite} and read ${ourRead}, so an`
    + '\nidentical prefix is paid for in full on every question.'
    + '\n\nThis is NOT reachable by editing the prompt text: whether a user message'
    + '\ncarries a cache breakpoint is the CLI\'s decision. Changing it means'
    + '\nchanging how the agent is invoked, which deserves its own round.',
  );
}
