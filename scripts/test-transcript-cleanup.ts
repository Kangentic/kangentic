#!/usr/bin/env npx tsx
/**
 * Local test: spawn real TUI agents, capture PTY output, validate cleanup.
 *
 * Usage:
 *   npx tsx scripts/test-transcript-cleanup.ts           # test all detected agents
 *   npx tsx scripts/test-transcript-cleanup.ts claude     # test only Claude
 *   npx tsx scripts/test-transcript-cleanup.ts codex      # test only Codex
 *   npx tsx scripts/test-transcript-cleanup.ts gemini     # test only Gemini
 *
 * Each agent is spawned with a simple prompt ("Tell me about 3 birds"),
 * given time to respond, then killed. The raw PTY output is ANSI-stripped
 * and run through cleanTranscriptForHandoff. The test passes if the cleaned
 * output contains the expected content.
 *
 * Requires: agent CLIs installed and on PATH.
 */

import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { stripAnsiEscapes } from '../src/main/pty/buffer/transcript-writer';
import { cleanTranscriptForHandoff } from '../src/main/agent/handoff/transcript-cleanup';

const PROMPT = 'Tell me about 3 birds. Be brief - one sentence each.';
const CAPTURE_SECONDS = 90;

interface AgentConfig {
  cmd: string;
  args: string[];
  marker: string;
}

const AGENTS: Record<string, AgentConfig> = {
  claude: {
    cmd: 'claude',
    // Interactive mode (no -p) so we get the full TUI with viewport redraws.
    // The prompt is passed as the positional argument.
    args: [PROMPT],
    marker: 'birds',
  },
  codex: {
    cmd: 'codex',
    args: [PROMPT],
    marker: 'birds',
  },
  gemini: {
    cmd: 'gemini',
    args: [PROMPT],
    marker: 'birds',
  },
};

interface CaptureResult {
  name: string;
  rawOutput: string;
  stripped: string;
  cleaned: string | null;
  skipped: boolean;
}

function findCommand(command: string): string | null {
  try {
    const results = execSync(`where ${command}`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim());
    // On Windows, prefer .cmd/.exe over bare scripts (error code 193)
    const cmdOrExe = results.find((result) => /\.(cmd|exe)$/i.test(result));
    return cmdOrExe || results[0] || null;
  } catch {
    return null;
  }
}

function captureAgent(name: string, config: AgentConfig): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const cliPath = findCommand(config.cmd);
    if (!cliPath) {
      console.log(`  SKIP: ${config.cmd} not found on PATH\n`);
      resolve({ name, rawOutput: '', stripped: '', cleaned: null, skipped: true });
      return;
    }

    console.log(`  Spawning: ${cliPath} ${config.args.join(' ')}`);
    console.log(`  Capturing for ${CAPTURE_SECONDS}s...\n`);

    let rawOutput = '';
    const ptyProcess = pty.spawn(cliPath, config.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
    });

    // Idle detection: after the agent stops outputting for 3s, trigger a
    // PTY resize to force a clean TUI redraw, then kill after another 3s.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let resized = false;
    const IDLE_BEFORE_RESIZE_MS = 3000;
    const IDLE_AFTER_RESIZE_MS = 3000;

    function resetIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!resized) {
          // Force a TUI redraw by resizing the PTY. TUI agents redraw
          // the full viewport on resize, producing the clean final render.
          resized = true;
          console.log('  (triggering resize to force clean TUI redraw)');
          try { ptyProcess.resize(121, 31); } catch { /* best effort */ }
          resetIdleTimer();
        } else {
          console.log('  (idle timeout - capturing complete)');
          try { ptyProcess.kill(); } catch { /* best effort */ }
        }
      }, resized ? IDLE_AFTER_RESIZE_MS : IDLE_BEFORE_RESIZE_MS);
    }

    ptyProcess.onData((data: string) => {
      rawOutput += data;
      resetIdleTimer();
    });

    ptyProcess.onExit(() => {
      finalize();
    });

    // Hard timeout as backstop
    const timer = setTimeout(() => {
      console.log('  (hard timeout reached)');
      try { ptyProcess.kill(); } catch { /* best effort */ }
    }, CAPTURE_SECONDS * 1000);

    let finalized = false;
    function finalize(): void {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);

      const stripped = stripAnsiEscapes(rawOutput);
      const cleaned = cleanTranscriptForHandoff(stripped, name);

      resolve({ name, rawOutput, stripped, cleaned, skipped: false });
    }
  });
}

async function main(): Promise<void> {
  const requestedAgent = process.argv[2];
  const agentNames = requestedAgent
    ? [requestedAgent]
    : Object.keys(AGENTS);

  console.log('=== Transcript Cleanup Test ===\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const name of agentNames) {
    const config = AGENTS[name];
    if (!config) {
      console.log(`Unknown agent: ${name}`);
      failed++;
      continue;
    }

    console.log(`--- ${name.toUpperCase()} ---`);
    const result = await captureAgent(name, config);

    if (result.skipped) {
      skipped++;
      continue;
    }

    // Print stats
    const rawLines = result.stripped.split('\n').length;
    const cleanedLines = result.cleaned ? result.cleaned.split('\n').length : 0;
    console.log(`  Raw (stripped):  ${rawLines} lines`);
    console.log(`  Cleaned:         ${cleanedLines} lines`);
    console.log(`  Reduction:       ${rawLines > 0 ? Math.round((1 - cleanedLines / rawLines) * 100) : 0}%\n`);

    // Dump raw stripped output for failed or partially-extracted results
    if (name === 'gemini' || !result.cleaned?.toLowerCase().includes(config.marker)) {
      console.log('  --- Raw Stripped (last 60 lines) ---');
      const rawLines = result.stripped.split('\n');
      const startLine = Math.max(0, rawLines.length - 60);
      for (let lineIndex = startLine; lineIndex < rawLines.length; lineIndex++) {
        console.log(`  | ${rawLines[lineIndex]}`);
      }
      console.log('  --- End Raw ---\n');
    }

    // Print cleaned output
    console.log('  --- Cleaned Output ---');
    if (result.cleaned) {
      for (const line of result.cleaned.split('\n')) {
        console.log(`  ${line}`);
      }
    } else {
      console.log('  (null - no content extracted)');
    }
    console.log('  --- End ---\n');

    // Validate
    const checks: Array<{ label: string; pass: boolean }> = [];

    // Must have content
    if (!result.cleaned) {
      checks.push({ label: 'has content', pass: false });
    } else {
      checks.push({ label: 'has content', pass: true });

      // Must contain the expected marker word
      const hasMarker = result.cleaned.toLowerCase().includes(config.marker);
      checks.push({ label: `contains "${config.marker}"`, pass: hasMarker });

      // Must contain a structured list (numbered or bulleted)
      const hasStructuredList = /(\d+\.\s)|(\n\s*-\s)/.test(result.cleaned);
      checks.push({ label: 'contains structured list', pass: hasStructuredList });

      // Must not have excessive duplication (same line appearing 3+ times)
      const lineCount: Record<string, number> = {};
      for (const line of result.cleaned.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 10) {
          lineCount[trimmed] = (lineCount[trimmed] || 0) + 1;
        }
      }
      const maxDupes = Math.max(0, ...Object.values(lineCount));
      checks.push({ label: `no excessive duplication (max repeats: ${maxDupes})`, pass: maxDupes < 3 });
    }

    let allPass = true;
    for (const check of checks) {
      const icon = check.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${check.label}`);
      if (!check.pass) allPass = false;
    }
    console.log('');

    if (allPass) passed++;
    else failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
