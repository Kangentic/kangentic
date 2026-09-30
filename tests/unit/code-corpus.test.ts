/**
 * The `code` corpus: the default branch's source files and docs, embedded so
 * Ask can explain the code.
 *
 * The record half and the status line are pure. The sweep runs the REAL
 * project migrations and the REAL RetrievalStore against node:sqlite, so the
 * diff-upsert, the index-state bookkeeping and the full-text triggers are the
 * shipped ones; only git is scripted. node:sqlite rather than better-sqlite3 on
 * purpose: better-sqlite3 is compiled for Electron's Node ABI, so every suite
 * gated on it skips.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { codeChunks, codePathOf, isIndexableCodePath, namesCodeIdentifier } from '../../src/main/retrieval/code/code-record';
import { batchesBySize, indexedCodeBranch, purgeCodeRecords, sweepCodeRecords, type CodeIndexerDeps } from '../../src/main/retrieval/code/code-indexer';
import {
  BRANCH_SIZE_TTL_MS,
  CODE_BYTES_PER_PASSAGE,
  branchSizeOf,
  codeStatus,
  createBranchSizes,
  type CodeStatusInput,
} from '../../src/main/retrieval/code/code-status';
import type { BranchHead, TreeEntry } from '../../src/main/retrieval/branch-git';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;
type NodeDatabase = InstanceType<SqliteModule['DatabaseSync']>;

describe('code records', () => {
  it('keeps source and docs, and skips tests, fixtures, data, lock files, binaries and build output', () => {
    for (const kept of [
      'src/main/pty/session-manager.ts', 'docs/architecture.md', 'scripts/dev.js', 'README.md', 'src/renderer/App.tsx',
      // Lookalikes of a secret file's name that are ordinary source.
      'src/env.ts', 'src/keyboard.ts',
    ]) {
      expect(isIndexableCodePath(kept), kept).toBe(true);
    }
    for (const skipped of [
      'tests/unit/foo.test.ts', 'src/main/foo.spec.ts', 'tests/fixtures/session.jsonl', 'src/__mocks__/fs.ts',
      'package-lock.json', 'package.json', 'config/app.yaml', 'assets/logo.png', 'public/vendor.min.js',
      'dist/index.js', 'node_modules/left-pad/index.js', 'models/embed.onnx',
    ]) {
      expect(isIndexableCodePath(skipped), skipped).toBe(false);
    }
  });

  it('never indexes a key or credential file, wherever it sits and however it is named', () => {
    // A passage is handed to the answering agent, and none of these matches any
    // other skip rule: each is caught by the secret-file rule alone.
    for (const secret of [
      '.env', 'config/.env.production', '.env.local', 'apps/web/.env.staging',
      'certs/server.pem', 'deploy/site.key', 'keys/signing.p12', 'keys/client.pfx', 'android/release.jks', 'android/upload.keystore',
      '.npmrc', 'packages/app/.npmrc', '.pypirc', '.netrc',
      'ops/id_ed25519', 'ops/id_rsa', 'ops/id_dsa', 'id_ecdsa',
    ]) {
      expect(isIndexableCodePath(secret), secret).toBe(false);
    }
  });

  it('splits at top-level declarations, packs up to 1,600 characters, and opens each passage with its path', () => {
    const declaration = (index: number) => `export function step${index}() {\n  return ${'x'.repeat(400)};\n}\n`;
    const text = Array.from({ length: 8 }, (_, index) => declaration(index)).join('');
    const chunks = codeChunks('src/steps.ts', text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [seq, chunk] of chunks.entries()) {
      expect(chunk.seq).toBe(seq);
      expect(chunk.role).toBe('code');
      expect(chunk.tsStart).toBeNull();
      expect(codePathOf(chunk.text)).toBe('src/steps.ts');
      expect(chunk.text.startsWith('src/steps.ts\n\n')).toBe(true);
      expect(chunk.text.length - 'src/steps.ts\n\n'.length).toBeLessThanOrEqual(1_600);
    }
    // Never mid-declaration: each passage starts at one.
    for (const chunk of chunks) expect(chunk.text.slice('src/steps.ts\n\n'.length)).toMatch(/^export function step\d/);
    // Nothing lost or repeated.
    expect(chunks.map((chunk) => chunk.text.slice('src/steps.ts\n\n'.length)).join('')).toBe(`${text}\n`);
  });

  it('holds a file with a NUL byte as a document with no passages', () => {
    expect(codeChunks('assets/blob.dat', 'abc\u0000def')).toEqual([]);
  });

  it('tells a question that names an identifier from one that does not', () => {
    for (const question of ['Where is computeEmbedSleepMs?', 'What does `withTaskLock` do?', 'Who sets session_id?', 'When is store.getMeta called?']) {
      expect(namesCodeIdentifier(question), question).toBe(true);
    }
    for (const question of ['How does the embedding drain pace itself?', 'Which task took the longest?', 'Where is the PTY resize debounced?']) {
      expect(namesCodeIdentifier(question), question).toBe(false);
    }
  });
});

describe('batchesBySize', () => {
  const entryOf = (index: number, size: number): TreeEntry => ({ path: `src/file-${index}.ts`, blob: `blob-${index}`, size });
  const sizesOf = (batches: TreeEntry[][]): number[][] => batches.map((batch) => batch.map((entry) => entry.size));

  it('holds no batch for no entries', () => {
    expect(batchesBySize([], 10)).toEqual([]);
  });

  it('cuts the entries in order into runs whose sizes sum to at most the limit', () => {
    const entries = [4, 4, 4, 4, 4].map((size, index) => entryOf(index, size));

    const batches = batchesBySize(entries, 10);

    expect(sizesOf(batches)).toEqual([[4, 4], [4, 4], [4]]);
    // Order kept, nothing lost or repeated.
    expect(batches.flat().map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
  });

  it('keeps entries that sum to exactly the limit in one batch', () => {
    expect(sizesOf(batchesBySize([5, 5].map((size, index) => entryOf(index, size)), 10))).toEqual([[5, 5]]);
    expect(sizesOf(batchesBySize([5, 5, 1].map((size, index) => entryOf(index, size)), 10))).toEqual([[5, 5], [1]]);
  });

  it('gives an entry larger than the limit a batch of its own, wherever it sits, and never an empty one', () => {
    expect(sizesOf(batchesBySize([entryOf(0, 30)], 10))).toEqual([[30]]);
    expect(sizesOf(batchesBySize([30, 3].map((size, index) => entryOf(index, size)), 10))).toEqual([[30], [3]]);
    expect(sizesOf(batchesBySize([3, 30, 3].map((size, index) => entryOf(index, size)), 10))).toEqual([[3], [30], [3]]);
  });
});

/** node:sqlite behind the slice of better-sqlite3 the store uses, with nested
 *  transactions as savepoints (a slice's transaction wraps the upsert's own). */
