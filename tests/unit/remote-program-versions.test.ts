/**
 * The versions of the helper installed on a host (#913): listing the complete ones, pruning the old ones, and
 * what the helper answers for `programInfo` and `pruneVersions`.
 *
 * What a user loses if it breaks: a host that keeps every release's copy of Node forever, or, worse, a prune
 * that removes the version the running program or another computer on the account still uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listInstalledVersions, pruneOldVersions } from '../../src/main/remote/helper/program-versions';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { dialHelper, makeHelperRig, settle } from './helpers/remote-link-rig';

const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;

function install(version: string, ageDays: number, options: { complete?: boolean } = {}): void {
  const directory = path.join(root, version);
  fs.mkdirSync(directory, { recursive: true });
  if (options.complete === false) return;
  const marker = path.join(directory, '.complete');
  fs.writeFileSync(marker, '');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(marker, when, when);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-versions-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listing installed versions', () => {
  it('lists complete versions oldest first and skips run, a partial install and a folder with no marker', async () => {
    install('0.53.0', 1);
    install('0.51.0', 40);
    install('0.52.0', 10);
    fs.mkdirSync(path.join(root, 'run'));
    fs.mkdirSync(path.join(root, '0.54.0.partial'));
    fs.mkdirSync(path.join(root, '0.54.0.upload'));
    install('0.50.0', 0, { complete: false });
    expect((await listInstalledVersions(root)).map((installed) => installed.version)).toEqual(['0.51.0', '0.52.0', '0.53.0']);
  });

  it('lists nothing when the folder is not there', async () => {
    expect(await listInstalledVersions(path.join(root, 'absent'))).toEqual([]);
  });
});

describe('pruning old versions', () => {
  it('removes a complete version past the age and leaves a newer one, a kept one and anything unfinished', async () => {
    install('0.49.0', 90);
    install('0.50.0', 45);
    install('0.51.0', 40);
    install('0.52.0', 5);
    install('0.53.0', 60);
    fs.mkdirSync(path.join(root, '0.54.0.partial'));
    fs.mkdirSync(path.join(root, 'run'));

    const removed = await pruneOldVersions({ root, keep: new Set(['0.53.0']), olderThanDays: 30, nowMs: Date.now() });

    expect(removed.sort()).toEqual(['0.49.0', '0.50.0', '0.51.0']);
    expect(fs.readdirSync(root).sort()).toEqual(['0.52.0', '0.53.0', '0.54.0.partial', 'run']);
  });

  it('removes nothing when every version is within the age', async () => {
    install('0.52.0', 3);
    install('0.53.0', 1);
    expect(await pruneOldVersions({ root, keep: new Set(), olderThanDays: 30, nowMs: Date.now() })).toEqual([]);
  });
});

describe('the helper\'s programInfo and pruneVersions requests', () => {
  const teardown: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const undo of teardown.splice(0)) undo();
    vi.useRealTimers();
  });

  function connect(programDirectory: string | undefined): RemoteLink {
    const helperRig = makeHelperRig(1, {
      homeDirectory: root,
      baseEnv: { HOME: '/home/dev', SHELL: '/bin/sh', PATH: '/usr/bin' },
      ...(programDirectory ? { programDirectory } : {}),
    });
    const link = new RemoteLink({
      identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
      connect: async () => dialHelper(helperRig),
      reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
    });
    link.start();
    teardown.push(() => link.stop(), () => helperRig.helper.dispose());
    return link;
  }

  /** The helper's file reads are real I/O, which fake timers do not advance: wait on the answer itself. */
  async function answered<T>(promise: Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await settle();
      const outcome = await Promise.race([promise.then((value) => ({ value })), new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
      if (outcome) return outcome.value;
    }
    throw new Error('the helper never answered');
  }

  it('reports the running version, how many terminals are live and the versions on the host', async () => {
    install('0.52.0', 10);
    install('0.53.0', 1);
    const link = connect(path.join(root, '0.53.0'));
    const info = await answered(link.requestHelper('programInfo', {}));
    expect(info.version).toBe('0.53.0');
    expect(info.liveSessions).toBe(0);
    expect(info.installedVersions).toEqual(['0.52.0', '0.53.0']);
    expect(new Date(info.startedAt).toString()).not.toBe('Invalid Date');
  });

  it('reports no version for a run that is not from an install', async () => {
    const link = connect(undefined);
    const info = await answered(link.requestHelper('programInfo', {}));
    expect(info.version).toBeNull();
    expect(info.installedVersions).toEqual([]);
  });

  it('prunes old versions but never the running one, whatever keep says', async () => {
    install('0.50.0', 90);
    install('0.51.0', 80);
    install('0.53.0', 90);
    const link = connect(path.join(root, '0.53.0'));
    const result = await answered(link.requestHelper('pruneVersions', { keep: [], olderThanDays: 30 }));
    expect(result.removed.sort()).toEqual(['0.50.0', '0.51.0']);
    expect(fs.existsSync(path.join(root, '0.53.0'))).toBe(true);
  });

  it('prunes nothing when the program is not running from an install', async () => {
    install('0.50.0', 90);
    const link = connect(undefined);
    expect(await answered(link.requestHelper('pruneVersions', { keep: [], olderThanDays: 30 }))).toEqual({ removed: [] });
    expect(fs.existsSync(path.join(root, '0.50.0'))).toBe(true);
  });
});
