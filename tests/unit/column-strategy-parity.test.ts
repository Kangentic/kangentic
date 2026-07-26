/**
 * Column-strategy parity guard.
 *
 * A Board Profile re-points a column's STRATEGY fields for one task, so every
 * spawn-affecting read of those fields must go through the profile-aware
 * resolver (`src/main/transition-engine/column-strategy.ts`) rather than
 * touching `lane.<field>` directly. A site that reads the raw lane silently
 * ignores the profile - and because the ladder still works everywhere else, the
 * symptom is "this one column ran the wrong model", which reads as flaky rather
 * than broken.
 *
 * This is not hypothetical. `auto_command` already shipped exactly this bug
 * WITHOUT profiles: the spawn path honored `task.auto_command` while the
 * live-injection path in task-move.ts read only the destination lane, so the
 * same task behaved differently depending on whether the destination happened
 * to have a live session. Profiles multiply that failure mode across ten
 * fields.
 *
 * The intended pattern is `applyProfileToLane(lane, profile)` at the TOP of a
 * call site, shadowing the lane, so every downstream read is profile-resolved
 * without threading a parallel argument through each call. Nothing in the type
 * system enforces that the folded object is the one used, which is precisely
 * why this scan exists.
 *
 * Scope note: deliberately limited to the spawn-affecting trees
 * (`src/main/ipc/**` and `src/main/transition-engine/**`). A repo-wide scan
 * would fire on sites that are correct by definition - `build-config.ts` and
 * `apply-config.ts` serialize every column field, `swimlane-repository.ts`
 * maps raw rows, and the renderer renders the board's own configuration.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['src/main/ipc', 'src/main/transition-engine'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const RESOLVER_FILE = 'src/main/transition-engine/column-strategy.ts';

/**
 * The strategy fields a Board Profile can re-point. Reading any of these off a
 * lane-ish identifier outside the resolver bypasses the profile tier.
 */
const STRATEGY_FIELDS = [
  'agent_override',
  'model_override',
  'effort_override',
  'permission_mode',
  'auto_command',
  'auto_spawn',
  'handoff_context',
  'session_target',
  'session_spawn_strategy',
  'plan_exit_target_id',
] as const;

/**
 * Identifiers that hold a swimlane. A read like `toLane.model_override` is only
 * profile-correct when `toLane` is already the folded object.
 */
const LANE_IDENTIFIERS = [
  'lane',
  'toLane',
  'fromLane',
  'rawToLane',
  'swimlane',
  'settingsLane',
  'destinationLane',
  'targetLane',
  'sourceLane',
  'currentLane',
  'existingLane',
];

const DIRECT_READ_PATTERN = new RegExp(
  `\\b(${LANE_IDENTIFIERS.join('|')})\\??\\.(${STRATEGY_FIELDS.join('|')})\\b`,
);

/**
 * Files allowed to read a lane's strategy fields without folding a profile
 * themselves, each with the reason. Keep this list short and specific: an entry
 * is a claim that the profile tier is either already applied upstream or
 * genuinely does not apply.
 */
const ALLOWLIST: Record<string, string> = {
  [RESOLVER_FILE]:
    'The resolver itself - it reads the base lane in order to fold the profile over it.',
  'src/main/transition-engine/session-isolation.ts':
    'Pure target/strategy helpers. Callers pass an already-folded lane; these only layer the '
    + 'context-aware defaults on top.',
  'src/main/transition-engine/injection-plan.ts':
    'Pure delta planner. Its `toLane` argument is supplied already folded by task-move.ts, which '
    + 'is the only caller that can know the task.',
  'src/main/transition-engine/spawn-preamble.ts':
    'The first-spawn lock returns early for profile tasks (`if (task.profile_id) return;`), so its '
    + 'raw settingsLane reads only ever run for direct-override tasks. Its `destinationLane` is '
    + 'supplied already folded by both chokepoints.',
};

/**
 * A file "folds" if it calls applyProfileToLane. That is the file-level
 * classification this repo already uses for spawn parity: it cannot prove every
 * read inside a folding file uses the folded object, but it does make a NEW
 * file, or a file that stops folding entirely, fail CI - which is the drift
 * that actually happens.
 */
function foldsProfile(source: string): boolean {
  return source.includes('applyProfileToLane(');
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(directory)) return files;
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

