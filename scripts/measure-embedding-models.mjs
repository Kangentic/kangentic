// Measures local embedding models the way the Knowledge Graph runs them, so a
// model's `noiseFloor` and a tier swap rest on numbers rather than model cards.
// It runs the embed worker's exact pipeline (feature-extraction, q8, the model's
// own pooling, normalize, the query prefix on queries only) over text from this
// repository and prints, per model:
//
//   1. Noise floor: cosine of unrelated query and passage pairs (p50, p90, p99),
//      and the share of genuine and unrelated pairs the model's floor keeps at
//      the search cutoff. A model without a floor gets one calibrated to keep as
//      much unrelated text as the registry's models keep at theirs (floorKeeping).
//   2. The "space" check: the one-word query "space" against passages that are
//      about it. It passes when each sits above the floor. mxbai-embed-xsmall
//      left the registry for scoring this below its own floor.
//   3. Retrieval: MRR@10 and recall@5 for docs (a heading finds its section) and
//      code (a docblock sentence, or the bare identifier, finds its function).
//   4. Code floors: the best code relevance a non-code question reaches against
//      a code question's, the split CODE_FLOOR in related-work.ts sits between.
//   5. Throughput in passages per second.
//
// Models: every entry in src/shared/embedding-models.ts, plus any candidate
// passed as --model <hfId>[@revision]:<cls|mean>[:<query prefix>]. Weights
// download from Hugging Face into a cache under the OS temp directory.
//
// Run: node scripts/measure-embedding-models.mjs [--device cpu|dml|webgpu]
//        [--model onnx-community/granite-embedding-english-r2-ONNX:cls] [--only <hfId substring>]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { EMBEDDING_MODELS } from '../src/shared/embedding-models.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_CUTOFF = 0.15; // SEMANTIC_RELEVANCE_CUTOFF in src/main/retrieval/memory-search.ts
const PASSAGE_CHARS = 1800; // about the 480-token chunks the indexers write
const UNRELATED_PAIRS = 300;
const DOC_QUERIES = 400;
const CODE_QUERIES = 250;
const BATCH = 16;

function parseArgs(argv) {
  const options = { device: 'cpu', models: [], only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--device') { options.device = value; index += 1; }
    else if (flag === '--only') { options.only = value; index += 1; }
    else if (flag === '--model') {
      const [idAndRevision, pooling = 'cls', ...prefixParts] = value.split(':');
      const [hfId, revision] = idAndRevision.split('@');
      options.models.push({
        id: hfId.split('/').pop(), hfId, revision, pooling,
        queryPrefix: prefixParts.join(':'), noiseFloor: null, dtype: 'q8',
      });
      index += 1;
    }
  }
  return options;
}

