import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';

// The no-activity-hold sentinel exists in three copies, and only one of them can
// import the constant:
//
//   1. `src/shared/background-shell-hold.ts` - the source of truth, read by the
//      activity engine's `updateCounters`.
//   2. `scripts/worktree-preview.js` - CommonJS, cannot import a `.ts` module.
//      Prints the `Watch:` command the agent runs.
//   3. `.claude/skills/preview/SKILL.md` - markdown, cannot import anything.
//
// Nothing links them at compile time, so a rename in (1) silently strands (2)
// and (3) and the preview watcher goes back to pinning its task ACTIVE for
// hours - a regression with NO failing type, lint, or engine test, because the
// engine keeps working perfectly on a flag nobody sends any more.
//
// This is the same hand-duplication pattern as `WORKTREE_MARKER`
// (`src/shared/git-utils.ts` vs `scripts/worktree-preview.js`).

const REPO_ROOT = path.resolve(__dirname, '../..');
const PREVIEW_SCRIPT = path.join(REPO_ROOT, 'scripts/worktree-preview.js');
const PREVIEW_SKILL = path.join(REPO_ROOT, '.claude/skills/preview/SKILL.md');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('no-activity-hold sentinel parity', () => {
  it('is a CLI flag, so it survives a command string unquoted', () => {
    // The sentinel rides inside `tool_input.command` and is matched with a
    // substring test. A value with whitespace or shell metacharacters would
    // need quoting and could be split or mangled before the hook ever sees it.
    expect(NO_ACTIVITY_HOLD_FLAG).toMatch(/^--[a-z0-9-]+$/);
  });

  it('the preview script declares the same flag value as the TypeScript constant', () => {
    const declared = /const NO_ACTIVITY_HOLD_FLAG = '([^']+)'/.exec(read(PREVIEW_SCRIPT));
    expect(declared, 'worktree-preview.js no longer declares NO_ACTIVITY_HOLD_FLAG').not.toBeNull();
    expect(declared?.[1]).toBe(NO_ACTIVITY_HOLD_FLAG);
  });

  it('the preview script prints the flag in the Watch: command it tells the agent to run', () => {
    const source = read(PREVIEW_SCRIPT);

    // Assert against the PRINTED line specifically, not the file as a whole. A
    // file-wide containment check would still pass if the `Watch:` template
    // dropped the flag but the constant declaration stayed - and SKILL.md step 4
    // tells the agent to run what was PRINTED, so that template is the copy
    // which actually reaches the background shell.
    const watchLine = source
      .split('\n')
      .find((line) => line.includes('console.log') && line.includes('Watch:'));
    expect(watchLine, 'no `Watch:` console.log found in worktree-preview.js').toBeDefined();

    // The line interpolates the script's own constant rather than repeating the
    // literal, so resolve that one substitution before asserting. Paired with
    // the declaration check above, this pins the actual printed text.
    const printed = (watchLine ?? '').replaceAll('${NO_ACTIVITY_HOLD_FLAG}', NO_ACTIVITY_HOLD_FLAG);
    expect(printed).toContain(NO_ACTIVITY_HOLD_FLAG);
    expect(printed).toContain('--wait');
  });

  it('the preview skill carries the flag on every watcher command it spells out', () => {
    const skill = read(PREVIEW_SKILL);

    // Every `--wait` invocation in the skill must carry the flag. Step 4 quotes
    // the printed command, and the session-restart note hand-writes a re-attach
    // command that the script never prints - so the second one can only be kept
    // correct by a check like this.
    const waitCommands = skill
      .split('\n')
      .filter((line) => line.includes('worktree-preview.js --wait'));
    expect(waitCommands.length).toBeGreaterThanOrEqual(2);
    for (const command of waitCommands) {
      expect(command).toContain(NO_ACTIVITY_HOLD_FLAG);
    }
  });
});
