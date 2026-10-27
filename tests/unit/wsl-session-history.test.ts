/**
 * A CLI installed in a WSL distro (#286) keeps its history in the distro's
 * home, in folders named from the path it ran in (`/mnt/c/...`). Every reader
 * after the spawn finds it from the place the session row recorded, and a
 * session on this machine reads exactly what it read before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';
import { codexHomeDir } from '../../src/main/agent/adapters/codex/config-toml';
import { CodexSessionHistoryParser, codexSessionsDirForToday } from '../../src/main/agent/adapters/codex/session-history-parser';
import { locateCodexTranscriptFile } from '../../src/main/agent/adapters/codex/transcript-parser';
import { readFinalReply, readTrail, type MessageTrailAdapter } from '../../src/main/agent/message-trail-read';
import { toStoredCliTarget, type CliPlace } from '../../src/main/agent/shared/cli-target';

const CONVERSATION_ID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';

function placeAt(homeUnc: string, env: CliPlace['facts']['env'] = {}): CliPlace {
  return {
    kind: 'wsl',
    distro: 'Ubuntu',
    facts: {
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc,
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
      interactivePath: '/usr/bin',
      env,
      networkingMode: 'nat',
    },
  };
}

describe('Claude: the transcript of a distro session', () => {
  it('is under the distro home, in the folder named from the /mnt path Claude ran in', () => {
    const place = placeAt('\\\\wsl.localhost\\Ubuntu\\home\\dev');
    expect(locateClaudeTranscriptFile(CONVERSATION_ID, 'C:\\proj\\wt', place)).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.claude', 'projects', '-mnt-c-proj-wt', `${CONVERSATION_ID}.jsonl`),
    );
  });

  it('is unchanged for this machine', () => {
    expect(locateClaudeTranscriptFile(CONVERSATION_ID, 'C:\\proj\\wt')).toBe(
      path.join(os.homedir(), '.claude', 'projects', 'C--proj-wt', `${CONVERSATION_ID}.jsonl`),
    );
  });
});

describe('Codex: rollouts of a distro session', () => {
  let distroHome: string;

  beforeEach(() => {
    distroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-wsl-codex-'));
  });

  afterEach(() => {
    fs.rmSync(distroHome, { recursive: true, force: true });
  });

  /** A rollout as Codex writes it in the distro: the `/mnt` cwd in its session_meta. */
  function writeRollout(place: CliPlace, recordedCwd: string, createdAt: Date): string {
    const directory = codexSessionsDirForToday(place);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `rollout-${createdAt.toISOString().replace(/[:.]/g, '-')}-${CONVERSATION_ID}.jsonl`);
    const meta = { type: 'session_meta', payload: { id: CONVERSATION_ID, cwd: recordedCwd, timestamp: createdAt.toISOString() } };
    fs.writeFileSync(filePath, `${JSON.stringify(meta)}\n`, 'utf8');
    return filePath;
  }

  it('live under the distro home, or the CODEX_HOME its shell sets', () => {
    expect(codexHomeDir(placeAt(distroHome))).toBe(path.join(distroHome, '.codex'));
    const withOverride = placeAt('\\\\wsl.localhost\\Ubuntu\\home\\dev', { CODEX_HOME: '/home/dev/.config/codex' });
    expect(codexHomeDir(withOverride)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.config\\codex');
    expect(codexSessionsDirForToday(placeAt(distroHome)).startsWith(path.join(distroHome, '.codex', 'sessions'))).toBe(true);
  });

  // Red-green: comparing the rollout's cwd with the Windows cwd (dropping
  // `cliPathForTarget`) makes the capture return null.
  it('are captured by matching the /mnt form of the spawn cwd', async () => {
    const place = placeAt(distroHome);
    const spawnedAt = new Date();
    writeRollout(place, '/mnt/c/proj/wt', spawnedAt);

    await expect(CodexSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: 'C:\\proj\\wt',
      cliTarget: toStoredCliTarget(place),
      maxAttempts: 1,
    })).resolves.toBe(CONVERSATION_ID);
    await expect(CodexSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: 'C:\\other\\folder',
      cliTarget: toStoredCliTarget(place),
      maxAttempts: 1,
    })).resolves.toBeNull();
  });

  it('are found by the telemetry locator and the transcript reader', async () => {
    const place = placeAt(distroHome);
    const filePath = writeRollout(place, '/mnt/c/proj/wt', new Date());

    await expect(CodexSessionHistoryParser.locate({
      agentSessionId: CONVERSATION_ID,
      cwd: 'C:\\proj\\wt',
      cliTarget: toStoredCliTarget(place),
    })).resolves.toBe(filePath);
    expect(locateCodexTranscriptFile(CONVERSATION_ID, place)).toBe(filePath);
  });
});

describe('the message trail and final reply of a distro session', () => {
  // The facts carry the stored target; every adapter read gets its place.
  const stored = toStoredCliTarget(placeAt('\\\\wsl.localhost\\Ubuntu\\home\\dev'));

  function recordingAdapter(): { adapter: MessageTrailAdapter; places: Array<CliPlace | null | undefined> } {
    const places: Array<CliPlace | null | undefined> = [];
    const adapter: MessageTrailAdapter = {
      locateSessionHistoryFile: vi.fn(async (_id: string, _cwd: string, place?: CliPlace | null) => {
        places.push(place);
        return '/mock/transcript.jsonl';
      }),
      parseTranscriptWindow: vi.fn(async (_id, _cwd, startByte, _maxBytes, _attributed, place?: CliPlace | null) => {
        places.push(place);
        return { entries: [], nextByteOffset: startByte, totalBytes: startByte, sourcePath: '/mock/transcript.jsonl' };
      }),
    };
    return { adapter, places };
  }

  it('reads the trail with the place', async () => {
    const { adapter, places } = recordingAdapter();
    await readTrail(adapter, { sessionType: 'claude_agent', agentSessionId: CONVERSATION_ID, cwd: 'C:\\proj', cliTarget: stored }, null, async () => 10);
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) expect(place?.facts.homeUnc).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev');
  });

  it('reads the final reply with the place, and a session on this machine with none', async () => {
    const distro = recordingAdapter();
    await readFinalReply(distro.adapter, { sessionType: 'claude_agent', agentSessionId: CONVERSATION_ID, cwd: 'C:\\proj', cliTarget: stored }, null, async () => 10);
    for (const place of distro.places) expect(place?.distro).toBe('Ubuntu');

    const local = recordingAdapter();
    await readFinalReply(local.adapter, { sessionType: 'claude_agent', agentSessionId: CONVERSATION_ID, cwd: 'C:\\proj' }, null, async () => 10);
    expect(local.places.length).toBeGreaterThan(0);
    for (const place of local.places) expect(place).toBeNull();
  });
});
