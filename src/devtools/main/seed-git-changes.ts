/**
 * Dev-only: seed a realistic git changeset into ephemeral preview repos so the
 * Changes tab has something to review while iterating on it. The preview board
 * starts clean, so this is the fast path to "give me a diff to look at" without
 * hand-editing files in a clone.
 *
 * The changeset is shaped to exercise EVERY scope, status, diff-viewer, AND
 * commit-history-browser feature in one click:
 *   - a chain of commits ahead of base -> the 'Full branch vs base' scope, the
 *                                        ahead/behind badge, the last-commit line,
 *                                        AND a rich commit-history browser: many
 *                                        rows to scroll (COMMIT_CHAIN.length,
 *                                        comfortably over 10), varied synthetic
 *                                        authors and backdated timestamps (so the
 *                                        graph's relative-time column and each
 *                                        commit's ref badges look real rather
 *                                        than "all just now"), and distinct
 *                                        per-commit diffs to click through
 *   - history-shared.ts               -> committed across FOUR of those commits
 *                                        by four different synthetic authors, so
 *                                        the per-file "View history" popover has
 *                                        more than one row, and the blame gutter
 *                                        shows more than one hash/author (every
 *                                        other fixture file is touched by exactly
 *                                        one commit, so blame on it alone would
 *                                        never exercise multi-author rendering)
 *   - staged changes (index vs HEAD) -> the 'Staged' scope: Modified / Added /
 *                                        Deleted / Renamed
 *   - working changes (vs index)     -> the 'Working changes' scope, deliberately
 *                                        rich so it exercises the diff viewer:
 *       big.ts        a long file with two far-apart hunks -> collapse-unchanged,
 *                     next/prev-change navigation, per-file scroll memory
 *       inline.ts     an intra-line edit -> word-level diff
 *       whitespace.ts an indentation/trailing-space-only edit -> ignore-whitespace
 *       gone.ts       a deletion (D)
 *       newfile.ts    an untracked file (U)
 *       logo.png      an untracked PNG (U) -> the image view's new-image-only state
 *       blob.bin      an untracked non-image binary (U) -> binary detection
 *                     ("cannot display diff")
 *       assets/hero.png  a regenerated screenshot (M), taller than the
 *                     committed one -> the image view's four comparison modes
 *                     and the dimension-change highlight
 *       assets/icon.svg  an SVG edit (M) -> the text diff and its image preview
 *       notes.md      a rich markdown edit (M) -> the markdown preview toggle
 *       changelog.markdown  a .markdown edit (M) -> the .markdown extension map,
 *                     and a second markdown file so the preview toggle's per-file
 *                     reset can be exercised by switching between the two
 *       removed.md    a deleted markdown file (D) -> preview falls back to the
 *                     old content instead of rendering blank
 *
 * The commit-history chain never touches big.ts / inline.ts / whitespace.ts /
 * notes.md / changelog.markdown after their single initial commit (each stays
 * exactly the content the working-tree mutation below expects to diff against)
 * - only staged-mod.ts and history-shared.ts get extra chain-only revisions, so
 * none of the precision-tuned diff-viewer fixtures above are disturbed.
 *
 * Seeds MULTIPLE repos in one click (every active task worktree the renderer
 * passes, plus the project), all sharing one `seed-N` directory so a single
 * click lands the same fixture wherever you look.
 *
 * SAFETY: silently skips any target not under the preview-projects root, so it
 * can never dirty the real source worktree (the repo `/preview` runs from) or a
 * user's real repo. The preview clones it does touch are throwaway and removed
 * on close.
 *
 * Build-excluded from production: imported only behind `__KANGENTIC_DEV__`
 * guards, so esbuild dead-code elimination drops it from prod bundles. See
 * `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { previewProjectsRoot, runPreviewGit } from './ephemeral-projects';
import type { DevSeedGitChangesResult } from '../../shared/types';

// Generic commit identity so a commit succeeds even when the clone inherits no
// user config. No personal info (the repo is public). See no-personal-info.md.
const SEED_IDENTITY = ['-c', 'user.name=Kangentic Dev', '-c', 'user.email=dev@kangentic.local'];

// Synthetic (fictional) author identities so the seeded commit chain exercises
// multi-author rendering in the commit graph, per-file history, and blame
// gutter - a single-author seed never shows more than one hash/author per
// line. No personal info (see no-personal-info.md); same spirit as the
// 'Kangentic Dev' committer identity above, just varied per commit via
// `--author` (which drives `%an`/blame authorship independently of the
// committer config that makes the commit itself succeed).
const SEED_AUTHORS = [
  { name: 'Ada Lin', email: 'ada@kangentic.local' },
  { name: 'Bea Osei', email: 'bea@kangentic.local' },
  { name: 'Chidi Okoro', email: 'chidi@kangentic.local' },
  { name: 'Dana Volkov', email: 'dana@kangentic.local' },
];

// A binary file that is not an image, so the "cannot display diff" placeholder
// still has a fixture now that logo.png opens in the image view.
const NON_IMAGE_BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f, 0x10, 0x00]);

// Per-repo counts for the toast summary (kept in sync with seedOneRepo's
// COMMIT_CHAIN). COMMITTED_COUNT is the distinct fixture files that end up
// committed ahead of base, spread across the chain (not all in one commit).
const COMMIT_CHAIN_LENGTH = 11;
const COMMITTED_COUNT = 13;
const STAGED_COUNT = 4;
const WORKING_COUNT = 12;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A minimal RGBA PNG encoder (one IDAT chunk, no filtering), enough for seed
 * fixtures. A pixel callback returning null leaves that pixel transparent.
 */
