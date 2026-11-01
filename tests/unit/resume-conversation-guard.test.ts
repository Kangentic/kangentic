/**
 * The resume check: what a `--resume` would find, decided before the spawn.
 *
 * Two dead ends it exists for, both reproduced on real boards:
 *
 *  - `never-started`: drag a task out of Done (the recovery move spawns
 *    command-free, so the agent boots idle with nothing to do), drag it back
 *    before typing, then drag it out again. Kangentic pre-specifies
 *    `--session-id` and persists it AT SPAWN TIME, so the never-used id looks
 *    resumable forever. The status fixtures below are trimmed from the real
 *    captured file of that session (Claude Code 2.1.233): `current_usage: null`,
 *    zero totals, and a `transcript_path` naming a file the CLI never wrote.
 *  - `expired`: Claude Code deletes transcripts older than `cleanupPeriodDays`.
 *    A task idle 59 days resumed `--resume <id>`, Claude printed "No
 *    conversation found", and the user sat on a bare shell. Its project folder
 *    was gone too, so the immediate parent of the reported path is not required.
 *
 * The check has to stay narrower than the `canResumeSession` guard that was
 * built and deliberately reverted in #255, whose false misses silently
 * destroyed real conversations. These tests pin what keeps it narrow: the paths
 * come from the agent's own reports, `expired` needs the adapter's proof that
 * the file is gone from every place it could be, only ENOENT counts as gone,
 * and absence of evidence always degrades to today's resume.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessResumeConversation,
  folderOnlyRecord,
  type ResumeLineageRecord,
} from '../../src/main/transition-engine/resume-conversation-guard';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { serializeCliTarget, type CliPlace } from '../../src/main/agent/shared/cli-target';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const RECORD_ID = '6fc5d715-77ca-47d6-9c50-8f27ad05e4a7';
const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';

let projectPath: string;
/** Stands in for `~/.claude/projects`: one folder per project slug. */
let projectsRoot: string;
let transcriptPath: string;
/** A cwd whose locator path (under the real home) never exists. */
let cwd: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-guard-'));
  projectsRoot = path.join(projectPath, 'claude-projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  transcriptPath = path.join(projectsRoot, '-work-project', `${AGENT_SESSION_ID}.jsonl`);
  cwd = path.join(projectPath, 'never-a-claude-project');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

/** An adapter shaped like Claude's: a status pipeline that parses real status JSON, and Claude's proof. */
function claudeShapedAdapter(): AgentAdapter {
  return {
    runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
    proveConversationGone: proveClaudeConversationGone,
  } as unknown as AgentAdapter;
}

/** A status pipeline but no way to prove a file gone: never `expired`. */
function adapterWithoutProof(): AgentAdapter {
  return {
    runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
  } as unknown as AgentAdapter;
}

/** Codex, Aider, and friends: no status file, so nothing to probe. */
function adapterWithoutStatusPipeline(): AgentAdapter {
  return { runtime: {} } as unknown as AgentAdapter;
}

function folderRecord(id: string = RECORD_ID): ResumeLineageRecord {
  return folderOnlyRecord(id);
}

function writeStatusFile(options: {
  recordId?: string;
  includeTranscriptPath?: boolean;
  reportedPath?: string;
  usedPercentage?: number | null;
  currentUsage?: Record<string, number> | null;
  totalCostUsd?: number;
  raw?: string;
}): void {
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', options.recordId ?? RECORD_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const contents = options.raw ?? JSON.stringify({
    session_id: AGENT_SESSION_ID,
    ...(options.includeTranscriptPath === false ? {} : { transcript_path: options.reportedPath ?? transcriptPath }),
    model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
    cost: { total_cost_usd: options.totalCostUsd ?? 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
    context_window: {
      total_input_tokens: options.currentUsage ? 4200 : 0,
      total_output_tokens: 0,
      context_window_size: 200000,
      current_usage: options.currentUsage ?? null,
      used_percentage: options.usedPercentage ?? null,
    },
  });
  fs.writeFileSync(path.join(sessionDir, 'status.json'), contents, 'utf8');
}

