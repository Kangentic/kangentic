/**
 * The descriptor table probe (Sentry DESKTOP-59): its reading, the buckets that
 * are all a report ever carries, the run's peak, and the one report a run sends
 * when the table crosses the high mark. Driven with a fake open, so no test
 * depends on how many descriptors this process holds.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HIGH_MARK,
  DESCRIPTOR_KINDS,
  bucketDescriptorReading,
  bucketUptime,
  createDescriptorTableProbe,
  getDescriptorKindsContext,
  getDescriptorTableContext,
  getDescriptorTableReading,
  readDescriptorKinds,
  readLowestFreeDescriptor,
  refreshDescriptorKinds,
  resetDescriptorKindsCache,
  startDescriptorTableProbe,
  type DescriptorKindDeps,
  type DescriptorProbeDeps,
  type DescriptorReading,
} from '../../src/main/diagnostics/descriptor-table';

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: open failed`);
  error.code = code;
  return error;
}

function fakeDeps(open: DescriptorProbeDeps['open']): DescriptorProbeDeps & { close: ReturnType<typeof vi.fn> } {
  return { open, close: vi.fn(), devNull: 'null-device' };
}

describe('readLowestFreeDescriptor', () => {
  it('returns the descriptor it was given and closes it', () => {
    const deps = fakeDeps(() => 412);
    expect(readLowestFreeDescriptor(deps)).toBe(412);
    expect(deps.close).toHaveBeenCalledWith(412);
  });

  it('reads a full table when the open fails with EMFILE or ENFILE', () => {
    expect(readLowestFreeDescriptor(fakeDeps(() => { throw errnoError('EMFILE'); }))).toBe('full');
    expect(readLowestFreeDescriptor(fakeDeps(() => { throw errnoError('ENFILE'); }))).toBe('full');
  });

  it('reads unknown when the open fails for any other reason', () => {
    expect(readLowestFreeDescriptor(fakeDeps(() => { throw errnoError('ENOENT'); }))).toBeNull();
    expect(readLowestFreeDescriptor(fakeDeps(() => { throw new Error('no code'); }))).toBeNull();
  });

  it('keeps the reading when the close fails', () => {
    const deps: DescriptorProbeDeps = {
      open: () => 77,
      close: () => { throw errnoError('EBADF'); },
      devNull: 'null-device',
    };
    expect(readLowestFreeDescriptor(deps)).toBe(77);
  });

  it('reads a real descriptor number from the null device', () => {
    const reading = readLowestFreeDescriptor();
    expect(typeof reading).toBe('number');
  });
});

describe('bucketDescriptorReading', () => {
  it.each<[DescriptorReading, string]>([
    [0, '<64'],
    [63, '<64'],
    [64, '64-255'],
    [255, '64-255'],
    [256, '256-1023'],
    [1023, '256-1023'],
    [1024, '1024-2047'],
    [2047, '1024-2047'],
    [2048, '2048-4095'],
    [4095, '2048-4095'],
    [4096, '4096-8191'],
    [8191, '4096-8191'],
    [8192, '8192+'],
    [20000, '8192+'],
    ['full', 'full'],
    [null, 'unknown'],
  ])('buckets %s as %s', (reading, bucket) => {
    expect(bucketDescriptorReading(reading)).toBe(bucket);
  });
});

describe('bucketUptime', () => {
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  it.each<[number, string]>([
    [0, '<10m'],
    [10 * minute - 1, '<10m'],
    [10 * minute, '10m-1h'],
    [hour, '1-4h'],
    [4 * hour, '4-12h'],
    [12 * hour, '12-24h'],
    [day, '1-3d'],
    [3 * day, '3d+'],
  ])('buckets %s seconds as %s', (seconds, bucket) => {
    expect(bucketUptime(seconds)).toBe(bucket);
  });
});

describe('createDescriptorTableProbe', () => {
  function scriptedProbe(readings: DescriptorReading[], onHigh = vi.fn()) {
    let index = 0;
    const probe = createDescriptorTableProbe({
      read: () => readings[index++] ?? null,
      uptimeSeconds: () => 5 * 3600,
      onHigh,
    });
    return { probe, onHigh };
  }

  it('keeps the latest reading and the highest one of the run', () => {
    const { probe } = scriptedProbe([300, 900, 120, null]);
    probe.tick();
    probe.tick();
    probe.tick();
    expect(probe.reading()).toEqual({ latest: 120, peak: 900 });
    probe.tick();
    expect(probe.reading()).toEqual({ latest: null, peak: 900 });
  });

  it('ranks a full table above any count', () => {
    const { probe } = scriptedProbe([9000, 'full', 50]);
    probe.tick();
    probe.tick();
    probe.tick();
    expect(probe.reading().peak).toBe('full');
  });

  it('reports once, at the first reading that reaches the high mark', () => {
    const { probe, onHigh } = scriptedProbe([DEFAULT_HIGH_MARK - 1, DEFAULT_HIGH_MARK, 100, 5000, 'full']);
    probe.tick();
    expect(onHigh).not.toHaveBeenCalled();
    probe.tick();
    expect(onHigh).toHaveBeenCalledTimes(1);
    expect(onHigh).toHaveBeenCalledWith({
      descriptor_latest: '2048-4095',
      descriptor_peak: '2048-4095',
      uptime: '4-12h',
      pty_host_in_main: 'false',
    });
    probe.tick();
    probe.tick();
    probe.tick();
    expect(onHigh).toHaveBeenCalledTimes(1);
  });

  it('reports a full table on first sight', () => {
    const { probe, onHigh } = scriptedProbe(['full']);
    probe.tick();
    expect(onHigh).toHaveBeenCalledTimes(1);
    expect(onHigh.mock.calls[0][0]).toMatchObject({ descriptor_latest: 'full', descriptor_peak: 'full' });
  });

  it('never reports a run that stays under the high mark', () => {
    const { probe, onHigh } = scriptedProbe([10, 400, 2047, null]);
    for (let tick = 0; tick < 4; tick += 1) probe.tick();
    expect(onHigh).not.toHaveBeenCalled();
  });

  // A breakdown costs one read per descriptor, so it is taken only while the
  // table is high, and always before the report, so the report finds it kept.
  it('reads the breakdown on every reading at or above the mark, before the report, and never below it', () => {
    const order: string[] = [];
    let index = 0;
    const readings: DescriptorReading[] = [100, DEFAULT_HIGH_MARK - 1, DEFAULT_HIGH_MARK, 3000, 200];
    const probe = createDescriptorTableProbe({
      read: () => readings[index++] ?? null,
      uptimeSeconds: () => 0,
      readKinds: () => order.push('kinds'),
      onHigh: () => order.push('report'),
    });
    for (let tick = 0; tick < readings.length; tick += 1) probe.tick();
    expect(order).toEqual(['kinds', 'report', 'kinds']);
  });
});

// Sentry DESKTOP-5W: a Linux install's table passed 2048 after a day, and the
// report said nothing about what it held. These run the readers on scripted
// listings, so they pass on every OS.
describe('readDescriptorKinds', () => {
  function linuxDeps(links: Record<string, string | Error>): DescriptorKindDeps {
    return {
      platform: 'linux',
      listDirectory: (directoryPath) => {
        expect(directoryPath).toBe('/proc/self/fd');
        return Object.keys(links);
      },
      readLink: (linkPath) => {
        const target = links[linkPath.slice('/proc/self/fd/'.length)];
        if (target instanceof Error) throw target;
        return target;
      },
      statDescriptor: () => { throw new Error('not on Linux'); },
    };
  }

  /** 3,000 sockets, 40 files, and a few of every other kind, as a socket leak would leave. */
  function leakingSocketsListing(): Record<string, string | Error> {
    const links: Record<string, string | Error> = {};
    let descriptor = 0;
    const add = (target: string | Error, count = 1): void => {
      for (let copy = 0; copy < count; copy++) links[String(descriptor++)] = target;
    };
    add('socket:[48213]', 3000);
    add('/home/dev/projects/secret-client/.kangentic/config.json', 40);
    add('pipe:[9912]', 70);
    add('anon_inode:[eventfd]', 12);
    add('anon_inode:[eventpoll]', 3);
    add('anon_inode:inotify', 1);
    add('anon_inode:[timerfd]', 2);
    add('/memfd:v8-heap (deleted)');
    add('/dev/shm/.org.chromium.Chromium.abc123');
    add('/dev/null', 2);
    add('/dev/pts/3');
    add('net:[4026531840]');
    add(errnoError('ENOENT'));
    return links;
  }

  it('counts each Linux descriptor by its link and skips one that closed during the read', () => {
    expect(readDescriptorKinds(linuxDeps(leakingSocketsListing()))).toEqual({
      socket: 3000,
      pipe: 70,
      eventfd: 12,
      epoll: 3,
      inotify: 1,
      anon_other: 2,
      memfd_shm: 2,
      file: 40,
      char_device: 3,
      other: 1,
    });
  });

  it('buckets each kind in the report context, with no path or link text in it', () => {
    resetDescriptorKindsCache();
    const context = getDescriptorKindsContext(() => readDescriptorKinds(linuxDeps(leakingSocketsListing())), 'linux');
    expect(context).toMatchObject({
      kind_socket: '2048-4095',
      kind_file: '<64',
      kind_pipe: '64-255',
      kind_eventfd: '<64',
      kind_other: '<64',
      source: 'fresh',
    });
    expect(Object.keys(context ?? {}).sort()).toEqual([
      ...DESCRIPTOR_KINDS.map((kind) => `kind_${kind}`),
      'kinds_at',
      'source',
    ].sort());
    const sent = JSON.stringify(context);
    expect(sent).not.toMatch(/\//);
    expect(sent).not.toMatch(/secret-client|socket:\[|anon_inode|v8-heap|chromium|pts/i);
  });

  it('counts each macOS descriptor by what fstat says it is', () => {
    const stat = (kind: 'socket' | 'fifo' | 'char' | 'file' | 'directory') => ({
      isSocket: () => kind === 'socket',
      isFIFO: () => kind === 'fifo',
      isCharacterDevice: () => kind === 'char',
      isFile: () => kind === 'file',
    });
    const table = { 0: 'char', 1: 'char', 3: 'socket', 4: 'socket', 5: 'fifo', 6: 'file', 7: 'directory' } as const;
    const deps: DescriptorKindDeps = {
      platform: 'darwin',
      listDirectory: (directoryPath) => {
        expect(directoryPath).toBe('/dev/fd');
        return [...Object.keys(table), '9'];
      },
      readLink: () => { throw new Error('not on macOS'); },
      statDescriptor: (descriptor) => {
        const kind = table[descriptor as keyof typeof table];
        if (!kind) throw errnoError('EBADF');
        return stat(kind);
      },
    };
    expect(readDescriptorKinds(deps)).toMatchObject({ socket: 2, pipe: 1, char_device: 2, file: 1, other: 1, eventfd: 0 });
  });

  it('has no breakdown on Windows, whose probe counts C runtime descriptors only', () => {
    const listDirectory = vi.fn(() => []);
    expect(readDescriptorKinds({ platform: 'win32', listDirectory, readLink: vi.fn(), statDescriptor: vi.fn() })).toBeNull();
    expect(listDirectory).not.toHaveBeenCalled();
    expect(getDescriptorKindsContext(() => ({ ...emptyCounts(), socket: 9 }), 'win32')).toBeNull();
  });

  // Listing a directory takes a descriptor, so at EMFILE the fresh read fails
  // exactly when the report matters most.
  it('falls back to the breakdown kept while the table was high once a full table cannot list itself', () => {
    resetDescriptorKindsCache();
    const full = (): null => readDescriptorKinds({
      platform: 'linux',
      listDirectory: () => { throw errnoError('EMFILE'); },
      readLink: vi.fn(),
      statDescriptor: vi.fn(),
    });
    expect(getDescriptorKindsContext(full, 'linux')).toMatchObject({ kind_socket: 'unknown', source: 'unavailable' });

    refreshDescriptorKinds(() => ({ ...emptyCounts(), socket: 7000, file: 30 }), 26 * 3600);
    expect(getDescriptorKindsContext(full, 'linux')).toMatchObject({
      kind_socket: '4096-8191',
      kind_file: '<64',
      kinds_at: '1-3d',
      source: 'cached',
    });
  });

  function emptyCounts(): Record<(typeof DESCRIPTOR_KINDS)[number], number> {
    return Object.fromEntries(DESCRIPTOR_KINDS.map((kind) => [kind, 0])) as Record<(typeof DESCRIPTOR_KINDS)[number], number>;
  }
});

