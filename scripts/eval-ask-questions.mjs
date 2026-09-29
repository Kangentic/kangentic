/**
 * The question set the Ask harness grades, and how each one's answer is known.
 *
 * Every entry declares a CORPUS and a ground-truth provider. The provider is a
 * function of the corpus rollup, so nothing here is a stored fixture: the
 * expected answer is computed from the live index at run time and cannot drift
 * from it. That is the whole reason this harness is cheap to keep - there is
 * no file anyone has to update when the board moves.
 *
 * The corpus field is not decoration. When the repo corpus lands, a code
 * question declares `corpus: 'file'` and supplies its own provider; the runner,
 * the grading and the report are unchanged.
 *
 * DELIBERATELY EXCLUDED: reasoning questions ("why did we drop the sphere
 * fit?"). They have no computable answer, so this harness measures the
 * CHECKABLE half of Ask and the other half stays a human judgement. Stating
 * that is the point - a harness that quietly grades only what it can reach,
 * while reading as a score for the whole feature, is worse than no harness.
 *
 * INCLUDED, since the agent searches the transcripts itself: three TRANSCRIPT
 * questions whose truth IS computable. A phrase lifted from a real passage
 * must lead the agent to that passage's task; a question about a task's
 * conversations must be answered by searching and quoting what was read; and
 * a phrase in no transcript must be declined, after a search. Together they
 * see the one thing the board questions cannot - whether agent-driven
 * retrieval finds the right conversation, and whether it says so when there
 * is none.
 */

/**
 * Facts a grader looks for. `all` must appear, `none` must not, and `any` needs
 * at least one hit - which is how a fact with more than one honest spelling (a
 * rounded total, a refusal in the agent's own words) gets graded on being right
 * rather than on being punctuated the way we guessed.
 *
 * `evidence` asks for things beyond the facts: `searched` requires at least
 * one `kangentic_search` call, read off the run record, and `grounded`
 * requires a QUOTED passage in the answer - a quote is what proves something
 * was read, where a summary could have come from the table row alone.
 */
const expect = (all, none = [], any = [], evidence = {}) => ({ all, none, any, ...evidence });

/**
 * Money as the answer will have written it. The prompt states cost to the cent
 * and the rows render `$308.42`, so the grader accepts either form rather than
 * failing an answer that is right and punctuated differently.
 */
const money = (value) => [value.toFixed(2)];

/**
 * The name a task has in an answer: its board ticket, `#529`, which is the ref
 * the prompt's table uses and the mark the chat draws. The `T<n>` positions the
 * table used before are retired, so an answer has one spelling to be graded on.
 */
export function nameFor(_rollup, row) {
  return [`#${row.displayId}`];
}

/**
 * Tasks whose title names a topic, busiest first.
 *
 * The recall floor for a relatedness question: a task called "Relay config:
 * resolved default + custom override" is related to the mobile relay whatever
 * the retrieval thinks, so an answer that omits the busiest of these has missed
 * something it cannot argue about. Sorted by sessions so `slice(0, n)` takes the
 * ones with the most conversations, which are the hardest to miss.
 */