function adaptDatabase(database: NodeDatabase): DatabaseType.Database {
  let depth = 0;
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        const savepoint = `sp_${depth}`;
        database.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const result = body(...args);
          depth -= 1;
          database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          depth -= 1;
          database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

/** A project and a scripted branch: its files by path, each blob id derived from its content. */
function project() {
  const database = new sqlite!.DatabaseSync(':memory:');
  const db = adaptDatabase(database);
  runProjectMigrations(db);
  const store = new RetrievalStore(db);
  const files = new Map<string, string>();
  // A hash of the content, as git's blob id is.
  const blobOf = (content: string): string => crypto.createHash('sha1').update(content).digest('hex');
  const git = {
    head: { ref: 'origin/main', sha: 'sha-1' } as BranchHead | null,
    listCalls: 0,
    blobReads: [] as string[][],
  };
  const deps: CodeIndexerDeps = {
    getDb: () => db,
    readHead: async () => git.head,
    listTree: async (): Promise<TreeEntry[]> => {
      git.listCalls += 1;
      return [...files].map(([path, content]) => ({ path, blob: blobOf(content), size: Buffer.byteLength(content) }));
    },
    readBlobs: async (_path, blobs) => {
      git.blobReads.push([...blobs]);
      const byBlob = new Map([...files.values()].map((content) => [blobOf(content), Buffer.from(content)]));
      return new Map(blobs.flatMap((blob) => (byBlob.has(blob) ? [[blob, byBlob.get(blob)!] as const] : [])));
    },
    now: () => 1_800_000_000_000,
    clock: () => 0,
    yieldToEventLoop: async () => undefined,
  };
  const paths = (): string[] => (database.prepare("SELECT DISTINCT doc_id AS docId FROM memory_chunks WHERE corpus = 'code' ORDER BY doc_id").all() as Array<{ docId: string }>)
    .map((row) => row.docId);
  const fullTextHits = (word: string): number => (database.prepare('SELECT COUNT(*) AS count FROM memory_chunks_fts WHERE memory_chunks_fts MATCH ?').get(word) as { count: number }).count;
  const sweep = (allowFullRead = true) => sweepCodeRecords('project', '/mock/repo', 'main', { allowFullRead }, deps);
  return { database, db, store, files, git, deps, paths, fullTextHits, sweep };
}

describeWithSqlite('sweepCodeRecords', () => {
  it('reads every indexable file on the branch into one document per path', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export function computeEmbedSleepMs() {\n  return 0;\n}\n');
    fixture.files.set('docs/pacing.md', '# Pacing\n\nThe drain sleeps between batches.\n');
    fixture.files.set('tests/unit/pacer.test.ts', 'it("paces", () => {});\n');
    fixture.files.set('package.json', '{}');

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 2, removed: 0, deferred: false });
    expect(fixture.paths()).toEqual(['docs/pacing.md', 'src/pacer.ts']);
    expect(indexedCodeBranch(fixture.store)).toBe('origin/main');
    expect(fixture.store.corpusProgress('code', 'model@1')).toEqual({ documents: 2, chunks: 2, embedded: 0 });
  });

  it('keeps code out of the full-text index, and a removal leaves that index whole', async () => {
    // The triggers skip code on insert AND on delete: a 'delete' for a row an
    // external-content index never held corrupts it.
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export function zyzzyvaPacer() {}\n');
    fixture.store.upsertDocument(
      { corpus: 'conversation', docId: 'agent-1', sessionId: null, taskId: 'task-1', agentSessionId: 'agent-1', metaJson: null },
      [{ seq: 0, text: 'we renamed zyzzyvaPacer', contentHash: 'hash-1', tokenEstimate: 5, role: 'assistant', tsStart: 1, tsEnd: 1, turnUuidStart: null, turnUuidEnd: null }],
    );
    await fixture.sweep();
    expect(fixture.fullTextHits('zyzzyvaPacer')).toBe(1);

    fixture.files.clear();
    fixture.git.head = { ref: 'origin/main', sha: 'sha-2' };
    const result = await fixture.sweep();

    // An unguarded delete trigger throws SQLITE_CORRUPT_VTAB here (measured on
    // node:sqlite 3.51), so the removal would not have happened. SQLite's own
    // integrity checks cannot tell: the plain one misses a stray delete, and the
    // one that compares against the content table reports every held-back code
    // row as corruption, by design.
    expect(result.removed).toBe(1);
    expect(fixture.paths()).toEqual([]);
    expect(fixture.fullTextHits('zyzzyvaPacer')).toBe(1);
    for (const trigger of ['trg_memory_chunks_fts_ai', 'trg_memory_chunks_fts_ad', 'trg_memory_chunks_fts_au']) {
      const row = fixture.database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(trigger) as { sql: string } | undefined;
      expect(row?.sql, trigger).toMatch(/WHEN (new|old)\.corpus <> 'code'/);
    }
  });

  it('reads nothing when the branch has not moved', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');
    await fixture.sweep();
    fixture.git.listCalls = 0;

    expect(await fixture.sweep()).toEqual({ indexed: 0, removed: 0, deferred: false });
    expect(fixture.git.listCalls).toBe(0);
  });

  it('reads the branch again after Rebuild cleared the index state, though its head did not move', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');
    fixture.files.set('docs/pacing.md', '# Pacing\n');
    await fixture.sweep();
    // Passages already embedded: Rebuild keeps them, and so must the refill.
    fixture.database.exec("UPDATE memory_chunks SET embedded_model = 'model@1' WHERE corpus = 'code'");
    // Rebuild forgets what each source was read from and keeps the passages. The
    // stored head, which a cleared index leaves behind, still matches the branch.
    fixture.store.resetIndexState();
    fixture.git.listCalls = 0;
    fixture.git.blobReads.length = 0;

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 2, removed: 0, deferred: false });
    expect(fixture.git.listCalls).toBe(1);
    expect(fixture.git.blobReads.flat()).toHaveLength(2);
    // The passages were never dropped, so the refill neither duplicates nor re-embeds them.
    expect(fixture.paths()).toEqual(['docs/pacing.md', 'src/pacer.ts']);
    expect(fixture.store.corpusProgress('code', 'model@1')).toEqual({ documents: 2, chunks: 2, embedded: 2 });

    // Read once more, so the next sweep on the same head is the free check again.
    fixture.git.listCalls = 0;
    expect(await fixture.sweep()).toEqual({ indexed: 0, removed: 0, deferred: false });
    expect(fixture.git.listCalls).toBe(0);
  });

  it('fills the index again when source code is switched back on, though the branch did not move', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');
    await fixture.sweep();
    // Switched off: the corpus is cleared, and the stored head stays behind.
    expect(purgeCodeRecords('project', () => fixture.db)).toBe(true);
    expect(fixture.paths()).toEqual([]);
    fixture.git.listCalls = 0;

    expect(await fixture.sweep()).toEqual({ indexed: 1, removed: 0, deferred: false });

    expect(fixture.git.listCalls).toBe(1);
    expect(fixture.paths()).toEqual(['src/pacer.ts']);
  });

  it('re-reads only the files whose content changed when the branch moves', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');
    fixture.files.set('src/kept.ts', 'export const kept = true;\n');
    fixture.files.set('src/gone.ts', 'export const gone = true;\n');
    await fixture.sweep();

    fixture.files.set('src/pacer.ts', 'export const one = 2;\n');
    fixture.files.delete('src/gone.ts');
    fixture.git.head = { ref: 'origin/main', sha: 'sha-2' };
    fixture.git.blobReads.length = 0;
    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: 1, removed: 1, deferred: false });
    expect(fixture.git.blobReads).toHaveLength(1);
    expect(fixture.git.blobReads[0]).toHaveLength(1);
    expect(fixture.paths()).toEqual(['src/kept.ts', 'src/pacer.ts']);
  });

  it('reads the changed files one 16 MB batch at a time, and still indexes every one of them', async () => {
    const fixture = project();
    const fileCount = 90;
    for (let index = 0; index < fileCount; index += 1) {
      fixture.files.set(`src/module-${String(index).padStart(2, '0')}.ts`, `export const value${index} = ${index};\n`);
    }
    // The tree listing is what reports a file's size, so the batches are cut on
    // it and the contents stay small: each file is listed at 200 KB, under the
    // per-file cap, so 90 of them are 18 MB and cannot go through in one read.
    const reportedSize = 200_000;
    const sixteenMegabytes = 16 * 1024 * 1024;
    const listedFromContent = fixture.deps.listTree;
    fixture.deps.listTree = async (projectPath, commit) =>
      (await listedFromContent(projectPath, commit)).map((entry) => ({ ...entry, size: reportedSize }));

    const result = await fixture.sweep();

    expect(result).toEqual({ indexed: fileCount, removed: 0, deferred: false });
    expect(fixture.paths()).toHaveLength(fileCount);
    // More than one read, none of them past the limit, and every blob read once.
    expect(fixture.git.blobReads.length).toBeGreaterThan(1);
    for (const read of fixture.git.blobReads) {
      expect(read.length * reportedSize).toBeLessThanOrEqual(sixteenMegabytes);
    }
    // 83 files of 200 KB fit in 16 MB and an 84th does not: 90 files read as 83, then 7.
    expect(fixture.git.blobReads.map((read) => read.length)).toEqual([83, 7]);
    expect(fixture.git.blobReads.flat()).toHaveLength(fileCount);
    expect(new Set(fixture.git.blobReads.flat()).size).toBe(fileCount);
  });

  it('puts off the first read of a whole branch until it may run, and never an update', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');

    expect(await fixture.sweep(false)).toEqual({ indexed: 0, removed: 0, deferred: true });
    expect(fixture.git.listCalls).toBe(0);

    await fixture.sweep(true);
    fixture.files.set('src/pacer.ts', 'export const one = 2;\n');
    fixture.git.head = { ref: 'origin/main', sha: 'sha-2' };
    expect(await fixture.sweep(false)).toEqual({ indexed: 1, removed: 0, deferred: false });
  });

  it('leaves a project with no default branch as it is', async () => {
    const fixture = project();
    fixture.git.head = null;
    expect(await fixture.sweep()).toEqual({ indexed: 0, removed: 0, deferred: false });
    expect(fixture.git.listCalls).toBe(0);
  });

  it('clears everything the corpus holds when switched off, and reports nothing to clear after', async () => {
    const fixture = project();
    fixture.files.set('src/pacer.ts', 'export const one = 1;\n');
    await fixture.sweep();

    expect(purgeCodeRecords('project', () => fixture.db)).toBe(true);
    expect(fixture.paths()).toEqual([]);
    expect(fixture.store.corpusProgress('code', 'model@1').documents).toBe(0);
    expect(purgeCodeRecords('project', () => fixture.db)).toBe(false);
  });
});

