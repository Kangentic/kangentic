/**
 * Grouping the map into named regions.
 *
 * Without this the surface is anonymous blobs: you can see that conversations
 * group, but not what any group is ABOUT, which is most of the value. Labelling
 * turns the map into a topic atlas of the project.
 *
 * Clustering runs on the 2D POSITIONS, not the source vectors, and that is
 * deliberate: a label names the blob the user is looking at, so it has to be
 * derived from the same grouping their eye makes. Clustering in full
 * dimensionality would produce groups that are more "correct" and visibly
 * wrong, with labels scattered across a region that does not exist on screen.
 *
 * Labels are scored by LIFT (how over-represented a term is in this cluster
 * versus the whole corpus), not raw frequency. Raw frequency just surfaces
 * whatever is common everywhere - on a software project every cluster would be
 * labelled "fix add update".
 */

/**
 * Grammar, never content. These may not appear in a label at all, alone or
 * inside a phrase.
 *
 * Separated from the generic-domain list below because the two behave
 * differently in phrases, and merging them produced both failures in turn.
 * Allowing a phrase whenever EITHER half was meaningful let "the relay",
 * "for antigravity" and "bytes from" name regions; forbidding a phrase whenever
 * either half was filler killed "task detail", which is the phrase that started
 * this. A function word qualifies nothing, so it is barred outright.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on', 'at',
  'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'these', 'those', 'we', 'i', 'you', 'they', 'not', 'no', 'do', 'does', 'did', 'can', 'will',
  'should', 'would', 'when', 'while', 'into', 'out', 'up', 'down', 'over', 'under', 'via', 'per',
  'only', 'just', 'still', 'now', 'also', 'more', 'most', 'some', 'any', 'each', 'every', 'than',
  'after', 'before', 'again', 'back', 'around', 'through', 'without', 'within',
  'across', 'about', 'between', 'during', 'against', 'because', 'where',
  // Possessives and wh-words. Added after `mcp / move their` named a region on
  // the real corpus: a phrase is only barred when BOTH halves are grammar, so a
  // pronoun paired with a real word sailed through as a plausible-looking term.
  'their', 'them', 'our', 'your', 'his', 'her', 'what', 'which', 'who', 'whose',
  'how', 'why', 'whether', 'there', 'here', 'until', 'once', 'upon', 'being',
  'toward', 'towards',
]);

/**
 * Words that are real but say nothing on their own HERE.
 *
 * Every one of these heads half the task titles on this project, so alone they
 * distinguish nothing - but inside a phrase they are exactly what supplies the
 * meaning. "task" alone is noise; "task detail" is a subject. So these are
 * barred as standalone terms and welcome as one half of a pair, which is the
 * distinction that makes the labels read as topics rather than fragments.
 */
const GENERIC_TERMS = new Set([
  'fix', 'fixes', 'fixed', 'add', 'adds', 'added', 'update', 'updates', 'updated', 'make', 'made',
  'use', 'uses', 'used', 'new', 'change', 'changes', 'changed', 'remove', 'removed', 'support',
  'task', 'dev', 'seed', 'untitled', 'conversation', 'conversations', 'work', 'get', 'gets',
  'set', 'sets', 'show', 'shows', 'move', 'moves', 'keep', 'keeps', 'read', 'reads', 'stop',
  'stops', 'let', 'lets', 'give', 'gives', 'run', 'runs',
]);

/** A term is excluded on its own if it is either kind of filler. */
const STOP_WORDS = new Set([...FUNCTION_WORDS, ...GENERIC_TERMS]);

const MIN_TERM_LENGTH = 3;
/** A term must describe at least this many of a cluster's documents. Guards
 *  against lift crowning a rare word that names almost nothing. Kept as a flat
 *  count rather than a share: a proportional floor pushed large clusters toward
 *  whatever generic word was most common, which is the opposite of the goal. */
