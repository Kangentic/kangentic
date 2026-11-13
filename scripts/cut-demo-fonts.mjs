/**
 * Cut the web demo's symbol faces: `node scripts/cut-demo-fonts.mjs`.
 *
 * The demo ships Roboto and Inconsolata (scripts/lib/demo-fonts.mjs), and neither draws an agent's
 * spinner, its arrows and bullets, or the language picker's native names. A glyph no shipped face
 * covers is drawn from the visitor's own face, a different glyph on every OS, and the posters
 * would not match the live frame. This cuts, from OFL Noto faces, exactly the codepoints the demo
 * carries (scripts/lib/demo-glyphs.mjs) that the two primary faces lack, and writes them to
 * demo/fonts/ as small WOFF2 files plus symbols.json, which the build reads. The files are
 * committed, so the build needs neither the Noto packages (the CJK ones are tens of megabytes) nor
 * a subsetter.
 *
 * Run it when tests/unit/demo-fonts.test.ts names a codepoint no face covers (a new recording, a
 * new UI string). It installs its pinned sources into a temporary directory, never into this
 * repository, picks each codepoint's first source in SOURCES order, and cuts each source file to
 * the codepoints it supplies. A codepoint no source covers must be added to DEMO_GLYPH_GAPS with
 * its reason; the cut refuses to finish otherwise. The cut is written beside demo/fonts/ and moved
 * into place only once it is whole, so a refusal leaves the committed faces as they were.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { woff2Codepoints, woff2FileCodepoints } from './lib/font-cmap.mjs';
import { DEMO_SYMBOL_FONTS_DIR, DEMO_SYMBOL_MANIFEST, demoFontFaces } from './lib/demo-fonts.mjs';
import { DEMO_GLYPH_GAPS, collectDemoCodepoints } from './lib/demo-glyphs.mjs';
import { REMOVE_OPTIONS, swapDirectoryIn } from './lib/directory-swap.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, DEMO_SYMBOL_FONTS_DIR);
/** Where a cut is written until it is whole, beside outputDir so the swap is a rename on one disk. */
const stagingDir = `${outputDir}.cut`;
/** Where the committed faces wait while the cut moves in (swapDirectoryIn), removed once it has. */
const retiredDir = `${outputDir}.old`;

/** Where each missing codepoint is looked for, in order: symbols first, then the CJK faces. */
const SOURCES = [
  '@fontsource/noto-sans-symbols-2@5.3.0',
  '@fontsource/noto-sans-math@5.3.0',
  '@fontsource/noto-sans-symbols@5.3.0',
  '@fontsource/noto-sans-sc@5.3.1',
  '@fontsource/noto-sans-tc@5.3.1',
  '@fontsource/noto-sans-kr@5.3.1',
];
const SUBSETTER = 'subset-font@2.9.0';

function log(message) {
  console.log(`[cut-demo-fonts] ${message}`);
}

/** A refusal: thrown, so main's `finally` still removes the scratch install. */
class CutRefused extends Error {}

function fail(message) {
  throw new CutRefused(message);
}

