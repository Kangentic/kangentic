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
 *
 * Its result names the conversation it made and what it cost. The run removes
 * that conversation, as the answer run does (a title is not a conversation to
 * resume), and hands the cost to its caller's usage sink.
 */
// The print run's PTY runs in the pty host; node-pty loads only there, or
// lazily here when no host is registered (the model-picker-probe precedent).
import { spawnOffMainPty, type OffMainPtyOptions } from '../../../utility-process/off-main-pty';
import { childProcessEnv } from '../../../shared/child-env';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The control-code core only (steps 1-5), DELIBERATELY without
// stripAnsiEscapes' newline normalization and trailing-whitespace trim
// (steps 6-8): those rewrite bytes that may sit inside the JSON payload
// extracted below.
import { stripAnsiControlCodes } from '../../../../shared/ansi-strip';
import type { AgentCallUsage } from '../../../../shared/types';
import { antigravityUsage, removeAntigravityConversation } from './answer-stream';
import { ensureWorkspaceTrust } from './trust-manager';

const PRINT_TIMEOUT_MS = 25_000;
const OUTPUT_CAP_BYTES = 64 * 1024;

/** Stable, pre-trustable scratch cwd for print runs. */
function scratchDirectory(): string {
  return path.join(os.tmpdir(), 'kangentic-antigravity-print');
}

/** A print run's result object, as far as its caller needs it. */
export interface AntigravityPrintResult {
  response: string;
  conversationId: string | null;
  usage: AgentCallUsage | null;
}

/**
 * Pull the print-mode result object out of captured PTY output: the LAST
 * `{...}` JSON blob carrying a `response` field (PTY chrome like the clear
 * sequence and the shell's OSC title precede/follow it).
 */
export function extractPrintResult(rawOutput: string): AntigravityPrintResult | null {
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
      const parsed = JSON.parse(candidate) as { response?: unknown; conversation_id?: unknown; usage?: unknown };
      if (typeof parsed.response === 'string') {
        return {
          response: parsed.response,
          conversationId: typeof parsed.conversation_id === 'string' ? parsed.conversation_id : null,
          usage: antigravityUsage(parsed.usage),
        };
      }
    } catch {
      // Not the result object - keep scanning.
    }
  }
  return null;
}

/**
 * Run `agy -p <prompt> --output-format json` in a hidden PTY and return the
 * response text. `flags` follow the fixed ones (the summarize caller's model and
 * effort). `onUsage` hears what the run reported it cost, before any throw.
 * Throws on timeout, spawn failure, or an unparseable result (the summarize
 * caller treats any throw as "auto-name unavailable").
 */
export async function runAntigravityPrint(
  cliPath: string,
  prompt: string,
  flags: readonly string[] = [],
  onUsage?: (usage: AgentCallUsage) => void,
): Promise<string> {
  const scratch = scratchDirectory();
  // sync-write-ok: this must throw, not degrade - the function docblock above
  // already documents that contract, and the summarize caller treats any
  // throw from this whole function as "auto-name unavailable".
  fs.mkdirSync(scratch, { recursive: true });
  await ensureWorkspaceTrust(scratch);

  // Newlines collapse to spaces: the prompt travels as one argv entry
  // through ConPTY's command-line reconstruction, where embedded CR/LF is
  // undefined territory. Title generation does not need line structure.
  const flatPrompt = prompt.replace(/\s*\r?\n\s*/g, ' ').trim();

  // Spawned in the pty host (off-main-pty.ts, the model-picker-probe
  // precedent): ConPTY creation is synchronous on the calling thread.
  const spawnOptions: OffMainPtyOptions = {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: scratch,
    env: childProcessEnv(),
  };
  const args = ['-p', flatPrompt, '--output-format', 'json', ...flags];
  const printProcess = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)
    ? await spawnOffMainPty('cmd.exe', ['/c', cliPath, ...args], spawnOptions)
    : await spawnOffMainPty(cliPath, args, spawnOptions);

  return new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { printProcess.kill(); } catch { /* already exited */ }
      // Read before any rejection: a run that failed still cost what it
      // reported, and its conversation is still not one to resume.
      const result = extractPrintResult(output);
      if (result?.usage) onUsage?.(result.usage);
      if (result?.conversationId) void removeAntigravityConversation(result.conversationId);
      if (error) {
        reject(error);
        return;
      }
      if (result && result.response.trim().length > 0) resolve(result.response.trim());
      else reject(new Error('antigravity print run produced no parseable response'));
    };

    const timer = setTimeout(() => finish(new Error('antigravity print run timed out')), PRINT_TIMEOUT_MS);

    printProcess.onData((data) => {
      // Retain the TAIL under the cap, not the head: extractPrintResult
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