function encodePng(width: number, height: number, pixelAt: (x: number, y: number) => [number, number, number] | null): Buffer {
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const pixel = pixelAt(x, y);
      if (pixel === null) continue; // Buffer.alloc zero-fills: transparent black
      const offset = y * rowBytes + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A small phone-screenshot stand-in for the image view: a header bar and three
 * cards. The `after` variant is taller (so the dimension change is flagged),
 * moves the cards down, and adds a colored strip to each, the shape of a real
 * regenerated store screenshot.
 */
function heroScreenshot(variant: 'before' | 'after'): Buffer {
  const width = 180;
  const height = variant === 'before' ? 320 : 360;
  const cardHeight = variant === 'before' ? 70 : 84;
  const cardGap = 16;
  const cardTop = 54;
  const stripColors: Array<[number, number, number]> = [[86, 138, 78], [192, 132, 56], [61, 107, 143]];
  return encodePng(width, height, (x, y) => {
    if (y >= 14 && y < 24 && x >= 14 && x < 90) return [223, 227, 232]; // title bar
    for (let card = 0; card < 3; card++) {
      const top = cardTop + card * (cardHeight + cardGap);
      if (y < top || y >= top + cardHeight || x < 10 || x >= width - 10) continue;
      const localY = y - top;
      if (localY >= 10 && localY < 18 && x >= 22 && x < 110) return [207, 211, 216]; // card title
      if (localY >= 28 && localY < 33 && x >= 22 && x < 150) return [75, 82, 92]; // card line
      if (variant === 'after' && localY >= cardHeight - 20 && localY < cardHeight - 10 && x >= 22 && x < width - 22) {
        return stripColors[card];
      }
      return [26, 30, 36]; // card body
    }
    return [14, 16, 19]; // page background
  });
}

/**
 * An untracked 96x96 logo: a rounded tile with three columns. The corners
 * outside the radius are transparent, so the image view's checkerboard shows.
 */
function logoImage(): Buffer {
  const size = 96;
  const radius = 20;
  const barColor: [number, number, number] = [104, 160, 96];
  const bars = [{ left: 18, height: 54 }, { left: 41, height: 36 }, { left: 64, height: 45 }];
  return encodePng(size, size, (x, y) => {
    const cornerX = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
    const cornerY = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
    if (cornerX * cornerX + cornerY * cornerY > radius * radius) return null;
    for (const bar of bars) {
      if (x >= bar.left && x < bar.left + 14 && y >= 21 && y < 21 + bar.height) return barColor;
    }
    return [31, 42, 29];
  });
}

/** An SVG icon edited in the working tree: one bar recolored and a badge added. */
function iconSvg(mutate: boolean): string {
  const firstBarColor = mutate ? '#e3b341' : '#68a060';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
    '  <rect width="64" height="64" rx="14" fill="#1f2a1d"/>',
    `  <rect x="12" y="14" width="10" height="36" rx="3" fill="${firstBarColor}"/>`,
    '  <rect x="27" y="14" width="10" height="24" rx="3" fill="#68a060"/>',
    '  <rect x="42" y="14" width="10" height="30" rx="3" fill="#68a060"/>',
    ...(mutate ? ['  <circle cx="50" cy="50" r="7" fill="#f87171"/>'] : []),
    '</svg>',
    '',
  ].join('\n');
}

