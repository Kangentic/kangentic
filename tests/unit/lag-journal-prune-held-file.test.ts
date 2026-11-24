/**
 * `pruneLaunches` when a journal file will not delete.
 *
 * A scanner or an editor can hold a file open (EBUSY on Windows). A real
 * locked file is not portable, since Linux unlinks an open file, so the
 * removal of one path is rejected through a partial mock of `node:fs/promises`
 * that passes every other call to the real module. It lives in its own file
 * because the mock applies to the whole module graph of the file it is in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const hoisted = vi.hoisted(() => ({ lockedPath: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (hoisted.lockedPath !== null && String(target) === hoisted.lockedPath) {
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.rm(target, options);
    },
  };
});

import { LAUNCH_FILE_SUFFIX, RUN_FILE_SUFFIX, launchIdOf } from '../../src/devtools/main/lag-journal';
import { pruneLaunches } from '../../src/devtools/main/lag-journal-reader';

describe('pruneLaunches with a file that will not delete', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-lag-prune-'));
  });

  afterEach(() => {
    hoisted.lockedPath = null;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('removes the other old launches, resolves, and leaves the held launch out of the ids it returns', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = launchIdOf(Date.UTC(2026, 10, 24, 4, index, 0), 100 + index);
      ids.push(id);
      fs.writeFileSync(path.join(directory, id + LAUNCH_FILE_SUFFIX), '');
      fs.writeFileSync(path.join(directory, id + RUN_FILE_SUFFIX), '');
    }
    // The second of the three launches past the keep line is the one held, so
    // a prune that gave up at it would also leave the third.
    hoisted.lockedPath = path.join(directory, ids[1] + LAUNCH_FILE_SUFFIX);

    const removed = await pruneLaunches(directory, 1);

    expect(removed).toEqual([ids[0], ids[2]]);
    expect(fs.readdirSync(directory).sort()).toEqual([
      ids[1] + LAUNCH_FILE_SUFFIX,
      ids[3] + RUN_FILE_SUFFIX,
      ids[3] + LAUNCH_FILE_SUFFIX,
    ].sort());
  });
});