const MIN_TERM_DOCUMENTS = 2;
/**
 * A term appearing in more than this share of the WHOLE corpus is excluded.
 *
 * Every corpus has words that are everywhere and mean nothing in it - on this
 * project "agent", "project", and "board" appear in most task titles, so they
 * float to the top of any cluster and label it nothing. A hand-maintained
 * stopword list cannot know that (they are perfectly good words elsewhere), so
 * the ceiling is measured per corpus instead. This is the same instinct as IDF:
 * a term that describes everything describes nothing.
 *
 * Set at half the corpus rather than lower: a project with only a few broad
 * areas legitimately has topic words in 30-40% of its titles, and an aggressive
 * ceiling excluded those too, leaving nothing and falling back to the very
 * noise it was meant to remove.
 */
const MAX_CORPUS_DOCUMENT_SHARE = 0.5;
const TERMS_PER_LABEL = 3;
/**
 * Budget for the whole label, in characters.
 *
 * A COUNT of terms is the wrong control now that terms can be phrases. Three
 * made sense when every term was one word; with bigrams the same three became a
 * six-word sentence that truncated in the Regions panel and drew an over-wide
 * pill on the map - "command injection / task detail / surface".
 *
 * A length budget adapts instead of averaging: a short unigram label keeps all
 * three terms ("session / live / shell"), while a phrase-heavy one stops at two
 * and stays readable. Sized to the panel's row, which is the narrowest place a
 * label has to fit.
 */
const MAX_LABEL_CHARS = 34;
/** How much a two-word phrase outranks a single word of equal frequency. */
const PHRASE_WEIGHT = 1.6;
const KMEANS_ITERATIONS = 24;

/**
 * How labels are made, as a number. Region names are laid over a built map
 * (`region-names.ts`) and stored against this, so a change to how a name is
 * made renames every map on its next read, with no rebuild. Bump it with any
 * change to the terms, weights or lists below.
 *
 * 2: product names kept whole, and each task's digest read beside its title.
 * 3: a digest saying its task has nothing to say is narration too.
 */
export const LABELLER_VERSION = 3;

/**
 * Product names that are one word whatever their capitals say. The camelCase
 * split below cut "GitHub" into "git hub", and that pair named a real region.
 */
const PRODUCT_NAMES = /\b(GitHub|OpenCode|TypeScript|JavaScript|WebGL|WebGPU|DirectML)\b/g;

/**
 * How much a word from a task's digest counts against the same word in a title.
 *
 * Measured on the real 998-conversation map at the balanced setting, against
 * titles alone: at 0.75, 21 of 40 region names read better, 12 the same, 2
 * worse and 5 did not change. Weighted equally, the digests' narration took
 * over ("two bugs / session manager", "tests covering / column manager").
 */
export const DIGEST_LABEL_WEIGHT = 0.75;

/**
 * Words a digest uses to narrate the work rather than to name the product part
 * it touched. A title rarely says "added" or "covering"; a digest nearly always
 * does, so these would otherwise name regions by how the work was described.
 * Applied to digest text only: in a title these words are the author's choice.
 */
export const DIGEST_FILLER: ReadonlySet<string> = new Set([
  'adding', 'added', 'adds', 'covering', 'covers', 'tests', 'test', 'testing', 'two', 'three', 'bugs', 'bug',
  'shipped', 'ships', 'ship', 'landed', 'merged', 'app', 'code', 'files', 'file', 'ended', 'end', 'ending',
  'set', 'out', 'instead', 'making', 'using', 'replacing', 'replaced', 'moving', 'fixing', 'several',
  'existing', 'new', 'now', 'also', 'plus', 'along', 'kangentic', 'task', 'tasks', 'feature', 'features',
  'first', 'second', 'one', 'both', 'all', 'multiple', 'various', 'across', 'renderer', 'main', 'process',
  // A task with an empty description gets a digest that says so ("the task
  // description gives no further detail"). On the real map three release
  // tasks' digests named a 36-conversation region "release / further detail".
  'further', 'beyond', 'nothing', 'known', 'description', 'released',
]);

