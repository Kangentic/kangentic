/**
 * Spare worktrees (#958): the pool's small on-disk state, tested on its own.
 *
 * A spare's ready record, the no-saving finding, the input comparison a claim
 * relies on, the folder-name test and the record-file pass of the startup
 * sweep. All of it is plain files under a temp project directory. No git repo
 * is needed: every sweep here has no spare folder for its first loop to
 * discard (a spare folder is planted only when a matching record keeps it, when
 * a task names it, or when the test holds it), so git never runs.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NO_SAVING_RATIO,
  SpareWorktreePool,
  isSpareWorktreeFolder,
  readNoSavingVerdict,
  readSpareRecord,
  spareInputsMatch,
  spareRecordsRootFor,
  writeSpareRecord,
  type SpareInputs,
  type SpareRecord,
} from '../../src/main/git/spare-worktree';
import { worktreesRootFor } from '../../src/main/git/task-worktree-folder';
import { tryHoldWorktreeCreation } from '../../src/main/git/worktree-creation-registry';

let temporaryRoot: string;
let projectPath: string;
let projectCounter = 0;

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-records-'));
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

beforeEach(() => {
  projectCounter += 1;
  projectPath = path.join(temporaryRoot, `project-${projectCounter}`);
  fs.mkdirSync(projectPath, { recursive: true });
  // The pool logs each decision. Keep the run quiet; a test that cares reads the spy.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_SAVING_FILE = 'no-saving.json';

function recordsRoot(): string {
  return spareRecordsRootFor(projectPath);
}

function plantRecordsFile(fileName: string, contents: string): string {
  fs.mkdirSync(recordsRoot(), { recursive: true });
  const filePath = path.join(recordsRoot(), fileName);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function sampleInputs(): SpareInputs {
  return {
    baseBranch: 'main',
    initScript: 'pnpm install --frozen-lockfile',
    linkNodeModules: false,
    copyFiles: ['.env', '.npmrc'],
  };
}

function sampleRecord(folder: string, overrides: Partial<SpareRecord> = {}): SpareRecord {
  return {
    ...sampleInputs(),
    folder,
    builtAt: '2026-10-31T12:00:00.000Z',
    installMs: 27_500,
    ...overrides,
  };
}

function sampleVerdict(): Record<string, unknown> {
  return {
    initScript: 'npm ci',
    buildInstallMs: 30_000,
    catchUpMs: 28_000,
    decidedAt: '2026-10-31T12:00:00.000Z',
  };
}

type FieldMutation = { label: string; mutate: (fields: Record<string, unknown>) => void };

function missing(field: string): FieldMutation {
  return { label: `${field} is missing`, mutate: (fields) => { delete fields[field]; } };
}

function mistyped(field: string, value: unknown): FieldMutation {
  return { label: `${field} is ${JSON.stringify(value)}`, mutate: (fields) => { fields[field] = value; } };
}

function recordFileNames(): string[] {
  return fs.readdirSync(recordsRoot()).sort();
}

describe('isSpareWorktreeFolder', () => {
  it.each(['spare_0a1b2c3d', 'spare_deadbeef', 'spare_00000000'])('is true for %s', (name) => {
    expect(isSpareWorktreeFolder(name)).toBe(true);
  });

  it.each([
    ['a display number', '958'],
    ['a legacy slug and id folder', 'fix-login-0a1b2c3d'],
    ['seven hex digits', 'spare_0a1b2c3'],
    ['nine hex digits', 'spare_0a1b2c3d4'],
    ['uppercase hex', 'spare_0A1B2C3D'],
    ['a non-hex character', 'spare_0a1b2c3g'],
    ['a dash prefix', 'spare-0a1b2c3d'],
    ['text before the prefix', 'xspare_0a1b2c3d'],
    ['text after the digits', 'spare_0a1b2c3d.json'],
    ['the bare prefix', 'spare_'],
  ])('is false for %s', (_label, name) => {
    expect(isSpareWorktreeFolder(name)).toBe(false);
  });
});

describe('spareRecordsRootFor', () => {
  it('is the spare-worktrees folder under the project .kangentic folder', () => {
    expect(spareRecordsRootFor(projectPath)).toBe(path.join(projectPath, '.kangentic', 'spare-worktrees'));
  });
});

describe('spareInputsMatch', () => {
  it('is true for equal inputs, and ignores the record fields that are not inputs', () => {
    expect(spareInputsMatch(sampleInputs(), sampleInputs())).toBe(true);
    expect(spareInputsMatch(sampleRecord('spare_0a1b2c3d'), sampleInputs())).toBe(true);
  });

  it('is true for two empty copy lists', () => {
    expect(spareInputsMatch({ ...sampleInputs(), copyFiles: [] }, { ...sampleInputs(), copyFiles: [] })).toBe(true);
  });

  it.each<[string, Partial<SpareInputs>]>([
    ['baseBranch', { baseBranch: 'develop' }],
    ['initScript', { initScript: 'npm ci' }],
    ['linkNodeModules', { linkNodeModules: true }],
    ['copyFiles with an entry fewer', { copyFiles: ['.env'] }],
    ['copyFiles with an entry more', { copyFiles: ['.env', '.npmrc', '.tool-versions'] }],
    ['copyFiles in another order', { copyFiles: ['.npmrc', '.env'] }],
    ['copyFiles with another entry', { copyFiles: ['.env', '.yarnrc'] }],
  ])('is false when only %s differs', (_label, difference) => {
    expect(spareInputsMatch(sampleInputs(), { ...sampleInputs(), ...difference })).toBe(false);
  });

  it('is false when the record lists fewer copy files than the inputs, whose entries it repeats', () => {
    // Walking only the record's own entries would call this a match.
    expect(spareInputsMatch({ ...sampleInputs(), copyFiles: ['.env'] }, { ...sampleInputs(), copyFiles: ['.env', '.npmrc'] })).toBe(false);
  });
});

describe('writeSpareRecord and readSpareRecord', () => {
  it('reads back the record that was written', async () => {
    const record = sampleRecord('spare_0a1b2c3d');
    await writeSpareRecord(projectPath, record);
    expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toEqual(record);
  });

  it('keeps a null installMs, and a zero one', async () => {
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3d', { installMs: null }));
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3e', { installMs: 0 }));
    expect((await readSpareRecord(projectPath, 'spare_0a1b2c3d'))?.installMs).toBeNull();
    expect((await readSpareRecord(projectPath, 'spare_0a1b2c3e'))?.installMs).toBe(0);
  });

  it('writes the record to <folder>.json under the records folder, creating the folder', async () => {
    expect(fs.existsSync(recordsRoot())).toBe(false);
    const record = sampleRecord('spare_0a1b2c3d');
    await writeSpareRecord(projectPath, record);
    const onDisk: unknown = JSON.parse(fs.readFileSync(path.join(recordsRoot(), 'spare_0a1b2c3d.json'), 'utf8'));
    expect(onDisk).toEqual(record);
  });

  it('leaves no temp file behind, and replaces an earlier record of the same folder', async () => {
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3d'));
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3d', { baseBranch: 'develop' }));
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3e'));
    expect(recordFileNames()).toEqual(['spare_0a1b2c3d.json', 'spare_0a1b2c3e.json']);
    expect((await readSpareRecord(projectPath, 'spare_0a1b2c3d'))?.baseBranch).toBe('develop');
  });

  describe('installMs that is not a number', () => {
    it.each([
      missing('installMs'),
      mistyped('installMs', '27500'),
      mistyped('installMs', null),
      mistyped('installMs', true),
    ])('reads as null when $label', async ({ mutate }) => {
      const fields: Record<string, unknown> = { ...sampleRecord('spare_0a1b2c3d') };
      mutate(fields);
      plantRecordsFile('spare_0a1b2c3d.json', JSON.stringify(fields));
      const record = await readSpareRecord(projectPath, 'spare_0a1b2c3d');
      expect(record).not.toBeNull();
      expect(record?.installMs).toBeNull();
    });
  });

  describe('a record that is not usable reads as null', () => {
    it('when there is no record file', async () => {
      expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toBeNull();
    });

    it('when the records folder holds only other spares', async () => {
      await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3e'));
      expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toBeNull();
    });

    it.each([
      ['invalid JSON', '{"folder": "spare_0a1b2c3d", '],
      ['an empty file', ''],
      ['the JSON null', 'null'],
      ['a JSON string', '"spare_0a1b2c3d"'],
      ['a JSON number', '7'],
      ['a JSON array', '[]'],
    ])('when the file holds %s', async (_label, contents) => {
      plantRecordsFile('spare_0a1b2c3d.json', contents);
      expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toBeNull();
    });

    it('when the record names another folder than its file does', async () => {
      plantRecordsFile('spare_0a1b2c3d.json', JSON.stringify(sampleRecord('spare_0a1b2c3e')));
      expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toBeNull();
    });

    it.each([
      missing('folder'),
      mistyped('folder', 7),
      missing('baseBranch'),
      mistyped('baseBranch', 7),
      missing('initScript'),
      mistyped('initScript', ['pnpm', 'install']),
      missing('linkNodeModules'),
      mistyped('linkNodeModules', 'true'),
      mistyped('linkNodeModules', 1),
      missing('copyFiles'),
      mistyped('copyFiles', '.env'),
      mistyped('copyFiles', ['.env', 7]),
      mistyped('copyFiles', { 0: '.env' }),
      missing('builtAt'),
      mistyped('builtAt', 1_761_912_000_000),
    ])('when $label', async ({ mutate }) => {
      const fields: Record<string, unknown> = { ...sampleRecord('spare_0a1b2c3d') };
      mutate(fields);
      plantRecordsFile('spare_0a1b2c3d.json', JSON.stringify(fields));
      expect(await readSpareRecord(projectPath, 'spare_0a1b2c3d')).toBeNull();
    });
  });
});

describe('readNoSavingVerdict', () => {
  it('returns the finding on disk', async () => {
    plantRecordsFile(NO_SAVING_FILE, JSON.stringify(sampleVerdict()));
    expect(await readNoSavingVerdict(projectPath)).toEqual(sampleVerdict());
  });

  it('returns null when there is no finding', async () => {
    expect(await readNoSavingVerdict(projectPath)).toBeNull();
  });

  it.each([
    ['invalid JSON', '{"initScript": "npm ci", '],
    ['an empty file', ''],
    ['the JSON null', 'null'],
    ['a JSON string', '"npm ci"'],
    ['a JSON array', '[]'],
  ])('returns null when the file holds %s', async (_label, contents) => {
    plantRecordsFile(NO_SAVING_FILE, contents);
    expect(await readNoSavingVerdict(projectPath)).toBeNull();
  });

  it.each([
    missing('initScript'),
    mistyped('initScript', 7),
    missing('buildInstallMs'),
    mistyped('buildInstallMs', '30000'),
    missing('catchUpMs'),
    mistyped('catchUpMs', '28000'),
    missing('decidedAt'),
    mistyped('decidedAt', 1_761_912_000_000),
  ])('returns null when $label', async ({ mutate }) => {
    const fields = sampleVerdict();
    mutate(fields);
    plantRecordsFile(NO_SAVING_FILE, JSON.stringify(fields));
    expect(await readNoSavingVerdict(projectPath)).toBeNull();
  });
});

describe('SpareWorktreePool.noteCatchUp', () => {
  const buildInstallMs = 30_000;
  // Half of the install, written out so the tests below do not follow the constant.
  const boundaryMs = 15_000;
  const verdictPath = (): string => path.join(recordsRoot(), NO_SAVING_FILE);

  it('counts a catch-up of half the install as saving nothing', () => {
    expect(NO_SAVING_RATIO).toBe(0.5);
    expect(buildInstallMs * NO_SAVING_RATIO).toBe(boundaryMs);
  });

  it('records the finding when the catch-up took more than the ratio of the install', async () => {
    const before = Date.now();
    await new SpareWorktreePool().noteCatchUp(projectPath, 'npm ci', buildInstallMs, buildInstallMs);
    const after = Date.now();

    const verdict = await readNoSavingVerdict(projectPath);
    expect(verdict).not.toBeNull();
    expect(verdict?.initScript).toBe('npm ci');
    expect(verdict?.buildInstallMs).toBe(buildInstallMs);
    expect(verdict?.catchUpMs).toBe(buildInstallMs);
    const decidedAt = verdict?.decidedAt ?? '';
    expect(new Date(decidedAt).toISOString()).toBe(decidedAt);
    expect(Date.parse(decidedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(decidedAt)).toBeLessThanOrEqual(after);
  });

  it('records the finding when the catch-up took exactly the ratio of the install', async () => {
    await new SpareWorktreePool().noteCatchUp(projectPath, 'npm ci', boundaryMs, buildInstallMs);
    expect(fs.existsSync(verdictPath())).toBe(true);
    expect((await readNoSavingVerdict(projectPath))?.catchUpMs).toBe(boundaryMs);
  });

  it('records nothing when the catch-up took just under the ratio of the install', async () => {
    await new SpareWorktreePool().noteCatchUp(projectPath, 'pnpm install', boundaryMs - 1, buildInstallMs);
    expect(fs.existsSync(verdictPath())).toBe(false);
  });

  it('records nothing for a catch-up that took a small share of the install', async () => {
    await new SpareWorktreePool().noteCatchUp(projectPath, 'pnpm install', 3_500, buildInstallMs);
    expect(await readNoSavingVerdict(projectPath)).toBeNull();
  });

  it('deletes an existing finding when a later catch-up is under the ratio', async () => {
    const pool = new SpareWorktreePool();
    await pool.noteCatchUp(projectPath, 'npm ci', buildInstallMs, buildInstallMs);
    expect(await readNoSavingVerdict(projectPath)).not.toBeNull();

    await pool.noteCatchUp(projectPath, 'npm ci', boundaryMs - 1, buildInstallMs);
    expect(fs.existsSync(verdictPath())).toBe(false);
    expect(await readNoSavingVerdict(projectPath)).toBeNull();
  });

  it('replaces the finding of another init script, and leaves no temp file behind', async () => {
    const pool = new SpareWorktreePool();
    await pool.noteCatchUp(projectPath, 'npm ci', buildInstallMs, buildInstallMs);
    await pool.noteCatchUp(projectPath, 'yarn install --immutable', boundaryMs + 1_000, 24_000);

    const verdict = await readNoSavingVerdict(projectPath);
    expect(verdict?.initScript).toBe('yarn install --immutable');
    expect(verdict?.buildInstallMs).toBe(24_000);
    expect(verdict?.catchUpMs).toBe(boundaryMs + 1_000);
    expect(recordFileNames()).toEqual([NO_SAVING_FILE]);
  });

  it('does not touch a spare record when it writes or deletes the finding', async () => {
    const pool = new SpareWorktreePool();
    await writeSpareRecord(projectPath, sampleRecord('spare_0a1b2c3d'));
    await pool.noteCatchUp(projectPath, 'npm ci', buildInstallMs, buildInstallMs);
    await pool.noteCatchUp(projectPath, 'npm ci', 0, buildInstallMs);
    expect(recordFileNames()).toEqual(['spare_0a1b2c3d.json']);
  });

  describe('when the spare has no usable install time', () => {
    it.each<[string, number | null]>([
      ['null', null],
      ['zero', 0],
      ['negative', -1],
    ])('changes nothing for a build install time that is %s', async (_label, unusableInstallMs) => {
      const pool = new SpareWorktreePool();

      // A catch-up that would record a finding creates none ...
      await pool.noteCatchUp(projectPath, 'npm ci', 99_999, unusableInstallMs);
      expect(fs.existsSync(recordsRoot())).toBe(false);

      // ... and one that would clear a finding leaves an existing one in place.
      plantRecordsFile(NO_SAVING_FILE, JSON.stringify(sampleVerdict()));
      await pool.noteCatchUp(projectPath, 'npm ci', 0, unusableInstallMs);
      expect(await readNoSavingVerdict(projectPath)).toEqual(sampleVerdict());
    });
  });

  describe('never rejects', () => {
    beforeEach(() => {
      // A regular file where the project's .kangentic folder belongs, so the
      // records folder can be neither created nor read on any platform.
      fs.writeFileSync(path.join(projectPath, '.kangentic'), 'not a folder');
    });

    it('when the finding cannot be written, and logs why', async () => {
      await expect(new SpareWorktreePool().noteCatchUp(projectPath, 'npm ci', buildInstallMs, buildInstallMs)).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('Could not record');
    });

    it('when the finding cannot be deleted', async () => {
      // Some platforms report the missing path and a forced delete swallows it, so
      // this pins only that the call resolves.
      await expect(new SpareWorktreePool().noteCatchUp(projectPath, 'npm ci', 0, buildInstallMs)).resolves.toBeUndefined();
    });
  });
});

describe('SpareWorktreePool.sweep, the record-file pass', () => {
  const nothingReferenced = (): ReadonlySet<string> => new Set<string>();

  function plantSpareFolder(folder: string): string {
    const folderPath = path.join(worktreesRootFor(projectPath), folder);
    fs.mkdirSync(folderPath, { recursive: true });
    return folderPath;
  }

  it('resolves when the project has no records folder at all', async () => {
    await expect(new SpareWorktreePool().sweep(projectPath, null, nothingReferenced)).resolves.toBeUndefined();
  });

  it('deletes a record whose folder is gone and a temp file a quit left, and keeps the no-saving finding', async () => {
    plantRecordsFile('spare_deadbeef.json', JSON.stringify(sampleRecord('spare_deadbeef')));
    plantRecordsFile('spare_c0ffee01.json.abc123.tmp', '{"folder": "spare_c0ffee01"');
    plantRecordsFile(NO_SAVING_FILE, JSON.stringify(sampleVerdict()));
    plantRecordsFile('other-notes.json', '{}');

    await new SpareWorktreePool().sweep(projectPath, null, nothingReferenced);

    expect(recordFileNames()).toEqual(['no-saving.json', 'other-notes.json']);
    expect(await readNoSavingVerdict(projectPath)).toEqual(sampleVerdict());
  });

  it('deletes a record file whose name is not a spare folder, even beside a folder of that name', async () => {
    const lookalikeFolder = plantSpareFolder('spare_zzzzzzzz');
    plantRecordsFile('spare_zzzzzzzz.json', JSON.stringify(sampleRecord('spare_zzzzzzzz')));

    await new SpareWorktreePool().sweep(projectPath, null, nothingReferenced);

    expect(fs.existsSync(path.join(recordsRoot(), 'spare_zzzzzzzz.json'))).toBe(false);
    // The pool never discards a folder that is not a spare's.
    expect(fs.existsSync(lookalikeFolder)).toBe(true);
  });

  it('deletes the record of a folder a task names, and leaves that folder alone', async () => {
    const adoptedFolder = plantSpareFolder('spare_5ca1ab1e');
    plantRecordsFile('spare_5ca1ab1e.json', JSON.stringify(sampleRecord('spare_5ca1ab1e')));
    const referencedFolders = vi.fn((): ReadonlySet<string> => new Set(['spare_5ca1ab1e']));

    await new SpareWorktreePool().sweep(projectPath, sampleInputs(), referencedFolders);

    expect(referencedFolders).toHaveBeenCalled();
    expect(fs.existsSync(path.join(recordsRoot(), 'spare_5ca1ab1e.json'))).toBe(false);
    expect(fs.existsSync(adoptedFolder)).toBe(true);
  });

  it('keeps the record of a live spare that still matches, and deletes a temp file beside it', async () => {
    const liveFolder = plantSpareFolder('spare_a11ce000');
    await writeSpareRecord(projectPath, sampleRecord('spare_a11ce000'));
    plantRecordsFile('spare_a11ce000.json.abc123.tmp', '{"folder": "spare_a11ce000"');

    await new SpareWorktreePool().sweep(projectPath, sampleInputs(), nothingReferenced);

    expect(recordFileNames()).toEqual(['spare_a11ce000.json']);
    expect(fs.existsSync(liveFolder)).toBe(true);
    expect(await readSpareRecord(projectPath, 'spare_a11ce000')).toEqual(sampleRecord('spare_a11ce000'));
  });

  it('leaves the record of a folder whose creation is held, and deletes it once the hold is released', async () => {
    const heldPath = path.join(worktreesRootFor(projectPath), 'spare_f00dcafe');
    plantRecordsFile('spare_f00dcafe.json', JSON.stringify(sampleRecord('spare_f00dcafe')));
    plantRecordsFile('spare_f00dcafe.json.abc123.tmp', '{"folder": "spare_f00dcafe"');
    const pool = new SpareWorktreePool();

    const release = tryHoldWorktreeCreation(heldPath);
    expect(release).not.toBeNull();
    try {
      // The folder is not on disk yet, as early in a build: only the hold keeps its files.
      await pool.sweep(projectPath, null, nothingReferenced);
      expect(recordFileNames()).toEqual(['spare_f00dcafe.json', 'spare_f00dcafe.json.abc123.tmp']);
    } finally {
      release?.();
    }

    await pool.sweep(projectPath, null, nothingReferenced);
    expect(recordFileNames()).toEqual([]);
  });
});
