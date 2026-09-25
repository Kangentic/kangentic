#!/usr/bin/env node
/**
 * Dev harness: seed realistic usage data into a project's DB so the usage
 * dashboard (title-bar chart icon / Mod+Shift+U) has something to show in a
 * /preview session without hours of real agent runs.
 *
 * Writes every ledger the dashboard reads:
 *   - usage_history          (per-finalized-session totals: KPIs, cost/day, by-model, by-agent)
 *   - conversation_turn_usage (per-turn time series: burn rate, token trend, live window),
 *                            both the driver turns and a subagent fan-out on
 *                            some sessions, which feeds the Subagents tile and
 *                            the by-subagent breakdown
 *
 * Seeded rows carry recognizable ids (seed-usage-* / seed-turn-*) so --clean
 * removes exactly what this script created and nothing else.
 *
 * Usage (Node 24+, uses the built-in node:sqlite so it runs on the system
 * Node without touching the Electron-ABI better-sqlite3 build):
 *   node scripts/seed-usage-data.js --project <name-or-id>   seed one project
 *   node scripts/seed-usage-data.js --all                    seed every registered project
 *   node scripts/seed-usage-data.js --project <name> --days 30
 *   node scripts/seed-usage-data.js --project <name> --clean revert the seed
 *   node scripts/seed-usage-data.js --list                   show registered projects
 *
 * Options: --days N (default 14), --config-dir <path> (default per-OS kangentic dir),
 *          --seed N (PRNG seed, default 42 - reruns are deterministic),
 *          --sessions-per-day N (weekday average; weekends dip to ~40%.
 *          Default keeps the organic 2-5/day mix. Use a large value to build
 *          perf-test volumes, e.g. --days 120 --sessions-per-day 30 for
 *          ~3,600 usage_history rows per project).
 *
 * A dense trailing-2h block tiles several short sessions across the full live
 * window so the Live range's per-bucket and cumulative charts have data across
 * most buckets, not just one thin tail session. Safe to run while the app is
 * open (WAL); the dashboard's poll picks the rows up within ~30s, or switch
 * ranges to refetch.
 *
 * NOTE: open the project in the app at least once after updating Kangentic so
 * migrations have added the usage_history.agent column; the script refuses to
 * write to an unmigrated schema instead of guessing at it.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

function defaultConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'kangentic');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kangentic');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kangentic');
}

function parseArgs(argv) {
  const args = { days: 14, seed: 42, sessionsPerDay: null, configDir: defaultConfigDir() };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--project') args.project = argv[++index];
    else if (arg === '--all') args.all = true;
    else if (arg === '--clean') args.clean = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--days') args.days = Number(argv[++index]);
    else if (arg === '--seed') args.seed = Number(argv[++index]);
    else if (arg === '--sessions-per-day') args.sessionsPerDay = Number(argv[++index]);
    else if (arg === '--config-dir') args.configDir = argv[++index];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

/** Trailing live window, mirrors LIVE_WINDOW_MS in src/main/usage-stats/bucketing.ts. */
const LIVE_WINDOW_MS = 120 * 60_000;