/** Deterministic PRNG, so every run draws the same pairs. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function walk(directory, extension) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();
const words = (text) => new Set(text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);

/** docs/ split at `##`/`###` headings: the heading is the query, the body its passage. */
function docSections() {
  const sections = [];
  for (const file of walk(path.join(repoRoot, 'docs'), '.md')) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let heading = null;
    let body = [];
    const flush = () => {
      const text = squash(body.join('\n'));
      if (heading && text.length >= 200) sections.push({ file, heading, passage: text.slice(0, PASSAGE_CHARS) });
    };
    for (const line of lines) {
      const match = /^#{2,3}\s+(.+)$/.exec(line);
      if (match) {
        flush();
        heading = squash(match[1].replace(/[`*_#]/g, ''));
        body = [];
      } else {
        body.push(line);
      }
    }
    flush();
  }
  // A heading that repeats ("Scope", "The rule") names no one section.
  const counts = new Map();
  for (const section of sections) counts.set(section.heading.toLowerCase(), (counts.get(section.heading.toLowerCase()) ?? 0) + 1);
  return sections.filter((section) => counts.get(section.heading.toLowerCase()) === 1);
}

/** Exported functions under src/ with a docblock: the docblock's first sentence
 *  and the bare name are the queries, the code without the docblock the passage. */
function codeChunks() {
  const chunks = [];
  const pattern = /\/\*\*([\s\S]*?)\*\/\s*\nexport (?:async )?function (\w+)/g;
  for (const file of walk(path.join(repoRoot, 'src'), '.ts')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const docblock = squash(match[1].replace(/^\s*\*/gm, ''));
      const firstSentence = docblock.split(/(?<=\.)\s/)[0].slice(0, 220);
      if (firstSentence.length < 40) continue;
      const start = match.index + match[0].indexOf('export');
      chunks.push({
        file, name: match[2], query: firstSentence,
        passage: source.slice(start, start + PASSAGE_CHARS),
      });
    }
  }
  return chunks;
}

const SPACE_PASSAGES = [
  { label: 'disk space', text: 'The disk is almost full. Free up space by deleting old worktrees and the model cache so the next build has room to write.' },
  { label: 'whitespace', text: 'The formatter strips trailing whitespace and converts tab indentation to two spaces before the file is saved.' },
  { label: 'Space key', text: 'Press the Space key to toggle the focused checkbox, or hold Shift and press Space to select a range of rows.' },
];

function cosine(first, second) {
  let sum = 0;
  for (let index = 0; index < first.length; index += 1) sum += first[index] * second[index];
  return sum;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

const relevance = (value, floor) => (value - floor) / (1 - floor);
const fixed = (value) => value.toFixed(3);

async function embedAll(extractor, texts, prefix) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH).map((text) => prefix + text);
    const output = await extractor.run(batch);
    vectors.push(...output);
  }
  return vectors;
}

function retrievalScores(queryVectors, passageVectors) {
  let reciprocalSum = 0;
  let hitsAtFive = 0;
  queryVectors.forEach((query, goldIndex) => {
    const gold = cosine(query, passageVectors[goldIndex]);
    let rank = 1;
    for (let index = 0; index < passageVectors.length; index += 1) {
      if (index !== goldIndex && cosine(query, passageVectors[index]) > gold) rank += 1;
    }
    if (rank <= 10) reciprocalSum += 1 / rank;
    if (rank <= 5) hitsAtFive += 1;
  });
  return { mrr: reciprocalSum / queryVectors.length, recall5: hitsAtFive / queryVectors.length };
}

async function loadModel(model, device) {
  const pipe = await pipeline('feature-extraction', model.hfId, {
    device, dtype: model.dtype ?? 'q8', revision: model.revision ?? 'main',
  });
  return {
    run: async (texts) => {
      const output = await pipe(texts, { pooling: model.pooling, normalize: true });
      return output.tolist().map((row) => Float32Array.from(row));
    },
    dispose: () => pipe.dispose?.(),
  };
}

async function measure(model, corpus, device) {
  const startedLoad = Date.now();
  const extractor = await loadModel(model, device);
  const loadSeconds = (Date.now() - startedLoad) / 1000;
  const prefix = model.queryPrefix ?? '';

  // 1. Unrelated pairs: a heading and a passage from another file that share no content word.
  const docQueryVectors = await embedAll(extractor, corpus.docs.map((section) => section.heading), prefix);
  const startedPassages = Date.now();
  const docPassageVectors = await embedAll(extractor, corpus.docs.map((section) => section.passage), '');
  const passagesPerSecond = corpus.docs.length / ((Date.now() - startedPassages) / 1000);
  const unrelated = corpus.unrelatedPairs.map(([queryIndex, passageIndex]) => cosine(docQueryVectors[queryIndex], docPassageVectors[passageIndex]));
  const genuine = docQueryVectors.map((query, index) => cosine(query, docPassageVectors[index]));

  // 2. "space".
  const [spaceQuery] = await embedAll(extractor, ['space'], prefix);
  const spaceVectors = await embedAll(extractor, SPACE_PASSAGES.map((passage) => passage.text), '');
  const spaceCosines = spaceVectors.map((vector) => cosine(spaceQuery, vector));
  const spaceRanks = spaceCosines.map((value) => 1 + docPassageVectors.filter((vector) => cosine(spaceQuery, vector) > value).length);

  // 3. Code retrieval.
  const codePassageVectors = await embedAll(extractor, corpus.code.map((chunk) => chunk.passage), '');
  const codeDocQueryVectors = await embedAll(extractor, corpus.code.map((chunk) => chunk.query), prefix);
  const codeNameQueryVectors = await embedAll(extractor, corpus.code.map((chunk) => chunk.name), prefix);

  // 4. Code floors: the best code cosine each question reaches.
  const bestAgainstCode = (query) => Math.max(...codePassageVectors.map((vector) => cosine(query, vector)));
  const boardBest = docQueryVectors.slice(0, 120).map(bestAgainstCode);
  const codeBest = codeDocQueryVectors.slice(0, 120).map(bestAgainstCode);
  const identifierBest = codeNameQueryVectors.slice(0, 120).map(bestAgainstCode);

  extractor.dispose();
  return {
    model, loadSeconds, passagesPerSecond, unrelated, genuine, spaceCosines, spaceRanks,
    docs: retrievalScores(docQueryVectors, docPassageVectors),
    codeByDoc: retrievalScores(codeDocQueryVectors, codePassageVectors),
    codeByName: retrievalScores(codeNameQueryVectors, codePassageVectors),
    boardBest, codeBest, identifierBest,
  };
}

const keptShare = (values, floor) => values.filter((value) => relevance(value, floor) >= SEARCH_CUTOFF).length / values.length;

/**
 * The floor that keeps `share` of this model's unrelated pairs at the search
 * cutoff. This corpus is one repository, so its "unrelated" pairs run hotter
 * than the mutually unrelated text the shipped floors were set on, and absolute
 * floors do not carry over. What carries over is the share: a candidate that
 * keeps as much unrelated text as the shipped models do at their floors is held
 * to the same precision, and its genuine-kept share is then a fair comparison.
 */
function floorKeeping(values, share) {
  const threshold = percentile(values, 1 - share);
  return (threshold - SEARCH_CUTOFF) / (1 - SEARCH_CUTOFF);
}

function report(result, targetShare) {
  const { model } = result;
  const p90 = percentile(result.unrelated, 0.9);
  const p99 = percentile(result.unrelated, 0.99);
  const calibrated = floorKeeping(result.unrelated, targetShare);
  const lines = [
    `\n=== ${model.hfId}${model.revision ? `@${model.revision.slice(0, 8)}` : ''} (${model.pooling}, prefix ${model.queryPrefix ? 'yes' : 'none'}) ===`,
    `load ${result.loadSeconds.toFixed(1)} s, ${result.passagesPerSecond.toFixed(1)} passages/s`,
    `unrelated cosine: p50 ${fixed(percentile(result.unrelated, 0.5))}  p90 ${fixed(p90)}  p99 ${fixed(p99)}`,
    `genuine cosine:   p10 ${fixed(percentile(result.genuine, 0.1))}  p50 ${fixed(percentile(result.genuine, 0.5))}`,
  ];
  const floors = [
    ...(model.noiseFloor !== null ? [{ floor: model.noiseFloor, tag: 'current' }] : []),
    { floor: calibrated, tag: `calibrated to ${(targetShare * 100).toFixed(1)}% unrelated kept` },
  ];
  for (const { floor, tag } of floors) {
    lines.push(`floor ${fixed(floor)} (${tag}): genuine kept ${(keptShare(result.genuine, floor) * 100).toFixed(1)}%, unrelated kept ${(keptShare(result.unrelated, floor) * 100).toFixed(1)}%`);
  }
  const floor = model.noiseFloor ?? calibrated;
  // Pass: "space" sits above the floor (relevance > 0) for every passage about it.
  // mxbai-embed-xsmall scored it below its floor; bge-small clears it.
  const spacePasses = result.spaceCosines.every((value) => relevance(value, floor) > 0);
  lines.push(`"space" at floor ${fixed(floor)} ${spacePasses ? 'PASS' : 'FAIL'}: ${SPACE_PASSAGES.map((passage, index) => `${passage.label} rel ${fixed(relevance(result.spaceCosines[index], floor))} rank ${result.spaceRanks[index]}`).join(', ')}`);
  lines.push(`docs:          MRR@10 ${fixed(result.docs.mrr)}  recall@5 ${fixed(result.docs.recall5)}`);
  lines.push(`code by doc:   MRR@10 ${fixed(result.codeByDoc.mrr)}  recall@5 ${fixed(result.codeByDoc.recall5)}`);
  lines.push(`code by name:  MRR@10 ${fixed(result.codeByName.mrr)}  recall@5 ${fixed(result.codeByName.recall5)}`);
  const spread = (values) => `p10 ${fixed(relevance(percentile(values, 0.1), floor))} p50 ${fixed(relevance(percentile(values, 0.5), floor))} p90 ${fixed(relevance(percentile(values, 0.9), floor))}`;
  lines.push(`best code relevance, board questions: ${spread(result.boardBest)}`);
  lines.push(`best code relevance, code questions:  ${spread(result.codeBest)}`);
  lines.push(`best code relevance, identifiers:     ${spread(result.identifierBest)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  env.allowRemoteModels = true;
  env.cacheDir = path.join(os.tmpdir(), 'kangentic-embedding-measure');

  const random = mulberry32(20261005);
  const docs = shuffled(docSections(), random).slice(0, DOC_QUERIES);
  const code = shuffled(codeChunks(), random).slice(0, CODE_QUERIES);
  const unrelatedPairs = [];
  while (unrelatedPairs.length < UNRELATED_PAIRS) {
    const queryIndex = Math.floor(random() * docs.length);
    const passageIndex = Math.floor(random() * docs.length);
    if (docs[queryIndex].file === docs[passageIndex].file) continue;
    const shared = [...words(docs[queryIndex].heading)].filter((word) => words(docs[passageIndex].passage).has(word));
    if (shared.length === 0) unrelatedPairs.push([queryIndex, passageIndex]);
  }
  process.stdout.write(`corpus: ${docs.length} doc sections, ${code.length} code chunks, ${unrelatedPairs.length} unrelated pairs, device ${options.device}\n`);

  const seen = new Set();
  const models = [...EMBEDDING_MODELS, ...options.models]
    .filter((model) => (seen.has(model.hfId) ? false : seen.add(model.hfId)))
    .filter((model) => !options.only || model.hfId.includes(options.only));
  const results = [];
  for (const model of models) {
    process.stdout.write(`measuring ${model.hfId}...\n`);
    results.push(await measure(model, { docs, code, unrelatedPairs }, options.device));
  }
  // The precision the shipped floors hold: the mean unrelated share they keep.
  const shipped = results.filter((result) => result.model.noiseFloor !== null);
  const targetShare = shipped.length > 0
    ? shipped.reduce((sum, result) => sum + keptShare(result.unrelated, result.model.noiseFloor), 0) / shipped.length
    : 0.1;
  for (const result of results) report(result, targetShare);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