/**
 * A second text per row, counted at a lower weight: each task's digest.
 *
 * A term the row's title already has is not counted twice, and a term with a
 * `stopWords` half is not counted at all.
 */
export interface SecondaryLabelSources {
  readonly texts: ReadonlyArray<string>;
  readonly weight: number;
  readonly stopWords: ReadonlySet<string>;
}

export interface ClusterAssignment {
  /** Cluster index per row, parallel to the projection's nodes. */
  readonly clusterOf: Int32Array;
  readonly clusterCount: number;
}

export interface ClusterSummary {
  readonly id: number;
  readonly label: string;
  /** Centroid in unit-box coordinates, for placing the label. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly size: number;
}

/**
 * Layout components these functions operate over. 3 since the surface went
 * spatial-only: clustering happens in the space the map is actually drawn in, so
 * a label always names the blob the eye sees. Parameterized rather than
 * hard-coded because that equivalence is the whole reason it is 3, and a future
 * layout change should have to state its own number.
 */
const DEFAULT_COMPONENTS = 3;

/** Squared distance between a row and a centroid. Squared, not `Math.hypot`:
 *  this is the k-means inner loop and only the ORDERING matters. */
function squaredDistanceTo(
  points: Float32Array,
  row: number,
  centroids: Float32Array,
  cluster: number,
  components: number,
): number {
  let total = 0;
  for (let axis = 0; axis < components; axis += 1) {
    const difference = points[row * components + axis] - centroids[cluster * components + axis];
    total += difference * difference;
  }
  return total;
}

/** Deterministic xorshift32, so a cached projection's clusters never shuffle. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Fewer than this says nothing about the corpus. */
const MIN_REGIONS = 3;
/**
 * Ceiling on regions.
 *
 * Was 10, justified as "more turns the map into a wall of text" - written when
 * regions were unmanaged floating labels with no way to switch any of them off.
 * There is now a Regions panel with per-region toggles and All / None, so the
 * cost of another region is much lower than when that limit was set, and on a
 * real 638-conversation corpus the old square-root rule already wanted 18 and
 * was being clamped to 10. Clamping is what forced unrelated work into one
 * region.
 *
 * Then 24, and that re-created the same failure one corpus size up. It binds
 * from `24 x band.min` conversations - n>144 for fine, n>240 for balanced - so
 * on a real 646-conversation index the balanced floor computed to 25, clamped to
 * 24, and the ceiling to 24: floor equalled ceiling, the sweep below never ran,
 * and FINE resolved to exactly the same 24. Two of the three granularities were
 * the identical map, and balanced still carried a 44-conversation region, which
 * is the "unrelated work filed together" complaint the size band exists to fix.
 *
 * 40 is measured, not chosen. Region sizes across every candidate k on that
 * corpus:
 *
 *     k    max  p75  med  p25  min  ratio   <6   >26
 *    24     44   31   25   23   15    2.9    0     9
 *    32     33   24   21   15    4    8.3    1     4
 *    40     31   19   15   13    4    7.8    1     2
 *    48     27   17   13   10    3    9.0    4     1
 *    54     26   16   12    9    1   26.0    8     0
 *
 * Past ~40 the split stops finding structure and starts shaving strays: one
 * region under six conversations at k=40, four by k=48, and by k=54 the
 * smallest region is a single conversation whose label can only name itself.
 * Below it, balanced settles at 32 (largest region 33, not 44) and fine reaches
 * 40, so the three granularities finally differ.
 *
 * Measured across all eight indexed projects on the development machine, raising
 * this changes NOTHING on seven of them - it cannot bind until a project passes
 * ~144 conversations. A reader who finds 40 regions too many now has Coarse,
 * which is the escape hatch the old ceiling was standing in for.
 */
const MAX_REGIONS = 40;
/**
 * The size band a region must land in. This is the WHOLE selection rule.
 *
 * Measured on the real corpus, every intrinsic score peaks at the same place and
 * for the same reason. Across k = 3..24 on 150 conversations:
 *
 *     k                 5      6      8      9     12     15     24
 *     Calinski-Har.   165    159    145    140    130    131    144
 *     silhouette     0.47   0.46   0.37   0.37   0.36   0.37   0.43
 *     kNN purity     0.72   0.70   0.58   0.56   0.54   0.48   0.41
 *     largest          46     45     26     23     20     18     12
 *     smallest         17     14     13     13      4      4      1
 *
 * They all favour FEWER regions, monotonically, because a neighbour embedding is
 * a continuum rather than a set of separated blobs - so "best separated" is
 * always "fewest". Calinski-Harabasz peaked at 5, below the floor of 6, which
 * means the score returned the floor every single time and the selection step
 * was decorative. That is what produced a 45-conversation region holding several
 * unrelated subjects. Swapping in silhouette or purity changes nothing: they
 * peak at 5 too.
 *
 * So there is no score to choose. How finely to cut is a READABILITY judgement,
 * and the band is that judgement stated directly: a region of ~16 reads as one
 * subject, ~45 reads as several filed together, and one of 2 is a stray rather
 * than a domain.
 */
const TARGET_MIN_ROWS_PER_REGION = 10;
const TARGET_MAX_ROWS_PER_REGION = 26;

/** How many conversations a region should hold, at each granularity. */
export interface RegionSizeBand {
  readonly min: number;
  readonly max: number;
}

/**
 * The three bands the granularity control offers.
 *
 * Balanced is the measured default above. The other two are the same judgement
 * made differently: how much detail does the reader want, which no separation
 * score can answer for them. The spans overlap deliberately - a hard boundary
 * between them would make one conversation's arrival flip the whole map.
 */
export const REGION_SIZE_BANDS: Record<'coarse' | 'balanced' | 'fine', RegionSizeBand> = {
  coarse: { min: 18, max: 45 },
  balanced: { min: TARGET_MIN_ROWS_PER_REGION, max: TARGET_MAX_ROWS_PER_REGION },
  fine: { min: 6, max: 15 },
};
// The sweep below deliberately reads EVERY row.
//
// It used to cluster a 500-row prefix to pick the count and then cluster the
// whole corpus with it. That prefix is in accumulator insertion order, which is
// chunk-id order, which is roughly chronological - so on any index past 500
// conversations the region count was decided by the OLDEST 500 and applied to
// all of them. The comment called it a sample; it was never a sample.
//
// Measured on the real 646-conversation corpus: the prefix picks 20 regions for
// coarse where the whole corpus picks 22, and the prefix's answer carries a
// 61-conversation region against the other's 44 - the sampled answer is the one
// that merges unrelated work, at the granularity least able to afford it. It
// bought nothing either: sweeping everything costs 77ms against the prefix's
// 85ms, because the candidate range narrows as the corpus grows (past
// `MAX_REGIONS x band.max` rows the floor meets the ceiling and there is no
// sweep left to run).

/**
 * How many regions to carve the map into.
 *
 * The rule: **the most regions we can have while every one of them is a
 * plausible size.** Sweep the band, actually cluster at each candidate, and take
 * the largest k where no region falls outside `TARGET_MIN..TARGET_MAX`. Where no
 * candidate is clean, take the one with the fewest out-of-range regions, and
 * prefer more regions on a tie.
 *
 * Two earlier rules failed differently and both are worth remembering.
 * `round(sqrt(rowCount / 2))` was a function of corpus SIZE that never looked at
 * its structure. Its replacement asked Calinski-Harabasz to pick within a band -
 * but every separation score is maximised by the fewest clusters on a continuous
 * cloud, so it returned the band's floor every time and left one region holding
 * a third of the corpus (see the band constant above for the measurements).
 *
 * This rule looks at the thing that was actually wrong. It does not ask which
 * cut is best separated - nothing can answer that here - it asks which cuts
 * produce regions a person can read, and then takes the most detailed of those.
 */
export function chooseClusterCount(
  rowCount: number,
  points?: Float32Array,
  components = DEFAULT_COMPONENTS,
  band: RegionSizeBand = REGION_SIZE_BANDS.balanced,
): number {
  if (rowCount < 6) return Math.max(1, Math.min(rowCount, 2));

  // The band, then the score within it.
  // The floor is clamped to MAX_REGIONS FIRST. Without that, a large corpus
  // pushes the floor past the ceiling and `Math.max(floor, ...)` quietly carries
  // it through - a 5000-conversation index asked for 193 regions and got one
  // more than the limit allows.
  const floor = Math.min(
    MAX_REGIONS,
    Math.max(MIN_REGIONS, Math.ceil(rowCount / band.max)),
  );
  const ceiling = Math.max(
    floor,
    Math.min(MAX_REGIONS, Math.floor(rowCount / band.min)),
  );
  // No layout to read (callers that only know the size, and the tests that pin
  // the range): the middle of the band is the best available guess.
  if (!points) return Math.round((floor + ceiling) / 2);
  if (ceiling <= floor) return floor;

  let bestCount = floor;
  let fewestViolations = Infinity;
  for (let candidate = floor; candidate <= ceiling; candidate += 1) {
    const assignment = assignClusters(points, rowCount, candidate, components);
    const sizes = new Int32Array(assignment.clusterCount);
    for (let row = 0; row < rowCount; row += 1) sizes[assignment.clusterOf[row]] += 1;

    let violations = 0;
    for (const size of sizes) if (size < band.min || size > band.max) violations += 1;

    // `<=` rather than `<`: candidates ascend, so a tie hands it to the LARGER
    // k. More regions at equal quality is the answer that stops distinct
    // domains being filed together, which is the failure this rule exists for.
    if (violations <= fewestViolations) {
      fewestViolations = violations;
      bestCount = candidate;
    }
  }
  return bestCount;
}

/** k-means over the layout, seeded k-means++ style for stable spread. */
export function assignClusters(
  points: Float32Array,
  rowCount: number,
  clusterCount: number,
  components = DEFAULT_COMPONENTS,
  seed = 0x51ec7e5,
): ClusterAssignment {
  const clusterOf = new Int32Array(rowCount);
  if (rowCount === 0 || clusterCount <= 1) return { clusterOf, clusterCount: rowCount === 0 ? 0 : 1 };

  const random = createSeededRandom(seed);
  const centroids = new Float32Array(clusterCount * components);

  // First centre at random, each subsequent one at the point furthest from any
  // chosen centre. Deterministic given the seed, and avoids the degenerate
  // all-centres-in-one-blob start that plain random seeding produces.
  const firstIndex = Math.floor(random() * rowCount);
  for (let axis = 0; axis < components; axis += 1) {
    centroids[axis] = points[firstIndex * components + axis];
  }
  for (let cluster = 1; cluster < clusterCount; cluster += 1) {
    let bestRow = 0;
    let bestDistance = -1;
    for (let row = 0; row < rowCount; row += 1) {
      let nearest = Infinity;
      for (let chosen = 0; chosen < cluster; chosen += 1) {
        const distance = squaredDistanceTo(points, row, centroids, chosen, components);
        if (distance < nearest) nearest = distance;
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestRow = row;
      }
    }
    for (let axis = 0; axis < components; axis += 1) {
      centroids[cluster * components + axis] = points[bestRow * components + axis];
    }
  }

  const sums = new Float64Array(clusterCount * components);
  const counts = new Int32Array(clusterCount);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    let moved = false;
    for (let row = 0; row < rowCount; row += 1) {
      let best = 0;
      let bestDistance = Infinity;
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const distance = squaredDistanceTo(points, row, centroids, cluster, components);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cluster;
        }
      }
      if (clusterOf[row] !== best) {
        clusterOf[row] = best;
        moved = true;
      }
    }

    sums.fill(0);
    counts.fill(0);
    for (let row = 0; row < rowCount; row += 1) {
      const cluster = clusterOf[row];
      for (let axis = 0; axis < components; axis += 1) {
        sums[cluster * components + axis] += points[row * components + axis];
      }
      counts[cluster] += 1;
    }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if (counts[cluster] === 0) continue;
      for (let axis = 0; axis < components; axis += 1) {
        centroids[cluster * components + axis] = sums[cluster * components + axis] / counts[cluster];
      }
    }
    if (!moved && iteration > 0) break;
  }

  return { clusterOf, clusterCount };
}

