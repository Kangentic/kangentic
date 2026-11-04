/**
 * A Copilot resume reaching its conversation, and the event log's locator.
 *
 * Every Kangentic spawn, a resume included, gets a new session record folder
 * and so a new `--config-dir`. GitHub's config directory reference keeps a
 * session in `<config home>/session-state/<id>/`, and the command reference
 * says `--session-id` with an unseen UUID creates a new session, so without
 * the seed a resume opened an empty conversation. Built from those docs, not
 * run against a real Copilot CLI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
});

import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import {
  kangenticSessionFolders,
  locateCopilotEventsFile,
  seedResumedSessionState,
} from '../../src/main/agent/adapters/copilot/session-state';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

let tmpDir: string;
let projectRoot: string;
let sessionsDir: string;
let savedCopilotHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-state-'));
  tmpHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'repo');
  sessionsDir = path.join(projectRoot, '.kangentic', 'sessions');
  fs.mkdirSync(tmpHome, { recursive: true });
  savedCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  if (savedCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = savedCopilotHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A Kangentic session record's config home, with this session's folder holding `text` as its log. */
function kangenticSession(recordId: string, text: string, mtimeSeconds: number): string {
  const folder = path.join(sessionsDir, recordId, 'copilot-config', 'session-state', SESSION_ID);
  fs.mkdirSync(path.join(folder, 'checkpoints'), { recursive: true });
  const eventsFile = path.join(folder, 'events.jsonl');
  fs.writeFileSync(eventsFile, text);
  fs.writeFileSync(path.join(folder, 'checkpoints', 'index.md'), 'checkpoint');
  fs.utimesSync(eventsFile, mtimeSeconds, mtimeSeconds);
  return folder;
}

function newConfigHome(recordId: string): string {
  return path.join(sessionsDir, recordId, 'copilot-config');
}