/** Deterministic PRNG (mulberry32) so reruns produce identical data. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `efforts` is the applied-effort mix per profile; null = agent default (no flag).
const AGENT_PROFILES = [
  { agent: 'claude', modelId: 'claude-opus-4-8', modelDisplayName: 'Opus 4.8', costPerMTokens: 45, weight: 0.5, efforts: ['high', 'max', null] },
  { agent: 'claude', modelId: 'claude-sonnet-5', modelDisplayName: 'Sonnet 5', costPerMTokens: 12, weight: 0.2, efforts: ['medium', null] },
  { agent: 'codex', modelId: 'gpt-5.2-codex', modelDisplayName: 'GPT-5.2 Codex', costPerMTokens: 15, weight: 0.15, efforts: ['high', 'medium'] },
  { agent: 'gemini', modelId: 'gemini-3-pro', modelDisplayName: 'Gemini 3 Pro', costPerMTokens: 10, weight: 0.1, efforts: [null] },
  // Subscription-style agent: real tokens, zero reported cost.
  { agent: 'aider', modelId: null, modelDisplayName: null, costPerMTokens: 0, weight: 0.05, efforts: [null] },
];

function pickProfile(random) {
  const roll = random();
  let cumulative = 0;
  for (const profile of AGENT_PROFILES) {
    cumulative += profile.weight;
    if (roll <= cumulative) return profile;
  }
  return AGENT_PROFILES[0];
}

function pickEffort(random, profile) {
  return profile.efforts[Math.floor(random() * profile.efforts.length)] ?? null;
}

function listProjects(configDir) {
  const globalDbPath = path.join(configDir, 'index.db');
  if (!fs.existsSync(globalDbPath)) {
    console.error(`No global DB at ${globalDbPath}. Is Kangentic installed / has it run once?`);
    process.exit(1);
  }
  const db = new DatabaseSync(globalDbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, name FROM projects ORDER BY position ASC').all();
  } finally {
    db.close();
  }
}

// The agent types this board's fan-out commands actually spawn. A dashboard
// seeded with driver turns alone understates a fan-out by most of its traffic:
// on the session measured in docs/code-review-fanout-audit.md the subagents
// moved 2.5x the driver's cache reads and 2.8x its output.
const SUBAGENT_TYPES = [
  'review-finder',
  'test-builder',
  'doc-auditor',
  'Explore',
  'general-purpose',
  'platform-guard',
];

function seedProject(configDir, project, days, sessionsPerDay, random) {
  const dbPath = path.join(configDir, 'projects', `${project.id}.db`);
  if (!fs.existsSync(dbPath)) {
    console.warn(`  skip ${project.name}: no project DB (open it in the app first)`);
    return;
  }
  const db = new DatabaseSync(dbPath);
  try {
    const usageColumns = db.prepare('SELECT name FROM pragma_table_info(?)').all('usage_history')
      .map((column) => column.name);
    if (!usageColumns.includes('agent') || !usageColumns.includes('effort')) {
      console.warn(`  skip ${project.name}: usage_history is missing the 'agent'/'effort' column(s) - open the project in the updated app once so migrations run`);
      return;
    }

    // Subagent rows need the columns task #649 added. A project DB that has
    // not been opened since still seeds its driver turns rather than failing.
    const turnColumns = db.prepare('SELECT name FROM pragma_table_info(?)').all('conversation_turn_usage')
      .map((column) => column.name);
    const canSeedSubagents = turnColumns.includes('subagent_id');
    if (!canSeedSubagents) {
      console.warn(`  ${project.name}: conversation_turn_usage has no 'subagent_id' column - seeding driver turns only (open the project in the updated app once so migrations run)`);
    }

    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, session_type,
         total_cost_usd, total_input_tokens, total_output_tokens, total_duration_ms,
         tool_call_count, model_id, model_display_name,
         lines_added, lines_removed, files_changed, compaction_count, agent, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTurn = db.prepare(`
      INSERT OR REPLACE INTO conversation_turn_usage
        (turn_uuid, agent_session_id, session_id, task_id, model, ts,
         input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSubagentTurn = canSeedSubagents
      ? db.prepare(`
      INSERT OR REPLACE INTO conversation_turn_usage
        (turn_uuid, agent_session_id, session_id, task_id, model, ts,
         input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, recorded_at,
         subagent_id, agent_type, spawn_depth, parent_tool_use_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      : null;

    // The other half of parent_tool_use_id. Guarded on the table the same way the
    // subagent columns are: a project DB not opened since the migration still
    // seeds its turns, it just shows every fan-out as unlinked.
    const hasSpawnLinks = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turn_spawn_links'").get() !== undefined;
    if (canSeedSubagents && !hasSpawnLinks) {
      console.warn(`  ${project.name}: no 'turn_spawn_links' table - seeding subagents without spawn links (fan-outs will read as unlinked)`);
    }
    const insertSpawnLink = hasSpawnLinks
      ? db.prepare('INSERT OR REPLACE INTO turn_spawn_links (tool_use_id, turn_uuid, recorded_at) VALUES (?, ?, ?)')
      : null;

    let sessionCounter = 0;
    let turnCounter = 0;
    let subagentTurnCounter = 0;
    let subagentCounter = 0;
    // Every seeded session, so the fan-out pass below can attach subagents to
    // some of them without re-deriving their start and duration.
    const seededSessions = [];
    const nowMs = Date.now();

    // Writes one session's turns + its usage_history row. Shared by the daily
    // history loop and the dense live-window block below so both feed the
    // same two ledgers the dashboard reads.
    function insertSeededSession(sessionId, profile, startMs, turnCount) {
      const durationMs = turnCount * (30_000 + Math.floor(random() * 90_000));

      // `turnCounter` is global, so a session's driver turn uuids are a
      // contiguous slice of it. Recording where the slice starts lets the fan-out
      // pass below name a real driver turn to hang its spawn links on, without
      // keeping every uuid in memory.
      const firstTurnIndex = turnCounter;

      let sessionInput = 0;
      let sessionOutput = 0;
      for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
        const ts = Math.min(startMs + Math.floor((durationMs * turnIndex) / turnCount), nowMs);
        const inputTokens = 500 + Math.floor(random() * 6_000);
        const outputTokens = 200 + Math.floor(random() * 2_500);
        sessionInput += inputTokens;
        sessionOutput += outputTokens;
        insertTurn.run(
          `seed-turn-${sessionId}-${turnCounter++}`,
          null,
          sessionId,
          null,
          profile.modelId,
          ts,
          inputTokens,
          outputTokens,
          Math.floor(inputTokens * 0.4),
          Math.floor(inputTokens * (8 + random() * 10)),
          new Date(ts).toISOString(),
        );
      }

      const totalTokens = sessionInput + sessionOutput;
      const costUsd = (totalTokens / 1_000_000) * profile.costPerMTokens * (0.8 + random() * 0.4);
      insertSession.run(
        `seed-usage-row-${sessionId}`,
        sessionId,
        new Date(Math.min(startMs + durationMs, nowMs)).toISOString(),
        new Date(startMs).toISOString(),
        'main',
        Math.round(costUsd * 10_000) / 10_000,
        // Snapshot-style tokens: the last context window, not the cumulative sum.
        Math.floor(sessionInput / Math.max(1, turnCount / 3)),
        Math.floor(sessionOutput / Math.max(1, turnCount / 3)),
        durationMs,
        Math.floor(turnCount * (1 + random() * 2)),
        profile.modelId,
        profile.modelDisplayName,
        Math.floor(random() * 400),
        Math.floor(random() * 120),
        Math.floor(random() * 20),
        random() < 0.15 ? 1 : 0,
        profile.agent,
        pickEffort(random, profile),
      );

      seededSessions.push({ sessionId, profile, startMs, durationMs, firstTurnIndex, turnCount });
    }

    // Attaches a fan-out to an already-seeded session. Subagent rows carry the
    // driver's session and model and land ONLY in conversation_turn_usage: the
    // session's usage_history cost already covers the whole tree, so pricing
    // these tokens again would double count. Their turn_uuid keeps the
    // 'seed-turn-' prefix so --clean removes them with everything else.
    function insertSubagentFanOut(session) {
      const subagentCount = 2 + Math.floor(random() * 5);
      // Tracks the last depth-1 subagent so a nested one can be linked to a real
      // parent SUBAGENT turn rather than to the driver. That edge is the whole
      // point of the links: without it a depth-2 row is just a number, and the
      // fan-out rollup cannot fold it into the group it belongs to.
      let previousDepthOneSubagentId = null;
      for (let subagentIndex = 0; subagentIndex < subagentCount; subagentIndex++) {
        const agentType = SUBAGENT_TYPES[Math.floor(random() * SUBAGENT_TYPES.length)];
        const subagentId = `seed-sub-${subagentCounter++}`;
        const spawnDepth = random() < 0.08 ? 2 : 1;
        const toolUseId = `seed-toolu-${subagentId}`;
        // Deterministic, so no random() call is added here and the PRNG stream
        // (and therefore every previously-seeded value) is unchanged. Three
        // subagents share a driver turn, which is what makes the fan-out rollup
        // show GROUPS rather than one row per subagent.
        const driverTurnUuid = `seed-turn-${session.sessionId}-${
          session.firstTurnIndex + ((Math.floor(subagentIndex / 3)) % session.turnCount)
        }`;
        const parentTurnUuid = spawnDepth === 2 && previousDepthOneSubagentId !== null
          ? `seed-turn-${previousDepthOneSubagentId}-0`
          : driverTurnUuid;
        if (insertSpawnLink) insertSpawnLink.run(toolUseId, parentTurnUuid, new Date(nowMs).toISOString());
        if (spawnDepth === 1) previousDepthOneSubagentId = subagentId;
        const turnCount = 3 + Math.floor(random() * 25);
        for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
          const ts = Math.min(session.startMs + Math.floor((session.durationMs * turnIndex) / turnCount), nowMs);
          const inputTokens = 100 + Math.floor(random() * 900);
          const outputTokens = 300 + Math.floor(random() * 3_000);
          insertSubagentTurn.run(
            `seed-turn-${subagentId}-${turnIndex}`,
            null,
            session.sessionId,
            null,
            session.profile.modelId,
            ts,
            inputTokens,
            outputTokens,
            Math.floor(inputTokens * 2.5),
            // A subagent re-reads its whole prompt cache every turn, which is
            // why cache read dominates a fan-out.
            20_000 + Math.floor(random() * 60_000),
            new Date(ts).toISOString(),
            subagentId,
            agentType,
            spawnDepth,
            toolUseId,
          );
          subagentTurnCounter++;
        }
      }
    }

    db.exec('BEGIN');
    try {
      for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
        const day = new Date();
        day.setDate(day.getDate() - dayOffset);
        // Weekend-ish dip + general variation. --sessions-per-day overrides
        // the weekday base (weekends dip to ~40% of it) for perf-test volume;
        // the formula shape is identical either way, so an unset flag leaves
        // the PRNG stream (and every previously-seeded value) unchanged.
        const isWeekend = day.getDay() === 0 || day.getDay() === 6;
        const weekdayBase = sessionsPerDay ?? 5;
        const weekendBase = sessionsPerDay === null ? 2 : Math.max(1, Math.round(sessionsPerDay * 0.4));
        const sessionsToday = Math.max(1, Math.round((isWeekend ? weekendBase : weekdayBase) * (0.5 + random())));

        for (let sessionIndex = 0; sessionIndex < sessionsToday; sessionIndex++) {
          const profile = pickProfile(random);

          // Session start spread over local working hours (9:00 - 19:00).
          const startHour = 9 + Math.floor(random() * 10);
          const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, Math.floor(random() * 60)).getTime();
          if (startMs > nowMs) continue;
          const sessionId = `seed-usage-${project.id.slice(0, 8)}-${dayOffset}-${sessionCounter++}`;
          const turnCount = 4 + Math.floor(random() * 20);
          insertSeededSession(sessionId, profile, startMs, turnCount);
        }
      }

      // Dense trailing-2h live window: tile several short sessions across the
      // full LIVE_WINDOW_MS so the Live period's per-bucket (token-type) and
      // cumulative chart cards have data across most of the ~24 five-minute
      // buckets, not just one thin tail session.
      const liveSessionCount = 3;
      const liveSliceMs = LIVE_WINDOW_MS / liveSessionCount;
      for (let liveIndex = 0; liveIndex < liveSessionCount; liveIndex++) {
        const profile = pickProfile(random);
        const sliceStartMs = nowMs - LIVE_WINDOW_MS + liveIndex * liveSliceMs;
        const startMs = Math.min(sliceStartMs + Math.floor(random() * liveSliceMs * 0.3), nowMs);
        const sessionId = `seed-usage-${project.id.slice(0, 8)}-live-${sessionCounter++}`;
        const turnCount = 6 + Math.floor(random() * 4);
        insertSeededSession(sessionId, profile, startMs, turnCount);
      }

      // Only some sessions fan out: /code-review, /test, and /sync-docs do, an
      // ordinary task agent does not. Runs after both loops so it consumes the
      // PRNG stream only at the end, leaving every previously-seeded value
      // byte-identical.
      if (canSeedSubagents) {
        for (const session of seededSessions) {
          if (random() < 0.35) insertSubagentFanOut(session);
        }
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(`  seeded ${project.name}: ${sessionCounter} sessions, ${turnCounter} driver turns, ${subagentTurnCounter} subagent turns over ${days} day(s)`);
  } finally {
    db.close();
  }
}

function cleanProject(configDir, project) {
  const dbPath = path.join(configDir, 'projects', `${project.id}.db`);
  if (!fs.existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  try {
    const sessions = db.prepare("DELETE FROM usage_history WHERE session_record_id LIKE 'seed-usage-%'").run();
    // Covers the subagent rows too: their turn_uuid carries the same prefix.
    const turns = db.prepare("DELETE FROM conversation_turn_usage WHERE turn_uuid LIKE 'seed-turn-%'").run();
    // Separate prefix, separate table, so it needs its own sweep. Guarded because
    // --clean must still work against a DB predating the table.
    const hasSpawnLinks = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turn_spawn_links'").get() !== undefined;
    const links = hasSpawnLinks
      ? db.prepare("DELETE FROM turn_spawn_links WHERE tool_use_id LIKE 'seed-toolu-%'").run()
      : { changes: 0 };
    console.log(`  cleaned ${project.name}: ${sessions.changes} sessions, ${turns.changes} turns, ${links.changes} spawn links`);
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv);
  const projects = listProjects(args.configDir);

  if (args.list) {
    for (const project of projects) console.log(`${project.id}  ${project.name}`);
    return;
  }

  let targets;
  if (args.all) {
    targets = projects;
  } else if (args.project) {
    const needle = args.project.toLowerCase();
    targets = projects.filter(
      (project) => project.id.toLowerCase() === needle || project.name.toLowerCase() === needle,
    );
    if (targets.length === 0) {
      console.error(`No registered project matches "${args.project}". Use --list to see projects.`);
      process.exit(1);
    }
  } else {
    console.error('Pass --project <name-or-id>, --all, or --list.');
    process.exit(1);
  }

  const random = makeRandom(args.seed);
  console.log(`${args.clean ? 'Cleaning' : 'Seeding'} usage data (config dir: ${args.configDir})`);
  for (const project of targets) {
    if (args.clean) cleanProject(args.configDir, project);
    else seedProject(args.configDir, project, args.days, args.sessionsPerDay, random);
  }
  if (!args.clean) {
    console.log('Done. Open the dashboard (title-bar chart icon / Mod+Shift+U); switch ranges or wait ~30s for the poll to pick the rows up.');
  }
}

main();
