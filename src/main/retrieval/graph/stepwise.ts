/**
 * Running a long computation either in one go or in slices.
 *
 * The projection pass runs in the retrieval worker, which answers Ask and search
 * requests between its steps. So every step of the pass that can take more than
 * a frame is written as a generator that yields between units of work (a
 * layout epoch, a region-count candidate). The pass drains it in slices and
 * pauses between them, the way the vector scan and the kNN already do; tests
 * and any caller with no requests to serve drain it in one go. Both walk the
 * same steps in the same order, so the result is identical either way.
 */

/** A computation that yields between units of work and returns `T`. */
export type Stepwise<T> = Generator<void, T, void>;

/** Run every step now and return the result. */
export function runToCompletion<T>(steps: Stepwise<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * Run steps until about `sliceMs` has been spent, then await `pause` with the
 * time the slice took, and repeat. Returns null when `aborted` reports true
 * between slices.
 */
export async function runInSlices<T>(
  steps: Stepwise<T>,
  sliceMs: number,
  pause: (workedMs: number) => Promise<void>,
  aborted: () => boolean,
): Promise<T | null> {
  for (;;) {
    if (aborted()) return null;
    const startedAt = Date.now();
    let next = steps.next();
    while (!next.done && Date.now() - startedAt < sliceMs) next = steps.next();
    if (next.done) return next.value;
    await pause(Date.now() - startedAt);
  }
}