/**
 * Split on non-alphanumerics AND on camelCase boundaries.
 *
 * Task titles are full of identifiers (`pruneOrphanedDirectories`,
 * `spawn_agent`), and lowercasing before splitting turns those into one
 * unreadable run - a real label came out as "pruneorphaneddirectories". Split
 * the case boundary first, then lowercase.
 */
/** The raw word stream, stop words INCLUDED. Phrases are built from this. */
/**
 * The title's words, split into runs that a PHRASE may not cross.
 *
 * Punctuation is a boundary, not whitespace to be discarded. Stripping it
 * outright made "Cross-project agent monitor: watch every running agent" yield
 * the pair "monitor watch" - two words that are adjacent only because a colon
 * was deleted between them - and that pair went on to name a region of 24
 * conversations. A dropped short word does the same thing more quietly, joining
 * two words that had something between them.
 *
 * An intra-word hyphen is deliberately NOT a boundary: "cross-project" is one
 * idea and should stay available as the pair it reads as.
 */
function wordSegments(text: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  const named = text.replace(PRODUCT_NAMES, (name) => name.toLowerCase());
  const pieces = named.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
  for (const piece of pieces) {
    // Trailing punctuation ends the phrase: "monitor:" cannot pair rightward.
    const endsClause = /[^a-z0-9]$/.test(piece);
    for (const part of piece.split(/[^a-z0-9]+/)) {
      if (part.length >= MIN_TERM_LENGTH && !/^\d+$/.test(part)) current.push(part);
      // Anything the filter rejects still SEPARATES what sat either side of it.
      else if (part.length > 0) flush();
    }
    if (endsClause) flush();
  }
  flush();
  return segments;
}

