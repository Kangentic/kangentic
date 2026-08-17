/**
 * One-shot Antigravity print runs through a hidden PTY.
 *
 * `agy -p` HANGS when stdio is not a TTY (upstream
 * google-antigravity/antigravity-cli#318), so the shared child_process
 * `runCliPrintSummarize` cannot drive it. Inside a PTY it behaves (verified
 * against 1.1.13): runs the prompt, prints a single JSON object
 * (`--output-format json`: conversation_id, status, response, usage) and
 * exits on its own within seconds.
 *
 * The run uses a dedicated scratch cwd, pre-trusted via the trust manager,
 * for two reasons: an untrusted cwd could block on the TUI trust prompt, and
 * a print run in the PROJECT cwd would overwrite that workspace's
 * `last_conversations.json` entry - hijacking the user's own `agy -c` there.
 */
// Type-only: erased at compile time so importing the adapter graph does not
// load node-pty's native bindings; the runtime module loads lazily per run
// (the model-picker-probe precedent).
import type * as pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The control-code core only (steps 1-5), DELIBERATELY without
// stripAnsiEscapes' newline normalization and trailing-whitespace trim
// (steps 6-8): those rewrite bytes that may sit inside the JSON payload
// extracted below.
import { stripAnsiControlCodes } from '../../../../shared/ansi-strip';
import { ensureWorkspaceTrust } from './trust-manager';

const PRINT_TIMEOUT_MS = 25_000;
const OUTPUT_CAP_BYTES = 64 * 1024;

/** Stable, pre-trustable scratch cwd for print runs. */
function scratchDirectory(): string {
  return path.join(os.tmpdir(), 'kangentic-antigravity-print');
}

/**
 * Pull the print-mode result object out of captured PTY output: the LAST
 * `{...}` JSON blob carrying a `response` field (PTY chrome like the clear
 * sequence and the shell's OSC title precede/follow it).
 */
export function extractPrintResponse(rawOutput: string): string | null {
  const cleaned = stripAnsiControlCodes(rawOutput);
  const candidates: string[] = [...(cleaned.match(/\{[\s\S]*?\}(?=\s*$|\s*\{)/g) ?? [])];
  // Also try a greedy whole-object match: the result JSON can contain nested
  // braces (usage object), which the lazy candidate split above would cut.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { response?: unknown };
      if (typeof parsed.response === 'string') return parsed.response;
    } catch {
      // Not the result object - keep scanning.
    }
  }
  return null;
}

/**
 * Run `agy -p <prompt> --output-format json` in a hidden PTY and return the
 * response text. Throws on timeout, spawn failure, or an unparseable result
 * (the summarize caller treats any throw as "auto-name unavailable").
 */
export async function runAntigravityPrint(cliPath: string, prompt: string): Promise<string> {
  const scratch = scratchDirectory();
  fs.mkdirSync(scratch, { recursive: true });
  await ensureWorkspaceTrust(scratch);

  // Newlines collapse to spaces: the prompt travels as one argv entry
  // through ConPTY's command-line reconstruction, where embedded CR/LF is
  // undefined territory. Title generation does not need line structure.
  const flatPrompt = prompt.replace(/\s*\r?\n\s*/g, ' ').trim();

  // Loaded lazily so the native bindings initialize only when a print run
  // actually happens (model-picker-probe precedent).
  const nodePty = await import('node-pty');
  const spawnOptions: pty.IPtyForkOptions = {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: scratch,
    env: { ...process.env } as Record<string, string>,
  };
  const args = ['-p', flatPrompt, '--output-format', 'json'];
  const printProcess = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)
    ? nodePty.spawn('cmd.exe', ['/c', cliPath, ...args], spawnOptions)
    : nodePty.spawn(cliPath, args, spawnOptions);

  return new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { printProcess.kill(); } catch { /* already exited */ }
      if (error) {
        reject(error);
        return;
      }
      const response = extractPrintResponse(output);
      if (response && response.trim().length > 0) resolve(response.trim());
      else reject(new Error('antigravity print run produced no parseable response'));
    };

    const timer = setTimeout(() => finish(new Error('antigravity print run timed out')), PRINT_TIMEOUT_MS);

    printProcess.onData((data) => {
      // Retain the TAIL under the cap, not the head: extractPrintResponse
      // reads the result JSON from the END of the captured stream, so a
      // drop-forward guard would discard exactly the closing chunk that
      // carries it once a chatty run crosses the cap.
      output = (output + data).slice(-OUTPUT_CAP_BYTES);
    });
    printProcess.onExit(() => {
      // Give the final chunk a tick to land before parsing.
      setTimeout(() => finish(null), 100);
    });
  });
}
