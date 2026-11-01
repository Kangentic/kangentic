/**
 * Spawn entry-point parity guard (see .claude/rules/spawn-entry-point-parity.md).
 *
 * Every way a task agent can be spawned must route through one of the two
 * spawn chokepoints, because spawn-affecting behavior (the first-spawn
 * Advanced-override lock, agent resolution, permission-mode resolution,
 * auto_command handling) is applied there and ONLY there:
 *
 *   - board-driven spawns (task move, create-into-spawn-column, backlog
 *     promote, MCP create, unarchive) go through `spawnAgent`
 *     (src/main/ipc/helpers/agent-spawn.ts);
 *   - startup spawns (crash recovery, reconcile) go through
 *     `prepareAgentSpawn` (src/main/transition-engine/session-startup/
 *     prepare-spawn.ts).
 *
 * Both chokepoints run `runSpawnPreamble` (src/main/transition-engine/
 * spawn-preamble.ts): the lock, then agent resolution, in that order.
 *
 * This shipped as a bug: the first-spawn override lock landed in only 2 of
 * the 4 entry points that existed at the time (task-crud.ts and task-move's
 * spawnAgent call), so a task whose true first spawn happened via startup
 * recovery or unarchive never locked its overrides - and the create path
 * persisted a locked agent while the engine spawned a different one, because
 * it passed `agentOverride: undefined` and `executeSpawnAgent` never reads
 * `task.agent_override`.
 *
 * This test makes that class of drift unmergeable by pure source analysis:
 *   (a) every direct call to the engine spawn sinks (`executeTransition` /
 *       `resumeSuspendedSession`) must be in an explicitly classified file;
 *   (b) every raw PTY spawn (`sessionManager.spawn(`) must be in an
 *       explicitly classified file;
 *   (c) the chokepoints must actually contain their preamble calls, so an
 *       allowlisted file cannot silently drop the shared behavior;
 *   (d) the first-spawn lock has exactly one call site (inside the preamble),
 *       so an ad-hoc handler-level lock cannot reappear and diverge from
 *       agent-resolution ordering.
 *
 * A new entry point therefore cannot ship without a deliberate decision:
 * route it through a chokepoint, or add a justified allowlist entry here AND
 * update the rule file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_DIR = path.join(REPO_ROOT, 'src/main');
const RULE_FILE = '.claude/rules/spawn-entry-point-parity.md';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Files allowed to call `engine.executeTransition` / `engine.resumeSuspendedSession`
 * directly, each with the reason it is exempt from routing through `spawnAgent`.
 */
const ENGINE_SINK_FILES: Record<string, string> = {
  'src/main/ipc/helpers/agent-spawn.ts':
    'spawnAgent: the shared board-spawn chokepoint itself; runs runSpawnPreamble before every engine call. '
    + 'Its createEarlyAgentLauncher is the one caller of launchEarlyAgent, which starts an agent during '
    + "the worktree's setup script from previewSpawnPreamble's resolution and writes nothing: spawnAgent "
    + 'adopts that agent only through resumeSuspendedSession, after the real preamble ran',
  'src/main/ipc/handlers/session-resume.ts':
    'resumeTaskSession (the SESSION_RESUME handler, and start-session for a paused task): in-place '
    + 'resume of the task in its CURRENT lane; not a first-spawn entry point (agent stickiness comes '
    + 'from the session-type-scoped resume lookup). Known edge: with no resumable record it '
    + 'fresh-spawns the default agent (agentOverride undefined) - pre-existing, candidate follow-up',
  'src/main/ipc/handlers/session-reconcile.ts':
    'restartSessionForSettingsChange: suspend-and-respawn in place to apply CLI flags to an EXISTING '
    + 'session; not a first-spawn entry point',
  'src/main/ipc/handlers/task-move.ts':
    "Phase 1's automation hooks, and neither is a spawn of any kind. One runs the SOURCE column's "
    + "exit rows as the task leaves; the other runs the DESTINATION column's enter rows on a WARM "
    + 'move, where the session is already live and Priority 3 would otherwise return without running '
    + 'them at all. Neither passes startAgent: on exit the runner cannot start one, and on the warm '
    + 'path the session exists by construction. The shape is pinned below, so this entry cannot '
    + 'quietly widen into a real spawn path',
  'src/main/ipc/helpers/automation-run-again.ts':
    'AUTOMATION_RUN_AGAIN: re-runs ONE existing automation against the task\'s current state. Not a '
    + 'spawn either, and it cannot become one: executeSingleAutomation passes no startAgent, so a row '
    + 'that needs an agent and finds no session skips with that reason. A Move to column row runs '
    + 'outside the task lock and moves through handleTaskMove (move-from-row.ts), which spawns, if at '
    + 'all, through spawnAgent like any move',
  'src/main/automations/turn-end/turn-end-runner.ts':
    "A column's On agent turn end rows, run when the agent that is working the task finishes a turn. "
    + 'Not a spawn: it acts on the agent that just ended its turn, passes no startAgent, and runs '
    + 'outside the task lock. A Move to column row moves through handleTaskMove, which spawns, if at '
    + 'all, through spawnAgent like any move',
};