/**
 * Label candidates for one title: single words AND adjacent pairs.
 *
 * Bigrams are the fix for a specific, reported failure. Stop words used to be
 * stripped before anything else, so "Task detail terminal keeps a narrow frame"
 * lost "task" and left "detail" floating on its own - a word that means nothing
 * without the phrase it came from, and which duly showed up naming a region.
 * The same mechanism produced "read" and "gets". Pairs are therefore formed from
 * the stream WITH stop words still in it, so "task detail" survives intact even
 * though "task" alone is filler.
 *
 * This is the standard n-gram range of (1, 2) used for topic representation.
 * A pair whose halves are BOTH filler is dropped, since it describes nothing.
 */
export function candidateTerms(text: string): string[] {
  const segments = wordSegments(text);
  const terms: string[] = [];
  for (const segment of segments) {
    for (const word of segment) {
      if (!STOP_WORDS.has(word)) terms.push(word);
    }
    // Pairs are formed WITHIN a run only, so no phrase spans punctuation.
    for (let index = 0; index + 1 < segment.length; index += 1) {
      const first = segment[index];
      const second = segment[index + 1];
      // Grammar is barred outright; a generic word is welcome as one half, since
      // that is where it supplies meaning ("task detail") rather than noise.
      if (FUNCTION_WORDS.has(first) || FUNCTION_WORDS.has(second)) continue;
      if (GENERIC_TERMS.has(first) && GENERIC_TERMS.has(second)) continue;
      terms.push(`${first} ${second}`);
    }
  }
  return terms;
}