describe('the Source code status line', () => {
  const size = { branch: 'origin/main', files: 1_488, passages: 12_186 };
  const base: CodeStatusInput = {
    on: false,
    progress: { documents: 0, chunks: 0, embedded: 0 },
    indexedBranch: null,
    branchSize: size,
    chunksPerMinute: 435,
  };

  it('off, estimates the branch and how long it takes at the measured rate', () => {
    expect(codeStatus(base)).toEqual({ state: 'estimate', ...size, embedded: 0, minutesLeft: 12_186 / 435 });
    // No rate measured this launch: no time, rather than a guess.
    expect(codeStatus({ ...base, chunksPerMinute: null })?.minutesLeft).toBeNull();
    // Nothing to say before the branch has been read.
    expect(codeStatus({ ...base, branchSize: undefined })).toBeUndefined();
    // No commit to read (a folder just given git init), or no repository.
    expect(codeStatus({ ...base, branchSize: null })?.state).toBe('nothing-committed');
  });

  it('on, reads, then counts what is embedded, then is caught up', () => {
    expect(codeStatus({ ...base, on: true, branchSize: undefined })?.state).toBe('reading');
    expect(codeStatus({ ...base, on: true })?.state).toBe('reading');
    const indexing = codeStatus({
      ...base, on: true, indexedBranch: 'origin/main', branchSize: undefined,
      progress: { documents: 1_488, chunks: 12_186, embedded: 4_210 },
    });
    expect(indexing).toEqual({
      state: 'indexing', branch: 'origin/main', files: 1_488, passages: 12_186, embedded: 4_210, minutesLeft: (12_186 - 4_210) / 435,
    });
    expect(codeStatus({
      ...base, on: true, indexedBranch: 'origin/main', branchSize: undefined,
      progress: { documents: 1_488, chunks: 12_186, embedded: 12_186 },
    })).toMatchObject({ state: 'ready', minutesLeft: null });
  });

  it('estimates passages from file sizes, over the indexable files only', () => {
    const entries: TreeEntry[] = [
      { path: 'src/a.ts', blob: 'a', size: CODE_BYTES_PER_PASSAGE * 3 },
      { path: 'docs/b.md', blob: 'b', size: CODE_BYTES_PER_PASSAGE },
      { path: 'tests/unit/a.test.ts', blob: 'c', size: CODE_BYTES_PER_PASSAGE * 50 },
      { path: 'src/huge.ts', blob: 'd', size: 300 * 1024 },
    ];
    expect(branchSizeOf('origin/main', entries)).toEqual({ branch: 'origin/main', files: 2, passages: 4 });
  });

  it('reads a branch in the background, once at a time, and again once the reading is a minute old', async () => {
    let now = 0;
    let reads = 0;
    let release: () => void = () => undefined;
    const sizes = createBranchSizes({
      readHead: async () => {
        reads += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { ref: 'origin/main', sha: 'sha-1' };
      },
      listTree: async () => [{ path: 'src/a.ts', blob: 'a', size: CODE_BYTES_PER_PASSAGE }],
      now: () => now,
    });

    expect(sizes.get('project', '/repo', 'main')).toBeUndefined();
    expect(sizes.get('project', '/repo', 'main')).toBeUndefined();
    expect(reads).toBe(1);
    release();
    await waitUntil(() => sizes.get('project', '/repo', 'main') !== undefined);
    expect(sizes.get('project', '/repo', 'main')).toEqual({ branch: 'origin/main', files: 1, passages: 1 });
    expect(reads).toBe(1);

    now = BRANCH_SIZE_TTL_MS;
    sizes.get('project', '/repo', 'main');
    expect(reads).toBe(2);
    release();
  });
});

/** Poll a condition across microtask turns, for a reading that settles in the background. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never held');
}