/** Skips full-line comments so prose naming a field (this file's own docs, JSDoc) does not trip the scan. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Files that read a strategy field but neither fold a profile nor carry an allowlist reason. */
function collectUnclassifiedFiles(): Array<{ relativePath: string; firstHit: string }> {
  const unclassified: Array<{ relativePath: string; firstHit: string }> = [];
  for (const scannedDir of SCANNED_DIRS) {
    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, scannedDir))) {
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (relativePath in ALLOWLIST) continue;

      const source = fs.readFileSync(filePath, 'utf-8');
      if (foldsProfile(source)) continue;

      const lines = source.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (isCommentLine(lines[index])) continue;
        if (DIRECT_READ_PATTERN.test(lines[index])) {
          unclassified.push({
            relativePath,
            firstHit: `${relativePath}:${index + 1}  ${lines[index].trim()}`,
          });
          break;
        }
      }
    }
  }
  return unclassified;
}

describe('column-strategy parity: every strategy reader is classified', () => {
  it('a file reading column strategy either folds the task\'s profile or is allowlisted', () => {
    const unclassified = collectUnclassifiedFiles();

    expect(
      unclassified.map((entry) => entry.firstHit),
      'These files read a column strategy field but never call applyProfileToLane, so a task '
      + 'riding a Board Profile silently gets the column\'s BASE value there while every other '
      + 'site honors its profile:\n'
      + unclassified.map((entry) => `  ${entry.firstHit}`).join('\n')
      + '\n\nFix by folding the lane once at the top of the call site:\n'
      + '  const lane = applyProfileToLane(rawLane, findTaskProfile({ profiles, profileId: task.profile_id })) ?? rawLane;\n'
      + '\nIf the profile tier genuinely does not apply (the site edits the column itself, or its '
      + 'lane arrives already folded), add the file to ALLOWLIST with that reason.',
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still reads a strategy field', () => {
    // Stops the allowlist rotting into a list of stale exemptions that quietly
    // pre-approve files nobody has looked at in a year.
    for (const relativePath of Object.keys(ALLOWLIST)) {
      const fullPath = path.join(REPO_ROOT, relativePath);
      expect(fs.existsSync(fullPath), `Allowlisted file ${relativePath} no longer exists - remove the entry`).toBe(true);

      const stillReads = fs.readFileSync(fullPath, 'utf-8')
        .split('\n')
        .some((line) => !isCommentLine(line) && DIRECT_READ_PATTERN.test(line));
      expect(
        stillReads,
        `Allowlisted file ${relativePath} no longer reads any column strategy field - remove its ALLOWLIST entry`,
      ).toBe(true);
    }
  });
});

describe('column-strategy parity: the resolver stays the single source of truth', () => {
  it('exports the folding entry points the call sites depend on', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, RESOLVER_FILE), 'utf-8');
    for (const exportName of ['resolveColumnStrategy', 'applyProfileToLane', 'findTaskProfile', 'resolveEffectiveAutoCommand']) {
      expect(source, `${RESOLVER_FILE} must export ${exportName}`).toContain(`export function ${exportName}`);
    }
  });

  it('folds by key PRESENCE, never `??`, so a profile can clear a base column pin', () => {
    // The three-state contract (absent = inherit, null = clear to agent default,
    // value = override) collapses to two states under `??`, and a profile then
    // cannot express "this column runs the agent's default model" against a base
    // column that pins one. tests/unit/column-strategy.test.ts covers the
    // behavior; this asserts the mechanism it rests on is still present.
    const source = fs.readFileSync(path.join(REPO_ROOT, RESOLVER_FILE), 'utf-8');
    expect(source).toContain('hasOwnProperty');
  });

  it('both spawn chokepoints fold the profile before resolving', () => {
    const chokepoints = [
      'src/main/ipc/helpers/agent-spawn.ts',
      'src/main/transition-engine/session-startup/prepare-spawn.ts',
    ];
    for (const relativePath of chokepoints) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
      expect(
        source.includes('applyProfileToLane'),
        `${relativePath} is a spawn chokepoint and must fold the task's Board Profile over its lane`,
      ).toBe(true);
    }
  });

  it('the first-spawn lock bails out in profile mode', () => {
    // A profile is a ladder, not a snapshot. Locking would freeze the task's
    // first column's values for its whole life - exactly the per-column
    // variation the feature exists to provide.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/transition-engine/spawn-preamble.ts'), 'utf-8');
    expect(source).toContain('if (task.profile_id) return;');
  });
});