/**
 * c-TF-IDF: how often a term describes THIS region, damped by how many regions
 * of the corpus it describes at all.
 *
 * Replaces a raw lift ratio. Lift is a share-of-shares, so a term appearing in
 * two documents out of a small cluster could out-score one appearing in twenty,
 * which is how thin words reached the top. The log term is the standard inverse
 * document frequency and keeps a common word from winning on volume alone.
 */
function scoreTerm(
  term: string,
  countInCluster: number,
  corpusCounts: Map<string, number>,
  rowCount: number,
): number {
  const documentFrequency = Math.max(1, corpusCounts.get(term) ?? 1);
  const inverse = Math.log(1 + rowCount / documentFrequency);
  // A phrase says more than either of its halves, so it wins a close contest.
  // "task detail" over "detail" is exactly the case this exists for.
  const phraseBonus = term.includes(' ') ? PHRASE_WEIGHT : 1;
  return countInCluster * inverse * phraseBonus;
}

/**
 * The label's terms, highest scoring first, with no two sharing a word.
 *
 * The overlap rule does two jobs. It stops a label restating itself
 * ("terminal / task terminal / terminal pane"), and it stops a phrase and its
 * own fragment both appearing, which is what "detail" would do beside
 * "task detail". Fewer, more distinct terms describe a region better than three
 * views of one word.
 *
 * The character budget TRUNCATES the ranked list; it does not filter it. That
 * distinction is the whole of a bug that shipped: skipping a term that did not
 * fit and carrying on down the list let a short meaningless word jump the queue
 * ahead of a real phrase. Measured on the real corpus, `browser pane / light
 * dismiss` had `title bar` next at 16.5 and three characters too long, so the
 * budget reached past it and appended `one` - which fit exactly, scored on
 * rarity alone, and named a region of 24 conversations. `task detail / main
 * thread` did the same with `until`, and `adopt kangentic` with `app`.
 *
 * Two good terms are a better name than two good terms plus a bad short one, so
 * the list stops where it stops.
 */