describe('seedResumedSessionState', () => {
  it('copies the newest earlier Kangentic folder into the new config home and keeps the source', async () => {
    kangenticSession('record-1', 'older', 1_000);
    const newer = kangenticSession('record-2', 'newer', 2_000);
    const configHome = newConfigHome('record-3');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });

    const target = path.join(configHome, 'session-state', SESSION_ID);
    expect(fs.readFileSync(path.join(target, 'events.jsonl'), 'utf-8')).toBe('newer');
    expect(fs.readFileSync(path.join(target, 'checkpoints', 'index.md'), 'utf-8')).toBe('checkpoint');
    // Kept: a spawn abandoned before its record is saved leaves a folder the
    // cold-open sweep deletes, so the copy must never be the only one.
    expect(fs.readFileSync(path.join(newer, 'events.jsonl'), 'utf-8')).toBe('newer');
    // And the copy is what the locator reads next.
    expect(await locateCopilotEventsFile(SESSION_ID, projectRoot)).toBe(path.join(target, 'events.jsonl'));
  });

  it('copies from the user\'s own Copilot home and leaves it there', () => {
    const userFolder = path.join(tmpHome, '.copilot', 'session-state', SESSION_ID);
    fs.mkdirSync(userFolder, { recursive: true });
    fs.writeFileSync(path.join(userFolder, 'events.jsonl'), 'user');
    const configHome = newConfigHome('record-1');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });

    expect(fs.readFileSync(path.join(configHome, 'session-state', SESSION_ID, 'events.jsonl'), 'utf-8')).toBe('user');
    expect(fs.existsSync(path.join(userFolder, 'events.jsonl'))).toBe(true);
  });

  it('prefers a Kangentic folder over the user\'s home', () => {
    kangenticSession('record-1', 'kangentic', 1_000);
    const userFolder = path.join(tmpHome, '.copilot', 'session-state', SESSION_ID);
    fs.mkdirSync(userFolder, { recursive: true });
    fs.writeFileSync(path.join(userFolder, 'events.jsonl'), 'user');
    const configHome = newConfigHome('record-2');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });

    expect(fs.readFileSync(path.join(configHome, 'session-state', SESSION_ID, 'events.jsonl'), 'utf-8')).toBe('kangentic');
  });

  it('leaves a home that already holds the session alone', () => {
    const own = kangenticSession('record-2', 'own', 1_000);
    const other = kangenticSession('record-1', 'other', 2_000);

    seedResumedSessionState({ configHome: newConfigHome('record-2'), sessionId: SESSION_ID, sessionsDir, place: null });

    expect(fs.readFileSync(path.join(own, 'events.jsonl'), 'utf-8')).toBe('own');
    expect(fs.existsSync(other)).toBe(true);
  });

  it('never scans a parent that is not Kangentic\'s .kangentic/sessions', () => {
    const otherParent = path.join(tmpDir, 'scratch');
    const elsewhere = path.join(otherParent, 'record-1', 'copilot-config', 'session-state', SESSION_ID);
    fs.mkdirSync(elsewhere, { recursive: true });
    const configHome = path.join(otherParent, 'record-2', 'copilot-config');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir: otherParent, place: null });

    expect(fs.existsSync(path.join(configHome, 'session-state', SESSION_ID))).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('does nothing and throws nothing when the session is nowhere', () => {
    const configHome = newConfigHome('record-1');
    expect(() => seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null })).not.toThrow();
    expect(fs.existsSync(path.join(configHome, 'session-state', SESSION_ID))).toBe(false);
  });

  it('warns and lets the resume start empty when the copy fails', () => {
    kangenticSession('record-1', 'kangentic', 1_000);
    const configHome = newConfigHome('record-2');
    // A file where the session-state folder must go blocks both.
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(path.join(configHome, 'session-state'), 'not a folder');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null })).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('locateCopilotEventsFile', () => {
  it('takes the path the agent reported while it exists', async () => {
    const reported = path.join(kangenticSession('record-1', 'reported', 1_000), 'events.jsonl');
    kangenticSession('record-2', 'newer', 2_000);
    expect(await locateCopilotEventsFile(SESSION_ID, projectRoot, null, reported)).toBe(reported);
  });

  it('finds the newest log in the project\'s Kangentic homes, from a worktree too', async () => {
    kangenticSession('record-1', 'older', 1_000);
    const newer = kangenticSession('record-2', 'newer', 2_000);
    const worktree = path.join(projectRoot, '.kangentic', 'worktrees', 'task-1');
    expect(await locateCopilotEventsFile(SESSION_ID, worktree, null, path.join(tmpDir, 'gone.jsonl'))).toBe(path.join(newer, 'events.jsonl'));
  });

  it('falls back to the user\'s own Copilot home, then null', async () => {
    expect(await locateCopilotEventsFile(SESSION_ID, projectRoot)).toBeNull();
    const userFolder = path.join(tmpHome, '.copilot', 'session-state', SESSION_ID);
    fs.mkdirSync(userFolder, { recursive: true });
    fs.writeFileSync(path.join(userFolder, 'events.jsonl'), 'user');
    expect(await locateCopilotEventsFile(SESSION_ID, projectRoot)).toBe(path.join(userFolder, 'events.jsonl'));
  });

  it('ranks an older folder that holds a log over a newer folder with none', async () => {
    const older = kangenticSession('record-1', 'older', 1_000);
    emptySessionFolder('record-2');
    expect(await locateCopilotEventsFile(SESSION_ID, projectRoot)).toBe(path.join(older, 'events.jsonl'));
  });
});