const TURN_USAGE = { input_tokens: 4200, output_tokens: 130, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function assess(options: {
  adapter?: AgentAdapter;
  records?: ReadonlyArray<ResumeLineageRecord | null>;
  agentSessionId?: string;
  projectPath?: string | null;
  /** Where the spawn's CLI runs. Left undefined, the guard is called without a place. */
  place?: CliPlace | null;
}) {
  return assessResumeConversation({
    adapter: options.adapter ?? claudeShapedAdapter(),
    agentSessionId: options.agentSessionId ?? AGENT_SESSION_ID,
    records: options.records ?? [folderRecord()],
    cwd,
    projectPath: options.projectPath === undefined ? projectPath : options.projectPath,
    // Passed through as given: undefined means "no place asked for", null means "this machine".
    place: options.place,
  });
}

describe('assessResumeConversation - never-started', () => {
  it('reports never-started when the agent recorded no turns and never wrote the transcript it named', async () => {
    // The exact reported state: booted, zero turns, transcript path named but no file.
    writeStatusFile({});
    expect(fs.existsSync(transcriptPath)).toBe(false);
    await expect(assess({})).resolves.toBe('never-started');
  });

  it('resumes when the named transcript exists, even with no turns recorded yet', async () => {
    writeStatusFile({});
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8');
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('ignores a status report about another conversation, as a background spare writing the same file leaves', async () => {
    // Claude Code's background daemon ran an empty spare with the task's own
    // --settings, so the spare's write (zero totals, a transcript it never
    // wrote) can be the last one in the record's status file. The events file
    // still holds the resumed conversation's own SessionStart and turns.
    const spareId = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';
    writeStatusFile({
      raw: JSON.stringify({
        session_id: spareId,
        transcript_path: path.join(projectsRoot, '-work-project', `${spareId}.jsonl`),
        model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
        cost: { total_cost_usd: 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
        context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null },
      }),
    });
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
      JSON.stringify({
        ts: 1,
        type: 'session_start',
        hookContext: JSON.stringify({ session_id: AGENT_SESSION_ID, transcript_path: transcriptPath, hook_event_name: 'SessionStart', source: 'resume' }),
      }),
      JSON.stringify({ ts: 2, type: 'tool_start', tool: 'Read' }),
    ].join('\n') + '\n', 'utf8');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8');

    await expect(assess({})).resolves.toBe('unknown');
  });

  it('never reads zero totals on a row as no turns', async () => {
    // The path is written on the first status tick, before any metrics
    // capture, so a row with a path and zero totals proves nothing. Without the
    // agent's own report, the answer is unknown, never never-started.
    await expect(assess({
      records: [{ id: RECORD_ID, transcript_path: transcriptPath, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 }],
    })).resolves.toBe('unknown');
  });
});

describe('assessResumeConversation - a CLI that ran in a WSL distro (#286)', () => {
  // A distro CLI reports its transcript by its Linux path, which this machine
  // never finds. Read as written, a conversation that is there looked never
  // started, and the resume became a fresh conversation. Each record's own
  // `cli_target` names the distro share the path is read through.
  //
  // Red-green: dropping `reportedPathOnHost` (checking the reported Linux path
  // as is) makes the first case `never-started`.
  const LINUX_TRANSCRIPT = `/home/dev/.claude/projects/-mnt-c-proj/${AGENT_SESSION_ID}.jsonl`;
  let uncRoot: string;

  /** The path the share mapping gives, created exactly as given so it holds on every OS. */
  function sharePath(linuxPath: string): string {
    return `${uncRoot}\\${linuxPath.split('/').filter(Boolean).join('\\')}`;
  }

  function wslRecord(): ResumeLineageRecord {
    return {
      ...folderRecord(),
      cli_target: JSON.stringify({ kind: 'wsl', distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: `${uncRoot}\\home\\dev`, uncRoot }),
    };
  }

  beforeEach(() => {
    uncRoot = path.join(projectPath, 'distro-share');
  });

  it('reads the reported Linux path through the distro share, and resumes when the file is there', async () => {
    writeStatusFile({ reportedPath: LINUX_TRANSCRIPT });
    const onShare = sharePath(LINUX_TRANSCRIPT);
    fs.mkdirSync(path.dirname(onShare), { recursive: true });
    fs.writeFileSync(onShare, '{"type":"user"}\n', 'utf8');

    await expect(assess({ records: [wslRecord()] })).resolves.toBe('unknown');
  });

  it('still reports never-started when the distro holds no such file', async () => {
    writeStatusFile({ reportedPath: LINUX_TRANSCRIPT });
    await expect(assess({ records: [wslRecord()] })).resolves.toBe('never-started');
  });

  // A conversation with turns reaches Claude's proof, which is handed paths
  // the guard already mapped (and a row's path the session manager mapped as
  // it arrived). Mapping one of those again names a file that is never there,
  // which is a false `expired`: a fresh conversation in place of the resume.
  it('resumes a conversation with turns whose file the distro holds, with its path mapped once', async () => {
    writeStatusFile({ reportedPath: LINUX_TRANSCRIPT, currentUsage: TURN_USAGE, totalCostUsd: 0.12 });
    const onShare = sharePath(LINUX_TRANSCRIPT);
    fs.mkdirSync(path.dirname(onShare), { recursive: true });
    fs.writeFileSync(onShare, '{"type":"user"}\n', 'utf8');

    await expect(assess({ records: [{ ...wslRecord(), transcript_path: onShare }] })).resolves.toBe('unknown');
  });
});

describe('assessResumeConversation - a conversation lives in the place its CLI ran in', () => {
  // A conversation is kept in the home of the place its CLI ran in. The newest
  // record that kept a `cli_target` says where that was; a spawn whose CLI runs
  // somewhere else cannot resume it, so the verdict is `expired` when the
  // lineage had turns and `never-started` when it had none, instead of a
  // `--resume` the CLI answers with "No conversation found".
  //
  // Every fixture here has a row with no reported transcript path, so the
  // verdict without a place is `unknown` (nothing proves anything). That makes
  // the place the only thing that can move it, which is what each case checks.
  // Red-green: dropping the place check turns every refusal below into
  // `unknown`; reading `records[0]` instead of the newest record that kept a
  // `cli_target` fails the folder-only and newest-decides cases; testing the
  // field for truthiness instead of `!== undefined` fails the `null` cases.
  const OTHER_RECORD_ID = '2fec0dab-99d2-407a-8782-2a748dfc935e';
  const TURNS = { total_input_tokens: 9100, total_output_tokens: 300, total_cost_usd: 0.4 };
  const NO_TURNS = { total_input_tokens: null, total_output_tokens: null, total_cost_usd: null };

  /** A row's `cli_target` column as the session layer writes it for a CLI in a distro. */
  function storedDistroTarget(distro: string): string {
    const serialized = serializeCliTarget({
      kind: 'wsl',
      distro,
      homeLinux: '/home/dev',
      homeUnc: `\\\\wsl.localhost\\${distro}\\home\\dev`,
      uncRoot: `\\\\wsl.localhost\\${distro}`,
    });
    if (!serialized) throw new Error('serializeCliTarget gave no JSON for a distro target');
    return serialized;
  }

  /** The place a spawn's CLI runs in when it is installed in `distro`. */
  function distroPlace(distro: string): CliPlace {
    return {
      kind: 'wsl',
      distro,
      facts: {
        distro,
        homeLinux: '/home/dev',
        homeUnc: `\\\\wsl.localhost\\${distro}\\home\\dev`,
        uncRoot: `\\\\wsl.localhost\\${distro}`,
        interactivePath: '/usr/bin',
        env: {},
        networkingMode: 'nat',
      },
    };
  }

  function recordRunIn(
    cliTarget: string | null,
    totals: Pick<ResumeLineageRecord, 'total_input_tokens' | 'total_output_tokens' | 'total_cost_usd'>,
    id: string = RECORD_ID,
  ): ResumeLineageRecord {
    return { id, transcript_path: null, ...totals, cli_target: cliTarget };
  }

  it('is expired for a conversation that ran in a distro when the CLI now runs on this machine', async () => {
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), TURNS)], place: null })).resolves.toBe('expired');
  });

  it('is never-started for the same conversation when it had no turns', async () => {
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), NO_TURNS)], place: null })).resolves.toBe('never-started');
  });

  it('is expired for a conversation from this machine (cli_target null) when the CLI now runs in a distro', async () => {
    await expect(assess({ records: [recordRunIn(null, TURNS)], place: distroPlace('Ubuntu') })).resolves.toBe('expired');
    await expect(assess({ records: [recordRunIn(null, NO_TURNS)], place: distroPlace('Ubuntu') })).resolves.toBe('never-started');
  });

  it('is expired for a conversation from one distro when the CLI now runs in another', async () => {
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), TURNS)], place: distroPlace('Debian') })).resolves.toBe('expired');
  });

  it('keeps the verdict it had without a place when the CLI runs in the same distro, whatever the case of the name', async () => {
    const records = [recordRunIn(storedDistroTarget('Ubuntu'), TURNS)];
    const withoutPlace = await assess({ records });
    expect(withoutPlace).toBe('unknown');
    await expect(assess({ records, place: distroPlace('ubuntu') })).resolves.toBe(withoutPlace);
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), NO_TURNS)], place: distroPlace('UBUNTU') })).resolves.toBe('unknown');
  });

  it('keeps the verdict it had without a place when both ran on this machine', async () => {
    await expect(assess({ records: [recordRunIn(null, TURNS)], place: null })).resolves.toBe('unknown');
    await expect(assess({ records: [recordRunIn(null, NO_TURNS)], place: null })).resolves.toBe('unknown');
  });

  it('lets the newest record that kept a cli_target decide, not an older one', async () => {
    // Newest ran on this machine, an older one in a distro: the conversation
    // moved here, so a CLI on this machine can resume it.
    await expect(assess({
      records: [recordRunIn(null, TURNS), recordRunIn(storedDistroTarget('Ubuntu'), TURNS, OTHER_RECORD_ID)],
      place: null,
    })).resolves.toBe('unknown');
    // The other way round, the newest record's distro is where the conversation is.
    await expect(assess({
      records: [recordRunIn(storedDistroTarget('Ubuntu'), TURNS), recordRunIn(null, TURNS, OTHER_RECORD_ID)],
      place: null,
    })).resolves.toBe('expired');
  });

  it('decides nothing from a folder-only record, which keeps no cli_target', async () => {
    // Nothing is known about where the conversation is, so the place cannot
    // contradict it. Read as "this machine" it would be never-started here.
    expect(folderRecord()).not.toHaveProperty('cli_target');
    await expect(assess({ records: [folderRecord()], place: distroPlace('Ubuntu') })).resolves.toBe('unknown');
    await expect(assess({ records: [folderRecord()], place: null })).resolves.toBe('unknown');
  });

  it('skips a folder-only record in front of the record that does say where the conversation is', async () => {
    await expect(assess({
      records: [folderRecord(OTHER_RECORD_ID), recordRunIn(null, TURNS)],
      place: distroPlace('Ubuntu'),
    })).resolves.toBe('expired');
  });

  it('changes nothing when the spawn names no place', async () => {
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), TURNS)] })).resolves.toBe('unknown');
    await expect(assess({ records: [recordRunIn(storedDistroTarget('Ubuntu'), NO_TURNS)] })).resolves.toBe('unknown');
    await expect(assess({ records: [recordRunIn(null, TURNS)] })).resolves.toBe('unknown');
  });
});