export function selectLabelTerms(scored: ReadonlyArray<{ term: string; score: number }>): string[] {
  const chosen: string[] = [];
  const claimed = new Set<string>();
  let length = 0;
  for (const entry of scored) {
    if (chosen.length >= TERMS_PER_LABEL) break;
    const parts = entry.term.split(' ');
    // An overlapping term is SKIPPED rather than terminal: it says nothing new,
    // and the next distinct term is still a fair candidate.
    if (parts.some((part) => claimed.has(part))) continue;
    // ' / ' between terms, so each addition after the first costs three more.
    const added = entry.term.length + (chosen.length > 0 ? 3 : 0);
    // Always take the first, however long: a region with one very long term is
    // better named by it than by nothing.
    if (chosen.length > 0 && length + added > MAX_LABEL_CHARS) break;
    for (const part of parts) claimed.add(part);
    chosen.push(entry.term);
    length += added;
  }
  return chosen;
}

/**
 * Name each cluster from the terms most over-represented in it.
 *
 * `labelSources[row]` is the short text describing that document - the task
 * title where there is one. Titles are used rather than chunk text because they
 * are already human-written summaries, and reading 50k chunk bodies to build a
 * label would cost more than the entire projection.
 *
 * `secondary` adds each task's digest at a lower weight, which names a region
 * by what its work touched rather than by how its titles happened to be worded.
 */
