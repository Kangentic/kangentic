import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasOptOutMarker } from './helpers/opt-out-marker';

// Enforces .claude/rules/activity-state-classification.md. The idle-vs-active question
// ("does this session require user interaction?") has a single source of truth in
// src/shared/activity-state.ts (requiresUserInteraction / isActive, backed by a
// `satisfies Record<ActivityState, ...>` table). Re-deriving that bucket inline by
// comparing ActivityState string literals is what let 'permission' fall into the wrong
// bucket and produce the sidebar active/idle miscount.
//
// This scan flags renderer comparisons against the ActivityState literals so a new
// hand-rolled bucket check is caught in CI. It is deliberately tight (anchored on
// === / !== against the three literals) so it does not match unrelated strings.
//
// Two escape hatches, both legitimate and both narrow:
//   - A per-line `// activity-state-ok: <reason>` marker (on the line or the line above)
//     for a genuine GRANULAR comparison that distinguishes specific states for an
//     affordance (e.g. permission-specific message text), which is not a bucket question.
//   - Allowlisted paths: the debug overlay/timeline render every granular state on
//     purpose, and BrowserTab's `clearState` is an unrelated state machine that happens
//     to use the word 'idle'.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

// Comparison (=== / !==) against an ActivityState literal, either operand order.
const ACTIVITY_LITERAL_COMPARE =
  /(===|!==)\s*['"](idle|permission|thinking)['"]|['"](idle|permission|thinking)['"]\s*(===|!==)/;
const OK_MARKER = 'activity-state-ok';

// Paths (POSIX, relative to repo root) exempt from the scan, each with a reason.
const ALLOWLIST_PREFIXES = [
  // Diagnostic UI that intentionally renders each granular ActivityState.
  'src/renderer/components/debug/',
  // Unrelated cache-clear state machine; its 'idle' is not an ActivityState.
  'src/renderer/components/settings/tabs/BrowserTab.tsx',
];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

describe('activity-state idle-vs-active bucketing goes through the shared classifier', () => {
  it('no hand-rolled ActivityState bucket comparisons in src/renderer', () => {
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    for (const filePath of collectSourceFiles(absoluteDir)) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (ALLOWLIST_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (!ACTIVITY_LITERAL_COMPARE.test(line)) return;
        if (hasOptOutMarker(lines, index, OK_MARKER)) return;
        offenders.push(`${relative}:${index + 1}`);
      });
    }
    expect(
      offenders,
      `Renderer code must not hand-roll the idle-vs-active question by comparing ActivityState literals. ` +
        `Use requiresUserInteraction / isActive from src/shared/activity-state.ts. For a genuine ` +
        `per-state affordance (not a bucket), add // activity-state-ok: <reason>.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