describe('assessResumeConversation - falls back to the SessionStart hook', () => {
  // The status line only runs once the TUI is up, so a CLI killed in its first
  // second leaves none and used to blind the whole lineage. The SessionStart
  // hook fires far earlier and carries the same `transcript_path`. Lines below
  // are the real captured shape: the payload is a JSON STRING under hookContext.
  function writeEventsFile(lines: string[]): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  }

  const sessionStartLine = () => JSON.stringify({
    ts: 1786997736868,
    type: 'session_start',
    hookContext: JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
  });

  it('reports never-started from a start/end-only events file with no transcript on disk', async () => {
    writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997738763, type: 'session_end' })]);
    await expect(assess({})).resolves.toBe('never-started');
  });

  it('is never never-started when the events file shows any real turn', async () => {
    // Anything beyond the two lifecycle markers counts as a turn. With the
    // file gone everywhere, a conversation with turns is expired, never
    // never-started.
    for (const turnEvent of ['user_prompt', 'tool_start', 'idle']) {
      writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997737000, type: turnEvent })]);
      await expect(assess({})).resolves.toBe('expired');
    }
  });

  it('resumes when the events file carries no SessionStart payload (the mocked-CLI shape)', async () => {
    // mock-claude writes activity events with no session_start hook payload.
    writeEventsFile([JSON.stringify({ ts: 1786997737000, type: 'session_start' })]);
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('prefers the status line when both reports exist', async () => {
    // Status says the conversation had turns; the events file alone would have
    // said otherwise. The conversation is not treated as never started.
    writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997738763, type: 'session_end' })]);
    writeStatusFile({ currentUsage: TURN_USAGE });
    await expect(assess({ adapter: adapterWithoutProof() })).resolves.toBe('unknown');
  });

  it('tolerates a torn final line', async () => {
    writeEventsFile([sessionStartLine(), '{"ts":1786997738763,"type":"sess']);
    await expect(assess({})).resolves.toBe('never-started');
  });
});