export function labelClusters(
  assignment: ClusterAssignment,
  labelSources: ReadonlyArray<string>,
  points: Float32Array,
  components = DEFAULT_COMPONENTS,
  secondary?: SecondaryLabelSources,
): ClusterSummary[] {
  const { clusterOf, clusterCount } = assignment;
  const rowCount = clusterOf.length;
  if (rowCount === 0 || clusterCount === 0) return [];

  const corpusCounts = new Map<string, number>();
  const clusterCounts: Array<Map<string, number>> = [];
  const clusterTotals = new Int32Array(clusterCount);
  const sizes = new Int32Array(clusterCount);
  const centroidSums = new Float64Array(clusterCount * components);
  for (let cluster = 0; cluster < clusterCount; cluster += 1) clusterCounts.push(new Map());

  for (let row = 0; row < rowCount; row += 1) {
    const cluster = clusterOf[row];
    sizes[cluster] += 1;
    for (let axis = 0; axis < components; axis += 1) {
      centroidSums[cluster * components + axis] += points[row * components + axis];
    }

    // Deduped per document: a title repeating a word should not outvote a
    // document that mentions it once.
    const primary = new Set(candidateTerms(labelSources[row] ?? ''));
    for (const term of primary) {
      corpusCounts.set(term, (corpusCounts.get(term) ?? 0) + 1);
      const counts = clusterCounts[cluster];
      counts.set(term, (counts.get(term) ?? 0) + 1);
      clusterTotals[cluster] += 1;
    }
    if (secondary) {
      for (const term of new Set(candidateTerms(secondary.texts[row] ?? ''))) {
        if (primary.has(term)) continue;
        if (term.split(' ').some((part) => secondary.stopWords.has(part))) continue;
        corpusCounts.set(term, (corpusCounts.get(term) ?? 0) + 1);
        const counts = clusterCounts[cluster];
        counts.set(term, (counts.get(term) ?? 0) + secondary.weight);
        clusterTotals[cluster] += 1;
      }
    }
  }

  const summaries: ClusterSummary[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    if (sizes[cluster] === 0) continue;

    const corpusCeiling = Math.max(2, Math.floor(rowCount * MAX_CORPUS_DOCUMENT_SHARE));

    const scored: Array<{ term: string; score: number }> = [];
    for (const [term, count] of clusterCounts[cluster]) {
      // Too rare to describe this region, or too common to describe any.
      if (count < MIN_TERM_DOCUMENTS) continue;
      if ((corpusCounts.get(term) ?? 0) > corpusCeiling) continue;
      // And a PHRASE must not smuggle an everywhere-word back in. The ceiling
      // excluded "project" on its own, but "project terminal" is a different
      // term with its own lower frequency, so it sailed through and put the word
      // back in the label. If a half describes the whole corpus it describes
      // nothing here either.
      if (term.split(' ').some((part) => (corpusCounts.get(part) ?? 0) > corpusCeiling)) continue;
      scored.push({ term, score: scoreTerm(term, count, corpusCounts, rowCount) });
    }
    // Nothing cleared the rarity floor (a tiny cluster): relax it, but keep the
    // corpus ceiling. Relaxing both would hand the label straight back to the
    // everywhere-words the ceiling exists to remove.
    if (scored.length === 0) {
      for (const [term, count] of clusterCounts[cluster]) {
        if ((corpusCounts.get(term) ?? 0) > corpusCeiling) continue;
        if (term.split(' ').some((part) => (corpusCounts.get(part) ?? 0) > corpusCeiling)) continue;
        scored.push({ term, score: count });
      }
    }
    scored.sort((first, second) => second.score - first.score);

    const label = selectLabelTerms(scored).join(' / ');
    summaries.push({
      id: cluster,
      label: label.length > 0 ? label : 'unlabelled',
      x: centroidSums[cluster * components] / sizes[cluster],
      y: centroidSums[cluster * components + 1] / sizes[cluster],
      z: components > 2 ? centroidSums[cluster * components + 2] / sizes[cluster] : 0,
      size: sizes[cluster],
    });
  }

  return summaries.sort((first, second) => second.size - first.size);
}