function titledWith(rollup, words) {
  return rollup
    .filter((row) => row.displayId != null && words.some((word) => row.title.toLowerCase().includes(word)))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Every row tied at the top of a measure.
 *
 * A superlative over a discrete metric ties constantly - four tasks can all
 * have run four sessions - and picking one by sort order makes the harness
 * demand an arbitrary member of the tie. Any of them is the right answer.
 */
function topRows(rollup, valueOf) {
  const best = Math.max(...rollup.map((row) => valueOf(row) ?? -Infinity));
  return rollup.filter((row) => (valueOf(row) ?? -Infinity) === best);
}

/**
 * How a grounded answer says it has nothing. Phrasing varies; refusal does not.
 *
 * This list has already failed a textbook-correct refusal once - "the task table
 * and excerpts DON'T cover Kubernetes autoscaling" - because it carried
 * `does not` and `doesn't` but not `don't`. A vocabulary check is only ever as
 * good as its vocabulary, so when it fails, suspect the list before the answer:
 * read what the model actually wrote and ask whether a person would call it a
 * refusal. If they would, the list is wrong.
 */
const DECLINES = [
  'nothing', 'no task', 'not part', 'not covered', 'no record', 'not mentioned',
  'no mention', 'not in the', 'cannot', 'no such', 'not answerable', 'no data',
  // The fourth grader failure on this list: "No conversation in this project
  // mentions a zebra-striped quantum kettle" is a textbook decline after a
  // real search, and the list had `no task` and `no record` but not the unit
  // a transcript question is actually about.
  'no conversation', 'no session', 'no passage',
  // Every negation, in each of the forms a model actually writes them.
  'does not', "doesn't", 'do not', "don't", 'is not', "isn't", 'are not', "aren't",
];

export const QUESTIONS = [
  {
    id: 'superlative-cost',
    corpus: 'conversation',
    question: 'What is the most expensive task?',
    truth: (rollup) => {
      const top = topRows(rollup, (row) => row.costUsd)[0];
      return expect(money(top.costUsd), [], nameFor(rollup, top));
    },
  },
  {
    id: 'superlative-duration',
    corpus: 'conversation',
    question: 'Which task ran for the longest total time?',
    truth: (rollup) => {
      const tied = topRows(rollup, (row) => row.durationMs);
      return expect([], [], tied.flatMap((row) => nameFor(rollup, row)));
    },
  },
  {
    id: 'superlative-sessions',
    corpus: 'conversation',
    question: 'Which task took the most separate conversations?',
    truth: (rollup) => {
      const tied = topRows(rollup, (row) => row.sessions);
      return expect([String(tied[0].sessions)], [], tied.flatMap((row) => nameFor(rollup, row)));
    },
  },
  {
    id: 'count-total',
    corpus: 'conversation',
    question: 'How many tasks are in the index?',
    truth: (rollup) => expect([String(rollup.length)]),
  },
  {
    id: 'count-in-progress',
    corpus: 'conversation',
    question: 'How many tasks are still in progress?',
    truth: (rollup) => {
      const count = rollup.filter((row) => row.outcome === 'active').length;
      return expect([String(count)]);
    },
  },
  {
    id: 'lookup-by-ticket',
    corpus: 'conversation',
    question: 'What is task #529 about, and what has it cost so far?',
    truth: (rollup) => {
      const row = rollup.find((entry) => entry.displayId === 529);
      // Skipped rather than failed when this board has no #529: the harness
      // must be runnable against any project, not only the one it was written
      // on. A question that cannot apply is not a question that failed.
      if (!row) return null;
      return expect(money(row.costUsd));
    },
  },
  {
    id: 'selection-outcome',
    corpus: 'conversation',
    question: 'Which tasks were dropped without ever finishing?',
    // Status has no "dropped": only the move into Done archives a task. What the
    // table does carry is each task's pull request, and one closed without
    // merging is work given up on, which is how Sonnet read the question on the
    // real board (the three closed-unmerged PRs, and only those). With none, the
    // only thing worth asserting is that the answer does not INVENT one: naming
    // no ticket is the whole test, and the words it declines with are its own.
    truth: (rollup) => {
      const closed = rollup.filter((row) => row.prState === 'closed' && row.displayId != null);
      if (closed.length === 0) return expect([], ['#']);
      return expect([], [], [], { allOf: closed.slice(0, 3).map((row) => nameFor(rollup, row)) });
    },
  },
  {
    id: 'total-spend',
    corpus: 'conversation',
    question: 'What have all the tasks in this project cost in total?',
    truth: (rollup) => {
      const total = rollup.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
      // A total over hundreds of nullable rows is exactly where the agent's
      // arithmetic and ours legitimately part company in the last digits, so
      // this accepts the rounded dollar, the floor, or the two-decimal figure.
      // Pinning one spelling would fail answers that are correct.
      return expect([], [], [
        Math.round(total).toLocaleString('en-US'),
        Math.floor(total).toLocaleString('en-US'),
        total.toFixed(2),
      ]);
    },
  },

  // ---- Relatedness. The three shapes Round 36 measured failing: a set, a
  // superlative inside a set, and a count. Ground truth is a RECALL FLOOR: a task
  // whose title names the topic is related by construction, so the busiest few
  // of those must appear. A related task the title does not name is allowed and
  // never penalized, because the floor is a floor and not the whole set.
  {
    id: 'related-set',
    corpus: 'conversation',
    question: 'Which tasks are related to the mobile relay?',
    truth: (rollup) => {
      const named = titledWith(rollup, ['relay', 'mobile bridge', 'pairing']);
      if (named.length < 3) return null;
      return expect([], [], [], { allOf: named.slice(0, 3).map((row) => nameFor(rollup, row)) });
    },
  },
  {
    id: 'related-superlative',
    corpus: 'conversation',
    question: 'What was the most expensive task related to the mobile relay?',
    truth: (rollup) => {
      const named = titledWith(rollup, ['relay', 'mobile bridge', 'pairing'])
        .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
      if (named.length === 0) return null;
      // Any of the three costliest title-named tasks: a related task the title
      // does not name may legitimately cost more, so the floor stays a floor.
      return expect([], [], named.slice(0, 3).flatMap((row) => nameFor(rollup, row)));
    },
  },
  {
    id: 'related-count',
    corpus: 'conversation',
    question: 'How many tasks touched the terminal renderer?',
    truth: (rollup) => {
      const named = titledWith(rollup, ['xterm', 'terminal render', 'scrollback', 'conpty']);
      if (named.length < 3) return null;
      // The count itself has no computable truth until the change corpus lands;
      // what can be checked is that the answer names the busiest title-named
      // tasks rather than reinterpreting the question into one it can answer.
      return expect([], ['0 times', 'zero times', 'never'], [], { allOf: named.slice(0, 3).map((row) => nameFor(rollup, row)) });
    },
  },

  // ---- Controls. An answering surface that never declines is not measurable.
  {
    id: 'control-out-of-scope',
    corpus: 'conversation',
    question: 'What is the capital of France?',
    // It must NOT answer from general knowledge. Paris appearing at all is the
    // failure: the rules say answer only from the table and the excerpts.
    truth: () => expect([], ['Paris']),
  },
  {
    id: 'control-absent-subject',
    corpus: 'conversation',
    question: 'What did we decide about the Kubernetes autoscaling policy?',
    // Nothing in this index covers it, so the right answer SAYS SO - and
    // saying so necessarily restates the subject. The first version forbade
    // the word "autoscal" and therefore failed a textbook correct refusal
    // ("Nothing in the tasks or excerpts mentions Kubernetes or autoscaling").
    // What is actually being tested is that it declines rather than invents.
    truth: () => expect([], [], DECLINES),
  },

  // ---- Transcripts. Answerable only by searching, which is what this measures.
  {
    id: 'transcript-locates-phrase',
    corpus: 'conversation',
    // Written at run time. The phrase is seven consecutive words from a real
    // passage of the busiest task's conversations - present by construction,
    // in no task title, and therefore reachable only through the search tool.
    // The right answer names that task.
    question: null,
    truth: async (rollup, tools) => {
      const target = topRows(rollup.filter((row) => row.taskId), (row) => row.sessions)[0];
      if (!target) return null;
      const phrase = await tools.phraseFrom(target);
      if (!phrase) return null;
      return {
        question: `Which task's conversations contain the words "${phrase}"?`,
        ...expect([], [], nameFor(rollup, target), { searched: true }),
      };
    },
  },
  {
    id: 'transcript-what-happened',
    corpus: 'conversation',
    // A question the table cannot settle: it knows the task exists and what it
    // cost, not what was done. So the agent must search, and must show what it
    // read. What it then says is a judgement call this harness does not make;
    // that it searched and quoted is not.
    question: null,
    truth: (rollup) => {
      const target = topRows(rollup.filter((row) => row.displayId != null), (row) => row.sessions)[0];
      if (!target) return null;
      return {
        question: `What was actually done in the conversations for task #${target.displayId}? Quote something that was said.`,
        ...expect([], [], [], { searched: true, grounded: true }),
      };
    },
  },
  {
    id: 'transcript-absent-phrase',
    corpus: 'conversation',
    question: 'Which conversation mentions a zebra-striped quantum kettle?',
    // Nothing does. The right answer searches, finds nothing, and says so -
    // rather than answering from the table, which would mean it never looked,
    // or naming a task, which would mean it invented one.
    truth: () => expect([], ['#'], DECLINES, { searched: true }),
  },
];