// Module state; resets when the main process restarts. Each click uses a fresh
// index so re-clicks pile on a new, non-colliding directory of changes.
let seedRunIndex = 0;

/** True only when `targetPath` resolves inside the ephemeral preview-projects
 *  root - the one place it is safe to create git changes. */
function isUnderPreviewRoot(targetPath: string): boolean {
  const root = path.resolve(previewProjectsRoot());
  const resolved = path.resolve(targetPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Through runPreviewGit, not a bare `git -C`: a target under the preview root whose
// `.git` is missing would otherwise commit the seed fixtures onto the source worktree.
function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<unknown> {
  return runPreviewGit(repoPath, args, env);
}

/** ISO timestamp `hoursAgo` hours before now, for backdating seed commits
 *  (via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE) so the commit graph's relative-time
 *  column and blame dates show a realistic spread instead of every commit
 *  landing in the same second. */
function hoursAgoIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

/** A long file. With `mutate`, two far-apart fields change, producing two hunks
 *  separated by large unchanged regions (collapse-unchanged + change navigation). */
function bigFile(index: number, mutate: boolean): string {
  const lines = [
    '// Large file: exercises collapse-unchanged, next/prev-change nav, and scroll memory.',
    `export const config${index} = {`,
  ];
  for (let fieldNumber = 1; fieldNumber <= 60; fieldNumber += 1) {
    if (mutate && (fieldNumber === 10 || fieldNumber === 50)) {
      lines.push(`  field${fieldNumber}: ${fieldNumber * 1000}, // changed`);
    } else {
      lines.push(`  field${fieldNumber}: ${fieldNumber},`);
    }
  }
  lines.push('};', '');
  return lines.join('\n');
}

/** A rich markdown file (headings, list, external link, inline + fenced code, a
 *  gfm table and a task list). With `mutate` it grows into the fuller working-tree
 *  version, so toggling the diff viewer's eye icon shows a substantial render. */
function notesMarkdown(index: number, mutate: boolean): string {
  if (!mutate) {
    return [
      '# Project Notes',
      '',
      `Initial notes for config ${index}.`,
      '',
      '- first item',
      '- second item',
      '',
    ].join('\n');
  }
  return [
    '# Project Notes',
    '',
    `Updated notes for config ${index}. Toggle the eye icon to preview this rendered.`,
    '',
    '## Highlights',
    '',
    '- rendered **bold** and _italic_ text',
    // docs-link-ok: seeded markdown that exercises external-link routing through the shell. The
    // host is incidental to what it tests, and a contract docs path would misrepresent it.
    '- a [link home](https://kangentic.com) routed through the shell',
    '- inline `code` plus a fenced block:',
    '',
    '```ts',
    'export const answer = 42;',
    '```',
    '',
    '## Status',
    '',
    '| Feature | State |',
    '| --- | --- |',
    '| Preview toggle | done |',
    '| Deleted fallback | done |',
    '',
    '- [x] preview renders the new content',
    '- [ ] still reading the raw diff',
    '',
  ].join('\n');
}

/** A `.markdown`-extension file, exercising the extension the preview feature
 *  added to the language map. `mutate` prepends a new release section. */
function changelogMarkdown(index: number, mutate: boolean): string {
  const initial = ['## 0.1.0', '', `- initial release for config ${index}`, ''];
  const header = ['# Changelog', ''];
  if (!mutate) {
    return [...header, ...initial].join('\n');
  }
  return [
    ...header,
    '## 0.2.0',
    '',
    '- add markdown preview toggle to the diff viewer',
    '- fix the per-file reset and the deleted-file fallback',
    '',
    ...initial,
  ].join('\n');
}

/** The last-committed content of the file deleted in the working tree, so its
 *  preview has old content to fall back to. */
function removedMarkdown(index: number): string {
  return [
    '# Deprecated Notes',
    '',
    `These notes for config ${index} are going away. Previewing a deleted markdown`,
    'file should still render THIS old content, not a blank page.',
    '',
  ].join('\n');
}

/** Grows by one exported constant per revision (1-4), each added in a separate
 *  chain commit by a different SEED_AUTHORS entry. Never touched again after
 *  revision 4, so it stays part of the stable committed baseline: the fixture
 *  for testing multi-commit file history and multi-author blame (every other
 *  fixture file is created in exactly one commit). */
function historySharedFile(revision: number, index: number): string {
  const lines = [
    '// Shared history fixture: built up across several commits by different',
    '// authors, to exercise multi-commit file history and multi-author blame.',
    `export const historyRevision${index} = ${revision};`,
  ];
  if (revision >= 2) lines.push(`export const historyStepTwo${index} = 'added by the second revision';`);
  if (revision >= 3) lines.push(`export const historyStepThree${index} = 'added by the third revision';`);
  if (revision >= 4) lines.push(`export const historyStepFour${index} = 'added by the fourth revision';`);
  lines.push('');
  return lines.join('\n');
}

/** A small file re-committed once before Step 2 stages its real edit, purely
 *  to add one more commit-chain entry - Step 2 fully overwrites its content
 *  afterward, so this revision never affects the staged/working diff. */
function stagedModRevision(revision: number, index: number): string {
  return revision === 1
    ? `export const stagedMod${index} = ${index};\n`
    : `export const stagedMod${index} = ${index}; // seed chain revision ${revision}\n`;
}

/** One commit in the seed history chain: writes its files, stages exactly
 *  those paths, and commits with a distinct synthetic author + backdated
 *  timestamp (via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE) so the resulting graph,
 *  file-history popover, and blame gutter all show realistic variety instead
 *  of one commit repeated with the same author "just now". */
interface ChainStep {
  author: { name: string; email: string };
  hoursAgo: number;
  message: string;
  /** A string is written as UTF-8 text; a Buffer is written as raw bytes (the PNG fixtures). */
  writes: Array<{ relative: string; content: string | Buffer }>;
}

async function commitChainStep(
  repoPath: string,
  writeFile: (relative: string, content: string | Buffer) => Promise<void>,
  step: ChainStep,
): Promise<void> {
  for (const write of step.writes) {
    await writeFile(write.relative, write.content);
  }
  await runGit(repoPath, ['add', ...step.writes.map((write) => write.relative)]);
  const dateIso = hoursAgoIso(step.hoursAgo);
  await runGit(
    repoPath,
    // --author belongs to the `commit` subcommand, so it must come AFTER
    // 'commit' - placing it among the global -c flags (before the
    // subcommand) makes git reject it as "unknown option".
    [...SEED_IDENTITY, 'commit', '-m', step.message, `--author=${step.author.name} <${step.author.email}>`],
    { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso },
  );
}

/** Seed one repo with the full fixture under `seed-<index>/`. */
async function seedOneRepo(repoPath: string, dir: string, index: number): Promise<void> {
  const absolute = (relative: string): string => path.join(repoPath, relative);
  const writeFile = async (relative: string, content: string | Buffer): Promise<void> => {
    await fs.promises.mkdir(path.dirname(absolute(relative)), { recursive: true });
    if (typeof content === 'string') await fs.promises.writeFile(absolute(relative), content, 'utf-8');
    else await fs.promises.writeFile(absolute(relative), content);
  };

  // Step 1: a chain of commits ahead of base (COMMIT_CHAIN.length, well over
  // 10) instead of one giant commit - the originals the working and staged
  // diffs compare against, and they populate the branch-vs-base scope AND the
  // commit-history browser with real rows to click through. Author + hoursAgo
  // vary per step so the graph/blame show realistic spread rather than one
  // author "just now". Every file other than staged-mod.ts and
  // history-shared.ts is written exactly once here and never touched again by
  // the chain, so none of the working-tree mutations in Step 3 change what
  // they diff against.
  const [ada, bea, chidi, dana] = SEED_AUTHORS;
  const COMMIT_CHAIN: ChainStep[] = [
    {
      author: ada, hoursAgo: 48, message: `chore(seed): scaffold small fixtures ${index}`,
      writes: [
        { relative: `${dir}/gone.ts`, content: `export const gone${index} = ${index};\n` },
        { relative: `${dir}/staged-del.ts`, content: `export const stagedDel${index} = ${index};\n` },
        { relative: `${dir}/staged-old.ts`, content: `export const stagedRen${index} = ${index};\n` },
        { relative: `${dir}/assets/hero.png`, content: heroScreenshot('before') },
        { relative: `${dir}/assets/icon.svg`, content: iconSvg(false) },
      ],
    },
    {
      author: bea, hoursAgo: 43, message: `feat(seed): add long baseline config ${index}`,
      writes: [{ relative: `${dir}/big.ts`, content: bigFile(index, false) }],
    },
    {
      author: chidi, hoursAgo: 36, message: `feat(seed): add greeting + compute helpers ${index}`,
      writes: [
        { relative: `${dir}/inline.ts`, content: `export const greeting${index} = 'hello world from kangentic';\n` },
        { relative: `${dir}/whitespace.ts`, content: `export function compute${index}() {\n  return 1 + 2;\n}\n` },
      ],
    },
    {
      author: dana, hoursAgo: 29, message: `docs(seed): add project notes ${index}`,
      writes: [{ relative: `${dir}/notes.md`, content: notesMarkdown(index, false) }],
    },
    {
      author: ada, hoursAgo: 24, message: `docs(seed): add changelog + deprecated notes ${index}`,
      writes: [
        { relative: `${dir}/changelog.markdown`, content: changelogMarkdown(index, false) },
        { relative: `${dir}/removed.md`, content: removedMarkdown(index) },
      ],
    },
    {
      author: bea, hoursAgo: 20, message: `feat(seed): scaffold staged-mod helper ${index}`,
      writes: [{ relative: `${dir}/staged-mod.ts`, content: stagedModRevision(1, index) }],
    },
    {
      author: chidi, hoursAgo: 15, message: `feat(seed): introduce shared history file ${index}`,
      writes: [{ relative: `${dir}/history-shared.ts`, content: historySharedFile(1, index) }],
    },
    {
      author: dana, hoursAgo: 10, message: `feat(seed): extend shared history file ${index}`,
      writes: [{ relative: `${dir}/history-shared.ts`, content: historySharedFile(2, index) }],
    },
    {
      author: ada, hoursAgo: 6, message: `refactor(seed): tidy staged-mod helper ${index}`,
      writes: [{ relative: `${dir}/staged-mod.ts`, content: stagedModRevision(2, index) }],
    },
    {
      author: bea, hoursAgo: 3, message: `feat(seed): extend shared history file again ${index}`,
      writes: [{ relative: `${dir}/history-shared.ts`, content: historySharedFile(3, index) }],
    },
    {
      author: { name: 'Kangentic Dev', email: 'dev@kangentic.local' }, hoursAgo: 0.08,
      message: `test(seed): baseline files ${index}`,
      writes: [{ relative: `${dir}/history-shared.ts`, content: historySharedFile(4, index) }],
    },
  ];
  for (const step of COMMIT_CHAIN) {
    await commitChainStep(repoPath, writeFile, step);
  }

  // Step 2: staged changes (index vs HEAD) -> Modified / Added / Deleted / Renamed.
  await writeFile(`${dir}/staged-mod.ts`, `export const stagedMod${index} = ${index};\nexport const stagedExtra = true;\n`);
  await runGit(repoPath, ['add', `${dir}/staged-mod.ts`]);                          // staged Modified
  await writeFile(`${dir}/staged-add.ts`, `export const stagedAdd${index} = ${index};\n`);
  await runGit(repoPath, ['add', `${dir}/staged-add.ts`]);                          // staged Added
  await runGit(repoPath, ['rm', '-q', `${dir}/staged-del.ts`]);                     // staged Deleted
  await runGit(repoPath, ['mv', `${dir}/staged-old.ts`, `${dir}/staged-new.ts`]);   // staged Renamed

  // Step 3: working changes (working tree vs index), rich enough to exercise the
  // whole diff viewer.
  await writeFile(`${dir}/big.ts`, bigFile(index, true));                                                   // M: two hunks
  await writeFile(`${dir}/inline.ts`, `export const greeting${index} = 'hello brave new world from kangentic';\n`); // M: word-level
  await writeFile(`${dir}/whitespace.ts`, `export function compute${index}() {\n    return 1 + 2;   \n}\n`); // M: whitespace-only
  await fs.promises.rm(absolute(`${dir}/gone.ts`), { force: true });                                         // D
  await writeFile(`${dir}/newfile.ts`, `export const fresh${index} = ${index};\n`);                          // U
  await writeFile(`${dir}/logo.png`, logoImage());                                                           // U: image view, new image only
  await writeFile(`${dir}/blob.bin`, NON_IMAGE_BINARY);                                                      // U: binary placeholder
  await writeFile(`${dir}/assets/hero.png`, heroScreenshot('after'));                                        // M: image view, both sides, taller
  await writeFile(`${dir}/assets/icon.svg`, iconSvg(true));                                                  // M: SVG text diff + preview
  await writeFile(`${dir}/notes.md`, notesMarkdown(index, true));                                            // M: markdown preview
  await writeFile(`${dir}/changelog.markdown`, changelogMarkdown(index, true));                              // M: .markdown preview
  await fs.promises.rm(absolute(`${dir}/removed.md`), { force: true });                                      // D: deleted markdown
}

/**
 * Seed every given target repo (skipping any outside the preview root) with one
 * shared `seed-N` fixture. Throws only when nothing was safe to seed.
 */
export async function seedGitChanges(targetPaths: string[]): Promise<DevSeedGitChangesResult> {
  seedRunIndex += 1;
  const index = seedRunIndex;
  const dir = `seed-${index}`;

  let repos = 0;
  for (const targetPath of targetPaths) {
    if (!isUnderPreviewRoot(targetPath)) continue;
    try {
      await seedOneRepo(targetPath, dir, index);
      repos += 1;
    } catch (seedError) {
      console.warn(`[DEV] Seed failed for ${targetPath}:`, seedError);
    }
  }

  if (repos === 0) {
    throw new Error('No ephemeral preview repo to seed - open a project or an active task first');
  }
  return { repos, dir, commits: COMMIT_CHAIN_LENGTH, committed: COMMITTED_COUNT, staged: STAGED_COUNT, working: WORKING_COUNT };
}

let devIpcRegistered = false;

/**
 * Register the dev-only IPC behind the TestHarness "Seed File Changes" button. The
 * renderer passes the active task worktrees + the project path; the handler
 * refuses anything outside the ephemeral preview root. Idempotent.
 */
export function registerSeedGitChangesDevIpc(): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SEED_GIT_CHANGES, (_, targetPaths: string[]) => seedGitChanges(targetPaths));
}
