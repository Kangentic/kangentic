/**
 * What the docs concept layout buys without an agent run (task 889, second round). Spends no quota.
 *
 *   node scripts/measure-docs-structure.mjs drift [--flat <commit>:<path>] [--concepts docs/integrations/agents]
 *
 * `--flat` names the flat file as a git object, the last commit that still had it and its path there
 * (default `492f0c474:docs/agent-integration.md`, the agent doc before the split).
 *
 * DRIFT replays history: every commit up to that commit that changed the flat doc together with a
 * file under src/. The doc lines each commit changed are mapped
 * to the concept that holds that section now, and the commit's source files are mapped to concepts
 * through their `sources:` frontmatter (scripts/docs-bundle.mjs). Recall is the share of touched
 * concepts the source files predicted. The flat layout's equivalent is the old sync-docs row that
 * pointed every agent source file at the whole flat file: it either names the file or not, and a
 * reviewer then reads all of it.
 *
 * A section is mapped by its heading text: the deepest heading on the line's heading path that only
 * one concept still has, or, among several, the concept whose H1 is the path's top heading (each
 * adapter's old H2 became its concept's H1). A line under a heading no concept has any more (renamed
 * or removed since) is counted as unmapped and left out.
 *
 *   node scripts/measure-docs-structure.mjs retrieval --questions scripts/eval-docs-reads-questions-v2.json
 *     [--flat <commit>:<path>] [--concepts <folder>] [--device cpu|dml]
 *
 * (`--questions` has no default, so this script names the eval harness's question file only here:
 * tests/unit/eval-harness-on-demand-only.test.ts allows no other script to name it in code.)
 *
 * RETRIEVAL ranks passages for each question the way the Knowledge Graph would: the app's own
 * `codeChunks` cuts the flat file (as `--flat` names it) and each concept into passages, and the default
 * embedding model (the embed worker's pipeline: its pooling, normalize, its query prefix) and a BM25
 * reference rank them. A flat passage counts as relevant when any of its lines sits in a section a
 * question's gold concept now holds; a concept passage when it comes from a gold concept. It reports
 * MRR@10 and recall@5 per layout. Weights download once into a cache under the OS temp directory.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { conceptsForSource, headingsOf, headingText, parseFrontmatter } from './docs-bundle.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The sync-docs row that mapped agent source files to the flat agent-integration.md. */
export const FLAT_AUTHORITY = [
  /^src\/main\/agent\/agent-adapter\.ts$/,
  /^src\/main\/agent\/agent-registry\.ts$/,
  /^src\/main\/agent\/adapters\//,
  /^src\/main\/transition-engine\/agent-resolver\.ts$/,
];

