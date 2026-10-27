/**
 * The PO catalogs as the translation harness reads and writes them: only through
 * Lingui's own catalog API (the one `lingui extract` uses), so a written file is
 * byte for byte what extract would write and `npm run i18n:check` stays green.
 *
 * A machine translation carries the PO `fuzzy` flag until a person reviews it.
 * Lingui keeps flags through extract (its merge carries each entry's `extra`), and
 * its compile and its Vite plugin both use a fuzzy entry's translation like any
 * other, so a draft shows in the UI while it waits for review.
 * `tests/unit/i18n-translation-harness.test.ts` pins both. A translated entry
 * without the flag has been reviewed (or written by a person), and the harness
 * never touches it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The PO flag that marks a translation as machine-drafted and not yet reviewed. */
export const REVIEW_FLAG = 'fuzzy';

export function hasReviewMark(message) {
  return Boolean(message.extra?.flags?.includes(REVIEW_FLAG));
}

/** Write `icu` as the message's translation, marked for review. */
export function applyMachineTranslation(message, icu) {
  message.translation = icu;
  const flags = message.extra?.flags ?? [];
  message.extra = { ...message.extra, translatorComments: message.extra?.translatorComments ?? [], flags: flags.includes(REVIEW_FLAG) ? flags : [...flags, REVIEW_FLAG] };
}

/**
 * The IDs to translate: every entry with no translation, and with `redraft` also
 * every entry still marked for review. A reviewed translation is never picked.
 */
export function selectEntryIds(messages, { redraft = false } = {}) {
  return Object.entries(messages)
    .filter(([, message]) => !message.obsolete)
    .filter(([, message]) => !message.translation || (redraft && hasReviewMark(message)))
    .map(([id]) => id);
}

/** A catalog's area: its PO file name without the extension (`settings`, `src-main`). */
export function areaOf(catalog) {
  return path.basename(catalog.getFilename('en'), path.extname(catalog.getFilename('en')));
}

/** Lingui's config and catalogs for the repo, as `lingui extract` sees them. */
export async function loadCatalogs(repoRoot) {
  const { getConfig } = await import('@lingui/conf');
  const { getCatalogs } = await import('@lingui/cli/api');
  const config = getConfig({ configPath: path.join(repoRoot, 'lingui.config.ts'), skipValidation: true });
  const catalogs = await getCatalogs(config);
  return { config, catalogs: catalogs.map((catalog) => ({ area: areaOf(catalog), catalog })) };
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * The commit whose catalogs hold the translations a reworded string lost: the
 * one the caller names, or the merge-base with `origin/main`, or HEAD when there
 * is no `origin/main`.
 */
export function resolveBaseRef(repoRoot, requested) {
  if (requested) return git(repoRoot, ['rev-parse', '--verify', requested]).trim();
  try {
    return git(repoRoot, ['merge-base', 'HEAD', 'origin/main']).trim();
  } catch {
    return git(repoRoot, ['rev-parse', 'HEAD']).trim();
  }
}

/**
 * `locale`'s messages for `catalog` as they stood at `ref`, read through the
 * catalog's own formatter. Empty when the file did not exist there.
 */
export async function readCatalogAt(catalog, locale, ref, repoRoot) {
  const relativePath = path.relative(repoRoot, catalog.getFilename(locale)).split(path.sep).join('/');
  let content;
  try {
    content = git(repoRoot, ['show', `${ref}:${relativePath}`]);
  } catch {
    return {};
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-base-'));
  const file = path.join(directory, path.basename(relativePath));
  try {
    fs.writeFileSync(file, content);
    return (await catalog.format.read(file, locale)) ?? {};
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
