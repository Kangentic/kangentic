/**
 * The host's own look for a Claude conversation (`proveClaudeConversationGoneOnHost`), with its real
 * `sh` script run through the helper's real command runner on folders made for each case.
 *
 * Only the host proves a path absent (`.claude/rules/ssh-remote.md`). A wrong "absent" replaces a
 * resume with a fresh conversation, so every answer short of "looked everywhere, found nothing" must
 * read as no proof. What a user loses if it breaks: a host resume that either keeps printing "No
 * conversation found" (Sentry DESKTOP-2M, GitHub #970) or drops a conversation that was there.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proveClaudeConversationGoneOnHost } from '../../src/main/agent/adapters/claude/conversation-gone';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import type { SshCliPlace, SshPlaceFiles } from '../../src/main/agent/shared/cli-target';
import type { HostCommandRequest } from '../../src/main/remote/protocol/messages';

const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';
const FILE_NAME = `${AGENT_SESSION_ID}.jsonl`;

const folders: string[] = [];
afterEach(() => {
  const made = folders.splice(0);
  // A case may leave a folder it made unreadable, nested in another; give every one back before
  // removing any, so a parent's removal never meets a child it cannot read.
  for (const folder of made) {
    try { fs.chmodSync(folder, 0o755); } catch { /* the folder may already be gone */ }
  }
  for (const folder of made) fs.rmSync(folder, { recursive: true, force: true });
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-host-'));
  folders.push(home);
  return home;
}

/** A host whose helper runs commands through `/bin/sh` in `home`, with the environment given. */
function placeOn(home: string, env: Record<string, string> = {}): SshCliPlace & { files: SshPlaceFiles } {
  const runCommand = (request: HostCommandRequest) => runHostCommand(request, {
    shellPath: '/bin/sh',
    cwd: home,
    baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
  });
  return {
    kind: 'ssh',
    hostId: 'host-a',
    home,
    shellName: 'sh',
    localHome: path.join(home, 'mirror'),
    roots: [],
    files: { runCommand } as unknown as SshPlaceFiles,
  };
}

function projectFolder(root: string, slug: string): string {
  const folder = path.join(root, slug);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

describe.skipIf(process.platform === 'win32')('Claude\'s conversation, looked for on a POSIX host', () => {
  it('is gone when no project folder holds its file, in the folder the reported path names', async () => {
    const home = makeHome();
    const root = path.join(home, '.claude', 'projects');
    projectFolder(root, '-home-dev-api');
    fs.writeFileSync(path.join(projectFolder(root, '-home-dev-other'), 'another-conversation.jsonl'), '{}\n');

    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [path.join(root, '-home-dev-api', FILE_NAME)],
      place: placeOn(home),
    })).resolves.toBe(true);
  });

  it('is there when any project folder holds its file, a renamed project\'s included, or a link by its name', async () => {
    const home = makeHome();
    const root = path.join(home, '.claude', 'projects');
    projectFolder(root, '-home-dev-api');
    fs.writeFileSync(path.join(projectFolder(root, '-home-dev-api-renamed'), FILE_NAME), '{}\n');
    const reportedHostPaths = [path.join(root, '-home-dev-api', FILE_NAME)];

    await expect(proveClaudeConversationGoneOnHost({ agentSessionId: AGENT_SESSION_ID, reportedHostPaths, place: placeOn(home) })).resolves.toBe(false);

    fs.rmSync(path.join(root, '-home-dev-api-renamed', FILE_NAME));
    fs.symlinkSync(path.join(home, 'nowhere'), path.join(root, '-home-dev-api', FILE_NAME));
    await expect(proveClaudeConversationGoneOnHost({ agentSessionId: AGENT_SESSION_ID, reportedHostPaths, place: placeOn(home) })).resolves.toBe(false);
  });

  it('is no proof with no reported path, and searches the folder a reported path names whatever the environment says', async () => {
    const home = makeHome();
    const configRoot = path.join(home, 'claude-config', 'projects');
    fs.writeFileSync(path.join(projectFolder(configRoot, '-home-dev-api'), FILE_NAME), '{}\n');
    // The default folder is empty. The agent's real folder may be one the runner's environment does
    // not name (an rc file it skips), so an empty default must never read as gone.
    projectFolder(path.join(home, '.claude', 'projects'), '-home-dev-api');
    const unconfigured = placeOn(home);
    const runCommand = vi.spyOn(unconfigured.files, 'runCommand');

    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [],
      place: unconfigured,
    })).resolves.toBe(false);
    expect(runCommand).not.toHaveBeenCalled();

    // A reported path wins over the environment, which an `sh -lc` runner may not share with the agent.
    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [path.join(configRoot, '-home-dev-api', FILE_NAME)],
      place: placeOn(home),
    })).resolves.toBe(false);
    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [path.join(home, '.claude', 'projects', '-home-dev-api', FILE_NAME)],
      place: placeOn(home, { CLAUDE_CONFIG_DIR: path.join(home, 'claude-config') }),
    })).resolves.toBe(true);
  });

  it('is no proof when the projects folder is missing', async () => {
    const home = makeHome();

    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [path.join(home, '.claude', 'projects', '-home-dev-api', FILE_NAME)],
      place: placeOn(home),
    })).resolves.toBe(false);
  });

  // Root reads every folder whatever its mode, so the case means nothing there.
  it.skipIf(process.getuid?.() === 0)('is no proof when a project folder cannot be searched', async () => {
    const home = makeHome();
    const root = path.join(home, '.claude', 'projects');
    projectFolder(root, '-home-dev-api');
    const locked = projectFolder(root, '-home-dev-locked');
    fs.chmodSync(locked, 0o000);
    folders.push(locked);

    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [path.join(root, '-home-dev-api', FILE_NAME)],
      place: placeOn(home),
    })).resolves.toBe(false);
  });

  it('asks the host nothing for an id that is no plain name, or a reported path that climbs, names another file, or sits outside a projects folder', async () => {
    const home = makeHome();
    const place = placeOn(home);
    const runCommand = vi.spyOn(place.files, 'runCommand');

    await expect(proveClaudeConversationGoneOnHost({ agentSessionId: '../../etc/passwd', reportedHostPaths: [], place })).resolves.toBe(false);
    await expect(proveClaudeConversationGoneOnHost({ agentSessionId: '$(touch pwned)', reportedHostPaths: [], place })).resolves.toBe(false);
    await expect(proveClaudeConversationGoneOnHost({
      agentSessionId: AGENT_SESSION_ID,
      reportedHostPaths: [
        `/home/dev/../../tmp/x/${FILE_NAME}`,
        'relative/projects/x/other.jsonl',
        `/home/dev/.claude/projects/x/other.jsonl`,
        // Two levels up is `/home` and `/`: a scan there would answer absent for any id.
        `/home/dev/${FILE_NAME}`,
        `/${FILE_NAME}`,
      ],
      place,
    })).resolves.toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'pwned'))).toBe(false);
  });
});
