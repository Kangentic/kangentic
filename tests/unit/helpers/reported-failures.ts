/**
 * What the error-reporting-*-behavior tests read back from a mocked
 * `reportHandledError`. Each test file creates its own mock with `vi.hoisted`,
 * so both functions take it as an argument and import nothing from vitest.
 */

/** The part of a vitest mock these helpers read: its recorded calls. */
export interface ReportCallRecorder {
  mock: { calls: readonly (readonly unknown[])[] };
}

export interface ReportedFailure {
  sent: Error;
  tags: Record<string, string>;
  contexts: unknown;
  fingerprint: unknown;
}

/** One entry per call of the mocked `reportHandledError`, in call order. */
export function reportedFailures(reportMock: ReportCallRecorder): ReportedFailure[] {
  return reportMock.mock.calls.map((call) => ({
    sent: call[0] as Error,
    tags: call[1] as Record<string, string>,
    contexts: call[2],
    fingerprint: call[3],
  }));
}

/**
 * Everything the reports carried, as one JSON string: the sent error's name,
 * message and whole stack, the tags, the contexts and the fingerprint. A test
 * matches it against user text so nothing can hide in any field.
 */
export function reportedText(reportMock: ReportCallRecorder): string {
  return JSON.stringify(reportedFailures(reportMock).map((failure) => ({
    name: failure.sent.name,
    message: failure.sent.message,
    stack: failure.sent.stack,
    tags: failure.tags,
    contexts: failure.contexts,
    fingerprint: failure.fingerprint,
  })));
}