function git(args) {
  return execFileSync('git', ['-C', PROJECT_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The 1-based new-side lines a zero-context diff changed; a pure deletion counts the line it sits at. */
export function changedLines(diffText) {
  const lines = [];
  for (const match of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) lines.push(Math.max(start, 1));
    for (let offset = 0; offset < count; offset += 1) lines.push(start + offset);
  }
  return lines;
}

/** For each 1-based line of a markdown text, the rendered texts of the H2-and-deeper headings above it. */
export function headingPathsByLine(text) {
  const headings = headingsOf(text);
  const lineCount = text.split(/\r?\n/).length;
  const paths = new Array(lineCount + 1).fill(null);
  const stack = [];
  let next = 0;
  for (let line = 0; line < lineCount; line += 1) {
    while (next < headings.length && headings[next].line === line) {
      const heading = headings[next];
      if (heading.level >= 2) {
        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
        stack.push({ level: heading.level, text: headingText(heading.text) });
      }
      next += 1;
    }
    paths[line + 1] = stack.map((entry) => entry.text);
  }
  return paths;
}

/**
 * Maps a flat file's heading path to the concept that holds it now. `concepts` carry each concept's
 * rendered heading texts and its H1. The preamble (no H2 above) goes to `preambleConcept`.
 */
export function conceptForHeadingPath(headingPath, concepts, preambleConcept) {
  if (headingPath.length === 0) return preambleConcept;
  for (let depth = headingPath.length - 1; depth >= 0; depth -= 1) {
    const holders = concepts.filter((concept) => concept.headings.has(headingPath[depth]));
    if (holders.length === 1) return holders[0].path;
    if (holders.length > 1) {
      const byTitle = holders.filter((concept) => concept.h1 === headingPath[0]);
      if (byTitle.length === 1) return byTitle[0].path;
    }
  }
  return null;
}

/** The concepts in a folder, with their frontmatter, rendered heading texts, H1 and size. */
export function loadConcepts(folder) {
  const absolute = path.join(PROJECT_ROOT, folder);
  return fs.readdirSync(absolute)
    .filter((name) => name.endsWith('.md') && name !== 'index.md' && name !== 'log.md')
    .map((name) => {
      const text = fs.readFileSync(path.join(absolute, name), 'utf8');
      const headings = headingsOf(text);
      const h1 = headings.find((heading) => heading.level === 1);
      return {
        path: `${folder}/${name}`,
        frontmatter: parseFrontmatter(text),
        headings: new Set(headings.map((heading) => headingText(heading.text))),
        h1: h1 ? headingText(h1.text) : null,
        bytes: Buffer.byteLength(text, 'utf8'),
      };
    });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One commit's drift case: the concepts its doc edit touched, and what each layout would have flagged. */
export function driftCase({ sourceFiles, touchedConcepts, concepts }) {
  const predicted = new Set();
  for (const file of sourceFiles) for (const concept of conceptsForSource(file, concepts)) predicted.add(concept.path);
  const hits = [...touchedConcepts].filter((concept) => predicted.has(concept));
  const predictedBytes = concepts.filter((concept) => predicted.has(concept.path)).reduce((sum, concept) => sum + concept.bytes, 0);
  return {
    touched: [...touchedConcepts],
    predicted: [...predicted],
    hits: hits.length,
    recall: touchedConcepts.size === 0 ? null : hits.length / touchedConcepts.size,
    predictedBytes,
    flatFlagged: sourceFiles.some((file) => FLAT_AUTHORITY.some((pattern) => pattern.test(file))),
  };
}

function drift(options) {
  const concepts = loadConcepts(options.concepts);
  const preambleConcept = concepts.find((concept) => concept.path.endsWith('/adapter-interface.md'))?.path ?? null;
  const commits = git(['rev-list', '--no-merges', options.before, '--', options.source]).split('\n').filter(Boolean);
  const cases = [];
  let docsOnly = 0;
  let unmappedLines = 0;
  let mappedLines = 0;
  for (const commit of commits) {
    const files = git(['show', '--name-only', '--format=', commit]).split('\n').map((line) => line.trim()).filter(Boolean);
    const sourceFiles = files.filter((file) => file.startsWith('src/'));
    if (sourceFiles.length === 0) {
      docsOnly += 1;
      continue;
    }
    let text;
    try {
      text = git(['show', `${commit}:${options.source}`]);
    } catch {
      continue;
    }
    const diffText = git(['diff', '-U0', `${commit}^`, commit, '--', options.source]);
    const pathsByLine = headingPathsByLine(text);
    const touched = new Set();
    for (const line of changedLines(diffText)) {
      const headingPath = pathsByLine[Math.min(line, pathsByLine.length - 1)] ?? [];
      const concept = conceptForHeadingPath(headingPath, concepts, preambleConcept);
      if (concept) {
        touched.add(concept);
        mappedLines += 1;
      } else {
        unmappedLines += 1;
      }
    }
    if (touched.size === 0) continue;
    cases.push({ commit: commit.slice(0, 9), wholeBytes: Buffer.byteLength(text, 'utf8'), ...driftCase({ sourceFiles, touchedConcepts: touched, concepts }) });
  }
  const touchedTotal = cases.reduce((sum, entry) => sum + entry.touched.length, 0);
  const hitsTotal = cases.reduce((sum, entry) => sum + entry.hits, 0);
  const report = {
    commits: commits.length,
    docsOnly,
    cases: cases.length,
    mappedLines,
    unmappedLines,
    conceptRecall: touchedTotal === 0 ? null : hitsTotal / touchedTotal,
    fullRecallCases: cases.filter((entry) => entry.recall === 1).length,
    noHitCases: cases.filter((entry) => entry.hits === 0).length,
    flatFlaggedCases: cases.filter((entry) => entry.flatFlagged).length,
    medianPredictedBytes: median(cases.map((entry) => entry.predictedBytes)),
    medianWholeBytes: median(cases.map((entry) => entry.wholeBytes)),
    medianPredictedConcepts: median(cases.map((entry) => entry.predicted.length)),
    medianTouchedConcepts: median(cases.map((entry) => entry.touched.length)),
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.verbose) for (const entry of cases) console.log(JSON.stringify(entry));
  return 0;
}

/** The app's `codeChunks`, bundled on the fly so this script chunks exactly as the indexer does. */
async function loadChunker() {
  const esbuild = await import('esbuild');
  const built = await esbuild.build({
    stdin: { contents: "export { codeChunks } from './src/main/retrieval/code/code-record.ts';", resolveDir: PROJECT_ROOT, loader: 'ts', sourcefile: 'measure-docs-structure-entry.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-docs-structure-'));
  const file = path.join(directory, 'chunker.mjs');
  fs.writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Each chunk's body as a character range of `text`. `codeChunks` rebuilds a file line by line with a
 * newline after each, so its bodies laid end to end are the text plus one newline, and each body's
 * offset is the sum of the bodies before it.
 */
export function chunkRanges(chunks, header) {
  let offset = 0;
  return chunks.map((chunk) => {
    const prefix = `${header}\n\n`;
    const body = chunk.text.startsWith(prefix) ? chunk.text.slice(prefix.length) : chunk.text;
    const range = { start: offset, end: offset + body.length };
    offset += body.length;
    return range;
  });
}

/** 1-based line of each character offset's line start, for mapping a range to lines. */
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

const tokenize = (text) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

/** A BM25 scorer over passages (k1 1.2, b 0.75), the lexical reference beside the embedding model. */
export function bm25(passages) {
  const documents = passages.map((passage) => tokenize(passage));
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1);
  const documentFrequency = new Map();
  const termCounts = documents.map((tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    return counts;
  });
  return (query) => termCounts.map((counts, index) => {
    let score = 0;
    for (const term of new Set(tokenize(query))) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;
      const found = documentFrequency.get(term) ?? 0;
      const inverse = Math.log(1 + (documents.length - found + 0.5) / (found + 0.5));
      score += inverse * (frequency * 2.2) / (frequency + 1.2 * (1 - 0.75 + 0.75 * documents[index].length / averageLength));
    }
    return score;
  });
}

/** The 1-based rank of the first relevant passage under `scores`, or null when none is relevant. */
export function firstRelevantRank(scores, relevant) {
  const order = scores.map((score, index) => ({ score, index })).sort((left, right) => right.score - left.score || left.index - right.index);
  const position = order.findIndex((entry) => relevant[entry.index]);
  return position === -1 ? null : position + 1;
}

/** MRR@10 and recall@5 over the first-relevant ranks of a question set. */
export function rankScores(ranks) {
  const mrr = ranks.reduce((sum, rank) => sum + (rank !== null && rank <= 10 ? 1 / rank : 0), 0) / ranks.length;
  const recall5 = ranks.filter((rank) => rank !== null && rank <= 5).length / ranks.length;
  return { mrr, recall5 };
}

async function retrieval(options) {
  const { codeChunks } = await loadChunker();
  const questionSet = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, options.questions), 'utf8'));
  const questions = Array.isArray(questionSet) ? questionSet : questionSet.questions;
  const concepts = loadConcepts(options.concepts);
  const preambleConcept = concepts.find((concept) => concept.path.endsWith('/adapter-interface.md'))?.path ?? null;

  const flatText = git(['show', `${options.before}:${options.source}`]);
  const flatChunks = codeChunks(options.source, flatText);
  const starts = lineStarts(flatText);
  const pathsByLine = headingPathsByLine(flatText);
  const flatPassages = chunkRanges(flatChunks, options.source).map((range, index) => {
    const held = new Set();
    for (let line = lineOf(starts, range.start); line <= lineOf(starts, Math.max(range.start, range.end - 1)); line += 1) {
      const concept = conceptForHeadingPath(pathsByLine[Math.min(line, pathsByLine.length - 1)] ?? [], concepts, preambleConcept);
      if (concept) held.add(concept);
    }
    return { text: flatChunks[index].text, concepts: held };
  });
  const conceptPassages = concepts.flatMap((concept) => codeChunks(concept.path, fs.readFileSync(path.join(PROJECT_ROOT, concept.path), 'utf8'))
    .map((chunk) => ({ text: chunk.text, concepts: new Set([concept.path]) })));
  const layouts = { flat: flatPassages, concepts: conceptPassages };

  const { pipeline, env } = await import('@huggingface/transformers');
  const { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_ID } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src', 'shared', 'embedding-models.ts')).href);
  const model = EMBEDDING_MODELS.find((entry) => entry.id === DEFAULT_EMBEDDING_MODEL_ID);
  env.allowRemoteModels = true;
  env.cacheDir = path.join(os.tmpdir(), 'kangentic-embedding-measure');
  const extractor = await pipeline('feature-extraction', model.hfId, { device: options.device, dtype: model.dtype ?? 'q8', revision: model.revision ?? 'main' });
  const embed = async (texts, prefix) => {
    const vectors = [];
    for (let start = 0; start < texts.length; start += 16) {
      const output = await extractor(texts.slice(start, start + 16).map((text) => prefix + text), { pooling: model.pooling, normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  };
  const dot = (first, second) => first.reduce((sum, value, index) => sum + value * second[index], 0);
  const queryVectors = await embed(questions.map((question) => question.question), model.queryPrefix ?? '');

  const report = { model: model.id, questions: questions.length, layouts: {} };
  const perQuestion = [];
  for (const [name, passages] of Object.entries(layouts)) {
    const passageVectors = await embed(passages.map((passage) => passage.text), '');
    const lexical = bm25(passages.map((passage) => passage.text));
    const embeddingRanks = [];
    const lexicalRanks = [];
    questions.forEach((question, questionIndex) => {
      const relevant = passages.map((passage) => question.gold.some((concept) => passage.concepts.has(concept)));
      const embeddingRank = firstRelevantRank(passageVectors.map((vector) => dot(queryVectors[questionIndex], vector)), relevant);
      const lexicalRank = firstRelevantRank(lexical(question.question), relevant);
      embeddingRanks.push(embeddingRank);
      lexicalRanks.push(lexicalRank);
      perQuestion.push({ layout: name, question: question.id, embeddingRank, lexicalRank, relevantPassages: relevant.filter(Boolean).length });
    });
    report.layouts[name] = { passages: passages.length, embedding: rankScores(embeddingRanks), bm25: rankScores(lexicalRanks) };
  }
  await extractor.dispose?.();
  console.log(JSON.stringify(report, null, 2));
  if (options.verbose) for (const row of perQuestion) console.log(JSON.stringify(row));
  return 0;
}

export function parseArgs(argv) {
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : argv[at + 1] ?? fallback;
  };
  const flat = value('--flat', '492f0c474:docs/agent-integration.md');
  const separator = flat.indexOf(':');
  if (separator <= 0 || separator === flat.length - 1) throw new Error(`--flat: ${flat} is not <commit>:<path>`);
  return {
    mode: argv[0],
    before: flat.slice(0, separator),
    source: flat.slice(separator + 1),
    concepts: value('--concepts', 'docs/integrations/agents'),
    questions: value('--questions', null),
    device: value('--device', 'cpu'),
    verbose: argv.includes('--verbose'),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'drift') return drift(options);
  if (options.mode === 'retrieval' && options.questions) return retrieval(options);
  console.error([
    'usage: node scripts/measure-docs-structure.mjs drift [--flat <commit>:<path>] [--concepts <folder>] [--verbose]',
    '       node scripts/measure-docs-structure.mjs retrieval --questions <second-round question file>',
    '         [--flat <commit>:<path>] [--concepts <folder>] [--device cpu|dml] [--verbose]',
  ].join('\n'));
  return 2;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