describe('assessResumeConversation - heals an already-poisoned lineage', () => {
  // A failed resume is self-perpetuating: the CLI dies before its status line
  // runs, so THAT record has no status file, and the next spawn retires it and
  // finds no evidence either. The observed board had three records sharing one
  // agent_session_id, and only the first carried a status report.
  const DEAD_RESUME_RECORD_ID = '2fec0dab-99d2-407a-8782-2a748dfc935e';

  it('finds the evidence on an older record when the retiring one wrote no status file', async () => {
    writeStatusFile({});
    fs.mkdirSync(path.join(projectPath, '.kangentic', 'sessions', DEAD_RESUME_RECORD_ID), { recursive: true });
    await expect(assess({ records: [folderRecord(DEAD_RESUME_RECORD_ID), folderRecord()] })).resolves.toBe('never-started');
  });

  it('still resumes when no record in the lineage has any evidence', async () => {
    await expect(assess({ records: [folderRecord(DEAD_RESUME_RECORD_ID), folderRecord()] })).resolves.toBe('unknown');
  });
});

describe('assessResumeConversation - expired', () => {
  it('reports expired when a conversation with turns is gone from every project folder', async () => {
    // The real case: the reported file and its project folder are both gone.
    writeStatusFile({ currentUsage: TURN_USAGE });
    expect(fs.existsSync(path.dirname(transcriptPath))).toBe(false);
    await expect(assess({})).resolves.toBe('expired');
  });

  it('decides from the session row once the session folder is gone', async () => {
    // A quit or a removal deletes the session folder, which left most old
    // conversations with no evidence. The row keeps the path and the totals.
    await expect(assess({
      records: [{ id: RECORD_ID, transcript_path: transcriptPath, total_input_tokens: 9100, total_output_tokens: 300, total_cost_usd: 0.4 }],
    })).resolves.toBe('expired');
  });

  it('resumes when another project folder still holds the file', async () => {
    // A renamed or sibling worktree's folder: Claude may find it there, so the
    // check does not need to know whether it would.
    writeStatusFile({ currentUsage: TURN_USAGE });
    const elsewhere = path.join(projectsRoot, '-work-project-renamed', `${AGENT_SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '{"type":"user"}\n', 'utf8');
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when the reported file still exists', async () => {
    writeStatusFile({ currentUsage: TURN_USAGE });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8');
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when every reported path names another conversation (a record from before a /clear fork)', async () => {
    const otherConversation = path.join(projectsRoot, '-work-project', 'aaaaaaaa-0000-4000-8000-000000000000.jsonl');
    writeStatusFile({ currentUsage: TURN_USAGE, reportedPath: otherConversation });
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when the projects folder above the reported path does not exist (a WSL path seen from Windows)', async () => {
    const linuxStylePath = path.join(projectPath, 'no-such-home', '.claude', 'projects', '-home-dev-app', `${AGENT_SESSION_ID}.jsonl`);
    writeStatusFile({ currentUsage: TURN_USAGE, reportedPath: linuxStylePath });
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when the file cannot be read for any reason but ENOENT', async () => {
    // fs.existsSync, which the old guard used, also returns false on a
    // permission or lock error. Only a missing file is proof.
    writeStatusFile({ currentUsage: TURN_USAGE });
    const realStat = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, ...rest) => {
      if (String(target) === transcriptPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realStat(target, ...rest);
    });
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('never reports expired for an adapter that cannot prove a file gone', async () => {
    writeStatusFile({ currentUsage: TURN_USAGE });
    await expect(assess({ adapter: adapterWithoutProof() })).resolves.toBe('unknown');
  });

  it('counts cost or used_percentage as turns, as it counts tokens', async () => {
    writeStatusFile({ totalCostUsd: 0.42 });
    await expect(assess({})).resolves.toBe('expired');
    writeStatusFile({ usedPercentage: 12 });
    await expect(assess({})).resolves.toBe('expired');
  });
});

describe('assessResumeConversation - absence of evidence is never evidence', () => {
  it('resumes when no status file was ever written (the mocked-CLI path)', async () => {
    // mock-claude writes no status.json. This is exactly the case that broke
    // ten session-resume E2E specs when #255 gated on a computed path instead.
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when the adapter has no status pipeline at all', async () => {
    writeStatusFile({});
    await expect(assess({ adapter: adapterWithoutStatusPipeline() })).resolves.toBe('unknown');
  });

  it('resumes when the status file is malformed', async () => {
    writeStatusFile({ raw: 'not json {' });
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when the status report carries no transcript path', async () => {
    writeStatusFile({ includeTranscriptPath: false, currentUsage: TURN_USAGE });
    await expect(assess({})).resolves.toBe('unknown');
  });

  it('resumes when there is no record or no project path', async () => {
    await expect(assess({ records: [null] })).resolves.toBe('unknown');
    await expect(assess({ projectPath: null })).resolves.toBe('unknown');
  });
});

describe('both spawn chokepoints run the check after the reconcile and the migration', () => {
  // The board path (transition-engine) is where the reported bugs fired;
  // startup recovery reaches the same dead --resume after a crash. A check on
  // only one of them is the drift this exists to stop. The order matters: the
  // check needs the id actually being resumed, and a migrated file is where the
  // locator finds it.
  const repoRoot = path.resolve(__dirname, '../..');
  const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

  it('the board path reconciles, migrates, then checks', () => {
    const source = read('src/main/transition-engine/transition-engine.ts');
    const reconcileAt = source.indexOf('await reconcileResumeAgentSessionId(');
    const migrateAt = source.indexOf('await migrateResumeCwdIfRenamed(');
    const checkAt = source.indexOf('await assessResumeConversation(');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(reconcileAt);
    expect(checkAt).toBeGreaterThan(migrateAt);
  });

  it('the board path re-resolves the intent instead of clearing a flag', () => {
    // Flipping a flag would leave `intent.prompt` on the RESUME branch's value
    // (`resumePrompt`, undefined for an ordinary task spawn), so the fresh spawn
    // it produces comes up with no task prompt - itself a zero-turn
    // conversation. Only re-running the resolver forceFresh takes the fresh
    // branch's interpolated promptTemplate, and retires the old record.
    const source = read('src/main/transition-engine/transition-engine.ts');
    expect(source).toMatch(/resolveSpawnIntent\(\{ \.\.\.spawnIntentOptions, forceFresh: true \}\)/);
    expect(source).toMatch(/const canResume = intent\.mode === 'resume'/);
  });

  it('startup recovery reconciles, checks, then resolves the shim with the recap prompt', () => {
    const source = read('src/main/transition-engine/session-startup/prepare-spawn.ts');
    const reconcileAt = source.indexOf('await reconcileResumeAgentSessionId(');
    const checkAt = source.indexOf('await assessResumeConversation(');
    const shimAt = source.indexOf('await resolveShimLaunch(');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(reconcileAt);
    expect(shimAt).toBeGreaterThan(checkAt);
    expect(source).toMatch(/prompt: prompt \?\? undefined/);
  });
});