/**
 * Files allowed to call `sessionManager.spawn(` (the raw PTY sink), each with
 * the reason. Anything else is a brand-new spawn stack bypassing both
 * chokepoints.
 */
const PTY_SINK_FILES: Record<string, string> = {
  'src/main/transition-engine/transition-engine.ts':
    'executeSpawnAgent: the engine sink every board-driven spawn funnels into. The retired run_script '
    + 'ACTION used to spawn here too; the automation adapter that replaced it runs an ordinary child '
    + 'process, because an interactive shell never exits and its script could not be awaited',
  'src/main/transition-engine/session-startup/auto-spawn.ts':
    'startup reconcile; prepares every spawn via prepareAgentSpawn (asserted below)',
  'src/main/transition-engine/session-startup/resume-suspended.ts':
    'startup crash recovery; prepares every spawn via prepareAgentSpawn (asserted below)',
  'src/main/ipc/handlers/sessions.ts':
    'raw SESSION_SPAWN passthrough: renderer-supplied command, no task-agent resolution involved',
  'src/main/ipc/handlers/transient-sessions.ts':
    'transient Command Terminal sessions: not task agents, no overrides or lock apply',
  'src/main/workflows/workflow-agent.ts':
    'a workflow\'s own agent: no task, so no override lock or column resolution; it runs the Workflow '
    + 'agent setting\'s agent (read-only where the adapter can enforce it), and runs ensureTrust and '
    + 'resolveShimLaunch before buildCommand (scanned below)',
};

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

// Skips full-line comments (// and JSDoc bodies). task-lifecycle-lock.ts, for
// example, shows an `engine.resumeSuspendedSession(...)` call in its JSDoc.
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

type SinkCall = { relativePath: string; line: number; location: string };

function collectSinkCalls(pattern: RegExp): SinkCall[] {
  const calls: SinkCall[] = [];
  for (const filePath of collectSourceFiles(MAIN_DIR)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (pattern.test(line)) {
        calls.push({ relativePath, line: index + 1, location: `${relativePath}:${index + 1}` });
      }
    });
  }
  return calls;
}

// Lines strictly BEFORE `beforeLine` (1-based), so a call sharing a line with the
// site being checked does not count as preceding it.
function fileHasNonCommentCallBefore(relativePath: string, beforeLine: number, callName: string): boolean {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
  return source
    .split('\n')
    .slice(0, beforeLine - 1)
    .some((line) => !isCommentLine(line) && line.includes(`${callName}(`));
}

