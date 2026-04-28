/**
 * Transcript cleanup dispatcher and shared utilities.
 *
 * Agent-specific cleanup logic lives in each adapter's folder:
 * - adapters/claude/transcript-cleanup.ts
 * - adapters/codex/transcript-cleanup.ts
 * - adapters/gemini/transcript-cleanup.ts
 * - adapters/qwen-code/transcript-cleanup.ts
 * - adapters/aider/transcript-cleanup.ts
 * - adapters/kimi/transcript-cleanup.ts
 * - adapters/droid/transcript-cleanup.ts
 *
 * This file provides:
 * 1. The dispatcher (cleanTranscriptForHandoff) that routes to the right adapter
 * 2. Shared utilities (noise filtering, finalization) used by all adapters
 */

import { cleanClaudeTranscript } from '../adapters/claude/transcript-cleanup';
import { cleanCodexTranscript } from '../adapters/codex/transcript-cleanup';
import { cleanGeminiTranscript } from '../adapters/gemini/transcript-cleanup';
import { cleanQwenTranscript } from '../adapters/qwen-code/transcript-cleanup';
import { cleanAiderTranscript } from '../adapters/aider/transcript-cleanup';
import { cleanKimiTranscript } from '../adapters/kimi/transcript-cleanup';
import { cleanDroidTranscript } from '../adapters/droid/transcript-cleanup';

// ---------------------------------------------------------------------------
// Shared utilities (exported for use by adapter transcript-cleanup files)
// ---------------------------------------------------------------------------

/** Cross-agent TUI noise patterns - never contain conversation content. */
const SHARED_NOISE_PATTERNS: RegExp[] = [
  // Separator bars (horizontal rules)
  /^[─━═╌╍┄┅┈┉\-]{10,}/,
  // Shell prompts (PS/bash/zsh with full path)
  /^PS\s+[A-Z]:\\/,
  /^\$\s+.*\.(EXE|exe|cmd)\s+--/,
  // Shell commands invoking agent CLIs (leaks internal paths)
  /^\s*&?\s*"?[A-Za-z]:[\\\/].*\.(EXE|exe|cmd)"\s+--/,
  // Session exit hints (all agents)
  /Press Ctrl.?C again to exit/,
  /^Resume this session with:/,
  // Empty prompt lines
  /^[❯›>]\s*$/,
];

/** Lines that are purely whitespace and/or box-drawing border characters. */
const BORDER_ONLY_LINE = /^[\s─━═╌╍┄┅┈┉\-|│┃╎╏┆┇┊┋╭╮╰╯┌┐└┘├┤┬┴┼]+$/;

/**
 * Filter lines through shared + agent-specific noise patterns.
 * Returns the lines that passed all filters.
 */
export function filterNoiseLines(
  lines: string[],
  agentPatterns: RegExp[],
): string[] {
  const allPatterns = [...SHARED_NOISE_PATTERNS, ...agentPatterns];
  const result: string[] = [];

  for (const line of lines) {
    if (allPatterns.some((pattern) => pattern.test(line))) continue;
    if (BORDER_ONLY_LINE.test(line)) continue;
    result.push(line);
  }

  return result;
}

/**
 * Remove trailing paragraphs that duplicate content already present
 * earlier in the text. Walks backward from the end, removing any
 * paragraph whose text appears earlier. Stops at the first unique paragraph.
 */
function stripTrailingDuplicates(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length < 2) return text;

  let keepCount = paragraphs.length;
  for (let index = paragraphs.length - 1; index > 0; index--) {
    const paragraph = paragraphs[index].trim();
    if (!paragraph) { keepCount = index; continue; }

    const earlierText = paragraphs.slice(0, index).join('\n\n');
    if (earlierText.includes(paragraph)) {
      keepCount = index;
    } else {
      break;
    }
  }

  return paragraphs.slice(0, keepCount).join('\n\n');
}

/**
 * Shared finalization applied after agent-specific cleanup:
 * collapse excessive blank lines, strip trailing dupes, trim.
 */
export function finalizeTranscript(text: string): string | null {
  let result = text.replace(/\n{3,}/g, '\n\n');
  result = stripTrailingDuplicates(result);
  return result.trim() || null;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Clean a raw ANSI-stripped transcript for inclusion in handoff context.
 *
 * Dispatches to agent-specific cleanup based on the source agent name.
 * Each agent's cleanup understands its TUI structure and extracts the
 * clean conversation from the raw PTY stream.
 *
 * @param rawTranscript - ANSI-stripped PTY output from TranscriptWriter
 * @param sourceAgent - Agent identifier: 'claude', 'codex', 'gemini', 'qwen', 'aider', 'kimi', 'droid'
 * @returns Cleaned transcript text, or null if nothing meaningful remains.
 */
export function cleanTranscriptForHandoff(
  rawTranscript: string,
  sourceAgent: string,
): string | null {
  if (!rawTranscript.trim()) return null;

  switch (sourceAgent) {
    case 'claude':
      return cleanClaudeTranscript(rawTranscript);
    case 'codex':
      return cleanCodexTranscript(rawTranscript);
    case 'gemini':
      return cleanGeminiTranscript(rawTranscript);
    case 'qwen':
      return cleanQwenTranscript(rawTranscript);
    case 'aider':
      return cleanAiderTranscript(rawTranscript);
    case 'kimi':
      return cleanKimiTranscript(rawTranscript);
    case 'droid':
      return cleanDroidTranscript(rawTranscript);
    default:
      // Unknown agents: no TUI-specific cleanup, just basic finalization
      return finalizeTranscript(rawTranscript);
  }
}
