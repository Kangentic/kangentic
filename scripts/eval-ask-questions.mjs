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
 * conversations must be answered by searching and with grounds written; and
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
 * `evidence` asks for things beyond the prose: `searched` requires at least
 * one `kangentic_search` call, `grounded` requires a QUOTED passage in the
 * `<grounds>` block - a quote is what proves something was read, where a
 * block that restates the table row proves nothing. Both are read off the run
 * record rather than the answer text.
 */
const expect = (all, none = [], any = [], evidence = {}) => ({ all, none, any, ...evidence });

/**
 * Money as the answer will have written it. The prompt states cost to the cent
 * and the rows render `$308.42`, so the grader accepts either form rather than
 * failing an answer that is right and punctuated differently.
 */
const money = (value) => [value.toFixed(2)];

/**
 * Both names a task legitimately has in an answer.
 *
 * The prompt hands the agent a `T<n>` vocabulary and tells it explicitly to
 * refer back by that ref rather than by the ticket - the ref is a position in
 * the table, which is what makes it resolvable, and the renderer translates it
 * to `#529` on the way to the screen. So an answer saying `T1` is CORRECT and
 * the first version of this grader failed three questions for it. Grading raw
 * agent text against the rendered form measures our translation layer, not the
 * answer.
 *
 * Refs are positions in the cost-sorted table, so the ref is derivable here the
 * same way `buildAnswerTaskTable` assigns it.
 */
export function nameFor(rollup, row) {
  const ordered = [...rollup].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const ref = ordered.indexOf(row) + 1;
  return [`#${row.displayId}`, `T${ref}`];
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
    truth: (rollup) => {
      const dropped = rollup.filter((row) => row.outcome === 'abandoned');
      if (dropped.length === 0) {
        // On a board with none - which is most boards, measured: work gets
        // archived after Done, so archived-without-Done barely exists - the
        // only thing worth asserting is that it does not INVENT one. Naming no
        // ticket is the whole test; which words it declines with is its own
        // business, and requiring a specific phrasing would grade wording.
        return expect([], ['#']);
      }
      return expect(dropped.slice(0, 3).map((row) => `#${row.displayId}`));
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