function fileHasNonCommentCall(relativePath: string, callName: string): boolean {
  return fileHasNonCommentCallBefore(relativePath, Number.POSITIVE_INFINITY, callName);
}

type ReceiverCall = SinkCall & { receiver: string };

// Like collectSinkCalls, but captures the receiver identifier so a pairing check can
// demand the SAME receiver instead of a variable literally named `adapter`. Without
// this, a future spawn site written `claudeAdapter.buildCommand(...)` is never
// collected at all, and the scan passes by finding nothing rather than by finding it
// safe. A leading `.` also keeps method DECLARATIONS (`buildCommand(options) {`) out.
function collectReceiverCalls(methodName: string): ReceiverCall[] {
  const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.${methodName}\\s*\\(`);
  const calls: ReceiverCall[] = [];
  for (const filePath of collectSourceFiles(MAIN_DIR)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      const match = pattern.exec(line);
      if (match === null) return;
      calls.push({
        relativePath,
        line: index + 1,
        location: `${relativePath}:${index + 1}`,
        receiver: match[1],
      });
    });
  }
  return calls;
}

// `executeSingleAutomation` is in here with the two spawn sinks even though it
// cannot spawn. It reaches the same engine from outside it, so leaving it
// unscanned would mean a second public entry point growing its own callers
// with no test watching, which is the exact shape this scan exists to stop.
// `launchEarlyAgent` is here for the same reason: it starts an agent outside a
// spawn (during a worktree's setup script), so a caller of its own must be a
// deliberate decision.
const ENGINE_SINK_PATTERN = /\.(executeTransition|resumeSuspendedSession|executeSingleAutomation|launchEarlyAgent)\s*\(/;
/** The same names, global, for counting every occurrence in one file. */
const ENGINE_SINK_PATTERN_GLOBAL = new RegExp(ENGINE_SINK_PATTERN.source, 'g');
const PTY_SINK_PATTERN = /sessionManager\.spawn\s*\(/;

describe('spawn entry-point parity: engine sinks', () => {
  it('launchEarlyAgent has exactly one caller, the launcher in agent-spawn.ts', () => {
    const callers = collectSinkCalls(/\.launchEarlyAgent\s*\(/).map((call) => call.relativePath);
    expect(callers).toEqual(['src/main/ipc/helpers/agent-spawn.ts']);
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/ipc/helpers/agent-spawn.ts'), 'utf-8');
    // It resolves the launch the way the spawn will, without the lock's write.
    expect(source).toMatch(/previewSpawnPreamble\(/);
  });

  it('every direct engine.executeTransition / resumeSuspendedSession / executeSingleAutomation / launchEarlyAgent call site is classified', () => {
    const unclassified = collectSinkCalls(ENGINE_SINK_PATTERN)
      .filter((call) => !(call.relativePath in ENGINE_SINK_FILES))
      .map((call) => call.location);
    expect(
      unclassified,
      `Direct engine spawn call(s) outside the classified files:\n${unclassified.join('\n')}\n\n`
        + `A board-driven spawn must route through spawnAgent (src/main/ipc/helpers/agent-spawn.ts) `
        + `so the shared spawn preamble (first-spawn override lock + agent resolution) applies. `
        + `Either route through spawnAgent / prepareAgentSpawn, or add a justified ENGINE_SINK_FILES `
        + `entry here and update ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe("spawn entry-point parity: task-move's allowlisted engine calls never spawn", () => {
  // The allowlist is per FILE, so admitting task-move.ts would otherwise let a
  // future direct spawn call slip in beside the automation hooks with no test to
  // say so. Pin the shape instead: exactly two engine calls, one per trigger,
  // with no startAgent anywhere near either.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/ipc/handlers/task-move.ts'), 'utf-8');

  it('makes exactly two engine calls, one per trigger', () => {
    const calls = source.match(ENGINE_SINK_PATTERN_GLOBAL) ?? [];
    expect(calls).toHaveLength(2);
    // The source column as the task leaves, and the destination column as it
    // arrives on a warm move. A third call, or either of these turning into a
    // `resumeSuspendedSession`, fails here.
    expect(source).toMatch(/executeTransition\(\s*task,\s*fromLane,\s*'exit'/);
    expect(source).toMatch(/executeTransition\(\s*task,\s*toLane,\s*'enter'/);
  });

  it('passes no startAgent on either, so neither can become a spawn path', () => {
    // The PROPERTY, not the word: the call sites carry comments saying there is
    // no startAgent, and a bare-word scan fails on its own explanation.
    // Matches both `startAgent:` and the `startAgent,` shorthand.
    expect(source).not.toMatch(/startAgent\s*[:,]/);
  });
});

describe('spawn entry-point parity: raw PTY sinks', () => {
  it('every sessionManager.spawn( call site is classified', () => {
    const unclassified = collectSinkCalls(PTY_SINK_PATTERN)
      .filter((call) => !(call.relativePath in PTY_SINK_FILES))
      .map((call) => call.location);
    expect(
      unclassified,
      `Raw sessionManager.spawn( call(s) outside the classified files:\n${unclassified.join('\n')}\n\n`
        + `A new spawn stack bypasses BOTH spawn chokepoints (spawnAgent and prepareAgentSpawn), so `
        + `none of the shared spawn behavior (override lock, agent/permission resolution) applies. `
        + `Route through a chokepoint, or add a justified PTY_SINK_FILES entry here and update `
        + `${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: chokepoints actually run the shared preamble', () => {
  // An allowlisted chokepoint that silently drops its preamble call would pass
  // the classification checks above while losing the shared behavior. Pin the
  // positive side too.
  it.each([
    'src/main/ipc/helpers/agent-spawn.ts',
    'src/main/transition-engine/session-startup/prepare-spawn.ts',
  ])('%s calls runSpawnPreamble(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'runSpawnPreamble'),
      `${relativePath} must call runSpawnPreamble() (the first-spawn override lock + agent `
        + `resolution, in that order) before spawning. See ${RULE_FILE}.`,
    ).toBe(true);
  });

  it.each([
    'src/main/transition-engine/session-startup/auto-spawn.ts',
    'src/main/transition-engine/session-startup/resume-suspended.ts',
  ])('%s prepares spawns via prepareAgentSpawn(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'prepareAgentSpawn'),
      `${relativePath} must build its spawns through prepareAgentSpawn() so the startup path `
        + `shares the spawn preamble. See ${RULE_FILE}.`,
    ).toBe(true);
  });

  it.each([
    'src/main/transition-engine/transition-engine.ts',
    'src/main/transition-engine/session-startup/prepare-spawn.ts',
  ])('%s resolves permission via resolveEffectivePermissionMode(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'resolveEffectivePermissionMode'),
      `${relativePath} must resolve the effective permission mode via `
        + `resolveEffectivePermissionMode() (lane 'plan' always wins, else task -> lane -> global) `
        + `instead of an inline ternary. See ${RULE_FILE}.`,
    ).toBe(true);
  });
});

describe('spawn entry-point parity: every buildCommand site runs ensureTrust first', () => {
  // `adapter.ensureTrust` is the adapter's pre-spawn global-config step (trust
  // entries, and for Claude the diff-panel write in diff-panel.ts). The
  // Command Terminal (transient-sessions.ts) is allowlisted out of both
  // chokepoints above, so nothing else guarantees it keeps calling it - and a
  // maximized Command Terminal is exactly where Claude's diff panel would
  // otherwise come back. Pin: every file that builds an agent command calls
  // ensureTrust( on the SAME receiver, on an earlier non-comment line.
  //
  // Deliberate limits of a static scan, so nobody reads it as more than it is:
  // it proves line ORDER within a file, not that the two calls sit on one
  // control-flow path, and it only sees paths that build their command through
  // an adapter (a raw passthrough spawning a caller-supplied command string is
  // invisible to it). Runtime ordering is pinned by the handler-level tests.
  it('every buildCommand( call site is preceded by the same receiver calling ensureTrust(', () => {
    const buildSites = collectReceiverCalls('buildCommand');
    expect(buildSites.length, 'expected at least one buildCommand( call site').toBeGreaterThan(0);
    const missing = buildSites
      .filter((site) => !fileHasNonCommentCallBefore(site.relativePath, site.line, `${site.receiver}.ensureTrust`))
      .map((site) => `${site.location} (receiver: ${site.receiver})`);
    expect(
      missing,
      `buildCommand( without an earlier ensureTrust( on the same receiver:\n`
        + `${missing.join('\n')}\n\n`
        + `Pre-spawn global-config state (trust entries, Claude's diff-panel write) must apply on `
        + `every path that builds an agent command, including the Command Terminal. Call `
        + `<receiver>.ensureTrust(cwd) before building the command. See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: every buildCommand site resolves the shim launch first', () => {
  // On Windows an npm-installed CLI resolves to its `.cmd` shim, which a
  // PowerShell or Git Bash host launches through cmd.exe, and cmd.exe keeps
  // only the first line of a multi-line prompt (#353). resolveShimLaunch
  // (src/main/agent/shared/shim-launch.ts) swaps in the sibling shim the host
  // can run, or flattens the prompt, and it has to run on every path that
  // builds an agent command or one launcher silently truncates while the
  // others work. Same static-scan limits as the ensureTrust check above; the
  // runtime wiring per chokepoint is pinned by
  // prepare-spawn-shim-launch-wiring.test.ts, transition-engine.test.ts, and
  // transient-session-spawn-shim-launch.test.ts.
  it('every buildCommand( call site is preceded by a resolveShimLaunch( call in the same file', () => {
    const buildSites = collectReceiverCalls('buildCommand');
    expect(buildSites.length, 'expected at least one buildCommand( call site').toBeGreaterThan(0);
    const missing = buildSites
      .filter((site) => !fileHasNonCommentCallBefore(site.relativePath, site.line, 'resolveShimLaunch'))
      .map((site) => site.location);
    expect(
      missing,
      `buildCommand( without an earlier resolveShimLaunch( in the same file:\n`
        + `${missing.join('\n')}\n\n`
        + `A .cmd / .bat head must be resolved for the PTY shell before any builder sees it, or a `
        + `multi-line prompt reaches the agent as its first line only on Windows (#353). Call `
        + `resolveShimLaunch({ agentPath, shell, prompt }) after ensureTrust and hand the builder its `
        + `agentPath and prompt. See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: every buildCommand site holds by session id and can release', () => {
  // An adapter that writes a file every session in a folder shares (Gemini's
  // settings, Cursor's mcp.json, ...) holds it under CommandOptions.ptySessionId,
  // the id the session layer releases with (SharedFolderHolds). A build site
  // that leaves it out takes no hold, so a neighbour's exit strips the file
  // under its running session. A built command that never becomes a session
  // must release its hold through releaseCommandHold, or the folder's file
  // stays in place for the rest of the run. Same static-scan limits as above:
  // this proves each file says both, not that every path between build and
  // spawn releases. The per-site tests pin that.
  const PROPERTY_LINE = /^\s*ptySessionId\s*[:,]/;

  it('every buildCommand( call site passes ptySessionId in its command options', () => {
    const buildSites = collectReceiverCalls('buildCommand');
    expect(buildSites.length, 'expected at least one buildCommand( call site').toBeGreaterThan(0);
    // Each site looks only above itself and below the file's previous site, so a
    // second site in a file cannot pass on the first one's property.
    const missing = buildSites
      .filter((site) => {
        const lines = fs.readFileSync(path.join(REPO_ROOT, site.relativePath), 'utf-8').split('\n');
        const previousSiteLine = Math.max(
          0,
          ...buildSites
            .filter((other) => other.relativePath === site.relativePath && other.line < site.line)
            .map((other) => other.line),
        );
        return !lines
          .slice(previousSiteLine, site.line - 1)
          .some((line) => !isCommentLine(line) && PROPERTY_LINE.test(line));
      })
      .map((site) => site.location);
    expect(
      missing,
      `buildCommand( without a ptySessionId property in the command options above it:\n`
        + `${missing.join('\n')}\n\n`
        + `Pass the session's own id (the id handed to sessionManager.spawn) as ptySessionId, so a `
        + `folder-shared adapter file is held for exactly that session. See ${RULE_FILE}.`,
    ).toEqual([]);
  });

  it('every file with a buildCommand( call site also calls releaseCommandHold(', () => {
    const buildFiles = [...new Set(collectReceiverCalls('buildCommand').map((site) => site.relativePath))];
    const missing = buildFiles.filter((relativePath) => !fileHasNonCommentCall(relativePath, 'releaseCommandHold'));
    expect(
      missing,
      `Files that build an agent command but never release its hold:\n${missing.join('\n')}\n\n`
        + `A built command that does not become a session (an early return, an abort, a failed `
        + `spawn) must call releaseCommandHold(adapter, cwd, ptySessionId). See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: single lock call site', () => {
  it('lockAdvancedOverridesOnFirstSpawn is only referenced inside spawn-preamble.ts', () => {
    const outsideCalls = collectSinkCalls(/\blockAdvancedOverridesOnFirstSpawn\s*\(/)
      .filter((call) => call.relativePath !== 'src/main/transition-engine/spawn-preamble.ts')
      .map((call) => call.location);
    expect(
      outsideCalls,
      `lockAdvancedOverridesOnFirstSpawn( referenced outside spawn-preamble.ts:\n`
        + `${outsideCalls.join('\n')}\n\n`
        + `The lock runs only inside runSpawnPreamble, BEFORE agent resolution - a handler-level `
        + `call site can drift out of that ordering. Route the path through a spawn chokepoint `
        + `instead. See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: explicitStart is a user-gesture option', () => {
  /**
   * `explicitStart` lifts spawnAgent's `auto_spawn` default and its
   * manually-paused guard, both of which exist to stop an AUTOMATIC spawn from
   * overriding a choice the user made. The option therefore belongs only to a
   * path a user gesture drives. The declaration, the gates, and the forward
   * live in agent-spawn.ts; the one caller is the phone's start-session verb
   * body. A create, promote, unarchive, startup, or reconcile path growing
   * `{ explicitStart: true }` would silently un-pause a task the user paused,
   * and nothing but this scan would notice.
   */
  const EXPLICIT_START_FILES = new Set([
    'src/main/ipc/helpers/agent-spawn.ts',
    'src/main/ipc/handlers/session-start.ts',
  ]);

  it('explicitStart is referenced only by agent-spawn.ts and the start-session body', () => {
    const outsideReferences = collectSinkCalls(/\bexplicitStart\b/)
      .filter((reference) => !EXPLICIT_START_FILES.has(reference.relativePath))
      .map((reference) => reference.location);
    expect(
      outsideReferences,
      `explicitStart referenced outside its two classified files:\n`
        + `${outsideReferences.join('\n')}\n\n`
        + `The option bypasses the auto_spawn default and the manual-pause guard, so only a `
        + `user-initiated path may pass it. If this is a new user gesture, add the file here `
        + `with a reason; an automatic or reconcile caller never sets it. See ${RULE_FILE}.`,
    ).toEqual([]);
  });

  it('the one caller still passes it, so the scan is not vacuous', () => {
    expect(fileHasNonCommentCall('src/main/ipc/handlers/session-start.ts', 'autoSpawnForTask')).toBe(true);
    const callerReferences = collectSinkCalls(/explicitStart:\s*true/)
      .filter((reference) => reference.relativePath === 'src/main/ipc/handlers/session-start.ts');
    expect(callerReferences.length).toBeGreaterThan(0);
  });
});

describe('spawn entry-point parity: resumesEntry belongs to the Resume path', () => {
  /**
   * `resumesEntry` lifts spawnAgent's held-pause guard for the user's Resume of
   * an agent that was paused when its task entered its column (#929): the
   * entry ran only its rows that need no agent, and the Resume does the rest.
   * The declaration, the gate, and the forward live in agent-spawn.ts; the one
   * caller is `resumeTaskSession`, the body every Resume (desktop, phone,
   * workflow) shares. A move, startup or reconcile path growing it would start
   * a paused agent nobody resumed.
   */
  const RESUMES_ENTRY_FILES = new Set([
    'src/main/ipc/helpers/agent-spawn.ts',
    'src/main/ipc/handlers/session-resume.ts',
  ]);

  it('resumesEntry is referenced only by agent-spawn.ts and the Resume body', () => {
    const outsideReferences = collectSinkCalls(/\bresumesEntry\b/)
      .filter((reference) => !RESUMES_ENTRY_FILES.has(reference.relativePath))
      .map((reference) => reference.location);
    expect(
      outsideReferences,
      `resumesEntry referenced outside its two classified files:\n`
        + `${outsideReferences.join('\n')}\n\n`
        + `The option bypasses the held-pause guard, so only the user's Resume may pass it. `
        + `A move never starts a paused agent. See ${RULE_FILE}.`,
    ).toEqual([]);
  });

  it('the one caller still passes it, so the scan is not vacuous', () => {
    expect(fileHasNonCommentCall('src/main/ipc/handlers/session-resume.ts', 'spawnAgent')).toBe(true);
    const callerReferences = collectSinkCalls(/resumesEntry:\s*true/)
      .filter((reference) => reference.relativePath === 'src/main/ipc/handlers/session-resume.ts');
    expect(callerReferences.length).toBeGreaterThan(0);
  });
});

describe('spawn entry-point parity: held messages are claimed where an opening message is built', () => {
  /**
   * Messages held for a task (src/main/held-messages) go into the opening
   * message of the next agent that starts there. The two places that build one
   * claim them: `spawnAgent` (every board-driven start) and `resumeTaskSession`
   * (the Resume button and the phone's resume). Every other start (startup
   * recovery, a queued session's promotion, the legacy Start agent row) gets
   * them from the module's session-live flush, typed after the first turn
   * settles. A third claim site would race those two for the same rows.
   */
  const HELD_CLAIM_FILES = new Set([
    'src/main/ipc/helpers/agent-spawn.ts',
    'src/main/ipc/handlers/session-resume.ts',
    'src/main/held-messages/held-messages.ts',
  ]);

  it('claimHeldMessages is called only by spawnAgent, the Resume body and the module itself', () => {
    const outsideCalls = collectSinkCalls(/\bclaimHeldMessages\(/)
      .filter((reference) => !HELD_CLAIM_FILES.has(reference.relativePath))
      .map((reference) => reference.location);
    expect(
      outsideCalls,
      'claimHeldMessages called outside its classified files:\n'
        + `${outsideCalls.join('\n')}\n\n`
        + 'A new start gets held messages from the session-live flush (registerHeldMessageFlush), '
        + `not a claim of its own. See ${RULE_FILE}.`,
    ).toEqual([]);
  });

  it('both opening-message builders still claim, so the scan is not vacuous', () => {
    expect(fileHasNonCommentCall('src/main/ipc/helpers/agent-spawn.ts', 'claimHeldMessages')).toBe(true);
    expect(fileHasNonCommentCall('src/main/ipc/handlers/session-resume.ts', 'claimHeldMessages')).toBe(true);
  });
});