/** A session folder Copilot made and never wrote a log to; its own mtime is now. */
function emptySessionFolder(recordId: string): string {
  const folder = path.join(newConfigHome(recordId), 'session-state', SESSION_ID);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

describe('kangenticSessionFolders', () => {
  it('leaves out the excluded config home and returns another home\'s folder', () => {
    const excludedFolder = kangenticSession('record-1', 'excluded', 2_000);
    const otherFolder = kangenticSession('record-2', 'other', 1_000);

    expect(kangenticSessionFolders(sessionsDir, SESSION_ID).sort()).toEqual([excludedFolder, otherFolder].sort());
    expect(kangenticSessionFolders(sessionsDir, SESSION_ID, newConfigHome('record-1'))).toEqual([otherFolder]);
  });

  it('ranks a newer folder with no log after an older folder that has one', () => {
    const older = kangenticSession('record-1', 'older', 1_000);
    const newerWithoutLog = emptySessionFolder('record-2');

    expect(kangenticSessionFolders(sessionsDir, SESSION_ID)).toEqual([older, newerWithoutLog]);
  });
});

describe('seedResumedSessionState details', () => {
  it('seeds from the older folder that holds a log, not a newer one with none', () => {
    kangenticSession('record-1', 'older log', 1_000);
    emptySessionFolder('record-2');
    const configHome = newConfigHome('record-3');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });

    expect(fs.readFileSync(path.join(configHome, 'session-state', SESSION_ID, 'events.jsonl'), 'utf-8')).toBe('older log');
  });

  it('stamps the copied log with the time of the copy, even when the copy kept the source\'s write time', () => {
    const source = kangenticSession('record-1', 'log', 1_000);
    const configHome = newConfigHome('record-2');
    // Make the copy behave as Windows' does, keeping the source's write time.
    const realCopy = fs.cpSync.bind(fs);
    const copySpy = vi.spyOn(fs, 'cpSync').mockImplementation((from, to, options) => {
      realCopy(from, to, { ...options, preserveTimestamps: true });
    });
    const beforeCall = Date.now();
    try {
      seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });
    } finally {
      copySpy.mockRestore();
    }

    const copiedMtime = fs.statSync(path.join(configHome, 'session-state', SESSION_ID, 'events.jsonl')).mtimeMs;
    const sourceMtime = fs.statSync(path.join(source, 'events.jsonl')).mtimeMs;
    expect(sourceMtime).toBe(1_000_000);
    expect(copiedMtime).toBeGreaterThanOrEqual(beforeCall);
    expect(copiedMtime).toBeGreaterThan(sourceMtime);
  });

  it('leaves no half-made session when the copy fails partway, and completes on the next call', () => {
    kangenticSession('record-1', 'whole', 1_000);
    const configHome = newConfigHome('record-2');
    const target = path.join(configHome, 'session-state', SESSION_ID);
    const copySpy = vi.spyOn(fs, 'cpSync').mockImplementation((_from, to) => {
      fs.mkdirSync(String(to), { recursive: true });
      fs.writeFileSync(path.join(String(to), 'events.jsonl'), 'par');
      throw new Error('disk full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null })).not.toThrow();
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(configHome).filter((entry) => entry.startsWith('.seeding-'))).toEqual([]);
    } finally {
      copySpy.mockRestore();
      warn.mockRestore();
    }

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place: null });
    expect(fs.readFileSync(path.join(target, 'events.jsonl'), 'utf-8')).toBe('whole');
    expect(fs.readFileSync(path.join(target, 'checkpoints', 'index.md'), 'utf-8')).toBe('checkpoint');
    expect(fs.readdirSync(configHome).filter((entry) => entry.startsWith('.seeding-'))).toEqual([]);
  });

  it('copies from a WSL place\'s own Copilot home rather than the host\'s', () => {
    const distroHome = path.join(tmpDir, 'distro-home');
    const distroFolder = path.join(distroHome, '.copilot', 'session-state', SESSION_ID);
    fs.mkdirSync(distroFolder, { recursive: true });
    fs.writeFileSync(path.join(distroFolder, 'events.jsonl'), 'distro');
    const hostFolder = path.join(tmpHome, '.copilot', 'session-state', SESSION_ID);
    fs.mkdirSync(hostFolder, { recursive: true });
    fs.writeFileSync(path.join(hostFolder, 'events.jsonl'), 'host');
    const place: CliPlace = {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxCliPath: '/home/dev/.local/bin/copilot',
      facts: {
        distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome, uncRoot: '\\\\wsl.localhost\\Ubuntu',
        interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
      },
    };
    const configHome = newConfigHome('record-1');

    seedResumedSessionState({ configHome, sessionId: SESSION_ID, sessionsDir, place });

    expect(fs.readFileSync(path.join(configHome, 'session-state', SESSION_ID, 'events.jsonl'), 'utf-8')).toBe('distro');
  });
});