function hex(code) {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The codepoints the demo carries that the primary faces (the latin, latin-ext and Cyrillic files) do not draw. */
function missingFromPrimaryFaces() {
  const sans = new Set();
  const mono = new Set();
  for (const face of demoFontFaces(repoRoot, { primaryOnly: true })) {
    const into = face.family.endsWith('Mono') ? mono : sans;
    for (const code of woff2FileCodepoints(face.file)) into.add(code);
  }
  const { terminal, ui } = collectDemoCodepoints(repoRoot);
  const missing = new Map();
  for (const [code, file] of terminal) if (!mono.has(code)) missing.set(code, file);
  for (const [code, file] of ui) if (!sans.has(code) || !mono.has(code)) missing.set(code, missing.get(code) ?? file);
  return missing;
}

/** Install the sources and the subsetter into a scratch directory, and list every regular WOFF2 they hold, in SOURCES order. */
function installSources(scratchDir) {
  log(`Installing ${SOURCES.length} source fonts and ${SUBSETTER} into ${scratchDir}`);
  // One command string through the shell, since npm is a .cmd on Windows. Every part is a literal
  // here except the scratch path, which is quoted.
  const command = ['npm', 'install', '--prefix', JSON.stringify(scratchDir), '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', SUBSETTER, ...SOURCES].join(' ');
  const install = spawnSync(command, { stdio: 'inherit', shell: true });
  if (install.status !== 0) fail(`npm install exited with ${install.status ?? install.signal}`);
  const files = [];
  for (const spec of SOURCES) {
    const packageName = spec.slice(0, spec.lastIndexOf('@'));
    const filesDir = path.join(scratchDir, 'node_modules', ...packageName.split('/'), 'files');
    const names = fs.readdirSync(filesDir).filter((name) => name.endsWith('-400-normal.woff2')).sort();
    for (const name of names) files.push({ spec, name, filePath: path.join(filesDir, name) });
  }
  return files;
}

async function main() {
  const missing = missingFromPrimaryFaces();
  log(`${missing.size} codepoints the demo carries are not in Roboto or Inconsolata.`);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-demo-fonts-'));
  try {
    const sourceFiles = installSources(scratchDir);
    const assigned = new Map();
    const uncovered = [];
    const coverage = sourceFiles.map((source) => ({ ...source, codepoints: woff2FileCodepoints(source.filePath) }));
    for (const code of [...missing.keys()].sort((left, right) => left - right)) {
      const source = coverage.find((candidate) => candidate.codepoints.has(code));
      if (!source) {
        uncovered.push(code);
        continue;
      }
      if (!assigned.has(source.filePath)) assigned.set(source.filePath, { source, codepoints: [] });
      assigned.get(source.filePath).codepoints.push(code);
    }

    const unexplained = uncovered.filter((code) => !(code in DEMO_GLYPH_GAPS));
    for (const code of uncovered) {
      const reason = DEMO_GLYPH_GAPS[code];
      log(`${hex(code)} ${String.fromCodePoint(code)} is in no source (${missing.get(code)}): ${reason ? `a named gap, ${reason}` : 'NOT a named gap'}`);
    }
    if (unexplained.length > 0) {
      fail(`${unexplained.length} codepoint(s) no source covers and DEMO_GLYPH_GAPS does not name: ${unexplained.map(hex).join(', ')}. Add a source to SOURCES or a gap with its reason.`);
    }

    const subsetFont = createRequire(path.join(scratchDir, 'package.json'))('subset-font');
    fs.rmSync(stagingDir, REMOVE_OPTIONS);
    fs.mkdirSync(stagingDir, { recursive: true });
    const faces = [];
    for (const { source, codepoints } of assigned.values()) {
      const text = codepoints.map((code) => String.fromCodePoint(code)).join('');
      const cut = await subsetFont(fs.readFileSync(source.filePath), text, { targetFormat: 'woff2' });
      const kept = woff2Codepoints(cut, source.name);
      const lost = codepoints.filter((code) => !kept.has(code));
      if (lost.length > 0) fail(`the cut of ${source.name} dropped ${lost.map(hex).join(', ')}`);
      const file = `symbols-${source.name.replace('-400-normal.woff2', '')}.woff2`;
      fs.writeFileSync(path.join(stagingDir, file), cut);
      faces.push({ file, source: `${source.spec} files/${source.name}`, codepoints });
      log(`${file}: ${codepoints.length} codepoints, ${cut.length} bytes`);
    }
    // Each source's licence travels with its cut: every one is a Noto face under the SIL Open Font
    // License, with its own copyright line.
    const licences = [];
    for (const spec of new Set(faces.map((face) => face.source.split(' ')[0]))) {
      const packageName = spec.slice(0, spec.lastIndexOf('@'));
      const licenceFile = `LICENSE-${packageName.split('/')[1]}.txt`;
      fs.copyFileSync(path.join(scratchDir, 'node_modules', ...packageName.split('/'), 'LICENSE'), path.join(stagingDir, licenceFile));
      licences.push(licenceFile);
    }
    const manifest = {
      generatedBy: 'node scripts/cut-demo-fonts.mjs',
      faces,
      licences,
      gaps: uncovered.map(hex),
    };
    fs.writeFileSync(path.join(stagingDir, DEMO_SYMBOL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    // Whole now, so swap it in for the committed faces. A rename Windows refuses (a scanner holding
    // a fresh file) leaves the committed faces in place, or in retiredDir if even putting them back
    // is refused, and the error names where.
    swapDirectoryIn({ stagingDir, outputDir, retiredDir });
    log(`Wrote ${faces.length} faces and ${DEMO_SYMBOL_MANIFEST} to ${outputDir}`);
  } finally {
    fs.rmSync(stagingDir, REMOVE_OPTIONS);
    fs.rmSync(scratchDir, REMOVE_OPTIONS);
  }
}

main().catch((error) => {
  const message = error instanceof CutRefused ? error.message : error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[cut-demo-fonts] ${message}`);
  process.exitCode = 1;
});