describe('startDescriptorTableProbe', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it('takes its first reading at start, exposes it, and forgets it once stopped', () => {
    expect(getDescriptorTableReading()).toBeNull();
    stop = startDescriptorTableProbe({ onHigh: vi.fn() });
    const reading = getDescriptorTableReading();
    expect(typeof reading?.latest).toBe('number');
    stop();
    stop = null;
    expect(getDescriptorTableReading()).toBeNull();
  });

  it('gives an EMFILE report the running probe buckets and a fresh reading', () => {
    stop = startDescriptorTableProbe({ onHigh: vi.fn() });
    const context = getDescriptorTableContext(() => 'full');
    expect(context.at_report).toBe('full');
    expect(context.descriptor_latest).not.toBe('unknown');
    expect(context.descriptor_peak).not.toBe('unknown');
  });
});

describe('markPtyHostRunningInMain', () => {
  // The mark is one-way for the run, as it is in the app, so this test sets it
  // on a fresh copy of the module and leaves the one the other tests use alone.
  it('turns the pty_host_in_main tag on for every later report', async () => {
    vi.resetModules();
    const freshModule = await import('../../src/main/diagnostics/descriptor-table');
    const probe = freshModule.createDescriptorTableProbe({ read: () => 10, uptimeSeconds: () => 0 });
    expect(probe.tags().pty_host_in_main).toBe('false');
    freshModule.markPtyHostRunningInMain();
    expect(probe.tags().pty_host_in_main).toBe('true');
    expect(freshModule.getDescriptorTableContext(() => 10).pty_host_in_main).toBe('true');
    expect(createDescriptorTableProbe({ read: () => 10, uptimeSeconds: () => 0 }).tags().pty_host_in_main).toBe('false');
  });
});

// `src/main/index.ts` boots the app on import, so it is read as text, as the
// repo does for the other wiring no test can import (test-value.md).
describe('the probe in src/main/index.ts', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf-8');

  it('starts with the high-mark reporter, so a crossing is reported once', () => {
    expect(indexSource).toMatch(/startDescriptorTableProbe\(\s*\{\s*onHigh:\s*reportDescriptorTableHigh\s*\}\s*\)/);
  });

  it('stops inside clearPendingTimers, so no tick fires mid-shutdown', () => {
    const start = indexSource.indexOf('clearPendingTimers: () => {');
    expect(start).toBeGreaterThan(-1);
    // The callback ends at the first line closing a 4-space-indented property.
    const end = indexSource.slice(start).search(/\n {4}\},?\n/);
    expect(end).toBeGreaterThan(-1);
    const callbackBody = indexSource.slice(start, start + end);
    expect(callbackBody).toMatch(/stopDescriptorTableProbe\(\)/);
  });
});
